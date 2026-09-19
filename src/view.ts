import type { HomeViewModel } from "./view-model.js";
import { styles } from "./styles.js";
import { PROJECT_PLANS, type MemberApiResult } from "./service.js";

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
  const errorMessage = model.error ?? model.serviceError;
  const clientType = model.clientId.startsWith("https://")
    ? "CIMD · 공개 클라이언트"
    : "등록형 공개 클라이언트";
  return `<section class="intro">
    <p class="eyebrow">OpenID Connect · Live example</p>
    <h1>로그인 다음엔,<br>나만의 서비스를.</h1>
    <p class="lead">미지로 로그인하고, 허용한 회원 정보를 가져와 내 프로젝트 시작 보드를 만들어 보세요.
      미지와 별도로 동작하는 작은 서비스의 공개 예제입니다.</p>
  </section>
  ${errorMessage ? `<section class="error" role="alert"><h2>${model.error ? "로그인을 완료하지 못했어요" : "요청을 완료하지 못했어요"}</h2><p>${escape(errorMessage)}</p><p>아래 버튼으로 새 로그인 요청을 시작해 주세요.</p></section>` : ""}
  <div class="grid">
    <section class="card" aria-labelledby="login-heading">
      <h2 id="login-heading">직접 로그인해 보세요</h2>
      <p class="subtle">미지에서 계정을 확인하고 동의하면 이곳으로 돌아옵니다.
        먼저 회원 식별자와 닉네임으로 로그인하고, 다음 단계에서 프로필 읽기에 따로 동의할 수 있어요.</p>
      <div class="tags"><span class="tag">${clientType}</span><span class="tag">PKCE · S256</span><span class="tag">openid profile</span></div>
      <form class="login-form" action="${escape(model.loginAction)}" method="post">
        <button class="button primary" type="submit">미지로 로그인 <span aria-hidden="true">→</span></button>
      </form>
      <p class="fine">로그인은 미지 화면에서 진행하며, 비밀번호는 이 데모에 전달되지 않습니다.</p>
      ${resources()}
    </section>
    <section class="card" aria-labelledby="flow-heading">
      <h2 id="flow-heading">세 단계로 직접 경험해요</h2>
      <ol class="flow">
        <li><strong>미지로 로그인</strong><p>미지에서 로그인하면 이 데모 서버가 로그인 정보를 검증합니다.</p></li>
        <li><strong>허용한 회원 정보 가져오기</strong><p>추가 동의 뒤 미지 API에서 닉네임과 GitHub 연결 여부를 읽습니다.</p></li>
        <li><strong>내 프로젝트 시작 보드 만들기</strong><p>만들고 싶은 서비스를 고르면 이 데모가 준비한 시작 목록을 보여줘요.</p></li>
      </ol>
    </section>
  </div>`;
}

function connectProfile(): string {
  return `<form class="login-form" action="/connect-profile" method="post"><button class="button primary" type="submit">내 미지 정보 가져오기 <span aria-hidden="true">→</span></button></form>
    <p class="fine">다음 미지 화면에서 정보 제공을 허용해 주세요. 이 단계를 건너뛰어도 로그인은 완료된 상태예요.</p>`;
}

const API_ERROR_MESSAGES: Record<
  Extract<MemberApiResult, { status: "error" }>["reason"],
  string
> = {
  scope_missing:
    "프로필 읽기 권한이 아직 없어요. 추가 동의를 마치면 회원 정보를 가져올 수 있어요.",
  unauthorized:
    "회원 정보를 읽을 수 있는 연결이 만료되었거나 해제됐어요. 다시 연결해 주세요.",
  forbidden:
    "지금 연결로는 회원 정보를 읽을 수 없어요. 프로필 읽기 권한을 다시 확인해 주세요.",
  unavailable:
    "미지 회원 API에 잠시 연결하지 못했어요. 잠시 후 다시 연결해 주세요.",
  invalid_response:
    "로그인한 계정과 일치하는 회원 정보를 확인하지 못했어요. 다시 연결해 주세요.",
};

