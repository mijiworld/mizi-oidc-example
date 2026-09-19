import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore, type Session } from '../src/store.js';
import { DynamoStore } from '../src/dynamo-store.js';
import { API_REFRESH_LEASE_SECONDS, newSessionLifetime, SESSION_ABSOLUTE_SECONDS, SESSION_IDLE_SECONDS } from '../src/session-policy.js';
import { ApiGrantRefreshFailure, ApiGrantUnavailable, type ApiGrant } from '../src/api-grant.js';
import { ApiRefreshBusy, usableApiGrant } from '../src/renew-api-grant.js';
import type { OidcProvider } from '../src/oidc.js';

const now = Math.floor(Date.now() / 1000);
const day = 86400;
const session: Session = {
  ...newSessionLifetime(now, new Date(now * 1000).toISOString()), profile: { sub: 'synthetic-member' },
  verification: { issuer: 'https://issuer.example', audience: 'mzp_demo', sub: 'synthetic-member', algorithm: 'RS256',
    nonce: true, pkce: 'S256', state: true, issuerResponse: true, signature: true, userInfoSubject: true,
    authenticatedAt: new Date(now * 1000).toISOString(), checkedAt: new Date(now * 1000).toISOString() },
};
const oldGrant: ApiGrant = { accessToken: 'synthetic_access_old', refreshToken: 'synthetic_refresh_old',
  subject: session.profile.sub, issuer: session.verification.issuer, clientId: session.verification.audience,
  scope: 'openid profile user:profile', resources: ['https://issuer.example/v1/me', 'https://issuer.example/v1/me/profile'], expiresAt: now - 1 };
const newGrant: ApiGrant = { ...oldGrant, accessToken: 'synthetic_access_new', refreshToken: 'synthetic_refresh_new', expiresAt: now + 3600 };
const conditionFailed = () => Object.assign(new Error('conditional failure'), { name: 'ConditionalCheckFailedException' });
async function fixture() {
  const store = new MemoryStore();
  await store.putSession('session', session, oldGrant);
  return store;
}
function provider(refreshGrant: (grant: ApiGrant) => Promise<ApiGrant>): OidcProvider {
  return { authorizationUrl: vi.fn(), complete: vi.fn(), refreshGrant };
}

describe('bounded persistent login', () => {
  it('extends active use for 30 days but never past the original authentication + 90 days', async () => {
    const store = await fixture();
    for (const [visit, expected] of [[20, 50], [49, 79], [78, 90], [89, 90]]) {
      const value = await store.renewSession('session', now + visit! * day);
      expect(value?.expiresAt).toBe(now + expected! * day);
      expect(value?.absoluteExpiresAt).toBe(now + SESSION_ABSOLUTE_SECONDS);
      expect(value?.verification.authenticatedAt).toBe(session.verification.authenticatedAt);
    }
    expect(await store.renewSession('session', now + 90 * day)).toBeNull();
    expect(await store.getApiGrant('session', session.profile.sub, now + 90 * day)).toBeNull();
  });
  it('expires an unused session and never upgrades a legacy record merely by visiting', async () => {
    const store = await fixture();
    expect(await store.renewSession('session', now + SESSION_IDLE_SECONDS)).toBeNull();
    const { createdAt: _created, absoluteExpiresAt: _absolute, ...legacy } = session;
    await store.putSession('legacy', { ...legacy, expiresAt: now + 1800 });
    expect((await store.renewSession('legacy', now + 1700))?.expiresAt).toBe(now + 1800);
    expect(await store.renewSession('legacy', now + 1800)).toBeNull();
  });
  it('does not reset the absolute deadline when a recent SSO result has an old auth_time', () => {
    const result = newSessionLifetime(now, new Date((now - 89 * day) * 1000).toISOString());
    expect(result.expiresAt).toBe(now + day);
    expect(result.absoluteExpiresAt).toBe(now + day);
    expect(() => newSessionLifetime(now, new Date((now - 90 * day) * 1000).toISOString())).toThrow('Fresh authentication');
    expect(() => newSessionLifetime(now, 'invalid')).toThrow();
    expect(() => newSessionLifetime(now, new Date((now + 600) * 1000).toISOString())).toThrow();
  });
  it('uses conditional Dynamo renewal so a concurrent logout cannot recreate the item', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Item: session }).mockRejectedValueOnce(conditionFailed()).mockResolvedValueOnce({});
    const store = new DynamoStore('test-sessions', { send } as unknown as DynamoDBDocumentClient);
    expect(await store.renewSession('session', now + day)).toBeNull();
    const update = send.mock.calls[1]![0] as UpdateCommand;
    expect(update.input.ConditionExpression).toContain('attribute_exists(pk)');
    expect(update.input.ConditionExpression).toContain('expiresAt = :previous');
    expect(update.input.ConditionExpression).toContain('#absolute = :absolute');
    expect(update.input.ExpressionAttributeValues?.[':next']).toBe(now + 31 * day);
    expect(update.input.ReturnValues).toBeUndefined();
  });
  it('does not read private credentials while renewing a browser session', async () => {
    const store = await fixture();
    const publicSession = await store.renewSession('session', now + 60);
    expect(publicSession?.apiAccess?.renewable).toBe(true);
    expect(JSON.stringify(publicSession)).not.toContain('synthetic_refresh');
    expect(JSON.stringify(publicSession)).not.toContain('synthetic_access');
    expect(publicSession).not.toHaveProperty('apiRefresh');
  });
});

