import { z } from 'zod';
import { apiGrantSchema, type ApiGrant } from './api-grant.js';
import { memberApiResultSchema } from './service.js';
import { profileDetailsResultSchema, skillsApiResultSchema } from './extra-api-model.js';

/** Non-secret capability information; the access token never enters the view model. */
export const apiAccessSchema = apiGrantSchema.pick({ scope: true, resources: true, expiresAt: true })
  .extend({ renewable: z.literal(true).optional() });
export type ApiAccess = z.infer<typeof apiAccessSchema>;
export const publicApiAccess = (grant: ApiGrant): ApiAccess => apiAccessSchema.parse({
  ...grant, ...(grant.refreshToken ? { renewable: true } : {}),
});
export const privateApiRecordSchema = z.object({
  expiresAt: z.number().int().positive(), profile: z.object({ sub: z.string().min(1) }), apiGrant: apiGrantSchema,
});

const patchSchema = z.object({
  memberApi: memberApiResultSchema.optional(),
  profileDetails: profileDetailsResultSchema.optional(),
  skillsApi: skillsApiResultSchema.optional(),
}).refine((patch) => Object.values(patch).some(Boolean), 'Empty API update.');
export type ApiSnapshotPatch = z.infer<typeof patchSchema>;
export class ApiSnapshotInvalid extends Error {
  constructor() { super('API update validation failed.'); this.name = 'ApiSnapshotInvalid'; }
}

export function checkedApiPatch(input: ApiSnapshotPatch, subject: string): ApiSnapshotPatch {
  const parsed = patchSchema.safeParse(input);
  if (!parsed.success) throw new ApiSnapshotInvalid();
  const patch = parsed.data;
  if ((patch.memberApi && (patch.memberApi.status !== 'success' || patch.memberApi.profile.id !== subject)) ||
      (patch.profileDetails && (patch.profileDetails.status !== 'success' || patch.profileDetails.subject !== subject)) ||
      (patch.skillsApi && (patch.skillsApi.status !== 'success' || patch.skillsApi.subject !== subject))) {
    throw new ApiSnapshotInvalid();
  }
  return patch;
}

export function checkedApiGrant(input: ApiGrant | undefined, subject: string, issuer: string,
  clientId: string, sessionExpiresAt: number): ApiGrant | undefined {
  if (!input) return undefined;
  const grant = apiGrantSchema.parse(input);
  if (grant.subject !== subject || grant.issuer !== issuer || grant.clientId !== clientId) {
    throw new Error('API credential identity mismatch.');
  }
  return { ...grant, expiresAt: Math.min(grant.expiresAt, sessionExpiresAt) };
}
