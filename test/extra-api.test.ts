import { describe, expect, it, vi } from 'vitest';
import {
  readProfileDetails, readSkillsApi, profileDetailsResource, skillsApiResource,
} from '../src/extra-api.js';
import {
  MAX_EXTRA_API_RESPONSE_BYTES, profileDetailsResultSchema, skillsApiResultSchema,
} from '../src/extra-api-model.js';

const issuer = 'https://issuer.example';
const subject = 'usr_verified';
const token = 'access-token-do-not-retain';
const scopes = 'openid profile user:profile user:skills';
const profile = { user: { id: subject, role: '개발자' }, bio: '소개', interests: ['웹', 'AI'], partial: false };
const skill = {
  id: 'skl_first', name: 'TypeScript', source: 'github_analysis',
  verification_method: 'github_repo_analysis', verified_by: 'CCCV', verified_at: '2026-09-18T01:02:03Z',
  visible: false, visibility: { profile: false, skills: true },
};
const skills = { items: [skill], next_cursor: null };
const reply = (body: unknown, status = 200) => vi.fn<typeof fetch>(async () => Response.json(body, { status }));
const readers = [
  { name: 'profile', read: readProfileDetails, path: '/v1/me/profile', body: profile, requiredScope: 'user:profile', schema: profileDetailsResultSchema },
  { name: 'skills', read: readSkillsApi, path: '/v1/me/skills?limit=20', body: skills, requiredScope: 'user:skills', schema: skillsApiResultSchema },
] as const;

