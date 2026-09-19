import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Config } from './config.js';
import type { OidcProvider } from './oidc.js';
import { ATTEMPT_TTL_SECONDS, SESSION_TTL_SECONDS, digest, opaqueSchema, type Store } from './store.js';
import { renderHome } from './view.js';
import { LoginFailure, type LoginStage } from './login-error.js';
import { projectGoalSchema } from './service.js';
import type { HomeViewModel } from './view-model.js';

const random = (): string => randomBytes(32).toString('base64url');
const seconds = (): number => Math.floor(Date.now() / 1000);
const errors: Record<string, string> = {
  login_failed: '로그인 응답을 검증하지 못했습니다. 시간이 지났거나 이미 사용된 요청일 수 있습니다.',
  unavailable: '로그인 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};
const serviceErrors: Record<string, string> = {
  login_required: '미지로 로그인하면 내 정보와 프로젝트 보드를 이용할 수 있어요.',
  profile_required: '내 정보 페이지에서 미지 정보를 가져온 뒤 프로젝트 목표를 선택해 주세요.',
  session_expired: '데모 세션이 만료됐습니다. 다시 로그인해 주세요.',
  save_failed: '프로젝트 목표를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

export function createApp(config: Config, store: Store, oidc: OidcProvider) {
  const app = new Hono();
  const sessionCookie = config.secureCookies ? '__Host-mizi_demo_session' : 'mizi_demo_session';
  const attemptCookie = config.secureCookies ? '__Host-mizi_demo_attempt' : 'mizi_demo_attempt';
  const cookieOptions = { httpOnly: true, secure: config.secureCookies, sameSite: 'Lax' as const, path: '/' };

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // form-action is intentionally not restricted: browsers differ in applying it to
    // cross-origin redirects after POST /login. Forms and POST Origins are fixed below.
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; script-src 'none'");
    if (config.production) c.header('Strict-Transport-Security', 'max-age=31536000');
    await next();
  });
  app.onError(() => {
    // Hono's default logger prints exception objects, which may contain OAuth responses.
    console.error('request_failed');
    return new Response('요청을 처리하지 못했습니다.', { status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
  });

  app.get('/health', (c) => c.json({ status: 'ok', releaseSha: config.release }));
  app.get('/client.json', (c) => c.json({
    client_id: `${config.baseUrl}/client.json`, client_name: 'MiZi OIDC 로그인 예제',
    client_uri: config.baseUrl, redirect_uris: [config.callbackUrl],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'],
    scope: 'openid profile user:profile user:skills',
  }));
  // Public documentation never reads a member session or calls the provider.
  app.get('/developers', (c) => {
    c.header('Referrer-Policy', 'strict-origin');
    return c.html(renderHome({
      page: 'developers', issuer: config.issuer, clientId: config.clientId, baseUrl: config.baseUrl,
      loginAction: '/login', logoutAction: '/logout', authenticated: false,
    }));
  });
  const pages = { '/': 'home', '/profile': 'profile', '/skills': 'skills', '/projects': 'projects' } as const;
  async function page(c: Context, name: NonNullable<HomeViewModel['page']>) {
    const cookie = getCookie(c, sessionCookie);
    const session = cookie && opaqueSchema.safeParse(cookie).success ? await store.getSession(cookie, seconds()) : null;
    if (cookie && !session) deleteCookie(c, sessionCookie, cookieOptions);
    if (name !== 'home' && !session) return c.redirect(`${config.baseUrl}/?service_error=login_required`, 303);
    let skillsVisibleCount = 20;
    if (name === 'skills') {
      const values = c.req.queries('shown') ?? [];
      if (values.length > 1 || (values.length === 1 &&
          (!/^\d{2,3}$/.test(values[0]!) || Number(values[0]) < 20 ||
           Number(values[0]) > 200 || Number(values[0]) % 20 !== 0))) {
        return c.text('표시할 스킬 개수를 확인해 주세요.', 400);
      }
      if (values.length) skillsVisibleCount = Number(values[0]);
    }
    // no-referrer can make browser form POSTs send Origin: null. Every form document
    // must retain its origin; redirects and callback/error responses keep no-referrer.
    c.header('Referrer-Policy', 'strict-origin');
    return c.html(renderHome({
      page: name,
      ...(name === 'skills' ? { skillsVisibleCount } : {}),
      issuer: config.issuer, clientId: config.clientId, baseUrl: config.baseUrl,
      loginAction: '/login', logoutAction: '/logout', authenticated: Boolean(session),
      ...(session ? { profile: session.profile, verification: session.verification,
        memberApi: session.memberApi, projectGoal: session.projectGoal,
        profileDetails: session.profileDetails, skillsApi: session.skillsApi } : {}),
      ...(errors[c.req.query('error') ?? ''] ? { error: errors[c.req.query('error')!] } : {}),
      ...(serviceErrors[c.req.query('service_error') ?? ''] ? { serviceError: serviceErrors[c.req.query('service_error')!] } : {}),
    }));
  }
  for (const [path, name] of Object.entries(pages)) app.get(path, (c) => page(c, name));

  async function startLogin(c: Context, returnPage?: 'profile' | 'skills') {
    if (c.req.header('Origin') !== config.baseUrl) return c.text('허용되지 않은 요청입니다.', 403);
    let readSkillsApi = returnPage === 'skills';
    if (returnPage) {
      const cookie = getCookie(c, sessionCookie);
      const session = cookie && opaqueSchema.safeParse(cookie).success ? await store.getSession(cookie, seconds()) : null;
      if (!session) return c.redirect(`${config.baseUrl}/?service_error=login_required`, 303);
      // Refresh previously requested skills alongside profile data rather than carrying
      // an old snapshot into a new session or silently losing the skills page.
      readSkillsApi ||= Boolean(session.skillsApi);
    }
    const binding = random();
    const attempt = {
      state: random(), nonce: random(), codeVerifier: random(), bindingHash: digest(binding),
      expiresAt: seconds() + ATTEMPT_TTL_SECONDS,
      ...(returnPage ? { readMemberApi: true, readProfileDetails: true, readSkillsApi, returnPage } : {}),
    };
    let stage: LoginStage = 'discovery';
    try {
      const authorizationUrl = await oidc.authorizationUrl(attempt);
      stage = 'attempt_store';
      await store.putAttempt(attempt);
      setCookie(c, attemptCookie, binding, { ...cookieOptions, maxAge: ATTEMPT_TTL_SECONDS });
      return c.redirect(authorizationUrl, 303);
    } catch {
      console.warn('login_unavailable', { stage });
      return c.redirect(`${config.baseUrl}/?error=unavailable`, 303);
    }
  }
  app.post('/login', (c) => startLogin(c));
  app.post('/connect-profile', (c) => startLogin(c, 'profile'));
  app.post('/connect-skills', (c) => startLogin(c, 'skills'));

  app.post('/service/goal', bodyLimit({ maxSize: 1024,
    onError: (c) => c.text('요청 내용이 너무 큽니다.', 413) }), async (c) => {
    if (c.req.header('Origin') !== config.baseUrl) return c.text('허용되지 않은 요청입니다.', 403);
    const id = getCookie(c, sessionCookie);
    const session = id && opaqueSchema.safeParse(id).success ? await store.getSession(id, seconds()) : null;
    if (!session) return c.redirect(`${config.baseUrl}/?service_error=session_expired`, 303);
    if (session.memberApi?.status !== 'success' || session.memberApi.profile.id !== session.profile.sub) {
      return c.redirect(`${config.baseUrl}/projects?service_error=profile_required`, 303);
    }
    if (c.req.header('Content-Type')?.split(';')[0]?.trim() !== 'application/x-www-form-urlencoded') {
      return c.text('지원하지 않는 요청 형식입니다.', 415);
    }
    const body = new URLSearchParams(await c.req.text());
    const goal = projectGoalSchema.safeParse(body.get('goal'));
    if (!goal.success || Array.from(body.entries()).length !== 1) return c.text('프로젝트 목표를 확인해 주세요.', 400);
    try {
      const saved = await store.setProjectGoal(id!, session.profile.sub, goal.data, seconds());
      return c.redirect(saved ? `${config.baseUrl}/projects#project-board` : `${config.baseUrl}/?service_error=session_expired`, 303);
    } catch {
      console.warn('project_save_failed');
      return c.redirect(`${config.baseUrl}/projects?service_error=save_failed`, 303);
    }
  });

  app.get('/auth/callback', async (c) => {
    // Only the query is read from the incoming URL. Host/Forwarded never set redirect_uri.
    const callback = new URL(config.callbackUrl);
    callback.search = new URL(c.req.url).search;
    let stage: LoginStage = 'callback';
    try {
      for (const name of callback.searchParams.keys()) {
        if (callback.searchParams.getAll(name).length !== 1) throw new Error('Duplicate callback parameter.');
      }
      const state = opaqueSchema.parse(callback.searchParams.get('state'));
      const binding = opaqueSchema.parse(getCookie(c, attemptCookie));
      if (callback.searchParams.get('iss') !== config.issuer) throw new Error('Issuer response mismatch.');
      stage = 'attempt_consume';
      const attempt = await store.consumeAttempt(state, digest(binding), seconds());
      if (!attempt) throw new Error('Invalid login attempt.');
      deleteCookie(c, attemptCookie, cookieOptions);
      stage = 'oidc_validation';
      const identity = await oidc.complete(callback, attempt);
      const id = random();
      stage = 'session_write';
      await store.putSession(id, { ...identity, expiresAt: seconds() + SESSION_TTL_SECONDS });
      const previous = getCookie(c, sessionCookie);
      if (previous && opaqueSchema.safeParse(previous).success) await store.deleteSession(previous);
      setCookie(c, sessionCookie, id, { ...cookieOptions, maxAge: SESSION_TTL_SECONDS });
      return c.redirect(`${config.baseUrl}/${attempt.returnPage ?? ''}`, 303);
    } catch (error) {
      console.warn('login_failed', { stage: error instanceof LoginFailure ? error.stage : stage });
      return c.redirect(`${config.baseUrl}/?error=login_failed`, 303);
    }
  });

  app.post('/logout', async (c) => {
    if (c.req.header('Origin') !== config.baseUrl) return c.text('허용되지 않은 요청입니다.', 403);
    const id = getCookie(c, sessionCookie);
    if (id && opaqueSchema.safeParse(id).success) await store.deleteSession(id);
    deleteCookie(c, sessionCookie, cookieOptions);
    deleteCookie(c, attemptCookie, cookieOptions);
    return c.redirect(`${config.baseUrl}/`, 303);
  });
  return app;
}
