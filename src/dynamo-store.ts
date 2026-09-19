import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { attemptSchema, digest, sessionSchema, type Attempt, type Session, type Store } from './store.js';
import { projectGoalSchema, type ProjectGoal } from './service.js';
import { type ApiGrant } from './api-grant.js';
import { publicApiAccess, checkedApiGrant, checkedApiPatch, privateApiRecordSchema, type ApiSnapshotPatch } from './session-api.js';
import { API_REFRESH_LEASE_SECONDS, SESSION_IDLE_SECONDS } from './session-policy.js';

export class DynamoStore implements Store {
  constructor(
    private readonly table: string,
    private readonly db = DynamoDBDocumentClient.from(new DynamoDBClient({
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 2000, requestTimeout: 4000 },
    })),
  ) {}

  async putAttempt(attempt: Attempt): Promise<void> {
    const value = attemptSchema.parse(attempt);
    await this.db.send(new PutCommand({
      TableName: this.table,
      Item: { pk: `attempt:${digest(value.state)}`, ...value },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  }
  async consumeAttempt(state: string, bindingHash: string, now: number): Promise<Attempt | null> {
    try {
      // TTL cleanup is eventual. Conditions enforce expiry and browser binding immediately,
      // and ALL_OLD makes validation + one-time consumption one atomic DynamoDB operation.
      const result = await this.db.send(new DeleteCommand({
        TableName: this.table, Key: { pk: `attempt:${digest(state)}` },
        ConditionExpression: 'attribute_exists(pk) AND expiresAt > :now AND bindingHash = :binding',
        ExpressionAttributeValues: { ':now': now, ':binding': bindingHash }, ReturnValues: 'ALL_OLD',
      }));
      const parsed = attemptSchema.safeParse(result.Attributes);
      return parsed.success ? parsed.data : null;
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return null;
      throw error;
    }
  }
  async putSession(id: string, session: Session, inputGrant?: ApiGrant): Promise<void> {
    const value = sessionSchema.parse(session);
    const grant = checkedApiGrant(inputGrant, value.profile.sub, value.verification.issuer,
      value.verification.audience, value.expiresAt);
    delete value.apiAccess;
    if (grant) value.apiAccess = publicApiAccess(grant);
    await this.db.send(new PutCommand({
      // The table uses encryption at rest. The credential is a private attribute,
      // omitted from normal session reads and deleted with the owning session.
      TableName: this.table, Item: { pk: `session:${digest(id)}`, ...value, ...(grant ? { apiGrant: grant } : {}) },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  }
  async getSession(id: string, now: number): Promise<Session | null> {
    const result = await this.db.send(new GetCommand({
      TableName: this.table, Key: { pk: `session:${digest(id)}` }, ConsistentRead: true,
      ProjectionExpression: '#expires, #profile, #verification, #member, #details, #skills, #goal, #access, #created, #absolute',
      ExpressionAttributeNames: { '#expires': 'expiresAt', '#profile': 'profile', '#verification': 'verification',
        '#member': 'memberApi', '#details': 'profileDetails', '#skills': 'skillsApi', '#goal': 'projectGoal', '#access': 'apiAccess',
        '#created': 'createdAt', '#absolute': 'absoluteExpiresAt' },
    }));
    const parsed = sessionSchema.safeParse(result.Item);
    return parsed.success && parsed.data.expiresAt > now ? parsed.data : null;
  }
  async renewSession(id: string, now: number): Promise<Session | null> {
    const session = await this.getSession(id, now);
    if (!session || session.absoluteExpiresAt === undefined) return session;
    if (session.absoluteExpiresAt <= now) return null;
    const next = Math.min(now + SESSION_IDLE_SECONDS, session.absoluteExpiresAt);
    if (next <= session.expiresAt) return session;
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.table, Key: { pk: `session:${digest(id)}` },
        UpdateExpression: 'SET expiresAt = :next',
        ConditionExpression: 'attribute_exists(pk) AND expiresAt = :previous AND expiresAt > :now AND #absolute = :absolute AND #absolute > :now',
        ExpressionAttributeNames: { '#absolute': 'absoluteExpiresAt' },
        ExpressionAttributeValues: { ':next': next, ':previous': session.expiresAt, ':now': now, ':absolute': session.absoluteExpiresAt },
      }));
      return { ...session, expiresAt: next };
    } catch (error) {
      // Concurrent activity may already have renewed it; logout/expiry must win.
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return this.getSession(id, now);
      throw error;
    }
  }
  async getApiGrant(id: string, subject: string, now: number): Promise<ApiGrant | null> {
    const result = await this.db.send(new GetCommand({
      TableName: this.table, Key: { pk: `session:${digest(id)}` }, ConsistentRead: true,
      ProjectionExpression: '#grant, #expires, #profile',
      ExpressionAttributeNames: { '#grant': 'apiGrant', '#expires': 'expiresAt', '#profile': 'profile' },
    }));
    const record = privateApiRecordSchema.safeParse(result.Item);
    if (!record.success || record.data.expiresAt <= now || record.data.profile.sub !== subject || record.data.apiGrant.subject !== subject) return null;
    if (record.data.apiGrant.expiresAt <= now && !record.data.apiGrant.refreshToken) {
      await this.clearApiGrant(id, subject, now, record.data.apiGrant.accessToken);
      return null;
    }
    return record.data.apiGrant;
  }
  async beginApiRefresh(id: string, subject: string, accessToken: string, owner: string, now: number): Promise<'acquired' | 'busy' | 'stale'> {
    const base = {
      TableName: this.table, Key: { pk: `session:${digest(id)}` },
      ExpressionAttributeNames: { '#grant': 'apiGrant', '#token': 'accessToken', '#profile': 'profile', '#sub': 'sub', '#refresh': 'apiRefresh' },
      ExpressionAttributeValues: { ':now': now, ':subject': subject, ':token': accessToken },
    };
    const condition = 'attribute_exists(pk) AND expiresAt > :now AND #profile.#sub = :subject AND #grant.#token = :token';
    try {
      await this.db.send(new UpdateCommand({ ...base,
        UpdateExpression: 'SET #refresh = :lease',
        ConditionExpression: `${condition} AND attribute_not_exists(#refresh)`,
        ExpressionAttributeValues: { ...base.ExpressionAttributeValues, ':lease': { owner, startedAt: now } },
      }));
      return 'acquired';
    } catch (error) {
      if (!(error instanceof Error && error.name === 'ConditionalCheckFailedException')) throw error;
    }
    try {
      // An abandoned lease may have sent the token upstream. Invalidate instead of
      // handing that token to another worker after the provider's replay grace.
      await this.db.send(new UpdateCommand({ ...base,
        UpdateExpression: 'REMOVE #grant, #access, #refresh',
        ConditionExpression: `${condition} AND #refresh.#started <= :stale`,
        ExpressionAttributeNames: { ...base.ExpressionAttributeNames, '#access': 'apiAccess', '#started': 'startedAt' },
        ExpressionAttributeValues: { ...base.ExpressionAttributeValues, ':stale': now - API_REFRESH_LEASE_SECONDS },
      }));
      return 'stale';
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return 'busy';
      throw error;
    }
  }
  async finishApiRefresh(id: string, subject: string, accessToken: string, owner: string, input: ApiGrant, now: number): Promise<boolean> {
    const session = await this.getSession(id, now);
    if (!session || session.profile.sub !== subject) return false;
    const grant = checkedApiGrant(input, subject, session.verification.issuer, session.verification.audience, session.expiresAt)!;
    if (grant.expiresAt <= now) return false;
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.table, Key: { pk: `session:${digest(id)}` },
        UpdateExpression: 'SET #grant = :grant, #access = :access REMOVE #refresh',
        ConditionExpression: 'attribute_exists(pk) AND expiresAt > :now AND #profile.#sub = :subject AND #grant.#token = :token AND #refresh.#owner = :owner AND #refresh.#started > :stale',
        ExpressionAttributeNames: { '#grant': 'apiGrant', '#access': 'apiAccess', '#refresh': 'apiRefresh', '#token': 'accessToken',
          '#profile': 'profile', '#sub': 'sub', '#owner': 'owner', '#started': 'startedAt' },
        ExpressionAttributeValues: { ':now': now, ':subject': subject, ':token': accessToken, ':owner': owner,
          ':stale': now - API_REFRESH_LEASE_SECONDS, ':grant': grant, ':access': publicApiAccess(grant) },
      }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
  async abortApiRefresh(id: string, subject: string, accessToken: string, owner: string, discard: boolean, now: number): Promise<void> {
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.table, Key: { pk: `session:${digest(id)}` },
        UpdateExpression: discard ? 'REMOVE #refresh, #grant, #access' : 'REMOVE #refresh',
        ConditionExpression: 'attribute_exists(pk) AND expiresAt > :now AND #profile.#sub = :subject AND #grant.#token = :token AND #refresh.#owner = :owner',
        ExpressionAttributeNames: { '#grant': 'apiGrant', '#refresh': 'apiRefresh', '#token': 'accessToken', '#profile': 'profile',
          '#sub': 'sub', '#owner': 'owner', ...(discard ? { '#access': 'apiAccess' } : {}) },
        ExpressionAttributeValues: { ':now': now, ':subject': subject, ':token': accessToken, ':owner': owner },
      }));
    } catch (error) {
      if (!(error instanceof Error && error.name === 'ConditionalCheckFailedException')) throw error;
    }
  }
  async clearApiGrant(id: string, subject: string, now: number, expectedToken?: string): Promise<void> {
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.table, Key: { pk: `session:${digest(id)}` },
        UpdateExpression: 'REMOVE #grant, #access, #refresh',
        ConditionExpression: 'attribute_exists(pk) AND expiresAt > :now AND #profile.#sub = :subject' + (expectedToken === undefined ? '' : ' AND #grant.#token = :token'),
        ExpressionAttributeNames: { '#grant': 'apiGrant', '#access': 'apiAccess', '#profile': 'profile', '#sub': 'sub', '#refresh': 'apiRefresh', ...(expectedToken === undefined ? {} : { '#token': 'accessToken' }) },
        ExpressionAttributeValues: { ':now': now, ':subject': subject, ...(expectedToken === undefined ? {} : { ':token': expectedToken }) },
      }));
    } catch (error) {
      if (!(error instanceof Error && error.name === 'ConditionalCheckFailedException')) throw error;
    }
  }
  async saveApiResults(id: string, subject: string, grantExpiresAt: number, input: ApiSnapshotPatch, now: number): Promise<boolean> {
    const patch = checkedApiPatch(input, subject);
    const names: Record<string, string> = { '#grant': 'apiGrant', '#grantSubject': 'subject',
      '#grantExpiry': 'expiresAt', '#profile': 'profile', '#sub': 'sub' };
    const values: Record<string, unknown> = { ':now': now, ':subject': subject, ':grantExpiry': grantExpiresAt };
    const assignments = Object.entries(patch).filter(([, value]) => value !== undefined).map(([field, value], i) => {
      names[`#field${i}`] = field;
      values[`:field${i}`] = value;
      return `#field${i} = :field${i}`;
    });
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.table, Key: { pk: `session:${digest(id)}` },
        UpdateExpression: `SET ${assignments.join(', ')}`,
        // A logout, revocation or expiry while the API is in flight must win.
        ConditionExpression: 'attribute_exists(pk) AND expiresAt > :now AND #profile.#sub = :subject AND #grant.#grantSubject = :subject AND #grant.#grantExpiry = :grantExpiry AND #grant.#grantExpiry > :now',
        ExpressionAttributeNames: names, ExpressionAttributeValues: values,
      }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
  async deleteSession(id: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: `session:${digest(id)}` } }));
  }
  async setProjectGoal(id: string, subject: string, goal: ProjectGoal, now: number): Promise<boolean> {
    try {
      await this.db.send(new UpdateCommand({
        TableName: this.table, Key: { pk: `session:${digest(id)}` },
        UpdateExpression: 'SET #goal = :goal',
        ConditionExpression: 'attribute_exists(pk) AND expiresAt > :now AND #profile.#sub = :subject AND #api.#status = :success AND #api.#profile.#id = :subject',
        ExpressionAttributeNames: { '#goal': 'projectGoal', '#profile': 'profile', '#sub': 'sub',
          '#api': 'memberApi', '#status': 'status', '#id': 'id' },
        ExpressionAttributeValues: { ':goal': projectGoalSchema.parse(goal), ':now': now,
          ':subject': subject, ':success': 'success' },
      }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
}
