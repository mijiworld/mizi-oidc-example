import type { HomeViewModel } from "./view-model.js";
import { styles } from "./styles.js";
import { PROJECT_PLANS, type MemberApiResult } from "./service.js";

const SOURCE = "https://github.com/mijiworld/mizi-oidc-example";
const GUIDE = "https://mcp-auth.cccv.ai/developer/guide/oidc";
const SKILLS_PER_VIEW = 20;
type SkillsSnapshot = Extract<
  NonNullable<HomeViewModel["skillsApi"]>,
  { status: "success" }
>;

const PAGES = [
  { id: "home", href: "/", label: "내 홈" },
  { id: "profile", href: "/profile", label: "내 정보" },
  { id: "skills", href: "/skills", label: "내 스킬" },
  { id: "projects", href: "/projects", label: "프로젝트" },
] as const;

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
    <p class="lead">미지로 로그인하고, 내 정보와 스킬을 살펴보고, 프로젝트 시작 목록을 체험해 보세요.
      미지와 별도로 동작하는 작은 서비스의 공개 예제입니다.</p>
  </section>
  ${errorMessage ? `<section class="error" role="alert"><h2>${model.error ? "로그인을 완료하지 못했어요" : "요청을 완료하지 못했어요"}</h2><p>${escape(errorMessage)}</p><p>아래 버튼으로 새 로그인 요청을 시작해 주세요.</p></section>` : ""}
  <div class="grid">
    <section class="card" aria-labelledby="login-heading">
      <h2 id="login-heading">직접 로그인해 보세요</h2>
      <p class="subtle">미지에서 계정을 확인하고 동의하면 이곳으로 돌아옵니다.
        먼저 회원 식별자와 닉네임으로 로그인하고, 내 정보와 스킬 읽기는 각 화면에서 따로 동의할 수 있어요.</p>
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
        <li><strong>내 정보와 스킬 살펴보기</strong><p>추가 동의 뒤 소개·관심 분야와 스킬 목록을 각각의 화면에서 확인해요.</p></li>
        <li><strong>프로젝트 시작 목록 체험하기</strong><p>서비스 종류를 고르면 이 데모가 준비한 예제 목록을 보여줘요. 실제 프로젝트를 생성하지는 않습니다.</p></li>
      </ol>
    </section>
  </div>`;
}

function connectProfile(): string {
  return `<form class="login-form" action="/connect-profile" method="post"><button class="button primary" type="submit">내 미지 정보 가져오기 <span aria-hidden="true">→</span></button></form>
    <p class="fine">다음 미지 화면에서 정보 제공을 허용해 주세요. 이 단계를 건너뛰어도 로그인은 완료된 상태예요.</p>`;
}

function refreshNotice(model: HomeViewModel): string {
  return `<p class="fine">${model.skillsApi ? "이전에 조회한 스킬도 함께 새로 가져옵니다. 미지 동의 화면에 프로필·스킬 읽기 권한이 표시됩니다. " : ""}새 인증 요청으로 다시 연결하면 현재 프로젝트 선택은 초기화됩니다.</p>`;
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
    <div class="stage-heading"><h2 id="member-heading">${member ? "미지에서 읽은 정보" : "내 미지 정보 가져오기"}</h2>${member ? "" : '<span class="tag">선택</span>'}</div>
    ${
      member
        ? `<p class="subtle">아래는 표시된 조회 시점의 정보입니다.</p>
      <span class="status stage-status"><span aria-hidden="true">✓</span> 회원 API 조회 완료</span>
      <dl class="data member-data">
        ${row("API에서 읽은 닉네임", member.profile.nickname || "닉네임 없음")}
        ${row("회원 식별자", member.profile.id)}
        ${row("GitHub 연결 여부", member.profile.githubConnected === true ? "연결됨" : member.profile.githubConnected === false ? "연결 안 됨" : "확인할 수 없음")}
        ${row("조회 시각 · UTC", member.fetchedAt)}
      </dl>
      <form class="refresh-form" action="/connect-profile" method="post"><button class="button secondary" type="submit">프로필 다시 가져오기</button></form>
      ${refreshNotice(model)}`
        : `<p class="subtle">정보 제공에 동의하면 닉네임·GitHub 연결 여부와 소개·역할·관심 분야를 가져옵니다. 연락처와 위치는 표시하지 않습니다.</p>
        ${reason ? `<p class="inline-error" role="alert">${escape(API_ERROR_MESSAGES[reason])}</p>` : ""}
        ${connectProfile()}${model.skillsApi ? refreshNotice(model) : ""}`
    }
    ${profileDetails(model)}
    <details class="developer-note"><summary>어떤 API와 권한을 쓰나요?</summary><p><code>user:profile</code> 권한으로 서버가 <code>GET /v1/me</code>와 <code>GET /v1/me/profile</code>을 호출합니다. 응답의 회원 ID를 로그인한 회원과 대조한 뒤 필요한 항목만 보관합니다.</p><p>GitHub 연결 여부나 소개 내용은 스킬·개발 역량의 검증 결과가 아닙니다. 스킬 조회 기록이 있다면 <code>user:skills</code>도 요청해 스킬을 함께 새로 가져옵니다.</p></details>
  </section>`;
}

