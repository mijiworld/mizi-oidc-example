const SOURCE = 'https://github.com/mijiworld/mizi-oidc-example';
const CENTER = 'https://mcp-auth.cccv.ai/developer/oauth-clients';
const GUIDE = 'https://mcp-auth.cccv.ai/developer/guide/oidc';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
function code(label: string, value: string): string {
  return `<figure class="dg-code"><figcaption>${escape(label)}</figcaption><pre tabindex="0" aria-label="${escape(label)}"><code>${escape(value)}</code></pre></figure>`;
}
function link(href: string, label: string): string {
  // Configuration is validated at startup; keep this renderer safe in isolation too.
  try {
    const url = new URL(href);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return escape(label);
    return `<a href="${escape(url.href)}" target="_blank" rel="noreferrer">${escape(label)} ↗</a>`;
  } catch { return escape(label); }
}
function origin(value: string): string {
  try { return new URL(value).origin; } catch { return value; }
}
function host(value: string): string {
  try { return new URL(value).host; } catch { return value; }
}
function json(value: unknown): string { return JSON.stringify(value, null, 2); }

/** Public documentation only. No session, tokens, user profile or executable scripts. */
export function renderDeveloperGuide(model: { issuer: string; clientId: string; baseUrl: string }): string {
  const apiOrigin = origin(model.issuer);
  const discovery = `${model.issuer}/.well-known/openid-configuration`;
  const callback = `${model.baseUrl}/auth/callback`;
  const resources = ['/v1/me', '/v1/me/profile', '/v1/me/skills'].map((path) => `${apiOrigin}${path}`);
  const http = (path: string) => code('HTTP 요청 · 토큰 자리는 설명용 표시',
    `GET ${path} HTTP/1.1\nHost: ${host(model.issuer)}\nAuthorization: Bearer <ACCESS_TOKEN>\nAccept: application/json`);

  return `<section class="dev-guide" aria-labelledby="developer-title">
    <div class="dg-hero">
      <p class="eyebrow">Developer guide · MiZi API</p>
      <h1 id="developer-title">미지 로그인에서<br>내 서비스까지.</h1>
      <p class="lead">사용자가 허용한 정보만 읽어 여러분의 서비스에 연결하세요. 이 페이지는 데모가 사용하는 인증 흐름과 세 가지 읽기 API를 설명합니다. 로그인 없이 볼 수 있습니다.</p>
      <div class="dg-links"><a href="/">데모 홈으로 돌아가기</a>${link(`${SOURCE}#quickstart`, 'GitHub에서 시작하기')}${link(GUIDE, '미지 OIDC 가이드')}${link(discovery, '현재 Discovery 보기')}</div>
    </div>
    <nav class="dg-toc" aria-label="API 가이드 목차"><strong>필요한 부분부터 읽기</strong><ol>
      <li><a href="#dg-start">시작하기</a></li><li><a href="#dg-auth">로그인과 권한</a></li><li><a href="#dg-session">로그인 유지 정책</a></li><li><a href="#dg-api">API 규격</a></li>
      <li><a href="#dg-fetch">서버 호출 예제</a></li><li><a href="#dg-pagination">스킬 페이지 조회</a></li><li><a href="#dg-errors">오류와 저장 정책</a></li><li><a href="#dg-source">실제 코드</a></li>
    </ol></nav>

    <section class="dg-section" id="dg-start" aria-labelledby="dg-start-title">
      <h2 id="dg-start-title">세 단계로 연결합니다</h2>
      <ol class="dg-steps">
        <li><strong>앱과 돌아올 주소 준비</strong><p>공개 클라이언트와 정확한 콜백 URL을 준비합니다. 이 예제는 client secret 없이 PKCE를 사용합니다.</p></li>
        <li><strong>로그인 검증 후 권한 확인</strong><p>Authorization Code를 교환하고 ID 토큰과 UserInfo를 검증합니다. API를 읽을 때 필요한 범위에 추가로 동의받습니다.</p></li>
        <li><strong>서버에서 API 호출</strong><p>접근 토큰을 Bearer 헤더에 넣습니다. 응답을 검사하고 필요한 필드만 자체 서비스에 사용합니다.</p></li>
      </ol>
      <details class="dg-detail"><summary>로컬 실행 · 등록형 클라이언트와 CIMD</summary>
        <p>로컬에서는 ${link(CENTER, '미지 개발자 센터')}에서 공개 클라이언트를 만들고 <code>http://localhost:3000/auth/callback</code>을 등록하세요. 발급된 <code>mzp_…</code>를 <code>CLIENT_ID</code>에 넣고 <code>openid profile user:profile user:skills</code>를 사용할 수 있도록 설정합니다. 콜백 URL은 포트와 경로까지 일치해야 합니다.</p>
        ${code('로컬 빠른 시작 · Node.js 20.20 이상 / pnpm 9.4.0', `git clone ${SOURCE}.git\ncd mizi-oidc-example\ncorepack enable\npnpm install --frozen-lockfile\ncp .env.example .env\n# .env의 CLIENT_ID에 발급받은 mzp_… 입력\npnpm dev`)}
        <p>이 라이브 데모는 공개 HTTPS 주소의 ${link(`${model.baseUrl}/client.json`, 'CIMD 문서')}를 client ID로 사용합니다. CIMD는 앱 메타데이터를 제공하는 방식입니다. <code>localhost</code> 문서는 미지 서버에서 가져올 수 없으므로 로컬 예제에는 등록형 클라이언트를 사용합니다.</p>
        <dl class="dg-config"><div><dt>현재 발급자 · issuer</dt><dd><code>${escape(model.issuer)}</code></dd></div><div><dt>현재 데모 client ID</dt><dd><code>${escape(model.clientId)}</code></dd></div><div><dt>현재 데모 콜백 URL</dt><dd><code>${escape(callback)}</code></dd></div></dl>
      </details>
    </section>

    <section class="dg-section" id="dg-auth" aria-labelledby="dg-auth-title">
      <h2 id="dg-auth-title">로그인과 API 접근 권한은 따로 봅니다</h2>
      <p>인증은 OIDC Authorization Code + PKCE(S256)를 사용합니다. 인가·토큰·UserInfo·공개키 주소는 고정된 issuer의 Discovery에서 읽으세요. 콜백 요청의 Host나 <code>iss</code> 값으로 서버 설정을 바꾸면 안 됩니다.</p>
      <div class="dg-table-wrap"><table class="dg-table"><thead><tr><th>범위</th><th>이 데모에서 하는 일</th><th>규격</th></tr></thead><tbody>
        <tr><td><code>openid</code></td><td>회원 식별자 <code>sub</code>로 로그인</td><td>OIDC 표준</td></tr>
        <tr><td><code>profile</code></td><td>UserInfo의 닉네임 요청</td><td>OIDC 표준 범위</td></tr>
        <tr><td><code>user:profile</code></td><td>회원·소개·관심 분야 API 읽기</td><td>미지 고유 범위</td></tr>
        <tr><td><code>user:skills</code></td><td>내 스킬 API 읽기</td><td>미지 고유 범위</td></tr>
      </tbody></table></div>
      <p class="dg-note"><code>profile</code>과 <code>user:profile</code>은 다릅니다. <code>openid profile</code>로 로그인했다고 회원 API까지 허용된 것은 아닙니다.</p>
      <p>한 번 연결한 뒤에는 <strong>다시 가져오기</strong>로 같은 화면의 정보만 새로 읽습니다. 접근 토큰 갱신이 필요하면 서버에서 처리하며 프로젝트 선택도 유지합니다. 연결이 없거나 권한이 취소된 경우에는 <strong>다시 연결하기</strong>를 직접 선택합니다. 자동으로 미지 로그인 화면을 열지는 않습니다.</p>
      <details class="dg-detail"><summary>인가 요청과 코드 교환에 넣는 값</summary>
        <p>아래는 스킬까지 읽을 때의 주요 매개변수입니다. 실제 전송에는 URL 인코딩을 적용합니다. 첫 로그인에는 <code>openid profile</code>만 요청하고, 추가 API 권한은 사용자가 가져오기를 선택할 때 요청합니다.</p>
        ${code('인가 요청 매개변수 · URL 인코딩 전 설명용', `response_type=code\nclient_id=${model.clientId}\nredirect_uri=${callback}\nscope=openid profile user:profile user:skills\nmax_age=7776000\ncode_challenge=<S256으로 계산한 PKCE challenge>\ncode_challenge_method=S256\nstate=<브라우저에 결합한 일회용 state>\nnonce=<일회용 nonce>\n${resources.map((resource) => `resource=${resource}`).join('\n')}`)}
        <p><code>resource</code>는 접근하려는 API 주소를 나타내는 표준 매개변수입니다. 이 데모는 호출할 주소마다 반복해서 인가 요청과 코드 교환에 동일하게 전달합니다. 미지는 <code>openid</code> 동의에 UserInfo 대상도 포함합니다.</p>
        <p>코드 교환에는 <code>grant_type=authorization_code</code>, 받은 <code>code</code>, 같은 <code>redirect_uri</code>, <code>client_id</code>, 저장한 <code>code_verifier</code>와 해당 <code>resource</code>를 보냅니다. 이 예제의 공개 클라이언트 인증 방식은 <code>none</code>입니다.</p>
        <p>state·nonce·PKCE verifier는 브라우저별 일회용 요청에 묶어 서버에 저장합니다. 콜백의 state·iss, ID 토큰의 RS256 서명·iss·aud·exp·nonce·at_hash, UserInfo의 sub를 확인한 뒤 자체 세션을 만듭니다. 전체 구현은 ${link(`${SOURCE}/blob/main/src/oidc.ts`, 'src/oidc.ts')}를 참고하세요.</p>
      </details>
      <details class="dg-detail"><summary>ID 토큰과 접근 토큰의 차이</summary>
        <div class="dg-table-wrap"><table class="dg-table"><thead><tr><th>종류</th><th>미지의 현재 형식</th><th>용도</th></tr></thead><tbody>
          <tr><td>ID 토큰</td><td>RS256으로 서명한 JWT</td><td>앱이 로그인 결과 검증</td></tr>
          <tr><td>접근 토큰</td><td><code>dgt_…</code> 형태의 opaque 값</td><td>API의 Bearer 인증</td></tr>
        </tbody></table></div>
        <p>접근 토큰을 JWT처럼 해석하거나 자체적으로 회원 정보를 추출하지 마세요. API에는 ID 토큰 대신 <code>access_token</code>을 보냅니다. OAuth가 모든 접근 토큰의 JWT 형식을 요구하는 것은 아닙니다.</p>
      </details>
    </section>

    <section class="dg-section" id="dg-session" aria-labelledby="dg-session-title">
      <h2 id="dg-session-title">로그인은 얼마나 유지되나요?</h2>
      <p>새 로그인부터 <strong>30일 미사용 시 만료, 실제 미지 인증 후 최대 90일</strong>을 적용합니다. 로그인한 홈·내 정보·내 스킬·프로젝트 방문과 해당 화면의 정상 POST는 미사용 기한을 갱신합니다. 더 보기·프로젝트 선택도 사용으로 보지만, 페이지를 열어 두기만 하는 백그라운드 ping은 없습니다. 계속 사용해도 90일 상한은 늘어나지 않습니다.</p>
      <p>미지 로그인, 이 데모 로그인, Google 등의 로그인은 서로 다른 세션입니다. 미지와 데모는 각각 30일 미사용·90일 절대 한도를 적용합니다. 영속 쿠키가 유효하면 브라우저를 다시 열어도 로그인은 유지되지만, 쿠키 삭제·로그아웃·만료 시에는 다시 로그인합니다. 데모 로그아웃은 미지나 Google의 로그인까지 끝내지 않습니다.</p>
      <p>기존 데모 세션은 종전 30분 만료를 유지하며 새 로그인부터 새 정책을 적용합니다. refresh token이 없는 예전 연결은 한 번 다시 연결해야 합니다. API 연결이 취소되어도 유효한 앱 로그인은 유지하고 이전 조회 결과를 구분해서 표시합니다.</p>
      <details class="dg-detail"><summary>세션·토큰 수명과 내 서비스의 정책 변경</summary>
        <div class="dg-table-wrap"><table class="dg-table"><thead><tr><th>대상</th><th>현재 기한</th><th>의미</th></tr></thead><tbody>
          <tr><td>앱 로그인</td><td>30일 미사용 / 최대 90일</td><td>검증한 인증 시각과 세션 발급 시각에서 각각 90일 중 이른 상한</td></tr>
          <tr><td>로그인 시도</td><td>10분</td><td>state·nonce·PKCE를 묶은 일회용 요청</td></tr>
          <tr><td>인가 코드</td><td>60초</td><td>한 번 교환</td></tr>
          <tr><td>ID 토큰</td><td>5분</td><td>로그인 결과 검증용</td></tr>
          <tr><td>접근 토큰</td><td>현재 1시간</td><td>응답의 <code>expires_in</code>을 기준으로 계산</td></tr>
          <tr><td>갱신 토큰</td><td>90일 미사용 / 발급 후 최대 365일</td><td>API 자격 갱신용이며 앱 로그인 한도를 늘리지 않음</td></tr>
        </tbody></table></div>
        <p>30일·90일은 이 서비스의 정책이며 OIDC 표준이 정한 수명이 아닙니다. 개발자는 ${link(`${SOURCE}/blob/main/src/session-policy.ts`, 'src/session-policy.ts')}의 <code>SESSION_IDLE_SECONDS</code>·<code>SESSION_ABSOLUTE_SECONDS</code>를 검토하세요. 서버 만료 검사·쿠키·DynamoDB TTL·OIDC <code>max_age</code>가 함께 적용되어야 합니다. 검증한 <code>auth_time</code>으로 절대 한도를 제한하므로 재동의나 토큰 갱신이 새 로그인 시각을 만들지 않습니다.</p>
        <p>서버에서 만료를 검사하고 운영 쿠키에 Secure·HttpOnly·SameSite=Lax를 사용합니다. 이 구분의 배경은 ${link('https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#automatic-session-expiration', 'OWASP 세션 만료 지침')}과 ${link('https://openid.net/specs/openid-connect-core-1_0.html#IDToken', 'OIDC auth_time 정의')}에서 확인할 수 있습니다.</p>
      </details>
    </section>

    <section class="dg-section" id="dg-api" aria-labelledby="dg-api-title">
      <h2 id="dg-api-title">데모가 호출하는 세 가지 API</h2>
      <p>기본 주소는 <code>${escape(apiOrigin)}</code>입니다. HTTPS로 호출하고 JSON 응답을 받습니다. 경로·응답 필드·<code>user:*</code> 권한 이름은 미지의 API 계약이며 OIDC의 공통 사용자 정보 규격은 아닙니다.</p>
      <div class="dg-table-wrap"><table class="dg-table"><thead><tr><th>메서드 · 경로</th><th>필수 범위</th><th>데모에서 쓰는 정보</th></tr></thead><tbody>
        <tr><td><a href="#dg-me"><code>GET /v1/me</code></a></td><td><code>user:profile</code></td><td>회원 ID·닉네임·GitHub 연결 상태</td></tr>
        <tr><td><a href="#dg-profile"><code>GET /v1/me/profile</code></a></td><td><code>user:profile</code></td><td>역할·소개·관심 분야</td></tr>
        <tr><td><a href="#dg-skills"><code>GET /v1/me/skills</code></a></td><td><code>user:skills</code></td><td>스킬 이름·출처·제공된 검증 정보</td></tr>
      </tbody></table></div>
      <p class="dg-note">아래 JSON은 모두 가상 자료로 만든 <strong>설명용 일부 필드 예제</strong>입니다. 전체 응답 스키마나 실제 회원의 조회 결과를 나타내지 않습니다.</p>
      <article class="dg-endpoint" id="dg-me"><h3><code>GET /v1/me</code> · 회원 기본 정보</h3>
        <p><code>id</code>를 검증한 OIDC <code>sub</code>와 대조합니다. <code>github_connected</code>는 계정 연결 상태이며 스킬 검증 결과가 아닙니다.</p>
        <details class="dg-detail"><summary>HTTP 요청과 가상 응답 보기</summary>${http('/v1/me')}${code('설명용 일부 필드 예제 · 가상 JSON', json({ id: 'usr_example', nickname: '예제 회원', github_connected: false }))}
        <p>실제 응답에는 <code>avatar_url</code>, <code>providers</code>, <code>github_login</code>도 포함됩니다. 데모는 이 필드들을 저장하지 않습니다.</p></details>
      </article>
      <article class="dg-endpoint" id="dg-profile"><h3><code>GET /v1/me/profile</code> · 소개와 관심 분야</h3>
        <p>회원 ID는 <code>user.id</code>, 역할은 <code>user.role</code>에 있습니다. 소개와 관심 분야는 회원이 작성한 정보입니다.</p>
        <details class="dg-detail"><summary>HTTP 요청과 가상 응답 보기</summary>${http('/v1/me/profile')}${code('설명용 일부 필드 예제 · 가상 JSON', json({ user: { id: 'usr_example', role: '웹 개발자' }, bio: '작은 도구를 만들어요.', interests: ['웹', '디자인'], partial: false }))}
        <p>전체 응답에는 연락처·위치 등도 포함됩니다. 데모는 이를 제외하고 역할·소개·관심 분야만 남깁니다. <code>partial=true</code>는 집계 일부를 확인하지 못했다는 뜻이며 특정 소개 필드가 잘못됐다는 뜻은 아닙니다.</p></details>
      </article>
      <article class="dg-endpoint" id="dg-skills"><h3><code>GET /v1/me/skills</code> · 내 스킬 목록</h3>
        <p>원출처와 API가 제공한 검증 방법·주체·시각을 구분합니다. 검증 시각이 없으면 데모 조회 시각으로 채우지 않습니다.</p>
        <details class="dg-detail"><summary>HTTP 요청과 가상 응답 보기</summary>${http('/v1/me/skills?limit=20')}${code('설명용 일부 필드 예제 · 가상 JSON', json({ items: [{ id: 'skl_example', name: 'TypeScript', source: 'github_analysis', verification_method: 'github_repo_analysis', verified_by: '예제 검증 주체', verified_at: '2026-09-01T00:00:00Z', visible: false, visibility: { profile: false, skills: true } }], next_cursor: null }))}
        <p><code>verification_method</code>, <code>verified_by</code>, <code>verified_at</code>는 없을 수 있습니다. 이 API에는 스킬별 회원 ID나 전체 건수, <code>partial</code> 필드가 없습니다. 데모는 검증된 접근 토큰의 회원 세션에 조회 결과를 묶으며 독립적인 스킬 검증을 주장하지 않습니다.</p>
        <p>본인 목록에는 비공개 스킬도 포함될 수 있습니다. 공개 여부와 관계없이 타인에게 노출하지 않도록 자체 서비스의 접근 권한을 유지하세요.</p></details>
      </article>
    </section>

    <section class="dg-section" id="dg-fetch" aria-labelledby="dg-fetch-title">
      <h2 id="dg-fetch-title">서버에서 Bearer 토큰으로 호출합니다</h2>
      <p>다음은 로그인 검증을 마친 뒤 실행하는 핵심 호출 예제입니다. 토큰은 코드 교환 응답에서 서버가 받은 값이며, 사용자가 이 페이지에 입력하는 값이 아닙니다.</p>
      <details class="dg-detail"><summary>TypeScript · 회원 API 호출 예제</summary>
        ${code('서버측 핵심 예제 · Zod 검증 및 회원 ID 대조', `import { z } from 'zod';\n\nconst apiOrigin = ${JSON.stringify(apiOrigin)};\nconst memberSchema = z.object({\n  id: z.string().min(1),\n  nickname: z.string(),\n  github_connected: z.boolean(),\n});\n\nasync function readMember(\n  accessToken: string, grantedScope: string, verifiedSub: string,\n) {\n  if (!grantedScope.split(/\\s+/).includes('user:profile')) {\n    throw new Error('profile_scope_required');\n  }\n  const response = await fetch(new URL('/v1/me', apiOrigin), {\n    headers: {\n      Authorization: 'Bearer ' + accessToken,\n      Accept: 'application/json',\n    },\n    redirect: 'error',\n    cache: 'no-store',\n    signal: AbortSignal.timeout(5000),\n  });\n  if (!response.ok) throw new Error('member_api_failed');\n  const member = memberSchema.parse(await response.json());\n  if (member.id !== verifiedSub) throw new Error('subject_mismatch');\n  return { id: member.id, nickname: member.nickname,\n    githubConnected: member.github_connected };\n}`)}
        <p>이 짧은 예제는 호출과 회원 ID 검사를 보여줍니다. 실제 앱에서는 MIME·응답 크기·전체 시간 제한·오류 분류도 적용하세요. ${link(`${SOURCE}/blob/main/src/member-api.ts`, '회원 API 구현')}에서 응답 검증과 오류 분류를, ${link(`${SOURCE}/blob/main/src/extra-api.ts`, '소개·스킬 API 구현')}에서 응답 크기와 수집 한도를 확인할 수 있습니다.</p>
        <p>브라우저로 토큰을 보내지 않고 서버에서 호출하므로 이 예제에 브라우저 CORS 허용 출처를 추가할 필요는 없습니다. 응답을 그대로 화면이나 로그에 출력하지 말고 허용한 필드만 추출하세요.</p>
      </details>
    </section>

    <section class="dg-section" id="dg-pagination" aria-labelledby="dg-pagination-title">
      <h2 id="dg-pagination-title">스킬은 응답의 cursor로 이어 읽습니다</h2>
      <p><code>limit</code>은 기본 20, 최대 100입니다. <code>next_cursor</code>가 있으면 해석하거나 직접 만들지 않고 다음 요청의 <code>cursor</code>에 그대로 넣습니다. <code>URLSearchParams</code>로 인코딩하세요.</p>
      ${code('다음 페이지의 요청 URL 구성', `const nextUrl = new URL('/v1/me/skills', ${JSON.stringify(apiOrigin)});\nnextUrl.searchParams.set('limit', '20');\nnextUrl.searchParams.set('cursor', previousPage.next_cursor);\n// 같은 서버측 Bearer 접근 토큰으로 GET 요청`)}
      <ul class="dg-list"><li>첫 페이지에는 CCCV 보충 스킬이 앞에 합쳐져 <code>limit</code>보다 많은 항목이 올 수 있습니다. 응답 전체를 확인한 뒤 저장 한도를 적용하세요.</li>
        <li>cursor는 미지 목록의 다음 페이지를 가리킵니다. 첫 페이지에서 생략한 CCCV 항목을 다음 cursor로 복구할 수 있다고 가정하지 마세요.</li>
        <li><code>next_cursor=null</code>은 미지 후속 페이지가 없다는 뜻입니다. CCCV 보충 조회의 실패가 별도로 표시되지 않을 수 있어 전체 스킬을 빠짐없이 확인했다는 보증은 아닙니다.</li>
        <li>응답 중복·반복 cursor·시간과 저장 한도를 처리하세요. 데모의 <strong>더 보기</strong>는 외부 API를 다시 호출하지 않고 이미 저장한 목록을 20개씩 펼칩니다.</li></ul>
    </section>

    <section class="dg-section" id="dg-errors" aria-labelledby="dg-errors-title">
      <h2 id="dg-errors-title">오류 처리와 데모의 저장 정책</h2>
      <div class="dg-table-wrap"><table class="dg-table"><thead><tr><th>상태</th><th>확인할 것</th></tr></thead><tbody>
        <tr><td><code>401</code></td><td>인증 정보가 없거나 토큰이 유효하지 않을 수 있습니다. 만료·연결 취소 등을 확인하고 필요하면 새 인증을 시작합니다.</td></tr>
        <tr><td><code>403</code></td><td>필요한 scope 또는 해당 작업의 접근 권한을 확인합니다. 유효한 로그인만으로 모든 API가 허용되지는 않습니다.</td></tr>
        <tr><td>통신 실패 · 기타 오류</td><td>성공으로 표시하지 않습니다. 잠시 뒤 재시도할 수 있도록 안내하고 원본 토큰·응답은 로그에 남기지 않습니다.</td></tr>
      </tbody></table></div>
      <p>위 회원 API의 오류 응답은 <code>application/problem+json</code>이며 <code>type</code>, <code>title</code>, <code>status</code>, <code>code</code>, <code>trace_id</code> 등을 사용합니다. 예를 들어 <code>session_expired</code>는 만료·취소된 토큰, <code>consent_required</code>는 권한 부족 등에 사용됩니다. OIDC UserInfo의 <code>{ error, error_description }</code> 응답과 구분하세요.</p>
      <details class="dg-detail"><summary>이 데모에만 적용한 저장·조회 정책</summary>
        <ul><li>추가 API 권한을 허용하면 접근·갱신 토큰을 서버 전용 DynamoDB 필드에 보관합니다. 저장 시 암호화(SSE)를 사용하며 일반 세션 조회·화면 모델·브라우저·로그에 토큰 원문을 전달하지 않습니다. ID 토큰은 보관하지 않습니다.</li>
          <li>접근 토큰은 실제 응답의 <code>expires_in</code>(현재 3600초)을 따릅니다. 사용자가 다시 가져오기를 요청할 때 만료가 가까우면 서버가 갱신합니다. 분산 잠금과 조건부 저장으로 갱신을 직렬화하고 회전된 최신 토큰을 보관합니다. 토큰 갱신으로 로그인 절대 한도를 연장하지 않습니다.</li>
          <li><code>POST /refresh-profile</code>은 회원 기본 정보와 소개를, <code>POST /refresh-skills</code>는 스킬 목록만 갱신합니다. 다른 화면의 조회 결과와 프로젝트 선택, 세션 ID·로그인 절대 한도는 유지합니다. 정상 사용으로 미사용 기한만 갱신하며 요청의 Origin과 세션, 저장된 권한·대상 API를 서버에서 확인합니다.</li>
          <li>조회 실패 시 이전 결과와 조회 시각을 유지합니다. 프로필의 일부 API만 성공하면 해당 결과만 갱신하므로 각 시각을 확인하세요. 권한 취소·갱신의 <code>invalid_grant</code>·API의 401/403에는 자격을 제거하고 재연결을 안내하며 앱 로그인은 별도로 유지합니다. 스킬 후속 페이지의 401/403도 이번 목록 대신 이전 목록과 조회 시각을 유지합니다. 일시적인 통신 실패를 새 조회 성공으로 표시하거나 자동으로 OAuth 화면을 열지 않습니다.</li>
          <li>스킬은 최대 200개 고유 ID, 저장 요약 192 KiB, 10페이지, 5초 중 먼저 도달한 한도까지 모읍니다. 원본 응답은 페이지당 256 KiB·누적 1 MiB이며 공통 API 시간 예산도 적용합니다.</li>
          <li>후속 페이지에서 실패하면 앞서 확인한 목록과 중단 사유를 남깁니다. 같은 ID는 첫 정보를 유지합니다. 저장된 목록을 모두 펼쳤다는 것과 모든 원천 스킬을 수집했다는 것은 별개입니다.</li>
          <li>더 보기는 저장된 목록만 펼칩니다. 예전 세션처럼 재조회 연결이 없으면 한 번 명시적으로 다시 연결해야 합니다. 재연결은 새 인증·동의 흐름이며, 같은 회원으로 기본 회원 조회까지 성공하면 유효한 기존 세션의 프로젝트 선택을 이어갑니다. 다른 계정에는 이전 정보나 목표를 넘기지 않습니다. 거절·로그인 검증 실패 시 기존 세션은 유지됩니다.</li>
          <li>로그아웃이나 계정 교체 시 이전 서버 세션과 접근·갱신 토큰을 삭제합니다. DynamoDB의 TTL 삭제는 지연될 수 있지만, 앱은 세션·토큰의 만료를 검사해 만료된 연결을 사용할 수 없게 합니다.</li>
          <li>미지에서 연결을 해제해도 이미 저장된 요약은 데모 세션에 남을 수 있습니다. 즉시 지우려면 데모에서도 로그아웃하세요. 데모 로그아웃은 미지의 로그인 상태까지 종료하지 않습니다.</li></ul>
      </details>
    </section>

    <section class="dg-section" id="dg-source" aria-labelledby="dg-source-title">
      <h2 id="dg-source-title">설명 다음에는 실제 코드로</h2>
      <p>같은 흐름을 공개 예제에서 확인하고 여러분의 서비스에 맞게 변경할 수 있습니다.</p>
      <div class="dg-source-list">
        <a href="${SOURCE}/blob/main/src/oidc.ts" target="_blank" rel="noreferrer"><strong>src/oidc.ts ↗</strong><span>Discovery · PKCE · ID 토큰 · UserInfo 검증</span></a>
        <a href="${SOURCE}/blob/main/src/member-api.ts" target="_blank" rel="noreferrer"><strong>src/member-api.ts ↗</strong><span>회원 API 호출 · 최소 필드 추출 · 주체 대조</span></a>
        <a href="${SOURCE}/blob/main/src/extra-api.ts" target="_blank" rel="noreferrer"><strong>src/extra-api.ts ↗</strong><span>소개와 스킬 · cursor 수집 · 실패와 한도</span></a>
        <a href="${SOURCE}/blob/main/src/api-grant.ts" target="_blank" rel="noreferrer"><strong>src/api-grant.ts ↗</strong><span>서버 전용 접근 토큰 · 범위·대상·만료 스키마</span></a>
        <a href="${SOURCE}/blob/main/src/api-refresh.ts" target="_blank" rel="noreferrer"><strong>src/api-refresh.ts ↗</strong><span>OAuth 이동 없는 API 재조회 · 고정 경로와 시간 제한</span></a>
        <a href="${SOURCE}/blob/main/src/store.ts" target="_blank" rel="noreferrer"><strong>src/store.ts ↗</strong><span>일회용 요청 · 회원에 묶인 세션 스키마</span></a>
      </div>
      <p>${link(GUIDE, '미지 인증 서버 연동 가이드')} · ${link('https://openid.net/specs/openid-connect-core-1_0.html', 'OpenID Connect Core')} · ${link('https://www.rfc-editor.org/rfc/rfc7636', 'PKCE · RFC 7636')} · ${link('https://www.rfc-editor.org/rfc/rfc6750', 'Bearer · RFC 6750')} · ${link('https://www.rfc-editor.org/rfc/rfc8707', 'Resource Indicators · RFC 8707')}</p>
    </section>
  </section>`;
}
