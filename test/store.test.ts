import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoStore } from '../src/dynamo-store.js';
import { loadConfig } from '../src/config.js';
import { digest, MemoryStore, type Attempt, type Session } from '../src/store.js';

const now = Math.floor(Date.now() / 1000);
const attempt: Attempt = { state: 's'.repeat(43), nonce: 'n'.repeat(43), codeVerifier: 'v'.repeat(43),
  bindingHash: digest('b'.repeat(43)), expiresAt: now + 600 };
const session: Session = {
  expiresAt: now + 1800, profile: { sub: 'usr_verified', nickname: '닉네임' },
  verification: { issuer: 'https://issuer.example', audience: 'mzp_client', sub: 'usr_verified', algorithm: 'RS256',
    signature: true, nonce: true, pkce: 'S256', state: true, issuerResponse: true, userInfoSubject: true,
    authenticatedAt: new Date().toISOString(), checkedAt: new Date().toISOString() },
};

function dynamoFixture(result: Record<string, unknown> = {}) {
  const send = vi.fn(async (_command: unknown) => result);
  const store = new DynamoStore('sessions', { send } as unknown as DynamoDBDocumentClient);
  return { send, store };
}

describe('DynamoDB store enforces expiry and atomic one-time browser binding', () => {
  it('consumes a matching unexpired attempt using a single conditional DeleteItem returning ALL_OLD', async () => {
    const f = dynamoFixture({ Attributes: { pk: 'ignored', ...attempt } });
    expect(await f.store.consumeAttempt(attempt.state, attempt.bindingHash, now)).toEqual(attempt);
    expect(f.send).toHaveBeenCalledTimes(1);
    const command = f.send.mock.calls[0]![0] as DeleteCommand;
    expect(command).toBeInstanceOf(DeleteCommand);
    expect(command.input).toEqual({
      TableName: 'sessions', Key: { pk: `attempt:${digest(attempt.state)}` },
      ConditionExpression: 'attribute_exists(pk) AND expiresAt > :now AND bindingHash = :binding',
      ExpressionAttributeValues: { ':now': now, ':binding': attempt.bindingHash }, ReturnValues: 'ALL_OLD',
    });
  });
  it('handles expired, mismatched or already-consumed conditional failures without a second mutation', async () => {
    const f = dynamoFixture();
    f.send.mockRejectedValueOnce(Object.assign(new Error('conditional check failed'), { name: 'ConditionalCheckFailedException' }));
    expect(await f.store.consumeAttempt(attempt.state, attempt.bindingHash, now)).toBeNull();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.send.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(f.store.consumeAttempt(attempt.state, attempt.bindingHash, now)).rejects.toThrow('storage unavailable');
  });
  it('checks session expiry itself and requests a strongly consistent read after logout', async () => {
    const f = dynamoFixture({ Item: { ...session, expiresAt: now } });
    expect(await f.store.getSession('opaque-session', now)).toBeNull();
    const command = f.send.mock.calls[0]![0] as GetCommand;
    expect(command.input).toMatchObject({ ConsistentRead: true, Key: { pk: `session:${digest('opaque-session')}` } });
    f.send.mockResolvedValueOnce({ Item: session });
    expect(await f.store.getSession('opaque-session', now)).toEqual(session);
  });
  it('persists only profile/verification fields and a hashed session id, with TTL and collision prevention', async () => {
    const f = dynamoFixture();
    await f.store.putSession('raw-browser-session', { ...session, access_token: 'DO-NOT-PERSIST', id_token: 'DO-NOT-PERSIST' } as Session);
    const command = f.send.mock.calls[0]![0] as PutCommand;
    expect(command).toBeInstanceOf(PutCommand);
    expect(command.input).toMatchObject({ ConditionExpression: 'attribute_not_exists(pk)',
      Item: { pk: `session:${digest('raw-browser-session')}`, expiresAt: session.expiresAt } });
    const serialized = JSON.stringify(command.input);
    expect(serialized).not.toContain('raw-browser-session');
    expect(serialized).not.toContain('DO-NOT-PERSIST');
    await f.store.putAttempt(attempt);
    expect((f.send.mock.calls[1]![0] as PutCommand).input).toMatchObject({
      Item: { pk: `attempt:${digest(attempt.state)}`, expiresAt: attempt.expiresAt, bindingHash: attempt.bindingHash },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    await f.store.deleteSession('raw-browser-session');
    expect((f.send.mock.calls[2]![0] as DeleteCommand).input.Key).toEqual({ pk: `session:${digest('raw-browser-session')}` });
  });
});

describe('local store', () => {
  it('keeps API snapshots bound to the session subject and accepts sessions created before extra APIs existed', async () => {
    const store = new MemoryStore();
    await store.putSession('old', session);
    expect(await store.getSession('old', now)).toEqual(session);
    const profileDetails = { status: 'success' as const, subject: session.profile.sub,
      endpoint: 'https://issuer.example/v1/me/profile', fetchedAt: new Date().toISOString(), partial: false,
      profile: { bio: '소개', role: null, interests: [] } };
    const skillsApi = { status: 'success' as const, subject: session.profile.sub,
      endpoint: 'https://issuer.example/v1/me/skills', fetchedAt: new Date().toISOString(), partial: null,
      items: [], requestedLimit: 20 as const, returnedCount: 0, hasMore: false, truncated: false };
    await store.putSession('new', { ...session, profileDetails, skillsApi });
    expect(await store.getSession('new', now)).toMatchObject({ profileDetails, skillsApi });
    await expect(store.putSession('bad-profile', { ...session,
      profileDetails: { ...profileDetails, subject: 'other-user' } })).rejects.toThrow();
    await expect(store.putSession('bad-skills', { ...session,
      skillsApi: { ...skillsApi, subject: 'other-user' } })).rejects.toThrow();
  });

  it('stores only fixed local return pages for optional API attempts', async () => {
    const store = new MemoryStore();
    await expect(store.putAttempt({ ...attempt, returnPage: 'https://attacker.example' } as unknown as Attempt)).rejects.toThrow();
    const selected: Attempt = { ...attempt, returnPage: 'skills', readMemberApi: true, readProfileDetails: true, readSkillsApi: true };
    await store.putAttempt(selected);
    expect(await store.consumeAttempt(attempt.state, attempt.bindingHash, now)).toEqual(selected);
  });

  it('requires matching API identity and an unexpired session for a project update without extending its TTL', async () => {
    const store = new MemoryStore();
    const own = { ...session, memberApi: { status: 'success' as const, fetchedAt: new Date().toISOString(),
      profile: { id: session.profile.sub, nickname: '회원', githubConnected: null } } };
    await store.putSession('one', own);
    expect(await store.setProjectGoal('one', 'wrong-member', 'website', now)).toBe(false);
    expect(await store.setProjectGoal('one', session.profile.sub, 'website', own.expiresAt)).toBe(false);
    expect(await store.setProjectGoal('one', session.profile.sub, 'assistant', now)).toBe(true);
    expect(await store.getSession('one', now)).toMatchObject({ projectGoal: 'assistant', expiresAt: own.expiresAt });
    await store.deleteSession('one');
    expect(await store.setProjectGoal('one', session.profile.sub, 'website', now)).toBe(false);
    await expect(store.putSession('bad', { ...own, memberApi: { ...own.memberApi,
      profile: { ...own.memberApi.profile, id: 'wrong-member' } } })).rejects.toThrow();
  });
  it('does not consume a mismatched attempt and gives only one concurrent caller the valid attempt', async () => {
    const store = new MemoryStore();
    await store.putAttempt(attempt);
    expect(await store.consumeAttempt(attempt.state, 'wrong-browser', now)).toBeNull();
    expect(await store.consumeAttempt(attempt.state, attempt.bindingHash, now + 600)).toBeNull();
    const results = await Promise.all([1, 2].map(() => store.consumeAttempt(attempt.state, attempt.bindingHash, now)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

it('updates only the own-session project field with atomic expiry and member conditions in DynamoDB', async () => {
  const f = dynamoFixture();
  expect(await f.store.setProjectGoal('raw-session', session.profile.sub, 'automation', now)).toBe(true);
  const command = f.send.mock.calls[0]![0] as UpdateCommand;
  expect(command).toBeInstanceOf(UpdateCommand);
  expect(command.input.Key).toEqual({ pk: `session:${digest('raw-session')}` });
  expect(command.input.UpdateExpression).toBe('SET #goal = :goal');
  expect(command.input.ConditionExpression).toContain('attribute_exists(pk) AND expiresAt > :now');
  expect(command.input.ConditionExpression).toContain('#api.#profile.#id = :subject');
  expect(command.input.ExpressionAttributeValues).toMatchObject({ ':subject': session.profile.sub, ':goal': 'automation', ':now': now });
  f.send.mockRejectedValueOnce(Object.assign(new Error('expired or removed'), { name: 'ConditionalCheckFailedException' }));
  expect(await f.store.setProjectGoal('raw-session', session.profile.sub, 'website', now)).toBe(false);
});

describe('trusted environment configuration', () => {
  it('requires shared storage and HTTPS in production; derives callback and CIMD id from BASE_URL', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', BASE_URL: 'https://demo.example' })).toThrow('SESSION_TABLE');
    const configured = loadConfig({ NODE_ENV: 'production', BASE_URL: 'https://demo.example', SESSION_TABLE: 'sessions' });
    expect(configured.callbackUrl).toBe('https://demo.example/auth/callback');
    expect(configured.clientId).toBe('https://demo.example/client.json');
    expect(configured.secureCookies).toBe(true);
    expect(loadConfig({ BASE_URL: 'http://localhost:3000', CLIENT_ID: 'mzp_registered' }).clientId).toBe('mzp_registered');
  });
  it.each([
    { NODE_ENV: 'production', BASE_URL: 'http://localhost:3000', SESSION_TABLE: 'sessions' },
    { BASE_URL: 'http://public.example' }, { BASE_URL: 'https://user:secret@example.test' },
    { BASE_URL: 'https://example.test/path' }, { BASE_URL: 'https://example.test?query=value' },
    { OIDC_ISSUER: 'http://issuer.example' }, { OIDC_ISSUER: 'https://issuer.example/' },
  ])('rejects invalid trusted URL configuration %j', (env) => {
    expect(() => loadConfig(env)).toThrow();
  });
});
