import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { loadConfig } from '../src/config.js';
import { MiziOidcProvider } from '../src/oidc.js';
import { digest, type Attempt } from '../src/store.js';
import { apiGrantSchema, type ApiGrant } from '../src/api-grant.js';
import { SESSION_ABSOLUTE_SECONDS } from '../src/session-policy.js';

const issuer = 'https://issuer.example';
const clientId = 'https://demo.example/client.json';
const settings = loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://demo.example', OIDC_ISSUER: issuer, CLIENT_ID: clientId });
const attempt: Attempt = {
  state: 's'.repeat(43), nonce: 'n'.repeat(43), codeVerifier: 'v'.repeat(43),
  bindingHash: digest('b'.repeat(43)), expiresAt: Math.floor(Date.now() / 1000) + 600,
};
const access = 'access-token-server-private-only';
const refresh = 'refresh-token-server-private-only';
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let wrongKeys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  [keys, wrongKeys] = await Promise.all([generateKeyPair('RS256'), generateKeyPair('RS256')]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function callback(query: Record<string, string | undefined> = {}) {
  const result = new URL(settings.callbackUrl);
  result.search = new URLSearchParams({ code: 'single-use-code', state: attempt.state, iss: issuer }).toString();
  for (const [key, value] of Object.entries(query)) if (value !== undefined) result.searchParams.set(key, value);
  return result;
}

async function fixture(options: {
  claims?: JWTPayload; wrongSignature?: boolean; omitIdToken?: boolean; profileSub?: string; algorithm?: 'HS256';
  discoveryIssuer?: string; tokenFailure?: boolean; tokenEndpoint?: string;
  tokenScope?: string | null; memberProfile?: unknown; memberStatus?: number; memberUnavailable?: boolean;
  detailsProfile?: unknown; skillsBody?: unknown;
  expiresIn?: number | null; userInfoElapsed?: number;
  laterSkillsStatus?: 401 | 403;
  refreshToken?: string | null;
} = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const jwk = await exportJWK(keys.publicKey);
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({
      issuer: options.discoveryIssuer ?? issuer,
      authorization_endpoint: `${issuer}/authorize`, token_endpoint: options.tokenEndpoint ?? `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/jwks`,
      authorization_response_iss_parameter_supported: true, response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'], id_token_signing_alg_values_supported: ['RS256'],
      subject_types_supported: ['public'], token_endpoint_auth_methods_supported: ['none'],
    });
    if (url === `${issuer}/jwks`) return Response.json({ keys: [{ ...jwk, kid: 'test-rsa', alg: 'RS256', use: 'sig' }] });
    if (url === `${issuer}/token`) {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('client_id')).toBe(clientId);
      expect(form.get('code_verifier')).toBe(attempt.codeVerifier);
      expect(form.get('redirect_uri')).toBe(settings.callbackUrl);
      expect(form.has('client_secret')).toBe(false);
      if (options.tokenFailure) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        iss: issuer, sub: 'usr_verified', aud: clientId, iat: now, exp: now + 300,
        nonce: attempt.nonce, auth_time: now - 20,
        at_hash: createHash('sha256').update(access).digest().subarray(0, 16).toString('base64url'),
        ...options.claims,
      };
      const idToken = await new SignJWT(payload).setProtectedHeader({ alg: options.algorithm ?? 'RS256', kid: 'test-rsa' })
        .sign(options.algorithm === 'HS256' ? randomBytes(32) : (options.wrongSignature ? wrongKeys : keys).privateKey);
      return Response.json({ access_token: access,
        ...(options.refreshToken === null ? {} : { refresh_token: options.refreshToken ?? refresh }), token_type: 'Bearer',
        ...(options.expiresIn === null ? {} : { expires_in: options.expiresIn ?? 3600 }),
        ...(options.tokenScope === null ? {} : { scope: options.tokenScope ?? 'openid profile' }),
        ...(options.omitIdToken ? {} : { id_token: idToken }) });
    }
    if (url === `${issuer}/userinfo`) {
      if (options.userInfoElapsed) vi.setSystemTime(Date.now() + options.userInfoElapsed);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${access}`);
      return Response.json({ sub: options.profileSub ?? 'usr_verified', nickname: '검증한 회원', email: 'not-stored@example.test' });
    }
    if (url === `${issuer}/v1/me`) {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${access}`);
      if (options.memberUnavailable) throw new Error(`do not expose ${access}`);
      return Response.json(options.memberProfile ?? { id: 'usr_verified', nickname: 'API 회원', github_connected: true, email: 'api-private@example.test' },
        { status: options.memberStatus ?? 200 });
    }
    if (url === `${issuer}/v1/me/profile`) return Response.json(options.detailsProfile ?? {
      user: { id: 'usr_verified', role: '개발자' }, bio: '작은 도구를 만들어요.', interests: ['웹'], partial: false,
      location: 'not-retained-location', contact_method: 'not-retained-contact',
    });
    if (url === `${issuer}/v1/me/profile/bio`) {
      expect(init?.method).toBe('PATCH');
      const body = JSON.parse(String(init?.body)) as { bio: string };
      return Response.json({ user: { id: 'usr_verified' }, bio: body.bio });
    }
    if (url.startsWith(`${issuer}/v1/me/skills?limit=20&cursor=`) && options.laterSkillsStatus) {
      return Response.json({ error: 'not-retained-response' }, { status: options.laterSkillsStatus });
    }
    if (url === `${issuer}/v1/me/skills?limit=20`) return Response.json(options.skillsBody ?? {
      items: [{ id: 'skill_1', name: 'TypeScript', source: 'github_analysis', visible: true,
        verification_method: 'github_analysis', verified_by: 'MiZi', verified_at: '2026-09-19T00:00:00.000Z',
        visibility: { profile: true, skills: true } }], next_cursor: null,
    });
    throw new Error('Unexpected test request.');
  });
  return { provider: new MiziOidcProvider(settings, fetcher), calls };
}

