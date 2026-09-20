import { z } from 'zod';
import { profileDetailsResultSchema, type ProfileDetailsResult } from './extra-api-model.js';

/** Server-generated receipt, never accepted from a URL or browser form. */
export const profileWriteNoticeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  status: z.enum(['saved_verified', 'saved_unverified', 'unknown', 'not_saved']),
  draft: z.string().refine((value) => value.length <= 300),
  attemptedAt: z.iso.datetime(),
}).strict();
export type ProfileWriteNotice = z.infer<typeof profileWriteNoticeSchema>;
export function checkedProfileWrite(notice: ProfileWriteNotice, subject: string, input?: ProfileDetailsResult) {
  const value = profileWriteNoticeSchema.parse(notice);
  const details = input === undefined ? undefined : profileDetailsResultSchema.parse(input);
  if (value.status === 'saved_verified') {
    if (details?.status !== 'success' || details.subject !== subject || details.profile.bio !== value.draft) {
      throw new Error('Invalid verified write receipt.');
    }
  } else if (details !== undefined) throw new Error('Unverified write cannot update the snapshot.');
  return { notice: value, details };
}
