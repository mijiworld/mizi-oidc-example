import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Identity } from './view-model.js';
import { memberApiResultSchema, projectGoalSchema, type ProjectGoal } from './service.js';
import { profileDetailsResultSchema, skillsApiResultSchema } from './extra-api-model.js';
import { apiGrantSchema, type ApiGrant } from './api-grant.js';
import { apiAccessSchema, publicApiAccess, checkedApiGrant, checkedApiPatch, type ApiAccess, type ApiSnapshotPatch } from './session-api.js';
import { profileWriteNoticeSchema, checkedProfileWrite, type ProfileWriteNotice } from './profile-write-notice.js';
import type { ProfileDetailsResult } from './extra-api-model.js';
import { API_REFRESH_LEASE_SECONDS, SESSION_IDLE_SECONDS } from './session-policy.js';

export const ATTEMPT_TTL_SECONDS = 600;
export const SESSION_TTL_SECONDS = SESSION_IDLE_SECONDS;
export const opaqueSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const attemptSchema = z.object({
  state: opaqueSchema,
  nonce: opaqueSchema,
  codeVerifier: opaqueSchema,
  bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive(),
  readMemberApi: z.boolean().optional(),
  readProfileDetails: z.boolean().optional(),
  readSkillsApi: z.boolean().optional(),
  writeProfileBio: z.boolean().optional(),
  returnPage: z.enum(['profile', 'skills']).optional(),
});
export type Attempt = z.infer<typeof attemptSchema>;
export interface Session extends Identity { expiresAt: number; createdAt?: number; absoluteExpiresAt?: number; projectGoal?: ProjectGoal; apiAccess?: ApiAccess; profileWrite?: ProfileWriteNotice; profileWriteRevision?: string }
export const sessionSchema: z.ZodType<Session> = z.object({
  expiresAt: z.number().int().positive(),
  createdAt: z.number().int().positive().optional(),
  absoluteExpiresAt: z.number().int().positive().optional(),
  profile: z.object({ sub: z.string().min(1), nickname: z.string().optional() }),
  memberApi: memberApiResultSchema.optional(),
  profileDetails: profileDetailsResultSchema.optional(),
  skillsApi: skillsApiResultSchema.optional(),
  projectGoal: projectGoalSchema.optional(),
  apiAccess: apiAccessSchema.optional(),
  profileWrite: profileWriteNoticeSchema.optional(),
  // Keep the revision after dismissing the receipt so an older read cannot pass an absent-receipt CAS again.
  profileWriteRevision: opaqueSchema.optional(),
  verification: z.object({
    issuer: z.string(), audience: z.string(), sub: z.string().min(1), algorithm: z.literal('RS256'),
    nonce: z.literal(true), pkce: z.literal('S256'), state: z.literal(true), issuerResponse: z.literal(true),
    signature: z.literal(true), userInfoSubject: z.literal(true),
    authenticatedAt: z.iso.datetime(), checkedAt: z.iso.datetime(),
  }),
}).refine((session) => (session.createdAt === undefined && session.absoluteExpiresAt === undefined) ||
  (session.createdAt !== undefined && session.absoluteExpiresAt !== undefined &&
   session.createdAt < session.absoluteExpiresAt && session.expiresAt <= session.absoluteExpiresAt), 'Invalid session lifetime.')
  .refine((session) => !session.memberApi || session.memberApi.status !== 'success' ||
  session.memberApi.profile.id === session.profile.sub, 'Member API identity mismatch.')
  .refine((session) => !session.profileDetails || session.profileDetails.subject === session.profile.sub,
    'Profile details identity mismatch.')
  .refine((session) => !session.skillsApi || session.skillsApi.subject === session.profile.sub,
    'Skills API identity mismatch.')
  .refine((session) => !session.projectGoal || session.memberApi?.status === 'success',
    'Project board requires a successful member API response.');