function memberPanel(
  model: HomeViewModel,
  member: Extract<MemberApiResult, { status: "success" }> | undefined,
): string {
  const reason =
    model.memberApi?.status === "error"
      ? model.memberApi.reason
      : model.memberApi
        ? "invalid_response"
        : undefined;
  return `<section class="card stage" aria-labelledby="member-heading">
    <div class="stage-heading"><span class="step-number" aria-hidden="true">2</span><h2 id="member-heading">내 미지 정보 가져오기</h2>${member ? "" : '<span class="tag">선택</span>'}</div>
    ${
      member
        ? `<p class="subtle">아래는 표시된 조회 시점의 정보입니다.</p>
      <span class="status stage-status"><span aria-hidden="true">✓</span> 회원 API 조회 완료</span>
      <dl class="data member-data">
        ${row("API에서 읽은 닉네임", member.profile.nickname || "닉네임 없음")}
        ${row("GitHub 연결 여부", member.profile.githubConnected === true ? "연결됨" : member.profile.githubConnected === false ? "연결 안 됨" : "확인할 수 없음")}
        ${row("조회 시각 · UTC", member.fetchedAt)}
      </dl>
      <form class="refresh-form" action="/connect-profile" method="post"><button class="button secondary" type="submit">프로필 다시 가져오기</button></form>
      <p class="fine">새 인증 요청으로 다시 연결하면 현재 프로젝트 선택은 초기화됩니다.</p>`
        : `<p class="subtle">프로젝트 보드도 체험해 보세요. 아래 버튼에서 정보 제공에 동의하면 미지의 닉네임과 GitHub 연결 여부를 가져옵니다.</p>
        ${reason ? `<p class="inline-error" role="alert">${escape(API_ERROR_MESSAGES[reason])}</p>` : ""}
        ${connectProfile()}`
    }
    <details class="developer-note"><summary>어떤 API와 권한을 쓰나요?</summary><p><code>user:profile</code> 권한으로 서버가 <code>GET /v1/me</code>를 호출합니다. 응답의 회원 ID를 로그인한 회원과 대조하고, 닉네임·GitHub 연결 여부만 화면에 표시합니다.</p><p>GitHub 연결 여부는 스킬이나 개발 역량의 검증 결과가 아닙니다.</p></details>
  </section>`;
}

function projectPanel(model: HomeViewModel, ready: boolean): string {
  const selected = ready
    ? PROJECT_PLANS.find((plan) => plan.id === model.projectGoal)
    : undefined;
  return `<section id="project-board" class="card stage" aria-labelledby="project-heading">
    <div class="stage-heading"><span class="step-number" aria-hidden="true">3</span><h2 id="project-heading">내 프로젝트 시작 보드</h2></div>
    <p class="subtle">${ready ? "만들고 싶은 서비스를 골라 보세요. 이 데모가 준비한 시작 목록을 내 보드에 담습니다." : "위에서 내 미지 정보를 가져오면, 여기에서 만들고 싶은 서비스를 골라 나만의 보드를 체험할 수 있어요."}</p>
    ${model.serviceError ? `<p class="inline-error" role="alert">${escape(model.serviceError)}</p>` : ""}
    ${
      ready
        ? `
      <form class="plan-grid" action="/service/goal" method="post" aria-label="만들고 싶은 서비스 선택">
        ${PROJECT_PLANS.map((plan) => `<button class="plan-option${selected?.id === plan.id ? " selected" : ""}" type="submit" name="goal" value="${escape(plan.id)}" aria-pressed="${selected?.id === plan.id}"><strong>${escape(plan.title)}</strong><span>${escape(plan.description)}</span><span class="plan-action">${selected?.id === plan.id ? "선택됨 ✓" : "이걸로 시작 →"}</span></button>`).join("")}
      </form>
      ${selected ? `<div class="project-board"><div class="board-heading"><h3>${escape(selected.title)} 시작 목록</h3><span class="status">이 데모에 저장됨</span></div><ol class="flow">${selected.steps.map((step) => `<li><strong>${escape(step)}</strong></li>`).join("")}</ol></div>` : ""}
      <p class="fine">선택은 이 데모의 30분 세션에만 보관되며, 세션 만료나 로그아웃 시 사라집니다.</p>`
        : ""
    }
    <p class="fine">이 보드는 데모가 준비한 예제입니다. 미지의 추천이나 검증된 스킬을 뜻하지 않으며, 선택을 미지에 저장하지 않습니다.</p>
  </section>`;
}

