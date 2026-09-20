import { z } from 'zod';
import type { MemberApiResult } from './service.js';
import type { ProfileDetailsResult, SkillsApiResult } from './extra-api-model.js';

export const API_GRANT_MAX_SECONDS = 3600;
const credential = z.string().min(1).max(2048).regex(/^[A-Za-z0-9._~+/-]+=*$/);
const httpsUrl = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
});

/** Server-only credentials. Never spread this value into a view or public session. */
export const apiGrantSchema = z.object({
  accessToken: credential,
  refreshToken: credential.optional(),
  scope: z.string().min(1).max(2048).regex(/^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/),
  subject: z.string().min(1).max(255),
  issuer: httpsUrl,
  clientId: z.string().min(1).max(2048),
  resources: z.array(httpsUrl).min(1).max(4).refine((items) => new Set(items).size === items.length),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type ApiGrant = z.infer<typeof apiGrantSchema>;
export function profileBioResource(issuer: string): string {
  const url = new URL('/v1/me/profile/bio', issuer);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Untrusted API endpoint.');
  return url.href;
}
export type ApiRefreshPage = 'profile' | 'skills';
export interface ApiRefreshResult {
  memberApi?: MemberApiResult;
  profileDetails?: ProfileDetailsResult;
  skillsApi?: SkillsApiResult;
}

/** Safe control-flow reasons; never include credentials or provider responses. */
export class ApiGrantUnavailable extends Error {
  constructor(readonly reason: 'expired' | 'scope_missing' | 'resource_missing' | 'invalid_grant') {
    super('A new API connection is required.');
    this.name = 'ApiGrantUnavailable';
  }
}

/** No provider messages or credentials: callers decide whether to keep or discard a grant. */
export class ApiGrantRefreshFailure extends Error {
  constructor(readonly reason: 'invalid_grant' | 'invalid_response' | 'unavailable' | 'ambiguous') {
    super('The API connection could not be refreshed.');
    this.name = 'ApiGrantRefreshFailure';
  }
}