function partialNotice(partial: boolean | null): string {
  if (partial === true)
    return '<p class="snapshot-note">일부 정보만 가져왔어요. 표시된 내용 외의 정보는 이번 조회에서 확인하지 못했을 수 있습니다.</p>';
  if (partial === null)
    return '<p class="fine">이 응답만으로 전체 정보가 포함됐는지는 확인할 수 없어요.</p>';
  return "";
}

function profileDetails(model: HomeViewModel): string {
  const result = model.profileDetails;
  const details =
    result?.status === "success" && result.subject === model.profile?.sub
      ? result
      : undefined;
  if (!details) {
    return `<section class="profile-details" aria-labelledby="profile-details-heading"><h3 id="profile-details-heading">소개와 관심 분야</h3>${result ? '<p class="inline-error" role="alert">소개와 관심 분야를 가져오지 못했어요. 위 버튼으로 정보를 다시 가져와 주세요.</p>' : '<p class="subtle">소개와 관심 분야는 내 정보를 가져온 뒤 여기에서 확인할 수 있어요.</p>'}</section>`;
  }
  const { bio, role, interests } = details.profile;
  return `<section class="profile-details" aria-labelledby="profile-details-heading"><h3 id="profile-details-heading">소개와 관심 분야</h3>
    <p class="subtle">회원이 작성한 소개와 관심 분야입니다. 별도로 검증한 사실은 아닙니다.</p>
    <p class="fine">조회 시점의 정보 · <time datetime="${escape(details.fetchedAt)}">${escape(details.fetchedAt)}</time> · UTC</p>
    ${partialNotice(details.partial)}
    <dl class="profile-data"><div><dt>소개</dt><dd class="bio">${bio?.trim() ? escape(bio) : "이번 응답에 소개 정보가 없어요."}</dd></div>
      <div><dt>역할</dt><dd>${role?.trim() ? escape(role) : "이번 응답에 역할 정보가 없어요."}</dd></div>
      <div><dt>관심 분야</dt><dd>${interests === null ? "이번 응답에 관심 분야 정보가 없어요." : interests.length === 0 ? "이번 조회에서 관심 분야가 비어 있어요." : `<ul class="interests">${interests.map((interest) => `<li>${escape(interest)}</li>`).join("")}</ul>`}</dd></div></dl>
    <details class="developer-note"><summary>프로필 조회 기록</summary><dl class="data">${row("조회 대상 회원", details.subject)}${row("API", details.endpoint)}</dl></details>
  </section>`;
}

const SKILL_ERROR_MESSAGES: Record<
  Extract<MemberApiResult, { status: "error" }>["reason"],
  string
> = {
  scope_missing:
    "스킬 읽기 권한이 아직 없어요. 아래 버튼에서 프로필·스킬 읽기에 동의해 주세요.",
  unauthorized:
    "스킬을 읽을 수 있는 연결이 만료되었거나 해제됐어요. 다시 가져와 주세요.",
  forbidden:
    "지금 연결로는 스킬을 읽을 수 없어요. 스킬 읽기 권한을 다시 확인해 주세요.",
  unavailable:
    "미지 스킬 API에 잠시 연결하지 못했어요. 잠시 후 다시 시도해 주세요.",
  invalid_response:
    "로그인한 계정의 스킬 조회 결과를 확인하지 못했어요. 다시 가져와 주세요.",
};

function visibility(value: boolean | null): string {
  return value === true ? "표시" : value === false ? "숨김" : "정보 없음";
}

function sourceLabel(source: string): string {
  const labels: Record<string, string> = {
    github_analysis: "GitHub 분석",
    national_cert: "국가 자격",
    language_test: "어학 시험",
    degree: "학위",
    license: "면허",
  };
  return Object.hasOwn(labels, source) ? labels[source]! : source;
}

