import { z } from 'zod';

export const SKILLS_PREVIEW_LIMIT = 20;
export const MAX_EXTRA_API_RESPONSE_BYTES = 256 * 1024;

const snapshot = {
  subject: z.string().min(1).max(255),
  endpoint: z.url().max(2048),
  fetchedAt: z.iso.datetime(),
};
const error = z.object({
  ...snapshot,
  status: z.literal('error'),
  reason: z.enum(['scope_missing', 'unauthorized', 'forbidden', 'unavailable', 'invalid_response']),
});
const optionalText = (max: number) => z.string().max(max).nullable();

export const profileDetailsResultSchema = z.discriminatedUnion('status', [
  z.object({
    ...snapshot,
    status: z.literal('success'),
    // A partial aggregate does not tell us which individual profile field was unavailable.
    partial: z.boolean().nullable(),
    profile: z.object({
      bio: optionalText(300),
      role: optionalText(200),
      interests: z.array(z.string().min(1).max(200)).max(10).nullable(),
    }),
  }),
  error,
]);
export type ProfileDetailsResult = z.infer<typeof profileDetailsResultSchema>;

export const skillSnapshotSchema = z.object({
  id: z.string().min(1).max(255),
  name: z.string().min(1).max(200),
  // These are the API's source and verification claims, not this demo's endorsements.
  source: z.string().min(1).max(100),
  verificationMethod: optionalText(200),
  verifiedBy: optionalText(500),
  verifiedAt: z.iso.datetime({ offset: true }).nullable(),
  visible: z.boolean().nullable(),
  visibility: z.object({ profile: z.boolean().nullable(), skills: z.boolean().nullable() }),
});

export const skillsApiResultSchema = z.discriminatedUnion('status', [
  z.object({
    ...snapshot,
    status: z.literal('success'),
    // The current endpoint has no partial flag, so completeness stays unknown (null).
    partial: z.boolean().nullable(),
    items: z.array(skillSnapshotSchema).max(SKILLS_PREVIEW_LIMIT),
    requestedLimit: z.literal(SKILLS_PREVIEW_LIMIT),
    returnedCount: z.number().int().nonnegative(),
    // Only the server's next_cursor, not coverage of CCCV's merged first-page results.
    hasMore: z.boolean().nullable(),
    // The API may prepend CCCV items and exceed the requested limit. Retain at most 20.
    truncated: z.boolean(),
  }),
  error,
]);
export type SkillsApiResult = z.infer<typeof skillsApiResultSchema>;
