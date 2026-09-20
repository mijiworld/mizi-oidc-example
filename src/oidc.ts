import { createHash, timingSafeEqual } from 'node:crypto';
import * as client from 'openid-client';
import { createRemoteJWKSet, customFetch as joseFetch, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Attempt } from './store.js';
import type { Identity } from './view-model.js';
import { LoginFailure, type LoginStage } from './login-error.js';
import { memberApiResource, readMemberApi } from './member-api.js';
import { profileDetailsResource, skillsApiResource, readProfileDetails, readSkillsApi } from './extra-api.js';
import { API_GRANT_MAX_SECONDS, ApiGrantRefreshFailure, apiGrantSchema, profileBioResource, type ApiGrant, type ApiRefreshPage, type ApiRefreshResult } from './api-grant.js';
import { refreshApis, validateApiGrant } from './api-refresh.js';
import { SESSION_ABSOLUTE_SECONDS } from './session-policy.js';
import { writeProfileBio, type ProfileBioWriteResult } from './profile-write.js';

export type OidcIdentity = Identity & { apiGrant?: ApiGrant };

export interface OidcProvider {
  authorizationUrl(attempt: Attempt): Promise<string>;
  complete(callback: URL, attempt: Attempt): Promise<OidcIdentity>;
  readApis?(grant: ApiGrant, page: ApiRefreshPage): Promise<ApiRefreshResult>;
  refreshGrant?(grant: ApiGrant): Promise<ApiGrant>;
  writeProfileBio?(grant: ApiGrant, bio: string): Promise<ProfileBioWriteResult>;
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

/** Bound parsing as well as fetch, including a stalled provider response body. */
function withinRefreshBudget<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const expired = () => reject(new ApiGrantRefreshFailure('ambiguous'));
    if (signal.aborted) { operation.catch(() => undefined); expired(); return; }
    signal.addEventListener('abort', expired, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', expired));
  });
}
const supportedScopes = new Set(['openid', 'profile', 'user:profile', 'user:skills', 'user:profile:write']);
const hasApiScope = (scope: string[], resources: string[], issuer: string): boolean =>
  (scope.includes('user:profile') && resources.some((resource) =>
    [memberApiResource(issuer), profileDetailsResource(issuer)].includes(resource))) ||
  (scope.includes('user:skills') && resources.includes(skillsApiResource(issuer))) ||
  (scope.includes('user:profile:write') && resources.includes(profileBioResource(issuer)));

