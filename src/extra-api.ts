import { z } from 'zod';
import { LoginFailure } from './login-error.js';
import {
  MAX_EXTRA_API_RESPONSE_BYTES, SKILLS_PREVIEW_LIMIT, skillSnapshotSchema,
  MAX_SKILLS_SNAPSHOT_ITEMS, MAX_SKILLS_SNAPSHOT_BYTES, MAX_SKILLS_COLLECTION_PAGES,
  MAX_SKILLS_COLLECTION_BYTES, SKILLS_COLLECTION_TIMEOUT_MS,
  type ProfileDetailsResult, type SkillsApiResult, type SkillsCollection,
} from './extra-api-model.js';

type Reason = Extract<ProfileDetailsResult, { status: 'error' }>['reason'];
type StopReason = SkillsCollection['stoppedReason'];
type JsonResult = { body: unknown } | { reason: Reason; stop: StopReason };
export interface ApiReadOptions { signal?: AbortSignal }
interface ReadBudget { bytes: number }
class ByteLimit extends Error {}
const optionalText = (max: number) => z.string().max(max).nullable().optional();
const profileResponse = z.object({
  user: z.object({ id: z.string().min(1).max(255), role: optionalText(200) }),
  bio: optionalText(300),
  interests: z.array(z.string().min(1).max(200)).max(10).nullable().optional(),
  partial: z.boolean().nullable().optional(),
});
const skillResponse = z.object({
  id: z.string().min(1).max(255),
  name: z.string().min(1).max(200),
  source: z.string().min(1).max(100),
  verification_method: optionalText(200),
  verified_by: optionalText(500),
  verified_at: z.iso.datetime({ offset: true }).nullable().optional(),
  visible: z.boolean().nullable().optional(),
  visibility: z.object({
    profile: z.boolean().nullable().optional(), skills: z.boolean().nullable().optional(),
  }).nullable().optional(),
});
const skillsResponse = z.object({
  items: z.array(z.unknown()),
  next_cursor: z.string().min(1).max(2048).nullable().optional(),
  partial: z.boolean().nullable().optional(),
});

function endpointAt(issuer: string, path: string): string {
  const url = new URL(path, issuer);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Untrusted API endpoint.');
  return url.href;
}
export const profileDetailsResource = (issuer: string): string => endpointAt(issuer, '/v1/me/profile');
export const skillsApiResource = (issuer: string): string => endpointAt(issuer, '/v1/me/skills');