function skillCard(
  skill: SkillsSnapshot["items"][number],
  index: number,
): string {
  const method =
    skill.verificationMethod === "github_analysis"
      ? "GitHub 분석"
      : skill.verificationMethod || "정보 없음";
  return `<li class="skill-item" id="skill-${index + 1}" tabindex="-1"><h3><bdi>${escape(skill.name)}</bdi></h3>
    <p class="skill-source">원출처 · ${escape(sourceLabel(skill.source))}</p>
    <dl class="data skill-data">${row("검증 방법", method)}${row("검증 주체", skill.verifiedBy || "정보 없음")}${row("제공된 검증 시각", skill.verifiedAt || "검증 시각 정보 없음")}</dl>
    <details class="developer-note"><summary>API 원본 값과 표시 설정</summary><dl class="data">${row("스킬 ID", skill.id)}${row("원출처 코드", skill.source)}${row("검증 방법 원문", skill.verificationMethod || "정보 없음")}${row("표시 설정", visibility(skill.visible))}${row("프로필 표시", visibility(skill.visibility.profile))}${row("스킬 목록 표시", visibility(skill.visibility.skills))}</dl></details>
  </li>`;
}

function collectionNotice(skills: SkillsSnapshot): string {
  if (!skills.collection) {
    return skills.hasMore || skills.truncated
      ? '<p class="snapshot-note">이전에 저장한 목록입니다. 나머지를 보려면 한 번 다시 가져오세요.</p>'
      : "";
  }
  const messages: Record<
    NonNullable<SkillsSnapshot["collection"]>["stoppedReason"],
    string
  > = {
    cursor_exhausted: "",
    item_limit:
      "한 번에 가져올 수 있는 200개까지 저장했어요. 아직 가져오지 못한 스킬이 있을 수 있어요.",
    byte_limit: "한 번에 보관할 수 있는 정보량에 도달해 여기까지 가져왔어요.",
    time_limit: "조회 시간이 길어져 지금까지 가져온 목록을 저장했어요.",
    page_limit: "이번 조회에서 읽을 수 있는 범위까지 가져왔어요.",
    upstream_error:
      "이후 목록을 가져오지 못해 확인된 스킬만 저장했어요. 잠시 후 다시 가져와 주세요.",
    invalid_response: "이후 응답을 확인하지 못해 확인된 스킬만 저장했어요.",
    cursor_cycle: "다음 목록이 반복되어 여기까지 가져왔어요.",
    unknown_cursor: "다음 목록이 있는지 확인할 수 없어 여기까지 가져왔어요.",
  };
  const message = messages[skills.collection.stoppedReason];
  return message ? `<p class="snapshot-note">${message}</p>` : "";
}

function skillList(
  skills: SkillsSnapshot,
  requestedCount = SKILLS_PER_VIEW,
): string {
  const limit =
    Number.isInteger(requestedCount) &&
    requestedCount >= SKILLS_PER_VIEW &&
    requestedCount <= 200 &&
    requestedCount % SKILLS_PER_VIEW === 0
      ? requestedCount
      : SKILLS_PER_VIEW;
  const visible = skills.items.slice(0, limit);
  const remaining = skills.items.length - visible.length;
  return `<p class="snapshot-note">가져온 ${skills.items.length}개 중 ${visible.length}개 표시</p>
    ${collectionNotice(skills)}
    ${visible.length === 0 ? '<p class="empty-state">이번 조회에서 표시할 스킬이 없어요.</p>' : `<ul class="skill-list">${visible.map(skillCard).join("")}</ul>`}
    ${remaining > 0 ? `<div class="skills-more"><a class="button secondary" href="/skills?shown=${limit + SKILLS_PER_VIEW}#skill-${visible.length + 1}">${Math.min(SKILLS_PER_VIEW, remaining)}개 더 보기 <span aria-hidden="true">↓</span></a><p class="fine">가져온 목록을 펼칩니다. 다시 동의할 필요 없이 현재 프로젝트 선택도 유지돼요.</p></div>` : visible.length > 0 ? '<p class="list-complete">가져온 목록을 모두 표시했어요.</p>' : ""}`;
}

