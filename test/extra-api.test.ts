import { describe, expect, it, vi } from 'vitest';
import {
  readProfileDetails, readSkillsApi, profileDetailsResource, skillsApiResource,
} from '../src/extra-api.js';
import {
  MAX_EXTRA_API_RESPONSE_BYTES, MAX_SKILLS_SNAPSHOT_BYTES, MAX_SKILLS_COLLECTION_BYTES,
  profileDetailsResultSchema, skillsApiResultSchema,
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

describe('skills provenance and bounded collection', () => {
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
  it('keeps the merged first response beyond 20 when its MiZi cursor is null', async () => {
    const items = Array.from({ length: 25 }, (_, index) => ({ ...skill, id: `skl_${index}` }));
    const result = await readSkillsApi(issuer, token, scopes, subject, reply({ items, next_cursor: null }));
    expect(result).toMatchObject({ status: 'success', returnedCount: 25, truncated: false, hasMore: false, requestedLimit: 20,
      collection: { pages: 1, stoppedReason: 'cursor_exhausted', duplicateCount: 0 } });
    if (result.status === 'success') {
      expect(result.items).toHaveLength(25);
      expect(result.items.at(-1)!.id).toBe('skl_24');
    }
  });
  it('preserves cursor availability without retaining the opaque cursor or promising complete coverage', async () => {
    const result = await readSkillsApi(issuer, token, scopes, subject, reply({ ...skills, next_cursor: 'opaque-cursor-not-retained', partial: true }));
    expect(result).toMatchObject({ status: 'success', hasMore: true, partial: true, truncated: true,
      collection: { stoppedReason: 'cursor_cycle' } });
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

describe('bounded skills pagination', () => {
  const batch = (start: number, count: number) => Array.from({ length: count }, (_, index) => ({ ...skill, id: `skl_${start + index}` }));
  const sequence = (...bodies: unknown[]) => vi.fn<typeof fetch>(async () => {
    if (!bodies.length) throw new Error('Unexpected extra page.');
    return Response.json(bodies.shift());
  });

  it('collects the complete merged first page then follows an opaque cursor only on the fixed endpoint', async () => {
    const cursor = 'private-cursor+https://attacker.example/?token=never-send';
    const fetcher = sequence({ items: batch(0, 25), next_cursor: cursor },
      { items: [{ ...skill, id: 'skl_1', name: 'changed later claim' }, ...batch(25, 20)], next_cursor: null });
    const result = await readSkillsApi(issuer, token, scopes, subject, fetcher);
    expect(result).toMatchObject({ status: 'success', returnedCount: 46, hasMore: false, truncated: false,
      collection: { pages: 2, stoppedReason: 'cursor_exhausted', duplicateCount: 1 } });
    if (result.status !== 'success') throw new Error('Expected collection.');
    expect(result.items).toHaveLength(45);
    expect(result.items[1]!.name).toBe(skill.name);
    const second = new URL(String(fetcher.mock.calls[1]![0]));
    expect(second.origin).toBe(issuer);
    expect(second.pathname).toBe('/v1/me/skills');
    expect(second.searchParams.get('cursor')).toBe(cursor);
    expect(second.searchParams.get('limit')).toBe('20');
    expect(fetcher.mock.calls[0]![1]!.signal).toBe(fetcher.mock.calls[1]![1]!.signal);
    expect(JSON.stringify(result)).not.toContain(cursor);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(skillsApiResultSchema.safeParse(result).success).toBe(true);
    expect(Date.parse(result.fetchedAt)).toBeGreaterThanOrEqual(Date.parse(result.collection!.startedAt));
  });

  it('retains at most 200 unique items even when all CCCV rows arrive with a null cursor', async () => {
    const fetcher = sequence({ items: batch(0, 205), next_cursor: null });
    const result = await readSkillsApi(issuer, token, scopes, subject, fetcher);
    expect(result).toMatchObject({ status: 'success', returnedCount: 205, hasMore: false, truncated: true,
      collection: { pages: 1, stoppedReason: 'item_limit' } });
    if (result.status === 'success') expect(result.items).toHaveLength(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves the first claim for duplicate ids even when later claim fields are malformed', async () => {
    const fetcher = sequence({ items: [skill, { id: skill.id, name: false }], next_cursor: 'next' },
      { items: [{ id: skill.id, verified_at: 'invalid replacement' }], next_cursor: null });
    const result = await readSkillsApi(issuer, token, scopes, subject, fetcher);
    expect(result).toMatchObject({ status: 'success', returnedCount: 3, truncated: false,
      collection: { pages: 2, duplicateCount: 2 }, items: [{ name: skill.name, verifiedAt: skill.verified_at }] });
    if (result.status === 'success') expect(result.items).toHaveLength(1);
  });

  it('does not label an exact 200-item terminal response as truncated', async () => {
    const result = await readSkillsApi(issuer, token, scopes, subject, sequence({ items: batch(0, 200), next_cursor: null }));
    expect(result).toMatchObject({ status: 'success', truncated: false, collection: { stoppedReason: 'cursor_exhausted' } });
  });

  it('limits calls even when empty pages keep returning different cursors', async () => {
    let count = 0;
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ items: [], next_cursor: `cursor-${++count}` }));
    const result = await readSkillsApi(issuer, token, scopes, subject, fetcher);
    expect(result).toMatchObject({ status: 'success', items: [], hasMore: true, truncated: true,
      collection: { pages: 10, stoppedReason: 'page_limit' } });
    expect(fetcher).toHaveBeenCalledTimes(10);
  });

  it('detects a cursor cycle without issuing another request for the same cursor', async () => {
    const fetcher = sequence({ items: batch(0, 1), next_cursor: 'a' },
      { items: batch(1, 1), next_cursor: 'b' }, { items: batch(2, 1), next_cursor: 'a' });
    const result = await readSkillsApi(issuer, token, scopes, subject, fetcher);
    expect(result).toMatchObject({ status: 'success', collection: { pages: 3, stoppedReason: 'cursor_cycle' }, truncated: true });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('keeps unknown pagination distinct from cursor exhaustion and API partial state', async () => {
    const result = await readSkillsApi(issuer, token, scopes, subject, sequence({ items: [skill], partial: false }));
    expect(result).toMatchObject({ status: 'success', partial: false, hasMore: null, truncated: true,
      collection: { stoppedReason: 'unknown_cursor' } });
  });

  it.each([401, 403, 500])('keeps the confirmed prefix if a later page returns %s', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...skills, next_cursor: 'private-cursor' }))
      .mockResolvedValueOnce(Response.json({ secret: token }, { status }));
    const result = await readSkillsApi(issuer, token, scopes, subject, fetcher);
    expect(result).toMatchObject({ status: 'success', returnedCount: 1, hasMore: true, truncated: true,
      collection: { pages: 1, stoppedReason: 'upstream_error' } });
    if (result.status === 'success') expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('private-cursor');
  });

  it.each([
    () => new Response('{invalid', { headers: { 'Content-Type': 'application/json' } }),
    () => Response.json({ items: [...batch(1, 1), { id: 'bad' }], next_cursor: null }),
  ])('does not commit malformed later pages over a confirmed prefix', async (response) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...skills, next_cursor: 'next' }))
      .mockResolvedValueOnce(response());
    const result = await readSkillsApi(issuer, token, scopes, subject, fetcher);
    expect(result).toMatchObject({ status: 'success', returnedCount: 1, hasMore: true,
      collection: { pages: 1, stoppedReason: 'invalid_response' } });
    if (result.status === 'success') expect(result.items).toHaveLength(1);
  });

  it('honors the shared deadline during a stalled response body and cancels its reader', async () => {
    const controller = new AbortController();
    let cancel = false;
    let reading!: () => void;
    const readingStarted = new Promise<void>((resolve) => { reading = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ...skills, next_cursor: 'next' }))
      .mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({
        pull() { reading(); }, cancel() { cancel = true; },
      }), { headers: { 'Content-Type': 'application/json' } }));
    const pending = readSkillsApi(issuer, token, scopes, subject, fetcher, { signal: controller.signal });
    await readingStarted;
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ status: 'success', collection: { pages: 1, stoppedReason: 'time_limit' }, truncated: true });
    expect(cancel).toBe(true);
  });

  it('does not fetch after an already elapsed shared budget', async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = reply(skills);
    expect(await readSkillsApi(issuer, token, scopes, subject, fetcher, { signal: controller.signal }))
      .toMatchObject({ status: 'error', reason: 'unavailable' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('caps cumulative raw bytes even when the large discarded fields are not retained', async () => {
    let count = 0;
    const padding = 'x'.repeat(230 * 1024);
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ items: batch(count, 1),
      next_cursor: `next-${++count}`, discarded: padding }));
    const result = await readSkillsApi(issuer, token, scopes, subject, fetcher);
    expect(result).toMatchObject({ status: 'success', collection: { pages: 4, stoppedReason: 'byte_limit' }, truncated: true });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(padding.length * 5).toBeGreaterThan(MAX_SKILLS_COLLECTION_BYTES);
    expect(JSON.stringify(result)).not.toContain(padding);
  });

  it('caps the UTF-8 projected snapshot below 192KiB and rejects oversized stored snapshots', async () => {
    const large = { ...skill, name: '\u0000'.repeat(200), source: '\u0000'.repeat(100),
      verification_method: '\u0000'.repeat(200), verified_by: '\u0000'.repeat(500) };
    let count = 0;
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ items: Array.from({ length: 20 },
      () => ({ ...large, id: `skl_${count++}` })), next_cursor: `next-${count}` }));
    const result = await readSkillsApi(issuer, token, scopes, subject, fetcher);
    expect(result).toMatchObject({ status: 'success', truncated: true, collection: { stoppedReason: 'byte_limit' } });
    if (result.status !== 'success') throw new Error('Expected prefix.');
    expect(result.items.length).toBeGreaterThan(20);
    expect(result.items.length).toBeLessThan(200);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(MAX_SKILLS_SNAPSHOT_BYTES);
    expect(skillsApiResultSchema.safeParse(result).success).toBe(true);
    expect(skillsApiResultSchema.safeParse({ ...result, items: Array(200).fill(result.items[0]) }).success).toBe(false);
  });

  it('keeps old first-page snapshots valid when collection metadata is absent', async () => {
    const result = await readSkillsApi(issuer, token, scopes, subject, reply(skills));
    if (result.status !== 'success') throw new Error('Expected snapshot.');
    const { collection: _collection, ...oldSnapshot } = result;
    expect(skillsApiResultSchema.safeParse(oldSnapshot).success).toBe(true);
  });
});
