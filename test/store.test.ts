import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoStore } from '../src/dynamo-store.js';
import { loadConfig } from '../src/config.js';
import { digest, MemoryStore, type Attempt, type Session } from '../src/store.js';
import type { ApiGrant } from '../src/api-grant.js';
import type { ApiSnapshotPatch } from '../src/session-api.js';

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

const apiSession: Session = {
  ...session,
  memberApi: { status: 'success', fetchedAt: '2026-09-19T00:00:00.000Z',
    profile: { id: session.profile.sub, nickname: '이전 닉네임', githubConnected: false } },
  profileDetails: { status: 'success', subject: session.profile.sub,
    endpoint: 'https://issuer.example/v1/me/profile', fetchedAt: '2026-09-19T00:00:01.000Z', partial: false,
    profile: { bio: '이전 소개', role: null, interests: ['웹'] } },
  skillsApi: { status: 'success', subject: session.profile.sub, endpoint: 'https://issuer.example/v1/me/skills',
    fetchedAt: '2026-09-19T00:00:02.000Z', partial: null, items: [], requestedLimit: 20,
    returnedCount: 0, hasMore: false, truncated: false },
  projectGoal: 'assistant',
};
const apiGrant: ApiGrant = {
  accessToken: 'dgt_synthetic_test_credential', scope: 'openid profile user:profile user:skills',
  subject: session.profile.sub, issuer: session.verification.issuer, clientId: session.verification.audience,
  resources: ['https://issuer.example/v1/me', 'https://issuer.example/v1/me/profile', 'https://issuer.example/v1/me/skills'],
  expiresAt: now + 900,
};
const memberUpdate: ApiSnapshotPatch = {
  memberApi: { status: 'success', fetchedAt: '2026-09-19T00:10:00.000Z',
    profile: { id: session.profile.sub, nickname: '새 닉네임', githubConnected: true } },
};
const conditionalFailure = () => Object.assign(new Error('condition failed'), { name: 'ConditionalCheckFailedException' });

