import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MemoryStore, type Attempt, type Session } from '../src/store.js';
import { DynamoStore } from '../src/dynamo-store.js';
import type { ApiGrant } from '../src/api-grant.js';
import type { ProfileBioWriteResult } from '../src/profile-write.js';
import { checkedProfileWrite } from '../src/profile-write-notice.js';

const base = 'https://demo.example';
const issuer = 'https://issuer.example';
const config = loadConfig({ NODE_ENV: 'test', BASE_URL: base, OIDC_ISSUER: issuer });
const now = () => Math.floor(Date.now() / 1000);
const details = (bio: string) => ({ status: 'success' as const, subject: 'usr_test', endpoint: `${issuer}/v1/me/profile`,
  fetchedAt: new Date().toISOString(), partial: false, profile: { bio, role: '역할', interests: ['웹'] } });
const verified = (bio: string): ProfileBioWriteResult => ({ status: 'saved_verified', bio, profileDetails: details(bio) });
async function fixture(writeScope = true) {
  const id = randomBytes(32).toString('base64url');
  const session: Session = { expiresAt: now() + 1800, profile: { sub: 'usr_test', nickname: '회원' },
    verification: { issuer, audience: config.clientId, sub: 'usr_test', algorithm: 'RS256', signature: true,
      state: true, nonce: true, pkce: 'S256', issuerResponse: true, userInfoSubject: true,
      authenticatedAt: new Date().toISOString(), checkedAt: new Date().toISOString() },
    memberApi: { status: 'success', fetchedAt: new Date().toISOString(), profile: { id: 'usr_test', nickname: '회원', githubConnected: false } },
    profileDetails: details('원래 소개'), projectGoal: 'assistant',
    skillsApi: { status: 'success', subject: 'usr_test', endpoint: `${issuer}/v1/me/skills`, fetchedAt: new Date().toISOString(),
      partial: null, items: [], requestedLimit: 20, returnedCount: 0, hasMore: false, truncated: false } };
  const grant: ApiGrant = { subject: 'usr_test', issuer, clientId: config.clientId, accessToken: 'dgt_test_private_credential',
    scope: `openid profile user:profile user:skills${writeScope ? ' user:profile:write' : ''}`, expiresAt: now() + 900,
    resources: ['/v1/me', '/v1/me/profile', '/v1/me/skills', ...(writeScope ? ['/v1/me/profile/bio'] : [])].map(p => issuer + p) };
  const store = new MemoryStore();
  await store.putSession(id, session, grant);
  const provider = {
    authorizationUrl: vi.fn(async (_attempt: Attempt) => `${issuer}/authorize`),
    complete: vi.fn(async () => ({ ...session, apiGrant: grant })),
    writeProfileBio: vi.fn(async (_grant: ApiGrant, bio: string): Promise<ProfileBioWriteResult> => verified(bio)),
    readApis: vi.fn(async () => ({ profileDetails: details('재조회 소개') })),
  };
  const app = createApp(config, store, provider);
  const headers = { Origin: base, Cookie: `__Host-mizi_demo_session=${id}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  const post = (body = 'bio=새+소개', extra: Record<string, string> = {}) => app.request(`${base}/profile/bio`, { method: 'POST', headers: { ...headers, ...extra }, body });
  const get = (path = '/profile') => app.request(base + path, { headers: { Cookie: headers.Cookie } });
  return { app, store, session, grant, provider, id, headers, post, get };
}

describe('explicit bio write workflow', () => {
  it('only the explicit write connection requests write; consent never performs PATCH', async () => {
    const f = await fixture(false);
    for (const path of ['/login', '/connect-profile', '/connect-skills', '/connect-profile-write']) {
      expect((await f.app.request(base + path, { method: 'POST', headers: f.headers })).status).toBe(303);
    }
    const attempts = f.provider.authorizationUrl.mock.calls.map(([a]) => a);
    expect(attempts.slice(0, 3).every(a => a.writeProfileBio === undefined)).toBe(true);
    expect(attempts[3]).toMatchObject({ writeProfileBio: true, readMemberApi: true, readProfileDetails: true, readSkillsApi: true, returnPage: 'profile' });
    expect(f.provider.writeProfileBio).not.toHaveBeenCalled();
  });
  it('requires fresh explicit write permission before exposing or using an editor', async () => {
    const f = await fixture(false);
    const html = await (await f.get()).text();
    expect(html).toContain('내 소개 수정 허용하기');
    expect(html).not.toContain('action="/profile/bio"');
    expect(await (await f.post()).text()).toContain('입력한 내용은 아래에 남겨두었습니다');
    expect(f.provider.writeProfileBio).not.toHaveBeenCalled();
  });
  it.each(['  공백 보존  ', '', '</textarea><script>alert(1)</script>'])('saves exact input with verified readback and PRG; preserves unrelated state: %s', async bio => {
    const f = await fixture();
    const response = await f.post(new URLSearchParams({ bio }).toString());
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${base}/profile#profile-editor`);
    expect(f.provider.writeProfileBio).toHaveBeenCalledExactlyOnceWith(f.grant, bio);
    const saved = await f.store.getSession(f.id, now());
    expect(saved).toMatchObject({ profileWrite: { status: 'saved_verified', draft: bio }, profileDetails: { profile: { bio } },
      projectGoal: f.session.projectGoal, skillsApi: f.session.skillsApi, expiresAt: f.session.expiresAt });
    const html = await (await f.get()).text();
    expect(html).toContain('다시 읽어 반영된 내용까지 확인했어요');
    expect(html).not.toContain(f.grant.accessToken);
    expect(html).not.toContain('</textarea><script>');
    expect(f.provider.writeProfileBio).toHaveBeenCalledTimes(1); // GET never resubmits
  });
  it.each([
    ['bio=' + 'a'.repeat(301), 400], [new URLSearchParams({ bio: '😀'.repeat(151) }).toString(), 400],
    ['bio=x&bio=y', 400], ['bio=x&nickname=changed', 400], ['nickname=x', 400], ['bio=' + 'x'.repeat(4100), 413],
  ])('rejects malformed/oversize requests without calling MiZi: %s', async (body, status) => {
    const f = await fixture(); expect((await f.post(body)).status).toBe(status);
    expect(f.provider.writeProfileBio).not.toHaveBeenCalled();
  });
  it('rejects foreign Origin, unsupported MIME, and missing sessions', async () => {
    const f = await fixture();
    expect((await f.post('bio=x', { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await f.post('{}', { 'Content-Type': 'application/json' })).status).toBe(415);
    expect((await f.post('bio=x', { Cookie: '' })).headers.get('location')).toContain('session_expired');
    expect(f.provider.writeProfileBio).not.toHaveBeenCalled();
  });
  it.each([
    { status: 'saved_unverified', reason: 'readback_failed' },
    { status: 'unknown', reason: 'unavailable' },
    { status: 'not_saved', reason: 'rejected' },
  ] as const)('preserves draft and previous snapshot without false verified success: $status', async result => {
    const f = await fixture(); f.provider.writeProfileBio.mockResolvedValueOnce(result);
    expect((await f.post()).status).toBe(303);
    const saved = await f.store.getSession(f.id, now());
    expect(saved).toMatchObject({ profileWrite: { status: result.status, draft: '새 소개' }, profileDetails: f.session.profileDetails });
    expect(await (await f.get()).text()).not.toContain('다시 읽어 반영된 내용까지 확인했어요');
    expect(f.provider.writeProfileBio).toHaveBeenCalledTimes(1);
  });
  it('retains draft when token preparation fails before any PATCH', async () => {
    const f = await fixture();
    vi.spyOn(f.store, 'getApiGrant').mockRejectedValueOnce(new Error('temporary private store error'));
    const response = await f.post('bio=temporary-draft');
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain('temporary-draft</textarea>');
    expect(html).toContain('잠시 후 다시 저장해 주세요');
    expect(html).not.toContain('private store error');
    expect(f.provider.writeProfileBio).not.toHaveBeenCalled();
  });
  it('does not turn a query parameter into a saved receipt', async () => {
    const f = await fixture();
    expect(await (await f.get('/profile?write_status=saved_verified&bio=forged')).text()).not.toContain('다시 읽어 반영된 내용까지 확인했어요');
  });
  it('clears rejected credentials while keeping a safe receipt and login', async () => {
    const f = await fixture(); f.provider.writeProfileBio.mockResolvedValueOnce({ status: 'not_saved', reason: 'forbidden' });
    await f.post();
    expect(await f.store.getApiGrant(f.id, 'usr_test', now())).toBeNull();
    expect(await f.store.getSession(f.id, now())).toMatchObject({ profileWrite: { status: 'not_saved' }, projectGoal: 'assistant' });
  });
  it('does not recreate a logged-out session when PATCH returns late', async () => {
    const f = await fixture(); f.provider.writeProfileBio.mockImplementationOnce(async (_g, bio) => {
      await f.store.deleteSession(f.id); return verified(bio);
    });
    expect((await f.post()).status).toBe(409);
    expect(await f.store.getSession(f.id, now())).toBeNull();
  });
  it('reports uncertainty if receipt storage fails after successful PATCH', async () => {
    const f = await fixture(); vi.spyOn(f.store, 'saveProfileWrite').mockRejectedValueOnce(new Error('private failure'));
    const response = await f.post(); expect(response.status).toBe(409);
    expect(await response.text()).toContain('반영됐을 수 있으니');
    expect(f.provider.writeProfileBio).toHaveBeenCalledTimes(1);
  });
  it('an older in-flight profile read cannot replace the newly saved bio', async () => {
    const f = await fixture();
    let finishRead!: (value: { profileDetails: ReturnType<typeof details> }) => void;
    f.provider.readApis.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
    const reading = f.app.request(base + '/refresh-profile', { method: 'POST', headers: f.headers });
    await vi.waitFor(() => expect(f.provider.readApis).toHaveBeenCalledTimes(1));
    await f.post('bio=newly-saved');
    finishRead({ profileDetails: details('older-read') });
    expect((await reading).headers.get('location')).toContain('invalid_response');
    expect(await f.store.getSession(f.id, now())).toMatchObject({ profileDetails: { profile: { bio: 'newly-saved' } }, profileWrite: { status: 'saved_verified' } });
  });
  it('successful profile re-read replaces the snapshot and removes stale receipt/draft', async () => {
    const f = await fixture(); await f.post();
    await f.app.request(base + '/refresh-profile', { method: 'POST', headers: f.headers });
    const saved = await f.store.getSession(f.id, now());
    expect(saved?.profileWrite).toBeUndefined();
    expect(saved?.profileDetails).toMatchObject({ profile: { bio: '재조회 소개' } });
  });
});