describe('serialized server refresh and cancellation', () => {
  it('lets only one worker exchange the token and atomically stores the new rotating pair', async () => {
    const store = await fixture();
    let complete!: (value: ApiGrant) => void;
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    const refresh = vi.fn(() => { started(); return new Promise<ApiGrant>((resolve) => { complete = resolve; }); });
    const oidc = provider(refresh);
    const first = usableApiGrant(store, oidc, 'session', session, () => now);
    await hasStarted;
    await expect(usableApiGrant(store, oidc, 'session', session, () => now)).rejects.toBeInstanceOf(ApiRefreshBusy);
    complete(newGrant);
    expect(await first).toEqual(newGrant);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await store.getApiGrant('session', session.profile.sub, now)).toEqual(newGrant);
    expect((await store.getSession('session', now))?.absoluteExpiresAt).toBe(session.absoluteExpiresAt);
  });
  it('uses an unexpired token directly and preserves access-only legacy grants', async () => {
    const store = await fixture();
    await store.putSession('valid', session, { ...newGrant, refreshToken: undefined });
    const refresh = vi.fn(async () => newGrant);
    expect((await usableApiGrant(store, provider(refresh), 'valid', session, () => now)).accessToken).toBe(newGrant.accessToken);
    expect(refresh).not.toHaveBeenCalled();
  });
  it.each(['invalid_grant', 'invalid_response', 'ambiguous'] as const)('discards a %s result without retrying the old rotating token', async (reason) => {
    const store = await fixture();
    const refresh = vi.fn(async () => { throw new ApiGrantRefreshFailure(reason); });
    await expect(usableApiGrant(store, provider(refresh), 'session', session, () => now)).rejects.toBeInstanceOf(ApiGrantUnavailable);
    expect(await store.getApiGrant('session', session.profile.sub, now)).toBeNull();
    expect(await store.getSession('session', now)).toMatchObject({ profile: session.profile });
    await expect(usableApiGrant(store, provider(refresh), 'session', session, () => now)).rejects.toBeInstanceOf(ApiGrantUnavailable);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('retains credentials on a failure known to have happened before exchange', async () => {
    const store = await fixture();
    const refresh = vi.fn(async () => { throw new ApiGrantRefreshFailure('unavailable'); });
    await expect(usableApiGrant(store, provider(refresh), 'session', session, () => now)).rejects.toBeInstanceOf(ApiRefreshBusy);
    expect(await store.getApiGrant('session', session.profile.sub, now)).toEqual(oldGrant);
    expect(await store.beginApiRefresh('session', session.profile.sub, oldGrant.accessToken, 'next-worker', now)).toBe('acquired');
  });
  it('invalidates an abandoned lease instead of reusing a possibly consumed refresh token', async () => {
    const store = await fixture();
    expect(await store.beginApiRefresh('session', session.profile.sub, oldGrant.accessToken, 'crashed', now)).toBe('acquired');
    expect(await store.beginApiRefresh('session', session.profile.sub, oldGrant.accessToken, 'other', now + 10)).toBe('busy');
    expect(await store.beginApiRefresh('session', session.profile.sub, oldGrant.accessToken, 'later', now + API_REFRESH_LEASE_SECONDS)).toBe('stale');
    expect(await store.getApiGrant('session', session.profile.sub, now + API_REFRESH_LEASE_SECONDS)).toBeNull();
    expect(await store.finishApiRefresh('session', session.profile.sub, oldGrant.accessToken, 'crashed', newGrant, now + API_REFRESH_LEASE_SECONDS)).toBe(false);
  });
  it('lets logout and connection removal win over a successful in-flight token response', async () => {
    for (const remove of ['logout', 'connection']) {
      const store = await fixture();
      const refresh = vi.fn(async () => {
        if (remove === 'logout') await store.deleteSession('session');
        else await store.clearApiGrant('session', session.profile.sub, now);
        return newGrant;
      });
      await expect(usableApiGrant(store, provider(refresh), 'session', session, () => now)).rejects.toBeInstanceOf(ApiRefreshBusy);
      expect(await store.getApiGrant('session', session.profile.sub, now)).toBeNull();
      expect(await store.getSession('session', now)).toEqual(remove === 'logout' ? null : session);
    }
  });
  it('does not let a stale owner or stale API denial overwrite/remove a newer grant', async () => {
    const store = await fixture();
    await store.beginApiRefresh('session', session.profile.sub, oldGrant.accessToken, 'worker', now);
    expect(await store.finishApiRefresh('session', session.profile.sub, oldGrant.accessToken, 'wrong', newGrant, now)).toBe(false);
    expect(await store.finishApiRefresh('session', session.profile.sub, oldGrant.accessToken, 'worker', newGrant, now)).toBe(true);
    await store.abortApiRefresh('session', session.profile.sub, oldGrant.accessToken, 'worker', true, now);
    await store.clearApiGrant('session', session.profile.sub, now, oldGrant.accessToken);
    expect(await store.getApiGrant('session', session.profile.sub, now)).toEqual(newGrant);
  });
  it('requires the Dynamo lease owner, live session and previous token when committing a refresh', async () => {
    const send = vi.fn().mockResolvedValueOnce({ Item: session }).mockRejectedValueOnce(conditionFailed());
    const store = new DynamoStore('test-sessions', { send } as unknown as DynamoDBDocumentClient);
    expect(await store.finishApiRefresh('session', session.profile.sub, oldGrant.accessToken, 'worker', newGrant, now)).toBe(false);
    const command = send.mock.calls[1]![0] as UpdateCommand;
    expect(command.input.ConditionExpression).toContain('attribute_exists(pk) AND expiresAt > :now');
    expect(command.input.ConditionExpression).toContain('#grant.#token = :token');
    expect(command.input.ConditionExpression).toContain('#refresh.#owner = :owner');
    expect(command.input.ConditionExpression).toContain('#refresh.#started > :stale');
    const publicAccess = command.input.ExpressionAttributeValues?.[':access'];
    expect(publicAccess).toMatchObject({ renewable: true });
    expect(JSON.stringify(publicAccess)).not.toContain('synthetic_');
  });
});
