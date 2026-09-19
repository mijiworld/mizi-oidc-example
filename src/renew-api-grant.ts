import { randomBytes } from 'node:crypto';
import { ApiGrantRefreshFailure, ApiGrantUnavailable, type ApiGrant } from './api-grant.js';
import type { OidcProvider } from './oidc.js';
import type { Session, Store } from './store.js';

export class ApiRefreshBusy extends Error {
  constructor() { super('The API connection is temporarily unavailable.'); this.name = 'ApiRefreshBusy'; }
}

/** One refresh exchange per stored grant, across processes and Lambda instances. */
export async function usableApiGrant(store: Store, oidc: OidcProvider, id: string,
  session: Session, now: () => number): Promise<ApiGrant> {
  const subject = session.profile.sub;
  const grant = await store.getApiGrant(id, subject, now());
  if (!grant) throw new ApiGrantUnavailable('expired');
  if (grant.expiresAt > now() + 30 || (!grant.refreshToken && grant.expiresAt > now())) return grant;
  if (!grant.refreshToken || !oidc.refreshGrant) throw new ApiGrantUnavailable('expired');
  const owner = randomBytes(32).toString('base64url');
  const lease = await store.beginApiRefresh(id, subject, grant.accessToken, owner, now());
  if (lease !== 'acquired') {
    const latest = await store.getApiGrant(id, subject, now());
    if (latest && latest.accessToken !== grant.accessToken && latest.expiresAt > now() + 5) return latest;
    if (!latest || lease === 'stale') throw new ApiGrantUnavailable('invalid_grant');
    throw new ApiRefreshBusy();
  }
  try {
    const refreshed = await oidc.refreshGrant(grant);
    const saved = await store.finishApiRefresh(id, subject, grant.accessToken, owner, refreshed, now());
    if (!saved) {
      await store.abortApiRefresh(id, subject, grant.accessToken, owner, true, now());
      throw new ApiRefreshBusy();
    }
    // Re-read the stored/clamped grant. Logout or cancellation while saving wins.
    const stored = await store.getApiGrant(id, subject, now());
    if (!stored || stored.accessToken !== refreshed.accessToken) throw new ApiRefreshBusy();
    return stored;
  } catch (error) {
    const retryable = error instanceof ApiGrantRefreshFailure && error.reason === 'unavailable';
    await store.abortApiRefresh(id, subject, grant.accessToken, owner, !retryable, now());
    if (retryable || error instanceof ApiRefreshBusy) throw new ApiRefreshBusy();
    // Never retry an old rotating token after an uncertain provider response.
    throw new ApiGrantUnavailable('invalid_grant');
  }
}