describe('real OIDC library and independent RS256 verification', () => {
  it('discovers metadata and builds only openid/profile code + S256 with fresh binding values', async () => {
    const f = await fixture();
    const auth = new URL(await f.provider.authorizationUrl(attempt));
    expect(auth.origin).toBe(issuer);
    expect(Object.fromEntries(auth.searchParams)).toMatchObject({
      client_id: clientId, redirect_uri: settings.callbackUrl, response_type: 'code',
      scope: 'openid profile', nonce: attempt.nonce, state: attempt.state,
      code_challenge_method: 'S256',
      max_age: String(SESSION_ABSOLUTE_SECONDS),
      code_challenge: createHash('sha256').update(attempt.codeVerifier).digest('base64url'),
    });
    expect(auth.searchParams.has('client_secret')).toBe(false);
    expect(auth.searchParams.has('resource')).toBe(false);
  });

  it('verifies all bindings and UserInfo before returning only profile and verification data', async () => {
    const f = await fixture();
    const result = await f.provider.complete(callback(), attempt);
    expect(result.profile).toEqual({ sub: 'usr_verified', nickname: '검증한 회원' });
    expect(result).not.toHaveProperty('memberApi');
    const tokenCall = f.calls.find((call) => call.url === `${issuer}/token`)!;
    expect(new URLSearchParams(String(tokenCall.init?.body)).has('resource')).toBe(false);
    expect(result.verification).toMatchObject({ issuer, audience: clientId, sub: 'usr_verified',
      signature: true, algorithm: 'RS256', nonce: true, pkce: 'S256', state: true,
      issuerResponse: true, userInfoSubject: true });
    const { apiGrant, ...identity } = result;
    expect(apiGrant).toBeUndefined();
    const serialized = JSON.stringify(identity);
    for (const sensitive of [access, refresh, 'single-use-code', 'not-stored@example.test', 'id_token']) {
      expect(serialized).not.toContain(sensitive);
    }
    expect(f.calls.map((call) => call.url)).toEqual([
      `${issuer}/.well-known/openid-configuration`, `${issuer}/token`, `${issuer}/jwks`, `${issuer}/userinfo`,
    ]);
    for (const call of f.calls) {
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
      expect(call.init?.redirect).toBe('error');
    }
  });


  it('requests member scope/resource only for an explicit API attempt, and calls /me after identity validation', async () => {
    const apiAttempt: Attempt = { ...attempt, readMemberApi: true };
    const f = await fixture({ tokenScope: 'openid profile user:profile' });
    const auth = new URL(await f.provider.authorizationUrl(apiAttempt));
    expect(auth.searchParams.get('scope')).toBe('openid profile user:profile');
    expect(auth.searchParams.get('resource')).toBe(`${issuer}/v1/me`);
    const result = await f.provider.complete(callback(), apiAttempt);
    expect(result.profile.sub).toBe('usr_verified');
    expect(result.memberApi).toMatchObject({ status: 'success',
      profile: { id: 'usr_verified', nickname: 'API 회원', githubConnected: true } });
    expect(f.calls.map((call) => call.url)).toEqual([
      `${issuer}/.well-known/openid-configuration`, `${issuer}/token`, `${issuer}/jwks`, `${issuer}/userinfo`, `${issuer}/v1/me`,
    ]);
    const tokenCall = f.calls.find((call) => call.url === `${issuer}/token`)!;
    expect(new URLSearchParams(String(tokenCall.init?.body)).getAll('resource')).toEqual([`${issuer}/v1/me`]);
    const { apiGrant, ...identity } = result;
    expect(apiGrant).toMatchObject({ accessToken: access, refreshToken: refresh, subject: 'usr_verified', scope: 'openid profile user:profile',
      resources: [`${issuer}/v1/me`] });
    const serialized = JSON.stringify(identity);
    for (const sensitive of [access, refresh, 'api-private@example.test', 'id_token', 'access_token', 'refresh_token']) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it.each([
    ['scope_missing', { tokenScope: 'openid profile' }],
    ['scope_missing', { tokenScope: null }],
    ['unauthorized', { memberStatus: 401 }],
    ['forbidden', { memberStatus: 403 }],
    ['invalid_response', { memberProfile: { id: 'usr_verified' } }],
    ['unavailable', { memberUnavailable: true }],
  ] as const)('keeps the verified OIDC identity but reports optional API error %s', async (reason, options) => {
    const f = await fixture({ tokenScope: 'openid profile user:profile', ...options });
    const result = await f.provider.complete(callback(), { ...attempt, readMemberApi: true });
    expect(result.profile.sub).toBe('usr_verified');
    expect(result.verification.signature).toBe(true);
    expect(result.memberApi).toMatchObject({ status: 'error', reason });
    expect(result.memberApi).not.toHaveProperty('profile');
    if (reason === 'scope_missing') expect(f.calls.some((call) => call.url.endsWith('/v1/me'))).toBe(false);
    const { apiGrant, ...identity } = result;
    if (['scope_missing', 'unauthorized', 'forbidden'].includes(reason)) expect(apiGrant).toBeUndefined();
    expect(JSON.stringify(identity)).not.toContain(access);
  });

  it('uses all requested API resources at both OAuth boundaries and returns minimal per-API snapshots', async () => {
    const f = await fixture({ tokenScope: 'openid profile user:profile user:skills' });
    const requested = { ...attempt, readMemberApi: true, readProfileDetails: true, readSkillsApi: true };
    const resources = [`${issuer}/v1/me`, `${issuer}/v1/me/profile`, `${issuer}/v1/me/skills`];
    const auth = new URL(await f.provider.authorizationUrl(requested));
    expect(auth.searchParams.get('scope')).toBe('openid profile user:profile user:skills');
    expect(auth.searchParams.getAll('resource')).toEqual(resources);
    const result = await f.provider.complete(callback(), requested);
    const tokenCall = f.calls.find((call) => call.url === `${issuer}/token`)!;
    expect(new URLSearchParams(String(tokenCall.init?.body)).getAll('resource')).toEqual(resources);
    expect(result.profileDetails).toMatchObject({ status: 'success', subject: 'usr_verified',
      profile: { role: '개발자', bio: '작은 도구를 만들어요.', interests: ['웹'] } });
    expect(result.skillsApi).toMatchObject({ status: 'success', subject: 'usr_verified',
      items: [{ name: 'TypeScript', source: 'github_analysis', verifiedBy: 'MiZi' }] });
    const { apiGrant, ...identity } = result;
    expect(apiGrant?.resources).toEqual(resources);
    const serialized = JSON.stringify(identity);
    for (const sensitive of [access, refresh, 'not-retained-contact', 'not-retained-location']) expect(serialized).not.toContain(sensitive);
  });

  it('keeps profile details when skills permission is declined, without calling the skills API', async () => {
    const f = await fixture({ tokenScope: 'openid profile user:profile' });
    const result = await f.provider.complete(callback(), {
      ...attempt, readMemberApi: true, readProfileDetails: true, readSkillsApi: true,
    });
    expect(result.profileDetails?.status).toBe('success');
    expect(result.skillsApi).toMatchObject({ status: 'error', reason: 'scope_missing' });
    expect(f.calls.some((call) => call.url.includes('/me/skills'))).toBe(false);
    expect(result.apiGrant?.scope).toBe('openid profile user:profile');
  });

  it('requests and retains bio write authority only after an explicit write-consent attempt', async () => {
    const scope = 'openid profile user:profile user:skills user:profile:write';
    const f = await fixture({ tokenScope: scope });
    const requested: Attempt = { ...attempt, readMemberApi: true, readProfileDetails: true,
      readSkillsApi: true, writeProfileBio: true };
    const resources = [`${issuer}/v1/me`, `${issuer}/v1/me/profile`, `${issuer}/v1/me/skills`, `${issuer}/v1/me/profile/bio`];
    const auth = new URL(await f.provider.authorizationUrl(requested));
    expect(auth.searchParams.get('scope')).toBe(scope);
    expect(auth.searchParams.getAll('resource')).toEqual(resources);
    const identity = await f.provider.complete(callback(), requested);
    expect(identity.apiGrant?.scope).toBe(scope);
    expect(identity.apiGrant?.resources).toEqual(resources);
    const tokenCall = f.calls.find((call) => call.url === `${issuer}/token`)!;
    expect(new URLSearchParams(String(tokenCall.init?.body)).getAll('resource')).toEqual(resources);
    expect(f.calls.some((call) => call.init?.method === 'PATCH')).toBe(false);
    const normalAuth = new URL(await f.provider.authorizationUrl({ ...attempt, readMemberApi: true, readProfileDetails: true }));
    expect(normalAuth.searchParams.get('scope')).toBe('openid profile user:profile');
    expect(normalAuth.searchParams.getAll('resource')).not.toContain(`${issuer}/v1/me/profile/bio`);
  });

  it('does not retain unsolicited write scope on an ordinary API connection', async () => {
    const f = await fixture({ tokenScope: 'openid profile user:profile user:profile:write' });
    const identity = await f.provider.complete(callback(), { ...attempt, readMemberApi: true, readProfileDetails: true });
    expect(identity.apiGrant).toBeUndefined();
    expect(identity.verification.signature).toBe(true);
    expect(f.calls.some((call) => call.init?.method === 'PATCH')).toBe(false);
  });

  it('uses explicit write authority only when the caller invokes writeProfileBio', async () => {
    const scope = 'openid profile user:profile user:profile:write';
    const f = await fixture({ tokenScope: scope,
      detailsProfile: { user: { id: 'usr_verified' }, bio: '새 소개', interests: [], partial: false } });
    const identity = await f.provider.complete(callback(), {
      ...attempt, readMemberApi: true, readProfileDetails: true, writeProfileBio: true,
    });
    f.calls.length = 0;
    expect((await f.provider.readApis(identity.apiGrant!, 'profile')).profileDetails?.status).toBe('success');
    expect(f.calls.some((call) => call.init?.method === 'PATCH')).toBe(false);
    f.calls.length = 0;
    expect(await f.provider.writeProfileBio(identity.apiGrant!, '새 소개')).toMatchObject({ status: 'saved_verified', bio: '새 소개' });
    expect(f.calls.map((call) => [call.url, call.init?.method])).toEqual([
      [`${issuer}/v1/me/profile/bio`, 'PATCH'], [`${issuer}/v1/me/profile`, 'GET'],
    ]);
  });

  it.each([[401, 'unauthorized'], [403, 'forbidden']] as const)('keeps initial verified skills but does not retain a grant denied on a later page (%s)', async (laterSkillsStatus, authorizationFailure) => {
    const f = await fixture({ tokenScope: 'openid profile user:profile user:skills', laterSkillsStatus,
      skillsBody: { items: [{ id: 'skl_first', name: 'TypeScript', source: 'github_analysis' }], next_cursor: 'private-cursor' } });
    const result = await f.provider.complete(callback(), { ...attempt, readMemberApi: true, readProfileDetails: true, readSkillsApi: true });
    expect(result.apiGrant).toBeUndefined();
    expect(result.skillsApi).toMatchObject({ status: 'success', items: [{ id: 'skl_first' }],
      collection: { pages: 1, stoppedReason: 'upstream_error', authorizationFailure } });
    expect(result.verification.signature).toBe(true);
    expect(JSON.stringify(result)).not.toContain(access);
    expect(JSON.stringify(result)).not.toContain('private-cursor');
  });

  it.each([[3600, 3600], [7200, 3600], [45, 45]] as const)('bounds a private API grant from expires_in=%s to %s seconds after token receipt', async (expiresIn, expected) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const receivedAt = Math.floor(Date.now() / 1000);
    const f = await fixture({ tokenScope: 'openid profile user:profile', expiresIn, userInfoElapsed: 10000 });
    const result = await f.provider.complete(callback(), { ...attempt, readMemberApi: true, readProfileDetails: true });
    expect(result.apiGrant?.expiresAt).toBe(receivedAt + expected);
    expect(apiGrantSchema.safeParse(result.apiGrant).success).toBe(true);
    expect(Object.keys(result.apiGrant!).sort()).toEqual(['accessToken', 'clientId', 'expiresAt', 'issuer', 'refreshToken', 'resources', 'scope', 'subject']);
    const { apiGrant, ...identity } = result;
    expect(apiGrant?.refreshToken).toBe(refresh);
    expect(JSON.stringify(identity)).not.toContain(refresh);
    expect(JSON.stringify(result)).not.toContain('id_token');
  });

  it('preserves access-only legacy responses without inventing a refresh credential', async () => {
    const f = await fixture({ tokenScope: 'openid profile user:profile', refreshToken: null });
    const result = await f.provider.complete(callback(), { ...attempt, readMemberApi: true });
    expect(result.apiGrant?.accessToken).toBe(access);
    expect(result.apiGrant).not.toHaveProperty('refreshToken');
  });

  it('does not retain credentials for API scopes the user did not request', async () => {
    const f = await fixture({ tokenScope: 'openid profile user:profile user:skills' });
    const result = await f.provider.complete(callback(), { ...attempt, readMemberApi: true });
    expect(result.verification.signature).toBe(true);
    expect(result.apiGrant).toBeUndefined();
  });

  it.each([null, 0])('does not retain credentials without a positive explicit expiry (%s)', async (expiresIn) => {
    const f = await fixture({ tokenScope: 'openid profile user:profile', expiresIn });
    const result = await f.provider.complete(callback(), { ...attempt, readMemberApi: true });
    expect(result.apiGrant).toBeUndefined();
    expect(result.verification.signature).toBe(true);
  });

  it('does not retain a grant already expired during verification or unsolicited API permissions', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const expired = await fixture({ tokenScope: 'openid profile user:profile', expiresIn: 1, userInfoElapsed: 2000 });
    expect((await expired.provider.complete(callback(), { ...attempt, readMemberApi: true })).apiGrant).toBeUndefined();
    const unsolicited = await fixture({ tokenScope: 'openid profile user:profile user:skills' });
    expect((await unsolicited.provider.complete(callback(), attempt)).apiGrant).toBeUndefined();
  });

  it('reuses the server-private grant without discovery, token exchange, UserInfo or another authorization request', async () => {
    const f = await fixture({ tokenScope: 'openid profile user:profile user:skills' });
    const signedIn = await f.provider.complete(callback(), {
      ...attempt, readMemberApi: true, readProfileDetails: true, readSkillsApi: true,
    });
    f.calls.length = 0;
    const updated = await f.provider.readApis(signedIn.apiGrant!, 'profile');
    expect(f.calls.map((call) => call.url).sort()).toEqual([`${issuer}/v1/me`, `${issuer}/v1/me/profile`]);
    expect(updated.memberApi?.status).toBe('success');
    expect(updated.profileDetails?.status).toBe('success');
    expect(updated.skillsApi).toBeUndefined();
    expect(JSON.stringify(updated)).not.toContain(access);
    f.calls.length = 0;
    expect((await f.provider.readApis(signedIn.apiGrant!, 'skills')).skillsApi?.status).toBe('success');
    expect(f.calls.map((call) => call.url)).toEqual([`${issuer}/v1/me/skills?limit=20`]);
  });

  it('rejects a profile-details identity mismatch even when the basic member response matches', async () => {
    const f = await fixture({ tokenScope: 'openid profile user:profile',
      detailsProfile: { user: { id: 'another-user', role: null }, bio: null, interests: [], partial: false } });
    await expect(f.provider.complete(callback(), { ...attempt, readMemberApi: true, readProfileDetails: true }))
      .rejects.toMatchObject({ name: 'LoginFailure', stage: 'member_api' });
  });

  it('fails the entire new login when the member API returns a different verified subject', async () => {
    const f = await fixture({ tokenScope: 'openid profile user:profile',
      memberProfile: { id: 'usr_other', nickname: '다른 회원', github_connected: false } });
    await expect(f.provider.complete(callback(), { ...attempt, readMemberApi: true }))
      .rejects.toMatchObject({ name: 'LoginFailure', stage: 'member_api' });
  });

  it('never calls the optional API if ID token or UserInfo verification fails', async () => {
    for (const options of [{ wrongSignature: true }, { profileSub: 'usr_other' }]) {
      const f = await fixture({ tokenScope: 'openid profile user:profile', ...options });
      await expect(f.provider.complete(callback(), { ...attempt, readMemberApi: true, readProfileDetails: true, readSkillsApi: true })).rejects.toThrow();
      expect(f.calls.some((call) => call.url.endsWith('/v1/me'))).toBe(false);
      expect(f.calls.some((call) => call.url.includes('/v1/me/'))).toBe(false);
    }
  });

  it.each([
    ['wrong signature', { wrongSignature: true }],
    ['unexpected signing algorithm', { algorithm: 'HS256' }],
    ['missing nonce', { claims: { nonce: undefined } }],
    ['missing access token hash', { claims: { at_hash: undefined } }],
    ['wrong issuer', { claims: { iss: 'https://attacker.example' } }],
    ['wrong audience', { claims: { aud: 'different-client' } }],
    ['additional untrusted audience', { claims: { aud: [clientId, 'different-client'], azp: clientId } }],
    ['wrong nonce', { claims: { nonce: 'different-nonce' } }],
    ['expired ID token', { claims: { exp: 1 } }],
    ['future authentication time', { claims: { auth_time: 9000000000 } }],
    ['authentication older than the absolute session age', { claims: { auth_time: 1 } }],
    ['wrong access token hash', { claims: { at_hash: 'wrong-hash' } }],
    ['missing ID token', { omitIdToken: true }],
    ['failed token exchange', { tokenFailure: true }],
  ] as const)('rejects %s before requesting UserInfo', async (_name, options) => {
    const f = await fixture(options as Parameters<typeof fixture>[0]);
    await expect(f.provider.complete(callback(), attempt)).rejects.toThrow();
    expect(f.calls.some((call) => call.url.endsWith('/userinfo'))).toBe(false);
  });

  it('rejects a UserInfo identity belonging to a different subject', async () => {
    const f = await fixture({ profileSub: 'usr_other' });
    await expect(f.provider.complete(callback(), attempt)).rejects.toThrow();
  });

  it.each([{ state: 'wrong' }, { iss: 'https://attacker.example' }, { error: 'access_denied' }])(
    'rejects invalid callback %j before any outbound request', async (query) => {
      const f = await fixture();
      await expect(f.provider.complete(callback(query), attempt)).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    },
  );
  it('rejects duplicate authorization parameters and a different callback origin', async () => {
    const f = await fixture();
    const duplicated = callback();
    duplicated.searchParams.append('code', 'other-code');
    await expect(f.provider.complete(duplicated, attempt)).rejects.toThrow();
    const foreign = callback();
    foreign.hostname = 'attacker.example';
    await expect(f.provider.complete(foreign, attempt)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    { discoveryIssuer: 'https://attacker.example' },
    { tokenEndpoint: 'https://attacker.example/token' },
  ])('rejects metadata from an unexpected issuer/endpoint %j', async (options) => {
    const f = await fixture(options);
    await expect(f.provider.authorizationUrl(attempt)).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });
});

const renewalResources = [`${issuer}/v1/me`, `${issuer}/v1/me/profile`, `${issuer}/v1/me/skills`];
const storedGrant = (): ApiGrant => ({
  accessToken: access, refreshToken: refresh, scope: 'openid profile user:profile user:skills',
  subject: 'usr_verified', issuer, clientId, resources: [...renewalResources],
  expiresAt: Math.floor(Date.now() / 1000) - 1,
});

function renewalFixture(options: {
  tokenStatus?: number; tokenBody?: Record<string, unknown>; tokenUnavailable?: boolean;
  userInfoStatus?: number; userInfoSubject?: string; userInfoUnavailable?: boolean;
  discoveryFailure?: boolean; discoveryEndpoint?: string;
  tokenResponse?: () => Response; userInfoResponse?: () => Response;
  expectedResources?: string[];
} = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === `${issuer}/.well-known/openid-configuration`) {
      if (options.discoveryFailure) throw new Error(`private upstream detail ${refresh}`);
      return Response.json({ issuer,
        authorization_endpoint: `${issuer}/authorize`, token_endpoint: options.discoveryEndpoint ?? `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/jwks`,
        authorization_response_iss_parameter_supported: true, response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'], id_token_signing_alg_values_supported: ['RS256'],
        subject_types_supported: ['public'], token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url === `${issuer}/token`) {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('client_id')).toBe(clientId); // CIMD public client has no secret.
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('refresh_token')).toBe(refresh);
      expect(form.getAll('resource')).toEqual(options.expectedResources ?? renewalResources);
      for (const field of ['client_secret', 'code', 'code_verifier', 'redirect_uri']) expect(form.has(field)).toBe(false);
      if (options.tokenUnavailable) throw new Error(`private upstream detail ${refresh}`);
      if (options.tokenResponse) return options.tokenResponse();
      return Response.json(options.tokenBody ?? {
        access_token: 'renewed-private-access', refresh_token: 'renewed-private-refresh', token_type: 'Bearer',
        expires_in: 3600, scope: 'openid profile user:profile user:skills',
      }, { status: options.tokenStatus ?? 200 });
    }
    if (url === `${issuer}/userinfo`) {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer renewed-private-access');
      if (options.userInfoUnavailable) throw new Error('private UserInfo failure renewed-private-refresh');
      if (options.userInfoResponse) return options.userInfoResponse();
      return Response.json({ sub: options.userInfoSubject ?? 'usr_verified', nickname: 'Do not persist a new identity here' },
        { status: options.userInfoStatus ?? 200 });
    }
    throw new Error('Unexpected renewal request.');
  });
  return { provider: new MiziOidcProvider(settings, fetcher), calls };
}

