import { z } from 'zod';

export const SKILLS_PREVIEW_LIMIT = 20;
export const MAX_SKILLS_SNAPSHOT_ITEMS = 200;
export const MAX_SKILLS_SNAPSHOT_BYTES = 192 * 1024;
export const MAX_SKILLS_COLLECTION_PAGES = 10;
export const MAX_SKILLS_COLLECTION_BYTES = 1024 * 1024;
export const SKILLS_COLLECTION_TIMEOUT_MS = 5000;
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

export const skillsCollectionSchema = z.object({
  pages: z.number().int().min(1).max(MAX_SKILLS_COLLECTION_PAGES),
  startedAt: z.iso.datetime(),
  stoppedReason: z.enum(['cursor_exhausted', 'item_limit', 'byte_limit', 'time_limit', 'page_limit',
    'upstream_error', 'invalid_response', 'cursor_cycle', 'unknown_cursor']),
  duplicateCount: z.number().int().nonnegative(),
  // A later page may fail authorization after earlier pages were confirmed.
  // Preserve the prefix, but callers must discard the server-private API grant.
  authorizationFailure: z.enum(['unauthorized', 'forbidden']).optional(),
}).refine((value) => !value.authorizationFailure || value.stoppedReason === 'upstream_error',
  'Authorization failure requires an upstream error.');
export type SkillsCollection = z.infer<typeof skillsCollectionSchema>;

export const skillsApiResultSchema = z.discriminatedUnion('status', [
  z.object({
    ...snapshot,
    status: z.literal('success'),
    // The current endpoint has no partial flag, so completeness stays unknown (null).
    partial: z.boolean().nullable(),
    items: z.array(skillSnapshotSchema).max(MAX_SKILLS_SNAPSHOT_ITEMS),
    requestedLimit: z.literal(SKILLS_PREVIEW_LIMIT),
    // Sum of successful pages' response item counts, including duplicate ids.
    returnedCount: z.number().int().nonnegative(),
    // Only the server's next_cursor, not coverage of CCCV's merged first-page results.
    hasMore: z.boolean().nullable(),
    // Data was clipped, or collection stopped before the API cursor was exhausted.
    truncated: z.boolean(),
    // Absent on sessions produced before bounded multi-page collection existed.
    collection: skillsCollectionSchema.optional(),
  }),
  error,
]).refine((result) => result.status !== 'success' ||
  new TextEncoder().encode(JSON.stringify(result)).byteLength <= MAX_SKILLS_SNAPSHOT_BYTES,
'Skills snapshot exceeds its storage budget.');
export type SkillsApiResult = z.infer<typeof skillsApiResultSchema>;