export interface Store {
  putAttempt(attempt: Attempt): Promise<void>;
  /** A mismatched browser or expired attempt must never consume a valid attempt. */
  consumeAttempt(state: string, bindingHash: string, now: number): Promise<Attempt | null>;
  putSession(id: string, session: Session, grant?: ApiGrant): Promise<void>;
  getSession(id: string, now: number): Promise<Session | null>;
  renewSession(id: string, now: number): Promise<Session | null>;
  getApiGrant(id: string, subject: string, now: number): Promise<ApiGrant | null>;
  beginApiRefresh(id: string, subject: string, accessToken: string, owner: string, now: number): Promise<'acquired' | 'busy' | 'stale'>;
  finishApiRefresh(id: string, subject: string, accessToken: string, owner: string, grant: ApiGrant, now: number): Promise<boolean>;
  abortApiRefresh(id: string, subject: string, accessToken: string, owner: string, discard: boolean, now: number): Promise<void>;
  clearApiGrant(id: string, subject: string, now: number, expectedToken?: string): Promise<void>;
  saveApiResults(id: string, subject: string, grantExpiresAt: number, patch: ApiSnapshotPatch, now: number, expectedProfileWrite?: string | null): Promise<boolean>;
  saveProfileWrite(id: string, subject: string, expectedToken: string, notice: ProfileWriteNotice, details: ProfileDetailsResult | undefined, now: number, expectedProfileWrite?: string | null): Promise<boolean>;
  deleteSession(id: string): Promise<void>;
  setProjectGoal(id: string, subject: string, goal: ProjectGoal, now: number): Promise<boolean>;
}

/** Development only. Production must use a shared store across Lambda instances. */
export class MemoryStore implements Store {
  private readonly attempts = new Map<string, Attempt>();
  private readonly sessions = new Map<string, Session>();
  private readonly grants = new Map<string, ApiGrant>();
  private readonly refreshes = new Map<string, { owner: string; startedAt: number }>();

