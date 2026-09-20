import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ApiGrant, profileBioResource } from '../src/api-grant.js';
import { MAX_PROFILE_WRITE_RESPONSE_BYTES, writeProfileBio } from '../src/profile-write.js';

const issuer = 'https://issuer.example';
const clientId = 'https://demo.example/client.json';
const subject = 'usr_verified';
const accessToken = 'server-private-access';
const refreshToken = 'server-private-refresh';
const settings = { issuer, clientId };
const bio = '작은 도구를 만들어요.\n새 소개입니다.';
const endpoint = `${issuer}/v1/me/profile/bio`;
const readbackEndpoint = `${issuer}/v1/me/profile`;
const grant = (): ApiGrant => ({ issuer, clientId, subject, accessToken, refreshToken,
  scope: 'openid profile user:profile user:profile:write',
  resources: [`${issuer}/v1/me`, readbackEndpoint, endpoint], expiresAt: Math.floor(Date.now() / 1000) + 3600 });

function fixture(options: {
  patch?: (submitted: string) => Response | Promise<Response>;
  readback?: (submitted: string) => Response | Promise<Response>;
} = {}) {
  let submitted = '';
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(init?.redirect).toBe('error');
    expect(init?.cache).toBe('no-store');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${accessToken}`);
    expect(JSON.stringify({ body: init?.body, headers: Object.fromEntries(new Headers(init?.headers)) })).not.toContain(refreshToken);
    if (String(input) === endpoint) {
      expect(init?.method).toBe('PATCH');
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      const parsed = JSON.parse(String(init?.body)) as { bio: string };
      expect(Object.keys(parsed)).toEqual(['bio']);
      submitted = parsed.bio;
      return options.patch ? options.patch(submitted) : Response.json({ user: { id: subject }, bio: submitted });
    }
    expect(String(input)).toBe(readbackEndpoint);
    expect(init?.method).toBe('GET');
    return options.readback ? options.readback(submitted) : Response.json({
      user: { id: subject, role: '개발자' }, bio: submitted, interests: ['도구'], partial: false,
      contact_method: 'must-not-return-contact', location: 'must-not-return-location',
    });
  });
  return { fetcher };
}
afterEach(() => vi.restoreAllMocks());

describe('explicit profile bio write', () => {
  it.each([bio, '', '  그대로 보존  ', '😀'.repeat(150)])('confirms only exact PATCH plus fresh GET agreement (%s)', async (submitted) => {
    const f = fixture();
    const original = grant();
    const before = structuredClone(original);
    const result = await writeProfileBio(settings, original, submitted, f.fetcher);
    expect(result).toMatchObject({ status: 'saved_verified', bio: submitted,
      profileDetails: { status: 'success', subject, endpoint: readbackEndpoint,
        profile: { bio: submitted, role: '개발자', interests: ['도구'] } } });
    expect(f.fetcher.mock.calls.map(([url, init]) => [String(url), init?.method]))
      .toEqual([[endpoint, 'PATCH'], [readbackEndpoint, 'GET']]);
    expect(original).toEqual(before);
    for (const hidden of [accessToken, refreshToken, 'must-not-return-contact', 'must-not-return-location']) {
      expect(JSON.stringify(result)).not.toContain(hidden);
    }
  });

  it.each([null, undefined, 3, { bio }, { bio, role: 'admin' }, 'x'.repeat(301), '😀'.repeat(151)])(
    'rejects invalid input without sending any request: %j', async (input) => {
      const f = fixture();
      expect(await writeProfileBio(settings, grant(), input as string, f.fetcher))
        .toEqual({ status: 'not_saved', reason: 'invalid_input' });
      expect(f.fetcher).not.toHaveBeenCalled();
    });

  it.each([
    [{ scope: 'openid profile user:profile' }, 'scope_missing'],
    [{ scope: 'openid profile user:profile:write' }, 'scope_missing'],
    [{ scope: 'openid profile user:profile user:profile:write:extra' }, 'scope_missing'],
    [{ resources: [readbackEndpoint] }, 'resource_missing'],
    [{ resources: [endpoint] }, 'resource_missing'],
    [{ resources: [readbackEndpoint, `${endpoint}?other=1`] }, 'invalid_grant'],
    [{ resources: [readbackEndpoint, `${issuer}/v1/me/other-write`] }, 'invalid_grant'],
    [{ issuer: 'https://other.example' }, 'invalid_grant'],
    [{ clientId: 'another-client' }, 'invalid_grant'],
    [{ expiresAt: 1 }, 'expired'],
  ] as const)('rejects missing authority or invalid grant binding before transmission %j', async (patch, reason) => {
    const f = fixture();
    await expect(writeProfileBio(settings, { ...grant(), ...patch } as ApiGrant, bio, f.fetcher))
      .rejects.toMatchObject({ name: 'ApiGrantUnavailable', reason });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('pins the resource to the configured HTTPS issuer origin', () => {
    expect(profileBioResource(`${issuer}/tenant`)).toBe(endpoint);
    expect(() => profileBioResource('http://issuer.example')).toThrow('Untrusted API endpoint');
    expect(() => profileBioResource('https://user:password@issuer.example')).toThrow('Untrusted API endpoint');
  });

  it.each([[400, 'rejected'], [401, 'unauthorized'], [403, 'forbidden'], [409, 'rejected'], [422, 'rejected'], [429, 'rejected']] as const)(
    'reports explicit HTTP %s refusal without reading its body or sending GET', async (status, reason) => {
      const f = fixture({ patch: () => Response.json({ sensitive: accessToken }, { status }) });
      expect(await writeProfileBio(settings, grant(), bio, f.fetcher)).toEqual({ status: 'not_saved', reason });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    });

  it.each([408, 500, 503])('does not claim saved or unsaved after ambiguous HTTP %s', async (status) => {
    const f = fixture({ patch: () => Response.json({ detail: refreshToken }, { status }) });
    expect(await writeProfileBio(settings, grant(), bio, f.fetcher)).toEqual({ status: 'unknown', reason: 'unavailable' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it('never retries or logs a PATCH whose response was lost after the upstream may have saved it', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let possiblyStored: string | undefined;
    const f = fixture({ patch: (submitted) => { possiblyStored = submitted; throw new Error(`${accessToken} ${refreshToken}`); } });
    const result = await writeProfileBio(settings, grant(), bio, f.fetcher);
    expect(possiblyStored).toBe(bio);
    expect(result).toEqual({ status: 'unknown', reason: 'unavailable' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled(); expect(warnLog).not.toHaveBeenCalled();
  });

  it.each([
    { user: { id: subject }, bio, extra: 'do-not-return' },
    { user: { id: subject, nickname: 'unexpected' }, bio },
    { user: { id: subject }, bio: 'x'.repeat(301) },
    { user: { id: subject }, bio: null },
    { user: { id: subject }, bio: 'different bio' },
    { bio },
  ])('refuses malformed, extra, or nonmatching success fields: %j', async (body) => {
    const f = fixture({ patch: () => Response.json(body) });
    expect(await writeProfileBio(settings, grant(), bio, f.fetcher))
      .toEqual({ status: 'unknown', reason: 'invalid_response' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not accept a PATCH response belonging to another subject', async () => {
    const f = fixture({ patch: () => Response.json({ user: { id: 'usr_foreign' }, bio }) });
    const result = await writeProfileBio(settings, grant(), bio, f.fetcher);
    expect(result).toEqual({ status: 'unknown', reason: 'identity_mismatch' });
    expect(JSON.stringify(result)).not.toContain('usr_foreign');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['declared', 'streamed', 'content-type', 'invalid-json'] as const)('bounds or rejects %s PATCH response', async (kind) => {
    const f = fixture({ patch: () => kind === 'declared'
      ? Response.json({ user: { id: subject }, bio }, { headers: { 'Content-Length': String(MAX_PROFILE_WRITE_RESPONSE_BYTES + 1) } })
      : kind === 'streamed' ? new Response(' '.repeat(MAX_PROFILE_WRITE_RESPONSE_BYTES + 1), { headers: { 'Content-Type': 'application/json' } })
        : kind === 'content-type' ? new Response(JSON.stringify({ user: { id: subject }, bio }))
          : new Response('{invalid', { headers: { 'Content-Type': 'application/json' } }) });
    expect(await writeProfileBio(settings, grant(), bio, f.fetcher))
      .toEqual({ status: 'unknown', reason: 'invalid_response' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403, 503])('does not confirm saved content when subsequent GET returns %s', async (status) => {
    const f = fixture({ readback: () => Response.json({ sensitive: accessToken }, { status }) });
    expect(await writeProfileBio(settings, grant(), bio, f.fetcher)).toEqual({ status: 'saved_unverified', reason: 'readback_failed',
      ...(status === 401 ? { authorizationFailure: 'unauthorized' } : status === 403 ? { authorizationFailure: 'forbidden' } : {}) });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it('distinguishes a successful PATCH followed by a different readback value', async () => {
    const f = fixture({ readback: () => Response.json({ user: { id: subject }, bio: 'concurrent edit', partial: false }) });
    const result = await writeProfileBio(settings, grant(), bio, f.fetcher);
    expect(result).toEqual({ status: 'saved_unverified', reason: 'readback_mismatch' });
    expect(result).not.toHaveProperty('profileDetails');
  });

  it('rejects another subject in the fresh GET without exposing a foreign snapshot', async () => {
    const f = fixture({ readback: () => Response.json({ user: { id: 'usr_foreign' }, bio }) });
    const result = await writeProfileBio(settings, grant(), bio, f.fetcher);
    expect(result).toEqual({ status: 'saved_unverified', reason: 'identity_mismatch' });
    expect(JSON.stringify(result)).not.toContain('usr_foreign');
  });

  it.each(['patch', 'readback'] as const)('bounds a stalled %s body and preserves uncertainty without retry', async (phase) => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let received!: () => void;
    const started = new Promise<void>((resolve) => { received = resolve; });
    const response = () => new Response(new ReadableStream({ start() { received(); } }),
      { headers: { 'Content-Type': 'application/json' } });
    const f = fixture(phase === 'patch' ? { patch: response } : { readback: response });
    const pending = writeProfileBio(settings, grant(), bio, f.fetcher);
    await started;
    controller.abort();
    expect(await pending).toEqual(phase === 'patch' ? { status: 'unknown', reason: 'unavailable' }
      : { status: 'saved_unverified', reason: 'readback_failed' });
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });
});
