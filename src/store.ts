import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Identity } from './view-model.js';
import { memberApiResultSchema, projectGoalSchema, type ProjectGoal } from './service.js';
import { profileDetailsResultSchema, skillsApiResultSchema } from './extra-api-model.js';

export const ATTEMPT_TTL_SECONDS = 600;
export const SESSION_TTL_SECONDS = 1800;
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
  returnPage: z.enum(['profile', 'skills']).optional(),
});
export type Attempt = z.infer<typeof attemptSchema>;
export interface Session extends Identity { expiresAt: number; projectGoal?: ProjectGoal }
export const sessionSchema: z.ZodType<Session> = z.object({
  expiresAt: z.number().int().positive(),
  profile: z.object({ sub: z.string().min(1), nickname: z.string().optional() }),
  memberApi: memberApiResultSchema.optional(),
  profileDetails: profileDetailsResultSchema.optional(),
  skillsApi: skillsApiResultSchema.optional(),
  projectGoal: projectGoalSchema.optional(),
  verification: z.object({
    issuer: z.string(), audience: z.string(), sub: z.string().min(1), algorithm: z.literal('RS256'),
    nonce: z.literal(true), pkce: z.literal('S256'), state: z.literal(true), issuerResponse: z.literal(true),
    signature: z.literal(true), userInfoSubject: z.literal(true),
    authenticatedAt: z.iso.datetime(), checkedAt: z.iso.datetime(),
  }),
}).refine((session) => !session.memberApi || session.memberApi.status !== 'success' ||
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
  putSession(id: string, session: Session): Promise<void>;
  getSession(id: string, now: number): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;
  setProjectGoal(id: string, subject: string, goal: ProjectGoal, now: number): Promise<boolean>;
}

/** Development only. Production must use a shared store across Lambda instances. */
export class MemoryStore implements Store {
  private readonly attempts = new Map<string, Attempt>();
  private readonly sessions = new Map<string, Session>();

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
  async putSession(id: string, session: Session): Promise<void> {
    this.cleanExpired();
    if (this.sessions.size >= 10000) throw new Error('Session capacity exceeded.');
    this.sessions.set(digest(id), structuredClone(sessionSchema.parse(session)));
  }
  async getSession(id: string, now: number): Promise<Session | null> {
    const value = this.sessions.get(digest(id));
    return value && value.expiresAt > now ? structuredClone(value) : null;
  }
  async deleteSession(id: string): Promise<void> { this.sessions.delete(digest(id)); }
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
    for (const [key, item] of this.sessions) if (item.expiresAt <= now) this.sessions.delete(key);
  }
}
