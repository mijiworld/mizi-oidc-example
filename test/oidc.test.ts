import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { loadConfig } from '../src/config.js';
import { MiziOidcProvider } from '../src/oidc.js';
import { digest, type Attempt } from '../src/store.js';

const issuer = 'https://issuer.example';
const clientId = 'https://demo.example/client.json';
const settings = loadConfig({ NODE_ENV: 'test', BASE_URL: 'https://demo.example', OIDC_ISSUER: issuer, CLIENT_ID: clientId });
const attempt: Attempt = {
  state: 's'.repeat(43), nonce: 'n'.repeat(43), codeVerifier: 'v'.repeat(43),
  bindingHash: digest('b'.repeat(43)), expiresAt: Math.floor(Date.now() / 1000) + 600,
};
const access = 'access-token-must-never-be-stored';
const refresh = 'refresh-token-must-never-be-stored';
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let wrongKeys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  [keys, wrongKeys] = await Promise.all([generateKeyPair('RS256'), generateKeyPair('RS256')]);
});

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
      return Response.json({ access_token: access, refresh_token: refresh, token_type: 'Bearer',
        expires_in: 3600, ...(options.tokenScope === null ? {} : { scope: options.tokenScope ?? 'openid profile' }),
        ...(options.omitIdToken ? {} : { id_token: idToken }) });
    }
    if (url === `${issuer}/userinfo`) {
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
    const serialized = JSON.stringify(result);
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
    const serialized = JSON.stringify(result);
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
    expect(JSON.stringify(result)).not.toContain(access);
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
    const serialized = JSON.stringify(result);
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
