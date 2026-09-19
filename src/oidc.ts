import { createHash, timingSafeEqual } from 'node:crypto';
import * as client from 'openid-client';
import { createRemoteJWKSet, customFetch as joseFetch, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Attempt } from './store.js';
import type { Identity } from './view-model.js';
import { LoginFailure, type LoginStage } from './login-error.js';
import { memberApiResource, readMemberApi } from './member-api.js';

export interface OidcProvider {
  authorizationUrl(attempt: Attempt): Promise<string>;
  complete(callback: URL, attempt: Attempt): Promise<Identity>;
}

const claimsSchema = z.object({
  sub: z.string().min(1).max(255),
  nonce: z.string(),
  at_hash: z.string(),
  auth_time: z.number().int().nonnegative(),
});
const profileSchema = z.object({ sub: z.string().min(1).max(255), nickname: z.string().max(500).optional() });
const equal = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Never use callback parameters or the request Host to choose an issuer or endpoint. */
export class MiziOidcProvider implements OidcProvider {
  private discovery?: Promise<client.Configuration>;
  private keys?: ReturnType<typeof createRemoteJWKSet>;
  private readonly fetcher: typeof fetch;

  constructor(private readonly settings: Config, fetcher: typeof fetch = fetch) {
    this.fetcher = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.protocol !== 'https:' || url.origin !== new URL(settings.issuer).origin) {
        throw new Error('Untrusted OIDC endpoint.');
      }
      const signals = [AbortSignal.timeout(5000), ...(init?.signal ? [init.signal] : [])];
      return fetcher(input, { ...init, signal: AbortSignal.any(signals), redirect: 'error' });
    };
  }

  private configuration(): Promise<client.Configuration> {
    if (!this.discovery) {
      this.discovery = client.discovery(new URL(this.settings.issuer), this.settings.clientId,
        { id_token_signed_response_alg: 'RS256' }, client.None(),
        { timeout: 5, [client.customFetch]: (url, options) => this.fetcher(url, {
          ...options,
          body: options.body instanceof Uint8Array ? new Uint8Array(options.body) : options.body,
        }) },
      ).then((configuration) => {
        const metadata = configuration.serverMetadata();
        if (metadata.issuer !== this.settings.issuer ||
            !metadata.code_challenge_methods_supported?.includes('S256') ||
            !metadata.id_token_signing_alg_values_supported?.includes('RS256')) {
          throw new Error('Unexpected OIDC discovery metadata.');
        }
        for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint,
          metadata.userinfo_endpoint, metadata.jwks_uri]) {
          if (!endpoint) throw new Error('Missing OIDC endpoint.');
          const url = new URL(endpoint);
          if (url.protocol !== 'https:' || url.origin !== new URL(this.settings.issuer).origin ||
              url.username || url.password || url.hash) throw new Error('Untrusted OIDC endpoint.');
        }
        this.keys = createRemoteJWKSet(new URL(metadata.jwks_uri!), {
          timeoutDuration: 5000, [joseFetch]: this.fetcher,
        });
        return configuration;
      }).catch(() => {
        this.discovery = undefined; // A transient provider failure must not poison a warm Lambda.
        throw new Error('OIDC discovery failed.');
      });
    }
    return this.discovery;
  }

  async authorizationUrl(attempt: Attempt): Promise<string> {
    const configuration = await this.configuration();
    return client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.settings.callbackUrl,
      scope: attempt.readMemberApi ? 'openid profile user:profile' : 'openid profile', response_type: 'code',
      ...(attempt.readMemberApi ? { resource: memberApiResource(this.settings.issuer) } : {}),
      state: attempt.state, nonce: attempt.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(attempt.codeVerifier),
      code_challenge_method: 'S256',
    }).href;
  }

  async complete(callback: URL, attempt: Attempt): Promise<Identity> {
    let stage: LoginStage = 'callback';
    try {
      // Duplicate parameters are ambiguous across proxies/parsers. Fail before token exchange.
      for (const key of callback.searchParams.keys()) {
        if (callback.searchParams.getAll(key).length !== 1) throw new Error('Duplicate callback parameter.');
      }
      if (`${callback.origin}${callback.pathname}` !== this.settings.callbackUrl || callback.hash ||
          callback.searchParams.get('iss') !== this.settings.issuer ||
          callback.searchParams.get('state') !== attempt.state ||
          !callback.searchParams.get('code') || callback.searchParams.has('error')) {
        throw new Error('Invalid authorization response.');
      }
      stage = 'discovery';
      const configuration = await this.configuration();
      stage = 'token_exchange';
      const tokens = await client.authorizationCodeGrant(configuration, callback, {
        expectedState: attempt.state, expectedNonce: attempt.nonce,
        pkceCodeVerifier: attempt.codeVerifier, idTokenExpected: true,
      }, attempt.readMemberApi ? { resource: memberApiResource(this.settings.issuer) } : undefined);
      stage = 'id_token_validation';
      if (!tokens.id_token) throw new Error('Missing ID token.');

      // Code-flow validation can rely on TLS in some clients. Verify RS256 independently
      // against the issuer's JWKS before accepting any identity or calling UserInfo.
      const verified = await jwtVerify(tokens.id_token, this.keys!, {
        issuer: this.settings.issuer, audience: this.settings.clientId, algorithms: ['RS256'],
        requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'at_hash'],
        clockTolerance: 5, maxTokenAge: '5m',
      });
      const claims = claimsSchema.parse(verified.payload);
      const now = Math.floor(Date.now() / 1000);
      const audience = verified.payload.aud;
      const onlyThisClient = audience === this.settings.clientId ||
        (Array.isArray(audience) && audience.length === 1 && audience[0] === this.settings.clientId);
      if (!onlyThisClient ||
          (verified.payload.azp !== undefined && verified.payload.azp !== this.settings.clientId) ||
          claims.auth_time > now + 5 || !equal(claims.nonce, attempt.nonce)) {
        throw new Error('Invalid identity binding.');
      }
      const accessTokenHash = createHash('sha256').update(tokens.access_token, 'ascii')
        .digest().subarray(0, 16).toString('base64url');
      if (!equal(claims.at_hash, accessTokenHash)) throw new Error('Invalid access token binding.');
      stage = 'userinfo';
      const profile = profileSchema.parse(await client.fetchUserInfo(configuration, tokens.access_token, claims.sub));
      if (profile.sub !== claims.sub) throw new Error('UserInfo subject mismatch.');
      stage = 'member_api';
      const memberApi = attempt.readMemberApi
        ? await readMemberApi(this.settings.issuer, tokens.access_token, tokens.scope, claims.sub, this.fetcher)
        : undefined;

      // No tokens (including an unsolicited refresh token) escape this method or enter storage.
      return {
        profile,
        ...(memberApi ? { memberApi } : {}),
        verification: {
          issuer: this.settings.issuer, audience: this.settings.clientId, sub: claims.sub,
          algorithm: 'RS256', signature: true, nonce: true, pkce: 'S256', state: true,
          issuerResponse: true, userInfoSubject: true,
          authenticatedAt: new Date(claims.auth_time * 1000).toISOString(),
          checkedAt: new Date().toISOString(),
        },
      };
    } catch {
      throw new LoginFailure(stage);
    }
  }
}