function success(
  model: HomeViewModel,
  profile: NonNullable<HomeViewModel["profile"]>,
  verified: NonNullable<HomeViewModel["verification"]>,
): string {
  const member =
    model.memberApi?.status === "success" &&
    model.memberApi.profile.id === profile.sub
      ? model.memberApi
      : undefined;
  return `<section class="intro">
    <p class="eyebrow">MiZi login · Your service</p>
    <h1>${member ? "내 프로젝트,<br>여기서 시작해요." : "로그인이 완료됐어요."}</h1>
    <p class="lead">${member ? "미지로 로그인하고 내 정보도 가져왔어요. 이제 만들고 싶은 서비스를 골라 보세요." : "미지 계정으로 이 데모에 로그인했어요. 원하면 다음 단계에서 내 정보를 가져와 프로젝트 보드도 체험할 수 있어요."}</p>
  </section>
  ${model.error ? `<section class="error" role="alert"><h2>이번 연결을 완료하지 못했어요</h2><p>${escape(model.error)}</p><p>기존 로그인은 유지됩니다.${member ? " 아래 회원 정보는 이전 조회 결과입니다." : " 프로필 연결을 다시 시도해 주세요."}</p></section>` : ""}
  <div class="workspace">
    <section class="card stage" aria-labelledby="profile-heading">
      <div class="stage-heading"><span class="step-number" aria-hidden="true">1</span><h2 id="profile-heading">로그인 완료</h2><span class="status">✓ 로그인됨</span></div>
      <p class="member-name"><bdi>${escape(profile.nickname || "미지 회원")}</bdi><span>님으로 로그인했어요.</span></p>
      <details class="developer-note"><summary>로그인 검증 결과 보기</summary>
      <p>서버 검증 완료</p>
      <dl class="data">
        ${row("회원 식별자 · sub", profile.sub)}
        ${row("발급자 · iss", verified.issuer)}
        ${row("이 데모의 클라이언트 · aud", verified.audience)}
        ${row("미지 인증 시각 · UTC", verified.authenticatedAt)}
        ${row("검증 시각 · UTC", verified.checkedAt)}
      </dl>
      <ul class="checks">
        <li><strong>ID 토큰 서명 확인</strong><span>RS256 · 미지의 공개 서명 키로 검증</span></li>
        <li><strong>발급자와 대상 클라이언트 일치</strong><span>설정한 issuer · client_id와 대조</span></li>
        <li><strong>원래 로그인 요청과 일치</strong><span>state · nonce · 콜백 issuer 확인, PKCE S256 사용</span></li>
        <li><strong>UserInfo의 회원 식별자 일치</strong><span>ID 토큰과 UserInfo의 sub 대조</span></li>
      </ul>
      <p class="fine">토큰 원문과 인가 코드는 이 화면에 표시하지 않습니다.</p>
      </details>
    </section>
    ${memberPanel(model, member)}
    ${projectPanel(model, Boolean(member))}
  </div>
  <div class="session-actions"><form action="${escape(model.logoutAction)}" method="post"><button class="button secondary" type="submit">이 데모에서 로그아웃</button></form><p class="fine">이 데모의 세션만 종료합니다. 미지 계정은 로그아웃되지 않습니다.</p></div>
  ${resources()}`;
}

export function renderHome(model: HomeViewModel): string {
  const { profile, verification } = model;
  // 성공 표시는 서버가 전달한 검증 결과가 완전하고 같은 회원을 가리킬 때만 허용한다.
  const checked =
    model.authenticated &&
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
<meta name="description" content="미지 로그인, 동의한 회원 API 조회, 내 프로젝트 시작 보드까지 경험하는 공개 예제">
<title>${checked ? "내 프로젝트 시작 보드" : "미지로 로그인"} · MiZi OIDC 예제</title><style>${styles}</style></head>
<body><div class="wrap"><header class="header"><a class="brand" href="/"><strong>MiZi OIDC</strong><span>연동 예제</span></a><a class="header-link" href="${SOURCE}" target="_blank" rel="noreferrer">소스 코드 ↗</a></header>
<main>${content}
<details class="config"><summary>이 데모의 OIDC 설정</summary><dl class="data">${row("Issuer", model.issuer)}${row("Client ID", model.clientId)}${row("서비스 주소", model.baseUrl)}</dl></details>
</main><footer class="footer"><p>MiZi OIDC Example · 별도의 로그인 연동 서비스</p><p>Authorization Code + PKCE · openid profile</p></footer></div></body></html>`;
}