describe('private API grant and public session boundaries', () => {
  it('returns only non-secret connection metadata and clones both public and private reads in memory', async () => {
    const store = new MemoryStore();
    await store.putSession('api-session', apiSession, apiGrant);
    const publicView = await store.getSession('api-session', now);
    expect(publicView).toEqual({ ...apiSession,
      apiAccess: { scope: apiGrant.scope, resources: apiGrant.resources, expiresAt: apiGrant.expiresAt } });
    expect(JSON.stringify(publicView)).not.toContain(apiGrant.accessToken);
    expect(publicView).not.toHaveProperty('apiGrant');
    const privateView = await store.getApiGrant('api-session', session.profile.sub, now);
    expect(privateView).toEqual(apiGrant);
    privateView!.accessToken = 'modified-read';
    publicView!.profile.nickname = 'modified-public-read';
    expect((await store.getApiGrant('api-session', session.profile.sub, now))!.accessToken).toBe(apiGrant.accessToken);
    expect((await store.getSession('api-session', now))!.profile.nickname).toBe(apiSession.profile.nickname);
    expect(await store.getApiGrant('api-session', 'different-member', now)).toBeNull();
  });

  it('writes credentials only in a private Dynamo attribute and excludes them in normal reads', async () => {
    const f = dynamoFixture();
    await f.store.putSession('raw-session-id', apiSession, apiGrant);
    const put = f.send.mock.calls[0]![0] as PutCommand;
    const item = put.input.Item!;
    expect(item.apiGrant).toEqual(apiGrant);
    expect(item.apiAccess).toEqual({ scope: apiGrant.scope, resources: apiGrant.resources, expiresAt: apiGrant.expiresAt });
    expect(item.apiAccess).not.toHaveProperty('accessToken');
    expect(item.pk).toBe(`session:${digest('raw-session-id')}`);
    expect(put.input.ConditionExpression).toBe('attribute_not_exists(pk)');
    // Even an over-broad database result must be stripped by the public parser.
    f.send.mockResolvedValueOnce({ Item: { ...item, access_token: 'extra-private-field' } });
    const publicView = await f.store.getSession('raw-session-id', now);
    expect(JSON.stringify(publicView)).not.toContain(apiGrant.accessToken);
    expect(JSON.stringify(publicView)).not.toContain('extra-private-field');
    expect(publicView).toMatchObject({ projectGoal: 'assistant', expiresAt: session.expiresAt });
    const get = f.send.mock.calls[1]![0] as GetCommand;
    expect(get.input.ConsistentRead).toBe(true);
    expect(Object.values(get.input.ExpressionAttributeNames!)).not.toContain('apiGrant');
    expect(get.input.ProjectionExpression).not.toContain('#grant');
    f.send.mockResolvedValueOnce({ Item: item });
    expect(await f.store.getApiGrant('raw-session-id', session.profile.sub, now)).toEqual(apiGrant);
    const privateGet = f.send.mock.calls[2]![0] as GetCommand;
    expect(privateGet.input.ConsistentRead).toBe(true);
    expect(Object.values(privateGet.input.ExpressionAttributeNames!)).toContain('apiGrant');
  });

  it.each(['memory', 'dynamo'] as const)('binds %s credentials to subject, issuer and client before persisting', async (kind) => {
    for (const override of [{ subject: 'other-member' }, { issuer: 'https://other.example' }, { clientId: 'other-client' }]) {
      const f = dynamoFixture();
      const store = kind === 'memory' ? new MemoryStore() : f.store;
      await expect(store.putSession('bound', apiSession, { ...apiGrant, ...override })).rejects.toThrow('identity mismatch');
      if (kind === 'memory') expect(await store.getSession('bound', now)).toBeNull();
      else expect(f.send).not.toHaveBeenCalled();
    }
  });

  it.each(['memory', 'dynamo'] as const)('clamps %s grant lifetime to the earlier token or session expiry', async (kind) => {
    for (const tokenExpiresAt of [now + 30, session.expiresAt + 3600]) {
      const f = dynamoFixture();
      const store = kind === 'memory' ? new MemoryStore() : f.store;
      await store.putSession('clamped', apiSession, { ...apiGrant, expiresAt: tokenExpiresAt });
      const expectedExpiry = Math.min(tokenExpiresAt, session.expiresAt);
      if (kind === 'memory') {
        expect((await store.getApiGrant('clamped', session.profile.sub, now))!.expiresAt).toBe(expectedExpiry);
        expect((await store.getSession('clamped', now))!.apiAccess!.expiresAt).toBe(expectedExpiry);
        expect(await store.getApiGrant('clamped', session.profile.sub, expectedExpiry)).toBeNull();
      } else {
        const item = (f.send.mock.calls[0]![0] as PutCommand).input.Item!;
        expect(item.apiGrant.expiresAt).toBe(expectedExpiry);
        expect(item.apiAccess.expiresAt).toBe(expectedExpiry);
        expect(item.expiresAt).toBe(session.expiresAt);
      }
    }
  });

  it.each(['memory', 'dynamo'] as const)('keeps %s legacy sessions usable without accepting forged public capability metadata', async (kind) => {
    const f = dynamoFixture();
    const store = kind === 'memory' ? new MemoryStore() : f.store;
    const forged = { ...apiSession, apiAccess: { scope: apiGrant.scope, resources: apiGrant.resources, expiresAt: apiGrant.expiresAt } };
    await store.putSession('legacy', forged);
    if (kind === 'dynamo') {
      const item = (f.send.mock.calls[0]![0] as PutCommand).input.Item!;
      expect(item).not.toHaveProperty('apiGrant');
      expect(item).not.toHaveProperty('apiAccess');
      f.send.mockResolvedValue({ Item: item });
    }
    expect(await store.getSession('legacy', now)).toEqual(apiSession);
    expect(await store.getApiGrant('legacy', session.profile.sub, now)).toBeNull();
  });

  it('rejects expired or mismatched private Dynamo records while TTL deletion is still pending', async () => {
    for (const item of [
      { ...apiSession, apiGrant: { ...apiGrant, expiresAt: now } },
      { ...apiSession, expiresAt: now, apiGrant },
      { ...apiSession, profile: { sub: 'other-member' }, apiGrant },
      { ...apiSession, apiGrant: { ...apiGrant, subject: 'other-member' } },
      { ...apiSession, apiGrant: { ...apiGrant, accessToken: 'invalid\ncredential' } },
      apiSession,
    ]) {
      const f = dynamoFixture({ Item: item });
      expect(await f.store.getApiGrant('stale', session.profile.sub, now)).toBeNull();
      // A valid but expired access-only grant is conditionally removed; malformed
      // or other-member records are never mutated by this read.
      if ('apiGrant' in item && item.apiGrant?.expiresAt === now && item.expiresAt > now) {
        expect(f.send).toHaveBeenCalledTimes(2);
        const cleanup = f.send.mock.calls[1]![0] as UpdateCommand;
        expect(cleanup.input.ConditionExpression).toContain('#grant.#token = :token');
      } else expect(f.send).toHaveBeenCalledTimes(1);
    }
  });
});