  async putAttempt(attempt: Attempt): Promise<void> {
    this.cleanExpired();
    if (this.attempts.size >= 10000) throw new Error('Attempt capacity exceeded.');
    this.attempts.set(digest(attempt.state), structuredClone(attemptSchema.parse(attempt)));
  }
  async consumeAttempt(state: string, bindingHash: string, now: number): Promise<Attempt | null> {
    const key = digest(state);
    const value = this.attempts.get(key);
    if (!value || value.expiresAt <= now || value.bindingHash !== bindingHash) return null;
    this.attempts.delete(key); // No await between comparison and deletion.
    return structuredClone(value);
  }
  async putSession(id: string, session: Session, inputGrant?: ApiGrant): Promise<void> {
    this.cleanExpired();
    if (this.sessions.size >= 10000) throw new Error('Session capacity exceeded.');
    const value = sessionSchema.parse(session);
    const grant = checkedApiGrant(inputGrant, value.profile.sub, value.verification.issuer,
      value.verification.audience, value.expiresAt);
    const key = digest(id);
    if (this.sessions.has(key)) throw new Error('Session already exists.');
    delete value.apiAccess;
    if (grant) value.apiAccess = publicApiAccess(grant);
    this.sessions.set(key, structuredClone(value));
    if (grant) this.grants.set(key, structuredClone(grant));
  }
  async getSession(id: string, now: number): Promise<Session | null> {
    const value = this.sessions.get(digest(id));
    return value && value.expiresAt > now ? structuredClone(value) : null;
  }
  async renewSession(id: string, now: number): Promise<Session | null> {
    const value = this.sessions.get(digest(id));
    if (!value || value.expiresAt <= now || (value.absoluteExpiresAt !== undefined && value.absoluteExpiresAt <= now)) return null;
    // Legacy records retain their original deadline until a fresh login.
    if (value.absoluteExpiresAt !== undefined) value.expiresAt = Math.min(Math.max(value.expiresAt, now + SESSION_IDLE_SECONDS), value.absoluteExpiresAt);
    return structuredClone(value);
  }
  async getApiGrant(id: string, subject: string, now: number): Promise<ApiGrant | null> {
    const key = digest(id);
    const session = this.sessions.get(key);
    const parsed = apiGrantSchema.safeParse(this.grants.get(key));
    if (!session || session.expiresAt <= now || session.profile.sub !== subject || !parsed.success || parsed.data.subject !== subject) return null;
    if (parsed.data.expiresAt <= now && !parsed.data.refreshToken) {
      await this.clearApiGrant(id, subject, now, parsed.data.accessToken);
      return null;
    }
    return structuredClone(parsed.data);
  }
  async beginApiRefresh(id: string, subject: string, accessToken: string, owner: string, now: number): Promise<'acquired' | 'busy' | 'stale'> {
    const key = digest(id);
    const session = this.sessions.get(key);
    const grant = this.grants.get(key);
    if (!session || session.expiresAt <= now || session.profile.sub !== subject || grant?.accessToken !== accessToken) return 'stale';
    const lease = this.refreshes.get(key);
    if (lease) {
      if (lease.startedAt + API_REFRESH_LEASE_SECONDS > now) return 'busy';
      // A worker may have rotated the token and lost its response. Never retry that old token.
      this.grants.delete(key); this.refreshes.delete(key); delete session.apiAccess;
      return 'stale';
    }
    this.refreshes.set(key, { owner, startedAt: now });
    return 'acquired';
  }
  async finishApiRefresh(id: string, subject: string, accessToken: string, owner: string, input: ApiGrant, now: number): Promise<boolean> {
    const key = digest(id);
    const session = this.sessions.get(key);
    const lease = this.refreshes.get(key);
    if (!session || session.expiresAt <= now || session.profile.sub !== subject || this.grants.get(key)?.accessToken !== accessToken ||
        lease?.owner !== owner || lease.startedAt + API_REFRESH_LEASE_SECONDS <= now) return false;
    const grant = checkedApiGrant(input, subject, session.verification.issuer, session.verification.audience, session.expiresAt)!;
    if (grant.expiresAt <= now) return false;
    this.grants.set(key, structuredClone(grant)); session.apiAccess = publicApiAccess(grant); this.refreshes.delete(key);
    return true;
  }
  async abortApiRefresh(id: string, subject: string, accessToken: string, owner: string, discard: boolean, now: number): Promise<void> {
    const key = digest(id);
    const session = this.sessions.get(key);
    if (!session || session.expiresAt <= now || session.profile.sub !== subject || this.grants.get(key)?.accessToken !== accessToken || this.refreshes.get(key)?.owner !== owner) return;
    this.refreshes.delete(key);
    if (discard) { this.grants.delete(key); delete session.apiAccess; }
  }
  async clearApiGrant(id: string, subject: string, now: number, expectedToken?: string): Promise<void> {
    const key = digest(id);
    const session = this.sessions.get(key);
    if (!session || session.expiresAt <= now || session.profile.sub !== subject ||
        (expectedToken !== undefined && this.grants.get(key)?.accessToken !== expectedToken)) return;
    this.grants.delete(key);
    this.refreshes.delete(key);
    delete session.apiAccess;
  }
  async saveApiResults(id: string, subject: string, grantExpiresAt: number, input: ApiSnapshotPatch, now: number, expectedProfileWrite?: string | null): Promise<boolean> {
    const patch = checkedApiPatch(input, subject);
    const key = digest(id);
    const session = this.sessions.get(key);
    const grant = this.grants.get(key);
    if (!session || session.expiresAt <= now || session.profile.sub !== subject || !grant ||
        grant.subject !== subject || grant.expiresAt <= now || grant.expiresAt !== grantExpiresAt) return false;
    if (patch.profileDetails && expectedProfileWrite !== undefined &&
        (session.profileWriteRevision ?? null) !== expectedProfileWrite) return false;
    Object.assign(session, structuredClone(patch));
    if (patch.profileDetails) delete session.profileWrite;
    return true;
  }
  async saveProfileWrite(id: string, subject: string, expectedToken: string, notice: ProfileWriteNotice, details: ProfileDetailsResult | undefined, now: number, expectedProfileWrite?: string | null): Promise<boolean> {
    const checked = checkedProfileWrite(notice, subject, details);
    const key = digest(id);
    const session = this.sessions.get(key);
    const grant = this.grants.get(key);
    if (!session || session.expiresAt <= now || session.profile.sub !== subject ||
        grant?.subject !== subject || grant.accessToken !== expectedToken) return false;
    if (expectedProfileWrite !== undefined && (session.profileWriteRevision ?? null) !== expectedProfileWrite) return false;
    session.profileWrite = structuredClone(checked.notice);
    session.profileWriteRevision = checked.notice.id;
    if (checked.details) session.profileDetails = structuredClone(checked.details);
    return true;
  }
  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(digest(id));
    this.grants.delete(digest(id));
    this.refreshes.delete(digest(id));
  }
  async setProjectGoal(id: string, subject: string, goal: ProjectGoal, now: number): Promise<boolean> {
    const value = this.sessions.get(digest(id));
    if (!value || value.expiresAt <= now || value.profile.sub !== subject ||
        value.memberApi?.status !== 'success' || value.memberApi.profile.id !== subject) return false;
    value.projectGoal = projectGoalSchema.parse(goal);
    return true;
  }
  private cleanExpired(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [key, item] of this.attempts) if (item.expiresAt <= now) this.attempts.delete(key);
    for (const [key, item] of this.sessions) if (item.expiresAt <= now) {
      this.sessions.delete(key);
      this.grants.delete(key);
      this.refreshes.delete(key);
    }
  }
}