describe.each(readers)('$name extra API boundary', ({ read, path, body, requiredScope, schema }) => {
  it('uses the fixed HTTPS endpoint, one bearer token, no redirect and a bounded request', async () => {
    const fetcher = reply(body);
    const result = await read(issuer, token, scopes, subject, fetcher);
    expect(result.status).toBe('success');
    expect(schema.safeParse(result).success).toBe(true);
    expect(result.subject).toBe(subject);
    expect(result.endpoint).toBe(`${issuer}${path.split('?')[0]}`);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${issuer}${path}`);
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it.each([undefined, '', 'openid profile', 'user:profile:extra user:skills:extra'])
    ('does not fetch when the exact granted scope is missing: %s', async (grantedScope) => {
      const fetcher = reply(body);
      const result = await read(issuer, token, grantedScope, subject, fetcher);
      expect(result).toMatchObject({ status: 'error', reason: 'scope_missing', subject });
      expect(schema.safeParse(result).success).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
    });
  it('does not mistake the other API scope for its required permission', async () => {
    const fetcher = reply(body);
    const other = requiredScope === 'user:profile' ? 'user:skills' : 'user:profile';
    expect(await read(issuer, token, `openid profile ${other}`, subject, fetcher))
      .toMatchObject({ status: 'error', reason: 'scope_missing' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([[401, 'unauthorized'], [403, 'forbidden'], [429, 'unavailable'], [500, 'unavailable'], [302, 'unavailable']] as const)
    ('returns a safe %s error without retaining body or headers', async (status, reason) => {
      const result = await read(issuer, token, scopes, subject, reply({ private_debug: token }, status));
      expect(result).toMatchObject({ status: 'error', reason });
      expect(JSON.stringify(result)).not.toContain(token);
    });
  it('does not expose or log network exceptions', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnLog = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = await read(issuer, token, scopes, subject, vi.fn(async () => { throw new Error(token); }));
      expect(result).toMatchObject({ status: 'error', reason: 'unavailable' });
      expect(JSON.stringify(result)).not.toContain(token);
      expect(errorLog).not.toHaveBeenCalled();
      expect(warnLog).not.toHaveBeenCalled();
    } finally { errorLog.mockRestore(); warnLog.mockRestore(); }
  });
  it.each([
    () => new Response('<html>provider outage</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('{malformed', { headers: { 'Content-Type': 'application/json' } }),
  ])('rejects invalid MIME or JSON instead of claiming success', async (response) => {
    expect(await read(issuer, token, scopes, subject, vi.fn(async () => response())))
      .toMatchObject({ status: 'error', reason: 'invalid_response' });
  });
  it('stops reading oversized bodies even when Content-Length is absent', async () => {
    let cancelled = false;
    const fetcher: typeof fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_EXTRA_API_RESPONSE_BYTES + 1)); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'application/json' } }));
    expect(await read(issuer, token, scopes, subject, fetcher))
      .toMatchObject({ status: 'error', reason: 'invalid_response' });
    expect(cancelled).toBe(true);
  });
  it('rejects a declared oversize response without buffering its body', async () => {
    let cancelled = false;
    const fetcher: typeof fetch = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'application/json', 'Content-Length': String(MAX_EXTRA_API_RESPONSE_BYTES + 1) } }));
    expect(await read(issuer, token, scopes, subject, fetcher))
      .toMatchObject({ status: 'error', reason: 'invalid_response' });
    expect(cancelled).toBe(true);
  });
});

describe('profile details projection and subject binding', () => {
  it('keeps only bio/role/interests and aggregate partial state, discarding contact/location and unrelated claims', async () => {
    const result = await readProfileDetails(issuer, token, scopes, subject, reply({
      ...profile, partial: true, location: 'private location', contact_method: 'private@example.test', identity_verified: true,
      user: { ...profile.user, nickname: 'unneeded nickname', handle: 'unneeded handle', trust_score_total: 1000 },
      trust_score: { total: 1000 }, public_skills: [skill], token,
    }));
    expect(result).toEqual({ status: 'success', subject, endpoint: `${issuer}/v1/me/profile`,
      fetchedAt: expect.any(String), partial: true,
      profile: { bio: '소개', role: '개발자', interests: ['웹', 'AI'] } });
    for (const sensitive of ['location', 'contact', 'private@example.test', 'identity_verified', 'nickname', 'handle', 'trust_score', 'public_skills', token]) {
      expect(JSON.stringify(result)).not.toContain(sensitive);
    }
  });
  it('distinguishes missing optional values from an explicitly empty interests list', async () => {
    const unknown = await readProfileDetails(issuer, token, scopes, subject, reply({ user: { id: subject } }));
    expect(unknown).toMatchObject({ status: 'success', partial: null, profile: { bio: null, role: null, interests: null } });
    const empty = await readProfileDetails(issuer, token, scopes, subject, reply({ user: { id: subject, role: null }, bio: null, interests: [] }));
    expect(empty).toMatchObject({ status: 'success', profile: { bio: null, role: null, interests: [] } });
  });
  it('fails the whole login on user.id mismatch, rather than accepting an unrelated top-level id', async () => {
    await expect(readProfileDetails(issuer, token, scopes, subject,
      reply({ ...profile, id: subject, user: { id: 'usr_other' } })))
      .rejects.toMatchObject({ name: 'LoginFailure', stage: 'member_api' });
    await expect(readProfileDetails(issuer, token, scopes, subject,
      reply({ user: { id: 'usr_other' }, bio: 123 })))
      .rejects.toMatchObject({ name: 'LoginFailure', stage: 'member_api' });
    expect(await readProfileDetails(issuer, token, scopes, subject, reply({ id: subject, bio: 'wrong shape' })))
      .toMatchObject({ status: 'error', reason: 'invalid_response' });
  });
  it.each([
    { ...profile, bio: 123 }, { ...profile, bio: 'x'.repeat(301) },
    { ...profile, interests: ['x'.repeat(201)] }, { ...profile, interests: Array(11).fill('웹') },
    { ...profile, interests: false }, { ...profile, partial: 'true' },
  ])('rejects malformed or oversized profile data %j', async (body) => {
    expect(await readProfileDetails(issuer, token, scopes, subject, reply(body)))
      .toMatchObject({ status: 'error', reason: 'invalid_response' });
  });
  it('preserves untrusted text as data for the view to escape, without retaining unrelated HTML fields', async () => {
    const text = '<img src=x onerror=alert(1)>';
    const result = await readProfileDetails(issuer, token, scopes, subject,
      reply({ user: { id: subject, role: text }, bio: text, interests: [text], contact_method: '<script>private</script>' }));
    expect(result).toMatchObject({ status: 'success', profile: { bio: text, role: text, interests: [text] } });
    expect(JSON.stringify(result)).not.toContain('private');
  });
});

describe('skills provenance and bounded first-page snapshot', () => {
  it('retains only provided source, method, verifier, original verification timestamp and visibility', async () => {
    const result = await readSkillsApi(issuer, token, scopes, subject, reply({
      ...skills, items: [{ ...skill, valuation: { amount: 300000, currency: 'KRW' }, repository_url: 'https://private.example/repo' }],
      total_valuation: { amount: 300000, currency: 'KRW' }, owner_id: 'unprovided-owner-claim',
    }));
    expect(result).toMatchObject({ status: 'success', subject, endpoint: `${issuer}/v1/me/skills`, partial: null,
      requestedLimit: 20, returnedCount: 1, hasMore: false, truncated: false,
      items: [{ id: skill.id, name: skill.name, source: skill.source, verificationMethod: skill.verification_method,
        verifiedBy: skill.verified_by, verifiedAt: skill.verified_at, visible: false, visibility: { profile: false, skills: true } }] });
    for (const omitted of ['valuation', 'repository_url', 'owner_id', 'unprovided-owner-claim']) expect(JSON.stringify(result)).not.toContain(omitted);
    expect(skillsApiResultSchema.safeParse(result).success).toBe(true);
  });
  it('does not invent verification status, timestamp, visibility or completeness from the source', async () => {
    const result = await readSkillsApi(issuer, token, scopes, subject, reply({ items: [{ id: 'skl_unknown', name: 'Unknown', source: 'future_source' }] }));
    expect(result).toMatchObject({ status: 'success', partial: null, hasMore: null,
      items: [{ source: 'future_source', verificationMethod: null, verifiedBy: null, verifiedAt: null,
        visible: null, visibility: { profile: null, skills: null } }] });
    if (result.status === 'success') expect(result.items[0]).not.toHaveProperty('status');
  });
  it('records a larger merged first response as a preview, even when its MiZi cursor is null', async () => {
    const items = Array.from({ length: 25 }, (_, index) => ({ ...skill, id: `skl_${index}` }));
    const result = await readSkillsApi(issuer, token, scopes, subject, reply({ items, next_cursor: null }));
    expect(result).toMatchObject({ status: 'success', returnedCount: 25, truncated: true, hasMore: false, requestedLimit: 20 });
    if (result.status === 'success') {
      expect(result.items).toHaveLength(20);
      expect(result.items.at(-1)!.id).toBe('skl_19');
    }
  });
  it('preserves cursor availability without retaining the opaque cursor or promising complete coverage', async () => {
    const result = await readSkillsApi(issuer, token, scopes, subject, reply({ ...skills, next_cursor: 'opaque-cursor-not-retained', partial: true }));
    expect(result).toMatchObject({ status: 'success', hasMore: true, partial: true, truncated: false });
    expect(JSON.stringify(result)).not.toContain('opaque-cursor-not-retained');
    expect(await readSkillsApi(issuer, token, scopes, subject, reply({ items: [], next_cursor: null })))
      .toMatchObject({ status: 'success', items: [], returnedCount: 0, hasMore: false, partial: null });
  });
  it.each([
    { items: null }, { items: [{}] }, { items: [{ ...skill, source: false }] },
    { items: [{ ...skill, verified_at: 'yesterday' }] }, { items: [{ ...skill, verified_by: 'x'.repeat(501) }] },
    { items: [{ ...skill, name: 'x'.repeat(201) }] }, { items: [skill], next_cursor: 123 },
    { items: [skill], partial: 'unknown' },
  ])('rejects malformed returned skill data %j', async (body) => {
    expect(await readSkillsApi(issuer, token, scopes, subject, reply(body)))
      .toMatchObject({ status: 'error', reason: 'invalid_response' });
  });
  it('retains a verification date with an explicit offset instead of replacing it with fetch time', async () => {
    const verifiedAt = '2026-09-18T10:02:03+09:00';
    const result = await readSkillsApi(issuer, token, scopes, subject, reply({ ...skills, items: [{ ...skill, verified_at: verifiedAt }] }));
    if (result.status !== 'success') throw new Error('Expected a valid skill response.');
    expect(result.items[0]!.verifiedAt).toBe(verifiedAt);
    expect(result.items[0]!.verifiedAt).not.toBe(result.fetchedAt);
  });
  it('keeps untrusted skill names as plain data and stays well below the DynamoDB item limit', async () => {
    const text = '<script>alert(1)</script>';
    const result = await readSkillsApi(issuer, token, scopes, subject, reply({ ...skills, items: [{ ...skill, name: text, verified_by: text }] }));
    expect(result).toMatchObject({ status: 'success', items: [{ name: text, verifiedBy: text }] });
    const maximal = skillsApiResultSchema.parse({
      status: 'success', subject: 's'.repeat(255), endpoint: `${issuer}/${'a'.repeat(1900)}`, fetchedAt: new Date().toISOString(),
      partial: null, requestedLimit: 20, returnedCount: 20, hasMore: null, truncated: false,
      items: Array.from({ length: 20 }, () => ({
        id: '\u0000'.repeat(255), name: '\u0000'.repeat(200), source: '\u0000'.repeat(100),
        verificationMethod: '\u0000'.repeat(200), verifiedBy: '\u0000'.repeat(500), verifiedAt: null,
        visible: null, visibility: { profile: null, skills: null },
      })),
    });
    expect(Buffer.byteLength(JSON.stringify(maximal))).toBeLessThan(180 * 1024);
  });
});

it('resource helpers keep the issuer origin, omit query parameters and reject insecure issuers', () => {
  expect(profileDetailsResource(`${issuer}/tenant`)).toBe(`${issuer}/v1/me/profile`);
  expect(skillsApiResource(`${issuer}/tenant`)).toBe(`${issuer}/v1/me/skills`);
  expect(() => profileDetailsResource('http://insecure.example')).toThrow();
  expect(() => skillsApiResource('https://user:password@issuer.example')).toThrow();
});
