import { randomBytes } from 'node:crypto';
import { handle, type LambdaEvent } from 'hono/aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryStore, SESSION_TTL_SECONDS, type Attempt } from '../src/store.js';
import type { Identity } from '../src/view-model.js';

const base = 'https://demo.example';
const issuer = 'https://issuer.example';
const config = loadConfig({ NODE_ENV: 'test', BASE_URL: base, OIDC_ISSUER: issuer });
const identity: Identity = {
  profile: { sub: 'usr_verified', nickname: '테스트 회원' },
  verification: { issuer, audience: config.clientId, sub: 'usr_verified', algorithm: 'RS256',
    signature: true, state: true, nonce: true, pkce: 'S256', issuerResponse: true, userInfoSubject: true,
    authenticatedAt: new Date().toISOString(), checkedAt: new Date().toISOString() },
};
function fixture() {
  const store = new MemoryStore();
  const provider = {
    authorizationUrl: vi.fn(async (attempt: Attempt) => {
      const url = new URL(`${issuer}/authorize`);
      url.search = new URLSearchParams({ state: attempt.state, nonce: attempt.nonce }).toString();
      return url.href;
    }),
    complete: vi.fn(async (_callback: URL, _attempt: Attempt) => identity),
  };
  const app = createApp(config, store, provider);
  async function begin() {
    const response = await app.request(`${base}/login`, { method: 'POST', headers: { Origin: base } });
    expect(response.status).toBe(303);
    const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
    const state = new URL(response.headers.get('location')!).searchParams.get('state')!;
    const callback = `${base}/auth/callback?${new URLSearchParams({ state, code: 'one-use-code', iss: issuer })}`;
    return { response, cookie, state, callback };
  }
  return { store, provider, app, begin };
}
const sessionCookie = (response: Response) => response.headers.getSetCookie()
  .find((cookie) => cookie.startsWith('__Host-mizi_demo_session='))!.split(';')[0]!;
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('browser session and callback boundaries', () => {
  it.each([undefined, 'null', 'https://attacker.example', `${base}/path`])(
    'rejects POST login/logout Origin %s before state changes', async (origin) => {
      const f = fixture();
      for (const path of ['/login', '/logout']) {
        const response = await f.app.request(`${base}${path}`, {
          method: 'POST', headers: origin ? { Origin: origin } : {},
        });
        expect(response.status).toBe(403);
        expect(response.headers.getSetCookie()).toHaveLength(0);
      }
      expect(f.provider.authorizationUrl).not.toHaveBeenCalled();
    },
  );
  it('sets only a secure opaque attempt cookie and derives public URLs from configuration', async () => {
    const f = fixture();
    const { response, cookie } = await f.begin();
    expect(response.headers.getSetCookie()[0]).toMatch(/__Host-mizi_demo_attempt=[A-Za-z0-9_-]{43};/);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(response.headers.getSetCookie()[0]).toContain(flag);
    expect(response.headers.getSetCookie()[0]).not.toContain('Domain=');
    const attempt = f.provider.authorizationUrl.mock.calls[0]![0];
    expect(cookie).not.toContain(attempt.state);
    expect(cookie).not.toContain(attempt.nonce);
    expect(cookie).not.toContain(attempt.codeVerifier);
    const metadata = await f.app.request('https://attacker.example/client.json', { headers: { 'X-Forwarded-Host': 'attacker.example' } });
    expect(await metadata.json()).toMatchObject({ client_id: `${base}/client.json`, redirect_uris: [config.callbackUrl] });
    expect((await f.app.request(`${base}/health`)).status).toBe(200);
    for (const path of ['/login', '/logout']) expect((await f.app.request(`${base}${path}`)).status).toBe(404);
  });
  it('consumes an attempt once, rotates an opaque session, redirects cleanly, then logs out locally', async () => {
    const f = fixture();
    const first = await f.begin();
    const completed = await f.app.request(first.callback, { headers: { Cookie: first.cookie } });
    expect(completed.status).toBe(303);
    expect(completed.headers.get('location')).toBe(`${base}/`);
    const session = sessionCookie(completed);
    expect(completed.headers.get('referrer-policy')).toBe('no-referrer');
    expect(completed.headers.get('cache-control')).toBe('no-store');
    expect(completed.headers.get('content-security-policy')).toContain("script-src 'none'");
    expect(completed.headers.getSetCookie()).toHaveLength(2);
    const home = await f.app.request(`${base}/`, { headers: { Cookie: session } });
    expect(await home.text()).toContain('usr_verified');
    const replay = await f.app.request(first.callback, { headers: { Cookie: first.cookie } });
    expect(replay.headers.get('location')).toBe(`${base}/?error=login_failed`);
    expect(f.provider.complete).toHaveBeenCalledTimes(1);

    const second = await f.begin();
    const rotated = await f.app.request(second.callback, { headers: { Cookie: `${second.cookie}; ${session}` } });
    const newSession = sessionCookie(rotated);
    expect(newSession).not.toBe(session);
    expect(await (await f.app.request(`${base}/`, { headers: { Cookie: session } })).text()).not.toContain('usr_verified');
    const logout = await f.app.request(`${base}/logout`, { method: 'POST', headers: { Origin: base, Cookie: newSession } });
    expect(logout.status).toBe(303);
    expect(logout.headers.getSetCookie()).toHaveLength(2);
    expect(await (await f.app.request(`${base}/`, { headers: { Cookie: newSession } })).text()).not.toContain('usr_verified');
  });
  it.each(['wrong-state', 'wrong-browser', 'wrong-issuer', 'missing-cookie', 'duplicate-state', 'duplicate-code', 'duplicate-iss'])
    ('rejects %s without consuming another browser-bound valid attempt', async (attack) => {
      const f = fixture();
      const flow = await f.begin();
      const bad = new URL(flow.callback);
      let cookie: string | undefined = flow.cookie;
      if (attack === 'wrong-state') bad.searchParams.set('state', randomBytes(32).toString('base64url'));
      if (attack === 'wrong-browser') cookie = `__Host-mizi_demo_attempt=${randomBytes(32).toString('base64url')}`;
      if (attack === 'wrong-issuer') bad.searchParams.set('iss', 'https://attacker.example');
      if (attack === 'missing-cookie') cookie = undefined;
      if (attack.startsWith('duplicate-')) bad.searchParams.append(attack.slice('duplicate-'.length), 'duplicated');
      const rejected = await f.app.request(bad, { headers: cookie ? { Cookie: cookie } : {} });
      expect(rejected.headers.get('location')).toBe(`${base}/?error=login_failed`);
      expect(f.provider.complete).not.toHaveBeenCalled();
      const valid = await f.app.request(flow.callback, { headers: { Cookie: flow.cookie } });
      expect(valid.headers.get('location')).toBe(`${base}/`);
    });
  it('allows only one concurrent callback to create a session', async () => {
    const f = fixture();
    const flow = await f.begin();
    const responses = await Promise.all([1, 2].map(() => f.app.request(flow.callback, { headers: { Cookie: flow.cookie } })));
    expect(responses.map((response) => response.headers.get('location')).sort()).toEqual([`${base}/`, `${base}/?error=login_failed`]);
    expect(f.provider.complete).toHaveBeenCalledTimes(1);
  });
  it('rejects expired attempts and sessions even before storage cleanup', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fixture();
    const flow = await f.begin();
    vi.setSystemTime(Date.now() + 601000);
    const expired = await f.app.request(flow.callback, { headers: { Cookie: flow.cookie } });
    expect(expired.headers.get('location')).toContain('login_failed');
    expect(f.provider.complete).not.toHaveBeenCalled();
    const fresh = await f.begin();
    const completed = await f.app.request(fresh.callback, { headers: { Cookie: fresh.cookie } });
    vi.setSystemTime(Date.now() + (SESSION_TTL_SECONDS + 1) * 1000);
    const home = await f.app.request(`${base}/`, { headers: { Cookie: sessionCookie(completed) } });
    expect(await home.text()).not.toContain('usr_verified');
    expect(home.headers.getSetCookie()[0]).toContain('Max-Age=0');
  });
  it('never reflects or logs provider exception contents and never creates a session on failure', async () => {
    const f = fixture();
    const secret = 'SECRET-TOKEN-CODE-COOKIE';
    f.provider.complete.mockRejectedValueOnce(new Error(secret));
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const flow = await f.begin();
    const failed = await f.app.request(flow.callback, { headers: { Cookie: flow.cookie } });
    expect(failed.headers.get('location')).toBe(`${base}/?error=login_failed`);
    expect(failed.headers.getSetCookie().some((cookie) => cookie.startsWith('__Host-mizi_demo_session='))).toBe(false);
    expect(await failed.text()).not.toContain(secret);
    expect(logger).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls).toEqual([['login_failed', { stage: 'oidc_validation' }]]);
    const home = await f.app.request(`${base}/?error=${secret}`);
    expect(await home.text()).not.toContain(secret);
    vi.spyOn(f.store, 'getSession').mockRejectedValueOnce(new Error(secret));
    const unexpected = await f.app.request(`${base}/`, { headers: { Cookie: `__Host-mizi_demo_session=${'s'.repeat(43)}` } });
    expect(unexpected.status).toBe(503);
    expect(logger.mock.calls).toEqual([['request_failed']]);
  });
});