describe('write receipt storage', () => {
  const receipt = { id: 'r'.repeat(43), status: 'saved_verified' as const, draft: '새 소개', attemptedAt: new Date().toISOString() };
  it('rejects forged verified receipts and foreign snapshots before storage', () => {
    expect(() => checkedProfileWrite(receipt, 'usr_test')).toThrow();
    expect(() => checkedProfileWrite(receipt, 'usr_other', details(receipt.draft))).toThrow();
    expect(() => checkedProfileWrite(receipt, 'usr_test', details('다른 소개'))).toThrow();
    expect(() => checkedProfileWrite({ ...receipt, status: 'unknown' }, 'usr_test', details(receipt.draft))).toThrow();
    expect(() => checkedProfileWrite({ ...receipt, draft: '😀'.repeat(151) }, 'usr_test', details('😀'.repeat(151)))).toThrow();
  });
  it('memory rejects stale credentials, expired/deleted sessions, and wrong subject', async () => {
    const f = await fixture();
    for (const [sub, token, at] of [['usr_other', f.grant.accessToken, now()], ['usr_test', 'old_token', now()], ['usr_test', f.grant.accessToken, f.session.expiresAt]] as const) {
      expect(await f.store.saveProfileWrite(f.id, sub, token, { ...receipt, status: 'unknown' }, undefined, at)).toBe(false);
    }
    await f.store.clearApiGrant(f.id, 'usr_test', now(), f.grant.accessToken);
    expect(await f.store.saveProfileWrite(f.id, 'usr_test', f.grant.accessToken, receipt, details(receipt.draft), now())).toBe(false);
  });
  it('Dynamo atomically binds receipt+snapshot to the existing subject and token, and does not fall back to Put', async () => {
    const send = vi.fn(async (_command: unknown): Promise<Record<string, unknown>> => ({}));
    const store = new DynamoStore('test-table', { send } as unknown as DynamoDBDocumentClient);
    expect(await store.saveProfileWrite('opaque', 'usr_test', 'expected-token', receipt, details(receipt.draft), now())).toBe(true);
    const command = send.mock.calls[0]![0] as UpdateCommand;
    expect(command).toBeInstanceOf(UpdateCommand);
    expect(command.input.UpdateExpression).toBe('SET #write = :write, #writeRevision = :writeRevision, #details = :details');
    expect(command.input.ConditionExpression).toContain('attribute_exists(pk) AND expiresAt > :now');
    expect(command.input.ConditionExpression).toContain('#profile.#sub = :subject');
    expect(command.input.ConditionExpression).toContain('#grant.#token = :token');
    send.mockRejectedValueOnce(Object.assign(new Error('race'), { name: 'ConditionalCheckFailedException' }));
    expect(await store.saveProfileWrite('opaque', 'usr_test', 'expected-token', receipt, details(receipt.draft), now())).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    await store.getSession('opaque', now());
    expect((send.mock.calls[2]![0] as GetCommand).input.ProjectionExpression).toContain('#write');
  });
});