describe('server-only refresh-token rotation', () => {
  it('preserves explicitly granted write scope and its fixed resource without performing a write', async () => {
    const resources = [...renewalResources, `${issuer}/v1/me/profile/bio`];
    const scope = 'openid profile user:profile user:skills user:profile:write';
    const f = renewalFixture({ expectedResources: resources, tokenBody: {
      access_token: 'renewed-private-access', refresh_token: 'renewed-private-refresh', token_type: 'Bearer', expires_in: 3600, scope,
    } });
    const renewed = await f.provider.refreshGrant({ ...storedGrant(), resources, scope });
    expect(renewed.resources).toEqual(resources);
    expect(renewed.scope).toBe(scope);
    expect(f.calls.some((call) => call.init?.method === 'PATCH')).toBe(false);
    const tokenCall = f.calls.find((call) => call.url.endsWith('/token'))!;
    expect(new URLSearchParams(String(tokenCall.init?.body)).get('scope')).toBe(scope);
  });

  it('rejects a refresh response that adds write scope to an existing read-only grant', async () => {
    const f = renewalFixture({ tokenBody: {
      access_token: 'renewed-private-access', refresh_token: 'renewed-private-refresh', token_type: 'Bearer', expires_in: 3600,
      scope: 'openid profile user:profile user:skills user:profile:write',
    } });
    await expect(f.provider.refreshGrant(storedGrant()))
      .rejects.toMatchObject({ name: 'ApiGrantRefreshFailure', reason: 'invalid_response' });
    expect(f.calls.some((call) => call.url.endsWith('/userinfo'))).toBe(false);
  });
  it('renews an expired access token via the pinned public-client endpoint and verifies its subject', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const previous = storedGrant();
    const before = structuredClone(previous);
    const receivedAt = Math.floor(Date.now() / 1000);
    const f = renewalFixture();
    const renewed = await f.provider.refreshGrant(previous);
    expect(renewed).toEqual({ ...before, accessToken: 'renewed-private-access', refreshToken: 'renewed-private-refresh',
      expiresAt: receivedAt + 3600 });
    expect(previous).toEqual(before);
    expect(f.calls.map((call) => call.url)).toEqual([
      `${issuer}/.well-known/openid-configuration`, `${issuer}/token`, `${issuer}/userinfo`,
    ]);
    const tokenCall = f.calls.find((call) => call.url.endsWith('/token'))!;
    expect(new URLSearchParams(String(tokenCall.init?.body)).get('scope')).toBe(before.scope);
    expect(renewed).not.toHaveProperty('idToken');
    expect(renewed).not.toHaveProperty('profile');
    expect(renewed).not.toHaveProperty('authenticatedAt');
    for (const call of f.calls) {
      expect(call.init?.redirect).toBe('error');
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it.each([45, 7200])('uses the actual token expiry with the one-hour cap (%s)', async (expiresIn) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const receivedAt = Math.floor(Date.now() / 1000);
    const f = renewalFixture({ tokenBody: { access_token: 'renewed-private-access', refresh_token: 'renewed-private-refresh',
      token_type: 'Bearer', expires_in: expiresIn, scope: 'openid profile user:profile' } });
    const renewed = await f.provider.refreshGrant(storedGrant());
    expect(renewed.expiresAt).toBe(receivedAt + Math.min(expiresIn, 3600));
    expect(renewed.scope).toBe('openid profile user:profile'); // Downscoping is allowed.
    expect(renewed.resources).toEqual(renewalResources);
  });

  it.each([
    { refreshToken: undefined }, { refreshToken: 'bad\r\ncredential' },
    { issuer: 'https://other.example' }, { clientId: 'another-client' },
    { resources: ['https://other.example/v1/me'] }, { resources: [`${issuer}/v1/me?redirect=elsewhere`] },
    { resources: [`${issuer}/userinfo`] }, { resources: [renewalResources[0], renewalResources[0]] },
    { scope: 'openid profile' }, { scope: 'user:profile' }, { scope: 'openid user:profile admin' },
  ])('rejects invalid stored binding before discovery or token use: %j', async (patch) => {
    const f = renewalFixture();
    await expect(f.provider.refreshGrant({ ...storedGrant(), ...patch } as ApiGrant))
      .rejects.toMatchObject({ name: 'ApiGrantRefreshFailure', reason: 'invalid_grant' });
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    ['invalid_grant', 400, { error: 'invalid_grant', error_description: refresh }, 'invalid_grant'],
    ['unauthenticated', 401, { error: 'invalid_client' }, 'invalid_grant'],
    ['forbidden', 403, { error: 'access_denied' }, 'invalid_grant'],
    ['rate limited', 429, { error: 'temporarily_unavailable' }, 'unavailable'],
    ['upstream failure', 503, { error: 'server_error' }, 'ambiguous'],
    ['invalid grant in failed HTTP response', 500, { error: 'invalid_grant' }, 'ambiguous'],
  ] as const)('classifies explicit %s without retaining raw errors or retrying', async (_name, tokenStatus, tokenBody, reason) => {
    const f = renewalFixture({ tokenStatus, tokenBody });
    const error = await f.provider.refreshGrant(storedGrant()).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: 'ApiGrantRefreshFailure', reason });
    expect(String(error)).not.toContain(refresh);
    expect(error).not.toHaveProperty('cause');
    expect(f.calls.filter((call) => call.url.endsWith('/token'))).toHaveLength(1);
    expect(f.calls.some((call) => call.url.endsWith('/userinfo'))).toBe(false);
  });

  it.each([
    { refresh_token: undefined }, { refresh_token: refresh }, { refresh_token: 'invalid\ncredential' },
    { access_token: 'invalid\ncredential' }, { expires_in: undefined }, { expires_in: 0 },
    { expires_in: -1 }, { expires_in: 0.5 }, { expires_in: Number.MAX_SAFE_INTEGER + 1 },
    { token_type: 'MAC' }, { scope: undefined }, { scope: 'openid profile user:profile admin' },
    { scope: 'openid profile' }, { scope: 'user:profile user:skills' }, { id_token: 'unexpected-private-id-token' },
  ])('rejects malformed or escalated successful responses before UserInfo: %j', async (patch) => {
    const f = renewalFixture({ tokenBody: {
      access_token: 'renewed-private-access', refresh_token: 'renewed-private-refresh', token_type: 'Bearer',
      expires_in: 3600, scope: 'openid profile user:profile user:skills', ...patch,
    } });
    await expect(f.provider.refreshGrant(storedGrant()))
      .rejects.toMatchObject({ name: 'ApiGrantRefreshFailure', reason: 'invalid_response' });
    expect(f.calls.some((call) => call.url.endsWith('/userinfo'))).toBe(false);
  });

  it.each([
    [{ discoveryFailure: true }, 'unavailable', 0],
    [{ discoveryEndpoint: 'https://attacker.example/token' }, 'unavailable', 0],
    [{ tokenUnavailable: true }, 'ambiguous', 1],
    [{ userInfoUnavailable: true }, 'ambiguous', 1],
    [{ userInfoStatus: 503 }, 'ambiguous', 1],
    [{ userInfoStatus: 401 }, 'invalid_grant', 1],
    [{ userInfoStatus: 403 }, 'invalid_grant', 1],
    [{ userInfoSubject: 'usr_other' }, 'invalid_response', 1],
  ] as const)('keeps a safe retry boundary for provider failures %j', async (options, reason, tokenCalls) => {
    const f = renewalFixture(options);
    const error = await f.provider.refreshGrant(storedGrant()).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: 'ApiGrantRefreshFailure', reason });
    for (const secret of [refresh, 'renewed-private-access', 'renewed-private-refresh']) expect(String(error)).not.toContain(secret);
    expect(f.calls.filter((call) => call.url.endsWith('/token'))).toHaveLength(tokenCalls);
  });

  it('does not allow a refresh response to add a known API permission omitted from the stored grant', async () => {
    const f = renewalFixture();
    await expect(f.provider.refreshGrant({ ...storedGrant(), scope: 'openid profile user:profile' }))
      .rejects.toMatchObject({ name: 'ApiGrantRefreshFailure', reason: 'invalid_response' });
    expect(f.calls.some((call) => call.url.endsWith('/userinfo'))).toBe(false);
  });

  it.each(['token', 'userinfo'] as const)('bounds a stalled %s response body and treats rotation as ambiguous', async (phase) => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let started!: () => void;
    const responseStarted = new Promise<void>((resolve) => { started = resolve; });
    const response = () => new Response(new ReadableStream({ start() { started(); } }),
      { headers: { 'Content-Type': 'application/json' } });
    const f = renewalFixture(phase === 'token' ? { tokenResponse: response } : { userInfoResponse: response });
    const pending = f.provider.refreshGrant(storedGrant());
    await responseStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'ApiGrantRefreshFailure', reason: 'ambiguous' });
    expect(f.calls.filter((call) => call.url.endsWith('/token'))).toHaveLength(1);
  });
});