function skillsPanel(model: HomeViewModel): string {
  const result = model.skillsApi;
  const skills =
    result?.status === "success" && result.subject === model.profile?.sub
      ? result
      : undefined;
  const reason =
    result && result.subject !== model.profile?.sub
      ? "invalid_response"
      : result?.status === "error"
        ? result.reason
        : undefined;
  return `<section class="card stage" aria-labelledby="skills-heading"><div class="stage-heading"><h2 id="skills-heading">${skills ? "조회한 스킬 목록" : "내 스킬 가져오기"}</h2>${skills ? "" : '<span class="tag">선택</span>'}</div>
    ${
      skills
        ? `<p class="subtle">조회 시점의 정보입니다. 출처와 검증 정보는 미지 API가 제공한 값을 그대로 구분해 표시합니다.</p>
      <p class="fine">조회 시각 · UTC · <time datetime="${escape(skills.fetchedAt)}">${escape(skills.fetchedAt)}</time></p>
      ${partialNotice(skills.partial)}
      ${skillList(skills, model.skillsVisibleCount)}`
        : `<p class="subtle">프로필·스킬 읽기에 동의하면 내 정보와 스킬 목록을 함께 가져옵니다. 이 단계를 건너뛰어도 로그인은 완료된 상태예요.</p>${reason ? `<p class="inline-error" role="alert">${escape(SKILL_ERROR_MESSAGES[reason])}</p>` : ""}`
    }
    <form class="${skills ? "refresh-form" : "login-form"}" action="/connect-skills" method="post"><button class="button ${skills ? "secondary" : "primary"}" type="submit">${skills ? "스킬 다시 가져오기" : "내 스킬 가져오기"}</button></form>
    <p class="fine">다시 가져오기는 새 인증 요청을 시작합니다. 소개·관심 분야 등 내 정보도 함께 새로 가져오며, 현재 프로젝트 선택은 초기화됩니다.</p>
    <details class="developer-note"><summary>조회 범위와 검증 정보 읽는 법</summary><p><code>user:profile</code>과 <code>user:skills</code> 권한으로 서버가 <code>GET /v1/me</code>, <code>GET /v1/me/profile</code>, <code>GET /v1/me/skills?limit=20</code>을 호출합니다. 다음 커서가 있으면 이어서 읽되 최대 200개·10페이지·5초, 보관할 스킬 정보 192KiB 한도에서 멈춥니다.</p><p>인증할 때 가져온 목록을 데모 세션에 보관하고 토큰은 폐기합니다. ‘더 보기’는 저장된 목록을 20개씩 펼치며 API를 다시 호출하거나 세션 만료 시각을 연장하지 않습니다.</p><p>검증 방법·주체·시각은 API가 제공한 정보이며, 이 데모의 별도 검증이나 추천을 뜻하지 않습니다. 검증 시각이 없으면 조회 시각으로 대신하지 않습니다. 마지막 API 응답의 페이지 안내만으로 전체 스킬을 모두 가져왔다고 판단하지 않습니다.</p>${skills ? `<dl class="data">${row("조회 대상 · 로그인 회원", skills.subject)}${row("API", skills.endpoint)}${row("읽은 API 응답 항목 수 · 중복 포함", String(skills.returnedCount))}${row("마지막 응답의 후속 페이지 안내", skills.hasMore === null ? "정보 없음" : skills.hasMore ? "있음" : "없음")}${skills.collection ? `${row("수집 시작 시각 · UTC", skills.collection.startedAt)}${row("읽은 API 페이지 수", String(skills.collection.pages))}${row("중복으로 제외한 항목 수", String(skills.collection.duplicateCount))}${row("수집 종료 이유", skills.collection.stoppedReason)}` : ""}</dl><p>조회 대상은 검증된 로그인 계정입니다. 개별 스킬의 소유자 정보는 이 API 응답에 포함되지 않습니다.</p>` : ""}</details>
  </section>`;
}

function projectPanel(model: HomeViewModel, ready: boolean): string {
  const selected = ready
    ? PROJECT_PLANS.find((plan) => plan.id === model.projectGoal)
    : undefined;
  return `<section id="project-board" class="card stage" aria-labelledby="project-heading">
    <div class="stage-heading"><h2 id="project-heading">만들고 싶은 서비스 선택</h2></div>
    <p class="subtle">${ready ? "만들고 싶은 서비스를 골라 보세요. 이 데모가 준비한 시작 목록을 내 보드에 담습니다." : "내 정보 화면에서 미지 회원 정보를 가져오면 프로젝트 시작 목록을 체험할 수 있어요."}</p>
    ${!ready ? '<a class="button secondary refresh-form" href="/profile">내 정보로 이동 →</a>' : ""}
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
    <p class="fine">이 보드는 시작 목록을 고르는 체험입니다. 실제 프로젝트나 코드를 생성하지 않습니다. 미지의 추천이나 검증된 스킬을 뜻하지 않으며, 선택을 미지에 저장하지 않습니다.</p>
  </section>`;
}

function loginProof(
  profile: NonNullable<HomeViewModel["profile"]>,
  verified: NonNullable<HomeViewModel["verification"]>,
): string {
  return `<details class="config login-proof"><summary>로그인 검증 결과 보기</summary>
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
      </details>`;
}

