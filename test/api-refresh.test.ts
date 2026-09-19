import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiGrantSchema, type ApiGrant } from '../src/api-grant.js';
import { refreshApis } from '../src/api-refresh.js';

const issuer = 'https://issuer.example';
const subject = 'usr_verified';
const token = 'server-private-token-never-in-view';
const settings = { issuer, clientId: 'https://demo.example/client.json' };
const resources: [string, string, string] = [`${issuer}/v1/me`, `${issuer}/v1/me/profile`, `${issuer}/v1/me/skills`];
const grant = (): ApiGrant => ({ accessToken: token, issuer, clientId: settings.clientId, subject,
  scope: 'openid profile user:profile user:skills', resources, expiresAt: Math.floor(Date.now() / 1000) + 1800 });
const member = { id: subject, nickname: '새 닉네임', github_connected: true };
const profile = { user: { id: subject, role: '개발자' }, bio: '새 소개', interests: ['웹'], partial: false };
const skill = { id: 'skl_1', name: 'TypeScript', source: 'github_analysis' };
const goodFetch = () => vi.fn<typeof fetch>(async (input, init) => {
  expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
  expect(init?.redirect).toBe('error');
  expect(init?.cache).toBe('no-store');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  const url = String(input);
  if (url === resources[0]) return Response.json(member);
  if (url === resources[1]) return Response.json(profile);
  if (url === `${resources[2]}?limit=20`) return Response.json({ items: [skill], next_cursor: null });
  throw new Error('Unexpected request.');
});
afterEach(() => vi.restoreAllMocks());

describe('server-only API grants', () => {
  it.each([
    { accessToken: 'bad\r\nAuthorization: injected' }, { accessToken: 'x'.repeat(2049) },
    { scope: 'user:profile\nuser:skills' }, { scope: 'x'.repeat(2049) },
    { resources: [resources[0], resources[0]] }, { resources: ['http://insecure.example/v1/me'] },
    { resources: ['https://user:password@issuer.example/v1/me'] }, { subject: '' },
  ])('rejects malformed credentials and header/URL injection: %j', (patch) => {
    expect(apiGrantSchema.safeParse({ ...grant(), ...patch }).success).toBe(false);
  });

  it('drops unsolicited token fields from the persistence schema', () => {
    const result = apiGrantSchema.parse({ ...grant(), idToken: 'private-id-token', refreshToken: 'private-refresh-token' });
    expect(result).not.toHaveProperty('idToken');
    expect(result).not.toHaveProperty('refreshToken');
  });

  it.each([
    [{ expiresAt: 1 }, 'expired'],
    [{ issuer: 'https://other.example' }, 'invalid_grant'],
    [{ clientId: 'another-client' }, 'invalid_grant'],
    [{ scope: 'openid profile user:profile:extra' }, 'scope_missing'],
    [{ resources: [resources[0]] }, 'resource_missing'],
    [{ resources: [`${issuer}/unapproved`] }, 'invalid_grant'],
    [{ resources: [`${issuer}/v1/me?redirect=elsewhere`, resources[1]] }, 'invalid_grant'],
  ] as const)('rejects unusable or unbound grants before any network request: %j', async (patch, reason) => {
    const fetcher = goodFetch();
    await expect(refreshApis(settings, { ...grant(), ...patch, resources: [...('resources' in patch ? patch.resources : resources)] }, 'profile', fetcher))
      .rejects.toMatchObject({ name: 'ApiGrantUnavailable', reason });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('API-only refresh boundaries', () => {
  it('reads only the two profile endpoints and returns no credentials or original sensitive fields', async () => {
    const fetcher = goodFetch();
    const previous = grant();
    const before = structuredClone(previous);
    const result = await refreshApis(settings, previous, 'profile', fetcher);
    expect(fetcher.mock.calls.map(([url]) => String(url)).sort()).toEqual(resources.slice(0, 2));
    expect(result.memberApi).toMatchObject({ status: 'success', profile: { id: subject, nickname: member.nickname } });
    expect(result.profileDetails).toMatchObject({ status: 'success', subject, profile: { bio: profile.bio } });
    expect(result.skillsApi).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(token);
    expect(previous).toEqual(before); // Neither reuse nor a successful read extends expiry.
  });

  it.each([[401, 'unauthorized'], [403, 'forbidden']] as const)('reads only skills and preserves prefix plus later-page authorization failure %s', async (status, authorizationFailure) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ items: [skill], next_cursor: 'private-cursor' }))
      .mockResolvedValueOnce(Response.json({ secret: token }, { status }));
    const result = await refreshApis(settings, grant(), 'skills', fetcher);
    expect(fetcher.mock.calls.every(([url]) => new URL(String(url)).pathname === '/v1/me/skills')).toBe(true);
    expect(result).toMatchObject({ skillsApi: { status: 'success', items: [{ id: 'skl_1' }], truncated: true,
      collection: { pages: 1, stoppedReason: 'upstream_error', authorizationFailure } } });
    expect(result.memberApi).toBeUndefined();
    expect(result.profileDetails).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('private-cursor');
  });

  it.each([[401, 'unauthorized'], [403, 'forbidden'], [500, 'unavailable']] as const)
    ('reports a first skills response %s for the route to invalidate or preserve the grant appropriately', async (status, reason) => {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json({ secret: token }, { status }));
      expect(await refreshApis(settings, grant(), 'skills', fetcher))
        .toMatchObject({ skillsApi: { status: 'error', reason } });
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

  it('returns independent safe profile failures without claiming refreshed data or logging a token', async () => {
    const logger = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorLogger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === resources[0]) return Response.json(member);
      throw new Error(token);
    });
    const result = await refreshApis(settings, grant(), 'profile', fetcher);
    expect(result.memberApi?.status).toBe('success');
    expect(result.profileDetails).toMatchObject({ status: 'error', reason: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(logger).not.toHaveBeenCalled(); expect(errorLogger).not.toHaveBeenCalled();
  });

  it.each(['member', 'profile'])('fails closed when the %s response belongs to another account', async (which) => {
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input) === resources[0]
      ? Response.json(which === 'member' ? { ...member, id: 'usr_other' } : member)
      : Response.json(which === 'profile' ? { ...profile, user: { id: 'usr_other' } } : profile));
    await expect(refreshApis(settings, grant(), 'profile', fetcher))
      .rejects.toMatchObject({ name: 'LoginFailure', stage: 'member_api' });
  });

  it('bounds a stalled profile body with the shared deadline while preserving the other completed result', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let received!: () => void;
    const responseStarted = new Promise<void>((resolve) => { received = resolve; });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === resources[0]) return new Response(new ReadableStream({ start() { received(); } }),
        { headers: { 'Content-Type': 'application/json' } });
      return Response.json(profile);
    });
    const pending = refreshApis(settings, grant(), 'profile', fetcher);
    await responseStarted;
    // Let the small profile response complete before the shared deadline expires.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const result = await pending;
    expect(result.memberApi).toMatchObject({ status: 'error', reason: 'unavailable' });
    expect(result.profileDetails?.status).toBe('success');
    expect(timeout.mock.calls.every(([milliseconds]) => milliseconds <= 5000)).toBe(true);
  });
});
