import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BASE_URL: z.url().default('http://localhost:3000'),
  OIDC_ISSUER: z.url().default('https://mcp-auth-api.cccv.ai'),
  CLIENT_ID: z.string().trim().min(1).max(2048).optional(),
  SESSION_TABLE: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  RELEASE_SHA: z.string().max(80).default('development'),
});

export interface Config {
  production: boolean;
  baseUrl: string;
  issuer: string;
  clientId: string;
  callbackUrl: string;
  sessionTable?: string;
  secureCookies: boolean;
  port: number;
  release: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new Error('Invalid application configuration. Check environment variable names and formats.');
  const input = parsed.data;
  const base = new URL(input.BASE_URL);
  const issuer = new URL(input.OIDC_ISSUER);
  const production = input.NODE_ENV === 'production';
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      (base.protocol !== 'https:' && (production || base.protocol !== 'http:' || !localhost))) {
    throw new Error('BASE_URL must be an HTTPS origin (local development may use HTTP localhost).');
  }
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash ||
      input.OIDC_ISSUER.endsWith('/')) {
    throw new Error('OIDC_ISSUER must be an HTTPS issuer without credentials, query, fragment or trailing slash.');
  }
  if (production && !input.SESSION_TABLE) throw new Error('SESSION_TABLE is required in production.');
  const baseUrl = base.origin;
  return {
    production, baseUrl, issuer: input.OIDC_ISSUER,
    clientId: input.CLIENT_ID ?? `${baseUrl}/client.json`,
    callbackUrl: `${baseUrl}/auth/callback`, sessionTable: input.SESSION_TABLE,
    secureCookies: base.protocol === 'https:', port: input.PORT, release: input.RELEASE_SHA,
  };
}
