import type { Config } from './config.js';
import { apiGrantSchema, ApiGrantUnavailable, type ApiGrant, type ApiRefreshPage, type ApiRefreshResult } from './api-grant.js';
import { memberApiResource, readMemberApi } from './member-api.js';
import { profileDetailsResource, skillsApiResource, readProfileDetails, readSkillsApi } from './extra-api.js';
import type { MemberApiResult } from './service.js';

/** Bound the legacy member reader as well as fetch; a response body can stall too. */
function memberWithinBudget(operation: Promise<MemberApiResult>, signal: AbortSignal): Promise<MemberApiResult> {
  return new Promise((resolve, reject) => {
    const expired = () => resolve({ status: 'error', reason: 'unavailable', fetchedAt: new Date().toISOString() });
    if (signal.aborted) { operation.catch(() => undefined); expired(); return; }
    signal.addEventListener('abort', expired, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', expired));
  });
}

/** Reuse an existing grant for fixed read-only APIs; never invoke OAuth or refresh tokens. */
export async function refreshApis(
  settings: Pick<Config, 'issuer' | 'clientId'>,
  input: ApiGrant,
  page: ApiRefreshPage,
  fetcher: typeof fetch = fetch,
): Promise<ApiRefreshResult> {
  const parsed = apiGrantSchema.safeParse(input);
  if (!parsed.success || !['profile', 'skills'].includes(page)) throw new ApiGrantUnavailable('invalid_grant');
  const grant = parsed.data;
  if (grant.issuer !== settings.issuer || grant.clientId !== settings.clientId) throw new ApiGrantUnavailable('invalid_grant');
  if (grant.expiresAt <= Math.floor(Date.now() / 1000)) throw new ApiGrantUnavailable('expired');
  const member = memberApiResource(settings.issuer);
  const profile = profileDetailsResource(settings.issuer);
  const skills = skillsApiResource(settings.issuer);
  const allowed = [member, profile, skills];
  if (grant.resources.some((resource) => !allowed.includes(resource))) throw new ApiGrantUnavailable('invalid_grant');
  const requiredScope = page === 'profile' ? 'user:profile' : 'user:skills';
  if (!grant.scope.split(' ').includes(requiredScope)) throw new ApiGrantUnavailable('scope_missing');
  const requiredResources = page === 'profile' ? [member, profile] : [skills];
  if (requiredResources.some((resource) => !grant.resources.includes(resource))) throw new ApiGrantUnavailable('resource_missing');

  // One deadline across all reads, including pages and response bodies. A token near
  // expiry gets a shorter budget, never a new lifetime or an automatic token refresh.
  const signal = AbortSignal.timeout(Math.max(0, Math.min(5000, grant.expiresAt * 1000 - Date.now())));
  const apiFetch: typeof fetch = (inputUrl, init) => {
    const url = new URL(inputUrl instanceof Request ? inputUrl.url : String(inputUrl));
    if (url.username || url.password || url.hash || !requiredResources.includes(`${url.origin}${url.pathname}`)) {
      throw new ApiGrantUnavailable('invalid_grant');
    }
    return fetcher(inputUrl, { ...init, redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
  };
  if (page === 'skills') {
    return { skillsApi: await readSkillsApi(settings.issuer, grant.accessToken, grant.scope, grant.subject, apiFetch, { signal }) };
  }
  const [memberApi, profileDetails] = await Promise.all([
    memberWithinBudget(readMemberApi(settings.issuer, grant.accessToken, grant.scope, grant.subject, apiFetch), signal),
    readProfileDetails(settings.issuer, grant.accessToken, grant.scope, grant.subject, apiFetch, { signal }),
  ]);
  return { memberApi, profileDetails };
}
