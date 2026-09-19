/** Product policy, independent of the provider's token lifetimes. */
export const SESSION_IDLE_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_ABSOLUTE_SECONDS = 90 * 24 * 60 * 60;
export const API_REFRESH_LEASE_SECONDS = 30;

export function newSessionLifetime(now: number, authenticatedAt: string) {
  const authTime = Math.floor(Date.parse(authenticatedAt) / 1000);
  if (!Number.isSafeInteger(authTime) || authTime > now + 60) throw new Error('Invalid authentication time.');
  const absoluteExpiresAt = Math.min(now, authTime) + SESSION_ABSOLUTE_SECONDS;
  if (absoluteExpiresAt <= now) throw new Error('Fresh authentication is required.');
  return { createdAt: now, absoluteExpiresAt, expiresAt: Math.min(now + SESSION_IDLE_SECONDS, absoluteExpiresAt) };
}