describe('conditional API snapshot updates', () => {
  it('updates successful fields only while preserving other snapshots, project choice and expiry', async () => {
    const store = new MemoryStore();
    await store.putSession('refresh', apiSession, apiGrant);
    const before = await store.getSession('refresh', now);
    expect(await store.saveApiResults('refresh', session.profile.sub, apiGrant.expiresAt, memberUpdate, now)).toBe(true);
    expect(await store.getSession('refresh', now)).toEqual({ ...before, ...memberUpdate });
    expect(await store.getApiGrant('refresh', session.profile.sub, now)).toEqual(apiGrant);
    const partialSkills: ApiSnapshotPatch = { skillsApi: { ...apiSession.skillsApi!, status: 'success',
      subject: session.profile.sub, endpoint: 'https://issuer.example/v1/me/skills', fetchedAt: '2026-09-19T00:20:00.000Z',
      partial: null, items: [], requestedLimit: 20, returnedCount: 0, hasMore: true, truncated: true,
      collection: { pages: 1, startedAt: '2026-09-19T00:19:59.000Z', stoppedReason: 'upstream_error', duplicateCount: 0 } } };
    expect(await store.saveApiResults('refresh', session.profile.sub, apiGrant.expiresAt, partialSkills, now)).toBe(true);
    expect(await store.getSession('refresh', now)).toEqual({ ...before, ...memberUpdate, ...partialSkills });
  });

  it('rejects unsuccessful, empty and foreign-subject updates before they overwrite prior results', async () => {
    const store = new MemoryStore();
    await store.putSession('refresh', apiSession, apiGrant);
    const before = await store.getSession('refresh', now);
    const patches: ApiSnapshotPatch[] = [
      {},
      { memberApi: { status: 'error', reason: 'unavailable', fetchedAt: '2026-09-19T00:20:00.000Z' } },
      { memberApi: { status: 'success', fetchedAt: '2026-09-19T00:20:00.000Z', profile: { id: 'other', nickname: 'other', githubConnected: true } } },
      { profileDetails: { status: 'error', subject: session.profile.sub, endpoint: 'https://issuer.example/v1/me/profile',
        fetchedAt: '2026-09-19T00:20:00.000Z', reason: 'unavailable' } },
      { skillsApi: { status: 'error', subject: session.profile.sub, endpoint: 'https://issuer.example/v1/me/skills',
        fetchedAt: '2026-09-19T00:20:00.000Z', reason: 'forbidden' } },
    ];
    for (const patch of patches) {
      await expect(store.saveApiResults('refresh', session.profile.sub, apiGrant.expiresAt, patch, now)).rejects.toThrow();
      expect(await store.getSession('refresh', now)).toEqual(before);
      const f = dynamoFixture();
      await expect(f.store.saveApiResults('refresh', session.profile.sub, apiGrant.expiresAt, patch, now)).rejects.toThrow();
      expect(f.send).not.toHaveBeenCalled();
    }
  });

  it('does not accept session or credential mutations hidden beside an allowed API patch', async () => {
    const store = new MemoryStore();
    await store.putSession('refresh', apiSession, apiGrant);
    const before = await store.getSession('refresh', now);
    const extra = { ...memberUpdate, expiresAt: now + 99999, projectGoal: 'website',
      apiGrant: { ...apiGrant, accessToken: 'replacement' }, apiAccess: { scope: 'changed' } };
    expect(await store.saveApiResults('refresh', session.profile.sub, apiGrant.expiresAt, extra, now)).toBe(true);
    expect(await store.getSession('refresh', now)).toEqual({ ...before, ...memberUpdate });
    expect(await store.getApiGrant('refresh', session.profile.sub, now)).toEqual(apiGrant);
  });

  it('lets logout or credential removal win over an in-flight API response', async () => {
    for (const removed of ['logout', 'grant'] as const) {
      const store = new MemoryStore();
      await store.putSession('in-flight', apiSession, apiGrant);
      const capturedGrant = await store.getApiGrant('in-flight', session.profile.sub, now);
      expect(capturedGrant).not.toBeNull();
      if (removed === 'logout') await store.deleteSession('in-flight');
      else await store.clearApiGrant('in-flight', session.profile.sub, now);
      expect(await store.saveApiResults('in-flight', session.profile.sub, capturedGrant!.expiresAt, memberUpdate, now)).toBe(false);
      expect(await store.getApiGrant('in-flight', session.profile.sub, now)).toBeNull();
      expect(await store.getSession('in-flight', now)).toEqual(removed === 'logout' ? null : apiSession);
    }
  });

  it('does not write after token/session expiry, for another session owner, or against a different grant generation', async () => {
    const store = new MemoryStore();
    await store.putSession('refresh', apiSession, apiGrant);
    for (const when of [apiGrant.expiresAt, session.expiresAt]) {
      expect(await store.saveApiResults('refresh', session.profile.sub, apiGrant.expiresAt, memberUpdate, when)).toBe(false);
    }
    expect(await store.saveApiResults('refresh', session.profile.sub, apiGrant.expiresAt + 1, memberUpdate, now)).toBe(false);
    const foreignPatch: ApiSnapshotPatch = { memberApi: { status: 'success', fetchedAt: '2026-09-19T00:20:00.000Z',
      profile: { id: 'other-member', nickname: 'other', githubConnected: false } } };
    expect(await store.saveApiResults('refresh', 'other-member', apiGrant.expiresAt, foreignPatch, now)).toBe(false);
    await store.clearApiGrant('refresh', 'other-member', now);
    expect(await store.getApiGrant('refresh', session.profile.sub, now)).toEqual(apiGrant);
    expect((await store.getSession('refresh', now))!.memberApi).toEqual(apiSession.memberApi);
  });

  it('conditions Dynamo updates on the still-live same-owner grant without writing expiry or project fields', async () => {
    const f = dynamoFixture();
    expect(await f.store.saveApiResults('raw-session', session.profile.sub, apiGrant.expiresAt, memberUpdate, now)).toBe(true);
    const command = f.send.mock.calls[0]![0] as UpdateCommand;
    expect(command).toBeInstanceOf(UpdateCommand);
    expect(command.input.Key).toEqual({ pk: `session:${digest('raw-session')}` });
    expect(command.input.ConditionExpression).toContain('attribute_exists(pk) AND expiresAt > :now');
    expect(command.input.ConditionExpression).toContain('#profile.#sub = :subject');
    expect(command.input.ConditionExpression).toContain('#grant.#grantSubject = :subject');
    expect(command.input.ConditionExpression).toContain('#grant.#grantExpiry = :grantExpiry');
    expect(command.input.ConditionExpression).toContain('#grant.#grantExpiry > :now');
    expect(command.input.ExpressionAttributeValues).toMatchObject({ ':now': now, ':subject': session.profile.sub, ':grantExpiry': apiGrant.expiresAt });
    const assigned = command.input.UpdateExpression!.replace(/^SET /, '').split(', ').map((entry) => entry.split(' = ')[0]!);
    expect(assigned.map((alias) => command.input.ExpressionAttributeNames![alias])).toEqual(['memberApi']);
    expect(JSON.stringify(command.input)).not.toContain(apiGrant.accessToken);
    f.send.mockRejectedValueOnce(conditionalFailure());
    expect(await f.store.saveApiResults('raw-session', session.profile.sub, apiGrant.expiresAt, memberUpdate, now)).toBe(false);
    f.send.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(f.store.saveApiResults('raw-session', session.profile.sub, apiGrant.expiresAt, memberUpdate, now)).rejects.toThrow('storage unavailable');
  });

  it('clears only private grant and public capabilities with an atomic owner/expiry condition in Dynamo', async () => {
    const f = dynamoFixture();
    await f.store.clearApiGrant('raw-session', session.profile.sub, now);
    const command = f.send.mock.calls[0]![0] as UpdateCommand;
    expect(command.input.UpdateExpression).toBe('REMOVE #grant, #access, #refresh');
    expect(command.input.ExpressionAttributeNames).toMatchObject({ '#grant': 'apiGrant', '#access': 'apiAccess' });
    expect(command.input.ConditionExpression).toContain('attribute_exists(pk) AND expiresAt > :now');
    expect(command.input.ConditionExpression).toContain('#profile.#sub = :subject');
    expect(command.input.ExpressionAttributeValues).toEqual({ ':now': now, ':subject': session.profile.sub });
    f.send.mockRejectedValueOnce(conditionalFailure());
    await expect(f.store.clearApiGrant('raw-session', session.profile.sub, now)).resolves.toBeUndefined();
    f.send.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(f.store.clearApiGrant('raw-session', session.profile.sub, now)).rejects.toThrow('storage unavailable');
  });
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
