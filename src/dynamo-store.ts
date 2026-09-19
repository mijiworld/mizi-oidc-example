import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { attemptSchema, digest, sessionSchema, type Attempt, type Session, type Store } from './store.js';
import { projectGoalSchema, type ProjectGoal } from './service.js';

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
  async putSession(id: string, session: Session): Promise<void> {
    const value = sessionSchema.parse(session);
    await this.db.send(new PutCommand({
      TableName: this.table, Item: { pk: `session:${digest(id)}`, ...value },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  }
  async getSession(id: string, now: number): Promise<Session | null> {
    const result = await this.db.send(new GetCommand({
      TableName: this.table, Key: { pk: `session:${digest(id)}` }, ConsistentRead: true,
    }));
    const parsed = sessionSchema.safeParse(result.Item);
    return parsed.success && parsed.data.expiresAt > now ? parsed.data : null;
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
