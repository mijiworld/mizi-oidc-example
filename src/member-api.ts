import { z } from 'zod';
import { LoginFailure } from './login-error.js';
import type { MemberApiResult } from './service.js';

const profileSchema = z.object({
  id: z.string().min(1).max(255),
  nickname: z.string().max(500),
  github_connected: z.boolean().nullable().optional(),
});

/** A fixed resource at the configured issuer's origin, never a callback or user-supplied URL. */
export function memberApiResource(issuer: string): string {
  const url = new URL('/v1/me', issuer);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Untrusted member API endpoint.');
  return url.href;
}

/** A member API failure need not erase an already verified OIDC identity. */
export async function readMemberApi(
  issuer: string,
  accessToken: string,
  grantedScope: string | undefined,
  expectedSubject: string,
  fetcher: typeof fetch = fetch,
): Promise<MemberApiResult> {
  const failure = (reason: Extract<MemberApiResult, { status: 'error' }>['reason']): MemberApiResult =>
    ({ status: 'error', reason, fetchedAt: new Date().toISOString() });
  if (!grantedScope?.split(/\s+/).includes('user:profile')) return failure('scope_missing');

  let response: Response;
  try {
    response = await fetcher(memberApiResource(issuer), {
      method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
  } catch {
    return failure('unavailable');
  }
  if (response.status === 401) return failure('unauthorized');
  if (response.status === 403) return failure('forbidden');
  if (response.status !== 200) return failure('unavailable');
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return failure('invalid_response');

  let body: unknown;
  try { body = await response.json(); } catch { return failure('invalid_response'); }
  const owner = z.object({ id: z.string().min(1).max(255) }).safeParse(body);
  if (!owner.success) return failure('invalid_response');
  if (owner.data.id !== expectedSubject) {
    // A different account is an identity-boundary failure, not optional API unavailability.
    throw new LoginFailure('member_api');
  }
  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) return failure('invalid_response');
  return {
    status: 'success', fetchedAt: new Date().toISOString(),
    profile: { id: parsed.data.id, nickname: parsed.data.nickname, githubConnected: parsed.data.github_connected ?? null },
  };
}