function dashboard(
  model: HomeViewModel,
  profile: NonNullable<HomeViewModel["profile"]>,
  member: Extract<MemberApiResult, { status: "success" }> | undefined,
): string {
  const selected = member
    ? PROJECT_PLANS.find((plan) => plan.id === model.projectGoal)
    : undefined;
  return `<section class="intro"><p class="eyebrow">My home</p><h1>로그인이 완료됐어요.</h1>
    <p class="member-name"><bdi>${escape(profile.nickname || "미지 회원")}</bdi><span>님, 반가워요.</span></p>
    <p class="lead">보고 싶은 정보나 체험할 기능을 골라 보세요. 추가 정보 제공은 각 화면에서 선택할 수 있어요.</p></section>
    <div class="dashboard-grid">
      <a class="card dashboard-card" href="/profile"><span class="card-kicker">내 정보</span><h2>미지에 담긴 내 정보</h2><p>${member ? "읽어 둔 회원 정보를 확인하고 새로 가져올 수 있어요." : "내 정보를 가져오려면 여기에서 추가로 동의해 주세요."}</p><span class="card-link">내 정보 보기 →</span></a>
      <a class="card dashboard-card" href="/skills"><span class="card-kicker">내 스킬</span><h2>나의 스킬 기록</h2><p>미지 API에서 제공하는 스킬 정보를 확인해 보세요.</p><span class="card-link">내 스킬 보기 →</span></a>
      <a class="card dashboard-card" href="/projects"><span class="card-kicker">프로젝트</span><h2>${selected ? escape(selected.title) + " 시작 보드" : "작은 서비스 시작하기"}</h2><p>${selected ? "이 세션에 저장한 시작 목록을 이어서 확인해요." : "서비스 종류를 고르고 예제 시작 목록을 체험해요."}</p><span class="card-link">프로젝트 보드 보기 →</span></a>
    </div>`;
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
  const page = model.page ?? "home";
  const heading =
    page === "profile"
      ? "내 미지 정보"
      : page === "skills"
        ? "내 스킬"
        : "내 프로젝트 시작 보드";
  const lead =
    page === "profile"
      ? "허용한 내 정보를 한곳에서 확인하세요. 로그인은 이미 완료된 상태예요."
      : page === "skills"
        ? "미지에서 제공하는 내 스킬 기록을 확인하는 공간이에요."
        : "서비스 종류를 고르고 시작 목록을 체험해 보세요. 선택은 이 데모의 30분 세션에만 보관돼요.";
  const body =
    page === "home"
      ? dashboard(model, profile, member)
      : `<section class="intro"><p class="eyebrow">${page === "projects" ? "Example workspace" : "My MiZi"}</p><h1>${heading}</h1><p class="lead">${lead}</p></section><div class="workspace">${page === "profile" ? memberPanel(model, member) : page === "projects" ? projectPanel(model, Boolean(member)) : skillsPanel(model)}</div>`;
  return `${model.error ? `<section class="error" role="alert"><h2>이번 연결을 완료하지 못했어요</h2><p>${escape(model.error)}</p><p>기존 로그인은 유지됩니다.${member ? " 회원 정보는 이전 조회 결과입니다." : " 해당 정보 화면에서 다시 시도해 주세요."}</p></section>` : ""}
    ${model.serviceError ? `<p class="inline-error" role="alert">${escape(model.serviceError)}</p>` : ""}
    ${body}
    ${page === "home" ? loginProof(profile, verified) : ""}
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
<title>${checked ? (PAGES.find((page) => page.id === (model.page ?? "home"))?.label ?? "내 홈") : "미지로 로그인"} · MiZi OIDC 예제</title><style>${styles}</style></head>
<body${checked ? ' class="signed-in"' : ""}><div class="wrap"><header class="header"><a class="brand" href="/"><strong>MiZi OIDC</strong><span>연동 예제</span></a><a class="header-link" href="${SOURCE}" target="_blank" rel="noreferrer">소스 코드 ↗</a></header>
${checked ? `<nav class="site-nav" aria-label="내 서비스 메뉴">${PAGES.map((page) => `<a href="${page.href}"${page.id === (model.page ?? "home") ? ' aria-current="page"' : ""}>${page.label}</a>`).join("")}</nav>` : ""}
<main>${content}
<details class="config"><summary>이 데모의 OIDC 설정</summary><dl class="data">${row("Issuer", model.issuer)}${row("Client ID", model.clientId)}${row("서비스 주소", model.baseUrl)}</dl></details>
</main><footer class="footer"><p>MiZi OIDC Example · 별도의 로그인 연동 서비스</p><p>Authorization Code + PKCE · openid profile</p></footer></div></body></html>`;
}
