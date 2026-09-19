import { describe, expect, it, vi } from 'vitest';
import { memberApiResource, readMemberApi } from '../src/member-api.js';
import { LoginFailure } from '../src/login-error.js';

const issuer = 'https://issuer.example';
const token = 'opaque-token-never-returned';
const subject = 'usr_verified';
const scope = 'openid profile user:profile';
const profile = { id: subject, nickname: '회원 이름', github_connected: true };
const read = (fetcher: typeof fetch, grantedScope: string | undefined = scope) =>
  readMemberApi(issuer, token, grantedScope, subject, fetcher);

function reply(body: unknown = profile, status = 200) {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status }));
}

describe('optional member API projection', () => {
  it('reads the fixed HTTPS resource with a bearer token and retains only the three permitted fields', async () => {
    const fetcher = reply({ ...profile, email: 'private@example.test', avatar_url: 'https://other.example/image',
      github_login: 'private-github-name', providers: ['google'], arbitrary_token: token });
    const result = await read(fetcher);
    expect(result).toEqual({ status: 'success', fetchedAt: expect.any(String),
      profile: { id: subject, nickname: '회원 이름', githubConnected: true } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${issuer}/v1/me`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const serialized = JSON.stringify(result);
    for (const value of [token, 'private@example.test', 'private-github-name', 'arbitrary_token', 'providers']) {
      expect(serialized).not.toContain(value);
    }
  });
  it.each([false, null, undefined])('reports GitHub status %s without inferring a connection', async (githubConnected) => {
    const result = await read(reply({ ...profile, github_connected: githubConnected }));
    expect(result.status).toBe('success');
    if (result.status === 'success') expect(result.profile.githubConnected).toBe(githubConnected ?? null);
  });
  it.each([undefined, '', 'openid profile', 'openid profile user:profile:extra', 'openid profile USER:PROFILE'])
    ('does not call the API without the exact granted scope: %s', async (grantedScope) => {
      const fetcher = reply();
      const result = await readMemberApi(issuer, token, grantedScope, subject, fetcher);
      expect(result).toMatchObject({ status: 'error', reason: 'scope_missing' });
      expect(fetcher).not.toHaveBeenCalled();
    });
  it.each([[401, 'unauthorized'], [403, 'forbidden'], [429, 'unavailable'], [500, 'unavailable'], [302, 'unavailable']] as const)
    ('maps HTTP %s to %s without exposing the response body', async (status, reason) => {
      const result = await read(reply({ private_debug: token }, status));
      expect(result).toMatchObject({ status: 'error', reason });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(result).not.toHaveProperty('profile');
    });
  it.each([
    {}, { ...profile, id: 123 }, { ...profile, nickname: null },
    { ...profile, nickname: 'x'.repeat(501) }, { ...profile, github_connected: 'true' },
  ])('rejects malformed profile %j instead of claiming API success', async (body) => {
    expect(await read(reply(body))).toMatchObject({ status: 'error', reason: 'invalid_response' });
  });
  it.each([
    () => new Response('<html>outage</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{malformed', { headers: { 'Content-Type': 'application/json' } }),
  ])('rejects non-JSON or invalid JSON bodies', async (response) => {
    expect(await read(vi.fn(async () => response()))).toMatchObject({ status: 'error', reason: 'invalid_response' });
  });
  it('maps network failure to unavailable without returning or logging raw exceptions', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await read(vi.fn(async () => { throw new Error(`upstream error ${token}`); }));
      expect(result).toMatchObject({ status: 'error', reason: 'unavailable' });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(logger).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
    } finally { logger.mockRestore(); warning.mockRestore(); }
  });
  it('fails the identity boundary when the API returns another member', async () => {
    await expect(read(reply({ ...profile, id: 'usr_another' }))).rejects.toMatchObject({
      name: 'LoginFailure', stage: 'member_api',
    });
    await expect(read(reply({ ...profile, id: 'usr_another' }))).rejects.toBeInstanceOf(LoginFailure);
  });
  it('derives the resource from the issuer origin and never permits insecure transport', async () => {
    expect(memberApiResource(`${issuer}/tenant`)).toBe(`${issuer}/v1/me`);
    expect(() => memberApiResource('http://insecure.example')).toThrow();
  });
});
