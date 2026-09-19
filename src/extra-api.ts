import { z } from 'zod';
import { LoginFailure } from './login-error.js';
import {
  MAX_EXTRA_API_RESPONSE_BYTES, SKILLS_PREVIEW_LIMIT, skillSnapshotSchema,
  type ProfileDetailsResult, type SkillsApiResult,
} from './extra-api-model.js';

type Reason = Extract<ProfileDetailsResult, { status: 'error' }>['reason'];
type JsonResult = { body: unknown } | { reason: Reason };
const optionalText = (max: number) => z.string().max(max).nullable().optional();
const profileResponse = z.object({
  user: z.object({ id: z.string().min(1).max(255), role: optionalText(200) }),
  bio: optionalText(300),
  interests: z.array(z.string().min(1).max(200)).max(10).nullable().optional(),
  partial: z.boolean().nullable().optional(),
});
const skillResponse = z.object({
  id: z.string().min(1).max(255),
  name: z.string().min(1).max(200),
  source: z.string().min(1).max(100),
  verification_method: optionalText(200),
  verified_by: optionalText(500),
  verified_at: z.iso.datetime({ offset: true }).nullable().optional(),
  visible: z.boolean().nullable().optional(),
  visibility: z.object({
    profile: z.boolean().nullable().optional(), skills: z.boolean().nullable().optional(),
  }).nullable().optional(),
});
const skillsResponse = z.object({
  items: z.array(z.unknown()),
  next_cursor: z.string().min(1).max(2048).nullable().optional(),
  partial: z.boolean().nullable().optional(),
});

function endpointAt(issuer: string, path: string): string {
  const url = new URL(path, issuer);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Untrusted API endpoint.');
  return url.href;
}
export const profileDetailsResource = (issuer: string): string => endpointAt(issuer, '/v1/me/profile');
export const skillsApiResource = (issuer: string): string => endpointAt(issuer, '/v1/me/skills');

/** A byte cap also limits unexpected upstream envelopes before we project their fields. */
async function boundedJson(response: Response): Promise<unknown> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > MAX_EXTRA_API_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('API response too large.');
  }
  if (!response.body) throw new Error('Missing API response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_EXTRA_API_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('API response too large.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

async function readJson(
  endpoint: string, accessToken: string, scope: string, grantedScope: string | undefined, fetcher: typeof fetch,
): Promise<JsonResult> {
  if (!grantedScope?.split(/\s+/).includes(scope)) return { reason: 'scope_missing' };
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
  } catch { return { reason: 'unavailable' }; }
  if (response.status === 401) return { reason: 'unauthorized' };
  if (response.status === 403) return { reason: 'forbidden' };
  if (response.status !== 200) return { reason: 'unavailable' };
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return { reason: 'invalid_response' };
  }
  try { return { body: await boundedJson(response) }; } catch { return { reason: 'invalid_response' }; }
}

export async function readProfileDetails(
  issuer: string, accessToken: string, grantedScope: string | undefined,
  expectedSubject: string, fetcher: typeof fetch = fetch,
): Promise<ProfileDetailsResult> {
  const endpoint = profileDetailsResource(issuer);
  const result = await readJson(endpoint, accessToken, 'user:profile', grantedScope, fetcher);
  const snapshot = { subject: expectedSubject, endpoint, fetchedAt: new Date().toISOString() };
  if ('reason' in result) return { ...snapshot, status: 'error', reason: result.reason };
  const owner = z.object({ user: z.object({ id: z.string().min(1).max(255) }) }).safeParse(result.body);
  if (!owner.success) return { ...snapshot, status: 'error', reason: 'invalid_response' };
  if (owner.data.user.id !== expectedSubject) throw new LoginFailure('member_api');
  const parsed = profileResponse.safeParse(result.body);
  if (!parsed.success) return { ...snapshot, status: 'error', reason: 'invalid_response' };
  return {
    ...snapshot, status: 'success', partial: parsed.data.partial ?? null,
    profile: { bio: parsed.data.bio ?? null, role: parsed.data.user.role ?? null,
      interests: parsed.data.interests ?? null },
  };
}

export async function readSkillsApi(
  issuer: string, accessToken: string, grantedScope: string | undefined,
  expectedSubject: string, fetcher: typeof fetch = fetch,
): Promise<SkillsApiResult> {
  const endpoint = skillsApiResource(issuer);
  const requestUrl = new URL(endpoint);
  requestUrl.searchParams.set('limit', String(SKILLS_PREVIEW_LIMIT));
  const result = await readJson(requestUrl.href, accessToken, 'user:skills', grantedScope, fetcher);
  // This endpoint supplies no owner/sub. This is the OIDC-verified token subject used for the read.
  const snapshot = { subject: expectedSubject, endpoint, fetchedAt: new Date().toISOString() };
  if ('reason' in result) return { ...snapshot, status: 'error', reason: result.reason };
  const parsed = skillsResponse.safeParse(result.body);
  if (!parsed.success) return { ...snapshot, status: 'error', reason: 'invalid_response' };
  const selected = z.array(skillResponse).safeParse(parsed.data.items.slice(0, SKILLS_PREVIEW_LIMIT));
  if (!selected.success) return { ...snapshot, status: 'error', reason: 'invalid_response' };
  return {
    ...snapshot, status: 'success', partial: parsed.data.partial ?? null,
    items: selected.data.map((skill) => skillSnapshotSchema.parse({
      id: skill.id, name: skill.name, source: skill.source,
      verificationMethod: skill.verification_method ?? null,
      verifiedBy: skill.verified_by ?? null, verifiedAt: skill.verified_at ?? null,
      visible: skill.visible ?? null,
      visibility: { profile: skill.visibility?.profile ?? null, skills: skill.visibility?.skills ?? null },
    })),
    requestedLimit: SKILLS_PREVIEW_LIMIT, returnedCount: parsed.data.items.length,
    hasMore: parsed.data.next_cursor === undefined ? null : parsed.data.next_cursor !== null,
    truncated: parsed.data.items.length > SKILLS_PREVIEW_LIMIT,
  };
}