/** A byte cap also limits unexpected upstream envelopes before we project their fields. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('API time budget exceeded.'));
    if (signal.aborted) { operation.catch(() => undefined); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function boundedJson(response: Response, signal: AbortSignal, budget?: ReadBudget): Promise<unknown> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > MAX_EXTRA_API_RESPONSE_BYTES ||
      (budget && declaredSize + budget.bytes > MAX_SKILLS_COLLECTION_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    throw new ByteLimit();
  }
  if (!response.body) throw new Error('Missing API response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (budget) budget.bytes += value.byteLength;
      if (total > MAX_EXTRA_API_RESPONSE_BYTES || (budget && budget.bytes > MAX_SKILLS_COLLECTION_BYTES)) {
        throw new ByteLimit();
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

async function readJson(
  endpoint: string, accessToken: string, scope: string, grantedScope: string | undefined, fetcher: typeof fetch,
  signal: AbortSignal = AbortSignal.timeout(5000), budget?: ReadBudget,
): Promise<JsonResult> {
  if (!grantedScope?.split(/\s+/).includes(scope)) return { reason: 'scope_missing', stop: 'upstream_error' };
  if (signal.aborted) return { reason: 'unavailable', stop: 'time_limit' };
  let response: Response;
  try {
    response = await abortable(fetcher(endpoint, {
      method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      redirect: 'error', cache: 'no-store', signal,
    }), signal);
  } catch { return { reason: 'unavailable', stop: signal.aborted ? 'time_limit' : 'upstream_error' }; }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    return { reason: response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'unavailable',
      stop: 'upstream_error' };
  }
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    void response.body?.cancel().catch(() => undefined);
    return { reason: 'invalid_response', stop: 'invalid_response' };
  }
  try { return { body: await boundedJson(response, signal, budget) }; } catch (error) {
    return { reason: signal.aborted ? 'unavailable' : 'invalid_response',
      stop: signal.aborted ? 'time_limit' : error instanceof ByteLimit ? 'byte_limit' : 'invalid_response' };
  }
}

export async function readProfileDetails(
  issuer: string, accessToken: string, grantedScope: string | undefined,
  expectedSubject: string, fetcher: typeof fetch = fetch,
  options: ApiReadOptions = {},
): Promise<ProfileDetailsResult> {
  const endpoint = profileDetailsResource(issuer);
  const signal = AbortSignal.any([AbortSignal.timeout(5000), ...(options.signal ? [options.signal] : [])]);
  const result = await readJson(endpoint, accessToken, 'user:profile', grantedScope, fetcher, signal);
  const snapshot = { subject: expectedSubject, endpoint, fetchedAt: new Date().toISOString() };
  if ('reason' in result) return { ...snapshot, status: 'error', reason: result.reason };
  const owner = z.object({ user: z.object({ id: z.string().min(1).max(255) }) }).safeParse(result.body);
  if (!owner.success) return { ...snapshot, status: 'error', reason: 'invalid_response' };
  if (owner.data.user.id !== expectedSubject) throw new LoginFailure('member_api');
  const parsed = profileResponse.safeParse(result.body);
  if (!parsed.success) return { ...snapshot, status: 'error', reason: 'invalid_response' };
  return {
    ...snapshot, status: 'success', partial: parsed.data.partial ?? null,
    profile: { bio: parsed.data.bio ?? null, role: parsed.data.user.role ?? null,
      interests: parsed.data.interests ?? null },
  };
}

export async function readSkillsApi(
  issuer: string, accessToken: string, grantedScope: string | undefined,
  expectedSubject: string, fetcher: typeof fetch = fetch,
  options: ApiReadOptions = {},
): Promise<SkillsApiResult> {
  const endpoint = skillsApiResource(issuer);
  const startedAt = new Date().toISOString();
  const signal = AbortSignal.any([AbortSignal.timeout(SKILLS_COLLECTION_TIMEOUT_MS),
    ...(options.signal ? [options.signal] : [])]);
  const budget: ReadBudget = { bytes: 0 };
  // This endpoint supplies no owner/sub. This is the OIDC-verified token subject used for the read.
  const snapshot = () => ({ subject: expectedSubject, endpoint, fetchedAt: new Date().toISOString() });
  type Success = Extract<SkillsApiResult, { status: 'success' }>;
  const items: Success['items'] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let returnedCount = 0;
  let duplicateCount = 0;
  let hasMore: boolean | null = null;
  let partial: boolean | null = false;
  const finish = (stoppedReason: StopReason): Success => ({
    ...snapshot(), status: 'success', partial, items, requestedLimit: SKILLS_PREVIEW_LIMIT,
    returnedCount, hasMore, truncated: stoppedReason !== 'cursor_exhausted',
    collection: { pages, startedAt, stoppedReason, duplicateCount },
  });
  const fail = (reason: Reason, stop: StopReason): SkillsApiResult => pages
    ? finish(stop) : { ...snapshot(), status: 'error', reason };

  for (;;) {
    if (signal.aborted) return fail('unavailable', 'time_limit');
    const requestUrl = new URL(endpoint);
    requestUrl.searchParams.set('limit', String(SKILLS_PREVIEW_LIMIT));
    if (cursor) requestUrl.searchParams.set('cursor', cursor);
    const result = await readJson(requestUrl.href, accessToken, 'user:skills', grantedScope, fetcher, signal, budget);
    if ('reason' in result) return fail(result.reason, result.stop);
    const parsed = skillsResponse.safeParse(result.body);
    if (!parsed.success) return fail('invalid_response', 'invalid_response');

    // Validate/project a page before committing it. A malformed later page must not
    // replace the already confirmed prefix, and duplicate ids never overwrite claims.
    const selected: Success['items'] = [];
    const pageIds = new Set<string>();
    let pageDuplicates = 0;
    let stopped: StopReason | undefined;
    for (const raw of parsed.data.items) {
      const rawId = z.object({ id: z.string().min(1).max(255) }).safeParse(raw);
      if (!rawId.success) return fail('invalid_response', 'invalid_response');
      if (ids.has(rawId.data.id) || pageIds.has(rawId.data.id)) { pageDuplicates++; continue; }
      if (items.length + selected.length >= MAX_SKILLS_SNAPSHOT_ITEMS) { stopped = 'item_limit'; break; }
      const parsedSkill = skillResponse.safeParse(raw);
      if (!parsedSkill.success) return fail('invalid_response', 'invalid_response');
      const skill = parsedSkill.data;
      const projected = skillSnapshotSchema.parse({
        id: skill.id, name: skill.name, source: skill.source,
        verificationMethod: skill.verification_method ?? null,
        verifiedBy: skill.verified_by ?? null, verifiedAt: skill.verified_at ?? null,
        visible: skill.visible ?? null,
        visibility: { profile: skill.visibility?.profile ?? null, skills: skill.visibility?.skills ?? null },
      });
      // Reserve space for collection metadata and later count/reason changes. The
      // shared schema separately enforces the exact final snapshot JSON byte limit.
      const candidate = { ...finish('byte_limit'), items: [...items, ...selected, projected] };
      if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_SKILLS_SNAPSHOT_BYTES - 1024) {
        stopped = 'byte_limit'; break;
      }
      selected.push(projected);
      pageIds.add(skill.id);
    }
    items.push(...selected);
    for (const id of pageIds) ids.add(id);
    duplicateCount += pageDuplicates;
    returnedCount += parsed.data.items.length;
    pages++;
    // Any true stays true; any unknown makes a false aggregate unknown.
    partial = partial === true || parsed.data.partial === true ? true
      : partial === null || parsed.data.partial == null ? null : false;
    hasMore = parsed.data.next_cursor === undefined ? null : parsed.data.next_cursor !== null;
    if (stopped) return finish(stopped);
    if (parsed.data.next_cursor === null) return finish('cursor_exhausted');
    if (parsed.data.next_cursor === undefined) return finish('unknown_cursor');
    if (items.length >= MAX_SKILLS_SNAPSHOT_ITEMS) return finish('item_limit');
    if (cursors.has(parsed.data.next_cursor)) return finish('cursor_cycle');
    if (pages >= MAX_SKILLS_COLLECTION_PAGES) return finish('page_limit');
    cursor = parsed.data.next_cursor;
    cursors.add(cursor);
  }
}