/** Use the same fixed resource list at authorization and code exchange. */
function apiResources(issuer: string, attempt: Attempt): string[] {
  return [
    ...(attempt.readMemberApi ? [memberApiResource(issuer)] : []),
    ...(attempt.readProfileDetails ? [profileDetailsResource(issuer)] : []),
    ...(attempt.readSkillsApi ? [skillsApiResource(issuer)] : []),
    ...(attempt.writeProfileBio ? [profileBioResource(issuer)] : []),
  ];
}

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
    const parameters = new URLSearchParams({
      redirect_uri: this.settings.callbackUrl,
      scope: ['openid', 'profile',
        ...(attempt.readMemberApi || attempt.readProfileDetails ? ['user:profile'] : []),
        ...(attempt.readSkillsApi ? ['user:skills'] : []),
        ...(attempt.writeProfileBio ? ['user:profile:write'] : [])].join(' '), response_type: 'code',
      state: attempt.state, nonce: attempt.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(attempt.codeVerifier),
      code_challenge_method: 'S256',
      max_age: String(SESSION_ABSOLUTE_SECONDS),
    });
    for (const resource of apiResources(this.settings.issuer, attempt)) parameters.append('resource', resource);
    return client.buildAuthorizationUrl(configuration, parameters).href;
  }

  async readApis(grant: ApiGrant, page: ApiRefreshPage): Promise<ApiRefreshResult> {
    return refreshApis(this.settings, grant, page, this.fetcher);
  }

  async writeProfileBio(grant: ApiGrant, bio: string): Promise<ProfileBioWriteResult> {
    return writeProfileBio(this.settings, grant, bio, this.fetcher);
  }

  /** The store must lease/CAS this operation: a refresh token rotates on every use. */
  async refreshGrant(input: ApiGrant): Promise<ApiGrant> {
    const startedAt = Date.now();
    let grant: ApiGrant;
    try { grant = validateApiGrant(this.settings, input); }
    catch { throw new ApiGrantRefreshFailure('invalid_grant'); }
    const previousScopes = grant.scope.split(' ');
    if (!grant.refreshToken || !previousScopes.includes('openid') ||
        previousScopes.some((scope) => !supportedScopes.has(scope)) ||
        !hasApiScope(previousScopes, grant.resources, this.settings.issuer)) {
      throw new ApiGrantRefreshFailure('invalid_grant');
    }
    let discovered: client.Configuration;
    try { discovered = await this.configuration(); }
    catch { throw new ApiGrantRefreshFailure('unavailable'); }

    // Do not mutate the shared discovery configuration: each concurrent user has
    // an independent deadline and rotation outcome. Endpoints remain pinned.
    const configuration = new client.Configuration(discovered.serverMetadata(), this.settings.clientId,
      { id_token_signed_response_alg: 'RS256' }, client.None());
    configuration.timeout = 5;
    const metadata = configuration.serverMetadata();
    const signal = AbortSignal.timeout(Math.max(0, 10000 - (Date.now() - startedAt)));
    let tokenSent = false;
    let tokenStatus: number | undefined;
    let userInfoStatus: number | undefined;
    let phase: 'token' | 'userinfo' = 'token';
    configuration[client.customFetch] = async (url, options) => {
      if (![metadata.token_endpoint, metadata.userinfo_endpoint].includes(url)) {
        throw new ApiGrantRefreshFailure('invalid_response');
      }
      if (url === metadata.token_endpoint) {
        if (tokenSent) throw new ApiGrantRefreshFailure('ambiguous');
        tokenSent = true;
      }
      const response = await this.fetcher(url, { ...options,
        body: options.body instanceof Uint8Array ? new Uint8Array(options.body) : options.body,
        cache: 'no-store', signal: AbortSignal.any([signal, ...(options.signal ? [options.signal] : [])]),
      });
      if (url === metadata.token_endpoint) tokenStatus = response.status;
      else userInfoStatus = response.status;
      return response;
    };
    try {
      const parameters = new URLSearchParams({ scope: grant.scope });
      for (const resource of grant.resources) parameters.append('resource', resource);
      const tokens = await withinRefreshBudget(
        client.refreshTokenGrant(configuration, grant.refreshToken, parameters), signal);
      const tokenReceivedAt = Math.floor(Date.now() / 1000);
      const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(' ') : [];
      if (tokens.token_type.toLowerCase() !== 'bearer' || !Number.isSafeInteger(tokens.expires_in) ||
          tokens.expires_in! < 1 || !scopes.includes('openid') ||
          scopes.some((scope) => !previousScopes.includes(scope)) ||
          !hasApiScope(scopes, grant.resources, this.settings.issuer) ||
          !tokens.refresh_token || tokens.refresh_token === grant.refreshToken || tokens.id_token !== undefined) {
        throw new ApiGrantRefreshFailure('invalid_response');
      }
      const renewed = apiGrantSchema.safeParse({ ...grant, accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token, scope: tokens.scope,
        expiresAt: tokenReceivedAt + Math.min(tokens.expires_in!, API_GRANT_MAX_SECONDS) });
      if (!renewed.success) throw new ApiGrantRefreshFailure('invalid_response');
      phase = 'userinfo';
      const profile = profileSchema.parse(await withinRefreshBudget(
        client.fetchUserInfo(configuration, renewed.data.accessToken, grant.subject), signal));
      if (profile.sub !== grant.subject || renewed.data.expiresAt <= Math.floor(Date.now() / 1000)) {
        throw new ApiGrantRefreshFailure('invalid_response');
      }
      return renewed.data;
    } catch (error) {
      if (error instanceof ApiGrantRefreshFailure) throw error;
      const status = phase === 'token' ? tokenStatus : userInfoStatus;
      // Only a pre-exchange failure or explicit token-endpoint throttle is safe
      // to retry with the old refresh token. Even a 5xx may hide a rotation.
      if (!tokenSent || (phase === 'token' && status === 429)) {
        throw new ApiGrantRefreshFailure('unavailable');
      }
      if (status === undefined || status >= 500) throw new ApiGrantRefreshFailure('ambiguous');
      if (status === 401 || status === 403 ||
          (error instanceof client.ResponseBodyError && error.error === 'invalid_grant')) {
        throw new ApiGrantRefreshFailure('invalid_grant');
      }
      throw new ApiGrantRefreshFailure('invalid_response');
    }
  }

  async complete(callback: URL, attempt: Attempt): Promise<OidcIdentity> {
    const startedAt = Date.now();
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
      const resources = apiResources(this.settings.issuer, attempt);
      const resourceParameters = new URLSearchParams();
      for (const resource of resources) resourceParameters.append('resource', resource);
      const tokens = await client.authorizationCodeGrant(configuration, callback, {
        expectedState: attempt.state, expectedNonce: attempt.nonce,
        pkceCodeVerifier: attempt.codeVerifier, idTokenExpected: true,
      }, resourceParameters.size ? resourceParameters : undefined);
      const tokenReceivedAt = Math.floor(Date.now() / 1000);
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
          claims.auth_time > now + 5 || claims.auth_time + SESSION_ABSOLUTE_SECONDS <= now ||
          !equal(claims.nonce, attempt.nonce)) {
        throw new Error('Invalid identity binding.');
      }
      const accessTokenHash = createHash('sha256').update(tokens.access_token, 'ascii')
        .digest().subarray(0, 16).toString('base64url');
      if (!equal(claims.at_hash, accessTokenHash)) throw new Error('Invalid access token binding.');
      stage = 'userinfo';
      const profile = profileSchema.parse(await client.fetchUserInfo(configuration, tokens.access_token, claims.sub));
      if (profile.sub !== claims.sub) throw new Error('UserInfo subject mismatch.');
      stage = 'member_api';
      // Leave time for session writes within the Lambda's 20-second request budget.
      // Slow identity verification must reduce the remaining optional API budget.
      const apiSignal = AbortSignal.timeout(Math.max(0, 12000 - (Date.now() - startedAt)));
      const apiFetch: typeof fetch = (input, init) => this.fetcher(input, {
        ...init, signal: AbortSignal.any([apiSignal, ...(init?.signal ? [init.signal] : [])]),
      });
      const [memberApi, profileDetails, skillsApi] = await Promise.all([
        attempt.readMemberApi
          ? readMemberApi(this.settings.issuer, tokens.access_token, tokens.scope, claims.sub, apiFetch) : undefined,
        attempt.readProfileDetails
          ? readProfileDetails(this.settings.issuer, tokens.access_token, tokens.scope, claims.sub, apiFetch, { signal: apiSignal }) : undefined,
        attempt.readSkillsApi
          ? readSkillsApi(this.settings.issuer, tokens.access_token, tokens.scope, claims.sub, apiFetch, { signal: apiSignal }) : undefined,
      ]);

      // Only explicitly granted API access may be retained in server-private storage.
      // The route must separate apiGrant before writing the public identity/session.
      // The refresh credential is private too; ID tokens are never retained.
      const scopes = tokens.scope?.split(' ') ?? [];
      const hasApiPermission = ((attempt.readMemberApi || attempt.readProfileDetails) && scopes.includes('user:profile')) ||
        (attempt.readSkillsApi && scopes.includes('user:skills')) ||
        (attempt.writeProfileBio && scopes.includes('user:profile:write'));
      const expiresIn = tokens.expires_in;
      const denied = [memberApi, profileDetails, skillsApi].some((result) => result?.status === 'error' &&
        (result.reason === 'unauthorized' || result.reason === 'forbidden')) ||
        (skillsApi?.status === 'success' && Boolean(skillsApi.collection?.authorizationFailure));
      const expiresAt = typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn >= 1
        ? tokenReceivedAt + Math.min(Math.floor(expiresIn), API_GRANT_MAX_SECONDS) : 0;
      const requestedScopes = ['openid', 'profile',
        ...(attempt.readMemberApi || attempt.readProfileDetails ? ['user:profile'] : []),
        ...(attempt.readSkillsApi ? ['user:skills'] : []),
        ...(attempt.writeProfileBio ? ['user:profile:write'] : [])];
      const grant = hasApiPermission && scopes.every((scope) => requestedScopes.includes(scope)) &&
        !denied && expiresAt > Math.floor(Date.now() / 1000)
        ? apiGrantSchema.safeParse({ accessToken: tokens.access_token, scope: tokens.scope,
          ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
          subject: claims.sub, issuer: this.settings.issuer, clientId: this.settings.clientId, resources, expiresAt })
        : undefined;
      return {
        profile,
        ...(memberApi ? { memberApi } : {}),
        ...(profileDetails ? { profileDetails } : {}),
        ...(skillsApi ? { skillsApi } : {}),
        ...(grant?.success ? { apiGrant: grant.data } : {}),
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
