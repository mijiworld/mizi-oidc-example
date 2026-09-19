import { z } from 'zod';
import type { MemberApiResult } from './service.js';
import type { ProfileDetailsResult, SkillsApiResult } from './extra-api-model.js';

export const API_GRANT_MAX_SECONDS = 1800;
const httpsUrl = z.url().max(2048).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
});

/** Server-only credentials. Never spread this value into a view or public session. */
export const apiGrantSchema = z.object({
  accessToken: z.string().min(1).max(2048).regex(/^[A-Za-z0-9._~+/-]+=*$/),
  scope: z.string().min(1).max(2048).regex(/^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/),
  subject: z.string().min(1).max(255),
  issuer: httpsUrl,
  clientId: z.string().min(1).max(2048),
  resources: z.array(httpsUrl).min(1).max(3).refine((items) => new Set(items).size === items.length),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type ApiGrant = z.infer<typeof apiGrantSchema>;
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
