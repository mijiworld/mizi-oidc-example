import type { HomeViewModel } from "./view-model.js";
import { styles } from "./styles.js";

const SOURCE = "https://github.com/mijiworld/mizi-oidc-example";
const GUIDE = "https://mcp-auth.cccv.ai/developer/guide/oidc";

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

function row(label: string, value: string): string {
  return `<div><dt>${escape(label)}</dt><dd><code>${escape(value)}</code></dd></div>`;
}

function resources(): string {
  return `<nav class="resources" aria-label="개발자 자료">
    <a href="${SOURCE}" target="_blank" rel="noreferrer">GitHub 소스 보기 ↗</a>
    <a href="${GUIDE}" target="_blank" rel="noreferrer">OIDC 연동 가이드 ↗</a>
  </nav>`;
}

function login(model: HomeViewModel): string {
  const clientType = model.clientId.startsWith("https://")
    ? "CIMD · 공개 클라이언트"
    : "등록형 공개 클라이언트";
  return `<section class="intro">
    <p class="eyebrow">OpenID Connect · Live example</p>
    <h1>미지 계정으로,<br>내 서비스에 로그인.</h1>
    <p class="lead">로그인부터 ID 토큰 검증까지, 실제 연동 흐름을 체험해 보세요.
      이 데모는 미지와 별도의 서비스로 동작하는 공개 예제입니다.</p>
  </section>
  ${model.error ? `<section class="error" role="alert"><h2>로그인을 완료하지 못했어요</h2><p>${escape(model.error)}</p><p>아래 버튼으로 새 로그인 요청을 시작해 주세요.</p></section>` : ""}
  <div class="grid">
    <section class="card" aria-labelledby="login-heading">
      <h2 id="login-heading">직접 로그인해 보세요</h2>
      <p class="subtle">미지에서 계정을 확인하고 동의하면 이곳으로 돌아옵니다.
        요청하는 정보는 회원 식별자와 닉네임입니다.</p>
      <div class="tags"><span class="tag">${clientType}</span><span class="tag">PKCE · S256</span><span class="tag">openid profile</span></div>
      <form class="login-form" action="${escape(model.loginAction)}" method="post">
        <button class="button primary" type="submit">미지로 로그인 <span aria-hidden="true">→</span></button>
      </form>
      <p class="fine">로그인은 미지 화면에서 진행하며, 비밀번호는 이 데모에 전달되지 않습니다.</p>
      ${resources()}
    </section>
    <section class="card" aria-labelledby="flow-heading">
      <h2 id="flow-heading">돌아오는 길에 확인하는 것</h2>
      <ol class="flow">
        <li><strong>새 로그인 요청 만들기</strong><p>state·nonce·PKCE로 이 브라우저의 로그인 시도를 연결합니다.</p></li>
        <li><strong>미지에서 로그인하고 동의하기</strong><p>미지가 사용자를 확인한 뒤 일회용 인가 코드를 돌려줍니다.</p></li>
        <li><strong>서버에서 검증하고 결과 보기</strong><p>ID 토큰의 서명과 요청 정보를 검증하고, UserInfo의 회원 식별자까지 대조합니다.</p></li>
      </ol>
    </section>
  </div>`;
}

function success(
  model: HomeViewModel,
  profile: NonNullable<HomeViewModel["profile"]>,
  verified: NonNullable<HomeViewModel["verification"]>,
): string {
  return `<section class="intro">
    <p class="eyebrow">OpenID Connect · Verified session</p>
    <h1>로그인을 확인했어요.</h1>
    <p class="lead">미지가 발급한 ID 토큰을 이 데모 서버에서 검증했습니다.
      아래는 이번 로그인에서 확인한 결과입니다.</p>
  </section>
  <div class="grid">
    <section class="card" aria-labelledby="profile-heading">
      <span class="status"><span aria-hidden="true">✓</span> 서버 검증 완료</span>
      <div class="person"><h2 id="profile-heading"><bdi>${escape(profile.nickname || "미지 회원")}</bdi></h2><p class="subtle">미지에서 받은 회원 정보</p></div>
      <dl class="data">
        ${row("회원 식별자 · sub", profile.sub)}
        ${row("발급자 · iss", verified.issuer)}
        ${row("이 데모의 클라이언트 · aud", verified.audience)}
        ${row("미지 인증 시각 · UTC", verified.authenticatedAt)}
        ${row("검증 시각 · UTC", verified.checkedAt)}
      </dl>
      <form class="logout" action="${escape(model.logoutAction)}" method="post"><button class="button secondary" type="submit">이 데모에서 로그아웃</button></form>
      <p class="fine">이 데모의 세션만 종료합니다. 미지 계정은 로그아웃되지 않습니다.</p>
    </section>
    <section class="card" aria-labelledby="checks-heading">
      <h2 id="checks-heading">이번 로그인의 검증 결과</h2>
      <ul class="checks">
        <li><strong>ID 토큰 서명 확인</strong><span>RS256 · 미지의 공개 서명 키로 검증</span></li>
        <li><strong>발급자와 대상 클라이언트 일치</strong><span>설정한 issuer · client_id와 대조</span></li>
        <li><strong>원래 로그인 요청과 일치</strong><span>state · nonce · 콜백 issuer 확인, PKCE S256 사용</span></li>
        <li><strong>UserInfo의 회원 식별자 일치</strong><span>ID 토큰과 UserInfo의 sub 대조</span></li>
      </ul>
      <p class="fine">토큰 원문과 인가 코드는 이 화면에 표시하지 않습니다.</p>
      ${resources()}
    </section>
  </div>`;
}

export function renderHome(model: HomeViewModel): string {
  const { profile, verification } = model;
  // 성공 표시는 서버가 전달한 검증 결과가 완전하고 같은 회원을 가리킬 때만 허용한다.
  const checked =
    model.authenticated &&
    !model.error &&
    profile &&
    verification &&
    profile.sub === verification.sub &&
    verification.issuer === model.issuer &&
    verification.audience === model.clientId &&
    verification.algorithm === "RS256" &&
    verification.signature === true &&
    verification.state === true &&
    verification.nonce === true &&
    verification.pkce === "S256" &&
    verification.issuerResponse === true &&
    verification.userInfoSubject === true;
  const content =
    checked && profile && verification
      ? success(model, profile, verification)
      : login({
          ...model,
          error:
            model.error ??
            (model.authenticated
              ? "검증된 로그인 정보를 확인할 수 없습니다."
              : undefined),
        });

  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="strict-origin">
<meta name="description" content="미지 OIDC 로그인과 서버 검증 결과를 직접 확인하는 공개 예제">
<title>${checked ? "로그인 확인" : "미지로 로그인"} · MiZi OIDC 예제</title><style>${styles}</style></head>
<body><div class="wrap"><header class="header"><a class="brand" href="/"><strong>MiZi OIDC</strong><span>연동 예제</span></a><a class="header-link" href="${SOURCE}" target="_blank" rel="noreferrer">소스 코드 ↗</a></header>
<main>${content}
<details class="config"><summary>이 데모의 OIDC 설정</summary><dl class="data">${row("Issuer", model.issuer)}${row("Client ID", model.clientId)}${row("서비스 주소", model.baseUrl)}</dl></details>
</main><footer class="footer"><p>MiZi OIDC Example · 별도의 로그인 연동 서비스</p><p>Authorization Code + PKCE · openid profile</p></footer></div></body></html>`;
}