function lambdaEvent(path: string, method: string, rawQueryString = '', cookies: string[] = [], headers: Record<string, string> = {}): LambdaEvent {
  return {
    version: '2.0', routeKey: '$default', rawPath: path, rawQueryString, cookies,
    headers: { host: 'forged.execute-api.example', ...headers },
    requestContext: { accountId: 'test', apiId: 'test', domainName: 'forged.execute-api.example',
      domainPrefix: 'test', http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'test-request', routeKey: '$default', stage: '$default', time: '', timeEpoch: Date.now() },
    body: '', isBase64Encoded: false,
  // Public HTTP APIs omit authorizer/authentication, although Hono's event type requires them.
  } as unknown as LambdaEvent;
}

describe('AWS HTTP API payload 2.0 adapter', () => {
  it('preserves duplicate raw query parameters and returns separate secure cookies on a valid callback', async () => {
    const f = fixture();
    const handler = handle(f.app);
    const login = await handler(lambdaEvent('/login', 'POST', '', [], { origin: base }));
    const attemptCookie = login.cookies![0]!.split(';')[0]!;
    const state = new URL(login.headers!.location as string).searchParams.get('state')!;
    const query = new URLSearchParams({ state, iss: issuer, code: 'test-code' }).toString();
    const duplicated = lambdaEvent('/auth/callback', 'GET', `${query}&state=second`, [attemptCookie]);
    // API Gateway's normalized map cannot replace the original query during validation.
    (duplicated as unknown as { queryStringParameters: object }).queryStringParameters = { state: `${state},second` };
    const bad = await handler(duplicated);
    expect(bad.headers!.location).toBe(`${base}/?error=login_failed`);
    expect(f.provider.complete).not.toHaveBeenCalled();
    const success = await handler(lambdaEvent('/auth/callback', 'GET', query, [attemptCookie]));
    expect(success.statusCode).toBe(303);
    expect(success.headers!.location).toBe(`${base}/`);
    expect(success.cookies).toHaveLength(2);
    expect(success.cookies!.some((cookie) => cookie.startsWith('__Host-mizi_demo_session='))).toBe(true);
    expect(success.cookies!.every((cookie) => cookie.includes('Secure') && cookie.includes('HttpOnly'))).toBe(true);
    expect(f.provider.complete.mock.calls[0]![0].origin).toBe(base);
  });
});
