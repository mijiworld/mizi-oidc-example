import { z } from 'zod';
import type { Config } from './config.js';
import { ApiGrantUnavailable, profileBioResource, type ApiGrant } from './api-grant.js';
import { validateApiGrant } from './api-refresh.js';
import { profileDetailsResource, readProfileDetails } from './extra-api.js';
import type { ProfileDetailsResult } from './extra-api-model.js';
import { LoginFailure } from './login-error.js';

type ProfileSuccess = Extract<ProfileDetailsResult, { status: 'success' }>;
export type ProfileBioWriteResult =
  | { status: 'saved_verified'; bio: string; profileDetails: ProfileSuccess }
  | { status: 'saved_unverified'; reason: 'readback_failed' | 'readback_mismatch' | 'identity_mismatch';
      authorizationFailure?: 'unauthorized' | 'forbidden' }
  | { status: 'unknown'; reason: 'unavailable' | 'invalid_response' | 'identity_mismatch' }
  | { status: 'not_saved'; reason: 'invalid_input' | 'unauthorized' | 'forbidden' | 'rejected' };

export const PROFILE_WRITE_TIMEOUT_MS = 5000;
export const MAX_PROFILE_WRITE_RESPONSE_BYTES = 4096;
// HTML maxlength and the MiZi contract count UTF-16 code units. Newer Zod
// versions count Unicode code points for max(), so keep this boundary explicit.
const bioSchema = z.string().refine((value) => value.length <= 300);
const savedResponse = z.strictObject({
  user: z.strictObject({ id: z.string().min(1).max(255) }),
  bio: bioSchema,
});

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Profile write time budget exceeded.'));
    if (signal.aborted) { operation.catch(() => undefined); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}
async function readSavedResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
      Number(response.headers.get('content-length')) > MAX_PROFILE_WRITE_RESPONSE_BYTES) {
    discardBody(response);
    throw new Error('Invalid profile write response.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_PROFILE_WRITE_RESPONSE_BYTES) throw new Error('Profile response exceeds byte limit.');
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)) as unknown;
}

/** One explicit PATCH followed by one readback. An uncertain write is never retried. */
export async function writeProfileBio(
  settings: Pick<Config, 'issuer' | 'clientId'>,
  input: ApiGrant,
  inputBio: string,
  fetcher: typeof fetch = fetch,
): Promise<ProfileBioWriteResult> {
  const bio = bioSchema.safeParse(inputBio);
  if (!bio.success) return { status: 'not_saved', reason: 'invalid_input' };
  const grant = validateApiGrant(settings, input);
  if (grant.expiresAt <= Math.floor(Date.now() / 1000)) throw new ApiGrantUnavailable('expired');
  const scopes = grant.scope.split(' ');
  if (!scopes.includes('user:profile:write') || !scopes.includes('user:profile')) {
    throw new ApiGrantUnavailable('scope_missing');
  }
  const endpoint = profileBioResource(settings.issuer);
  const readbackEndpoint = profileDetailsResource(settings.issuer);
  if (!grant.resources.includes(endpoint) || !grant.resources.includes(readbackEndpoint)) {
    throw new ApiGrantUnavailable('resource_missing');
  }
  const signal = AbortSignal.timeout(Math.max(0, Math.min(PROFILE_WRITE_TIMEOUT_MS, grant.expiresAt * 1000 - Date.now())));
  let response: Response;
  try {
    response = await abortable(fetcher(endpoint, {
      method: 'PATCH', headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        Authorization: `Bearer ${grant.accessToken}` },
      body: JSON.stringify({ bio: bio.data }), redirect: 'error', cache: 'no-store', signal,
    }), signal);
  } catch { return { status: 'unknown', reason: 'unavailable' }; }
  if (response.status !== 200) {
    discardBody(response);
    if (response.status === 401) return { status: 'not_saved', reason: 'unauthorized' };
    if (response.status === 403) return { status: 'not_saved', reason: 'forbidden' };
    if (response.status >= 400 && response.status < 500 && response.status !== 408) {
      return { status: 'not_saved', reason: 'rejected' };
    }
    return { status: 'unknown', reason: response.status >= 500 || response.status === 408 ? 'unavailable' : 'invalid_response' };
  }
  try {
    const parsed = savedResponse.safeParse(await readSavedResponse(response, signal));
    if (!parsed.success) return { status: 'unknown', reason: 'invalid_response' };
    if (parsed.data.user.id !== grant.subject) return { status: 'unknown', reason: 'identity_mismatch' };
    if (parsed.data.bio !== bio.data) return { status: 'unknown', reason: 'invalid_response' };
  } catch { return { status: 'unknown', reason: signal.aborted ? 'unavailable' : 'invalid_response' }; }

  // Use the existing bounded/profile projection. Never return foreign identity
  // data or claim that the requested value was saved until this fresh GET agrees.
  try {
    const readback = await readProfileDetails(settings.issuer, grant.accessToken, grant.scope, grant.subject,
      (url, init) => {
        if (String(url) !== readbackEndpoint || init?.method !== 'GET') throw new Error('Untrusted readback endpoint.');
        return fetcher(url, { ...init, redirect: 'error', cache: 'no-store',
          signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) });
      }, { signal });
    if (readback.status === 'error') return { status: 'saved_unverified', reason: 'readback_failed',
      ...(['unauthorized', 'forbidden'].includes(readback.reason)
        ? { authorizationFailure: readback.reason as 'unauthorized' | 'forbidden' } : {}) };
    if (readback.subject !== grant.subject) return { status: 'saved_unverified', reason: 'identity_mismatch' };
    if (readback.profile.bio !== bio.data) return { status: 'saved_unverified', reason: 'readback_mismatch' };
    return { status: 'saved_verified', bio: bio.data, profileDetails: readback };
  } catch (error) {
    return { status: 'saved_unverified', reason: error instanceof LoginFailure ? 'identity_mismatch' : 'readback_failed' };
  }
}
