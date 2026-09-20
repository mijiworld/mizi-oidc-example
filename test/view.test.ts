import { describe, expect, it } from "vitest";
import { renderHome } from "../src/view.js";
import type { HomeViewModel } from "../src/view-model.js";

const anonymous: HomeViewModel = {
  issuer: "https://issuer.example",
  clientId: "https://demo.example/client.json",
  baseUrl: "https://demo.example",
  loginAction: "/login",
  logoutAction: "/logout",
  authenticated: false,
};
const verified: HomeViewModel = {
  ...anonymous,
  authenticated: true,
  profile: { sub: "usr_verified", nickname: "테스트 회원" },
  verification: {
    issuer: anonymous.issuer,
    audience: anonymous.clientId,
    sub: "usr_verified",
    algorithm: "RS256",
    nonce: true,
    pkce: "S256",
    state: true,
    issuerResponse: true,
    signature: true,
    userInfoSubject: true,
    authenticatedAt: "2026-09-19T00:00:00.000Z",
    checkedAt: "2026-09-19T00:00:02.000Z",
  },
};
const memberApi: NonNullable<HomeViewModel["memberApi"]> = {
  status: "success",
  fetchedAt: "2026-09-19T00:01:00.000Z",
  profile: { id: "usr_verified", nickname: "API 회원", githubConnected: null },
};
const profileDetails: Extract<
  NonNullable<HomeViewModel["profileDetails"]>,
  { status: "success" }
> = {
  status: "success",
  subject: "usr_verified",
  endpoint: "https://issuer.example/v1/me/profile",
  fetchedAt: "2026-09-19T00:02:00.000Z",
  partial: false,
  profile: {
    bio: "작은 도구를 만듭니다.",
    role: "개발자",
    interests: ["웹", "자동화"],
  },
};
const skillsApi: Extract<
  NonNullable<HomeViewModel["skillsApi"]>,
  { status: "success" }
> = {
  status: "success",
  subject: "usr_verified",
  endpoint: "https://issuer.example/v1/me/skills?limit=20",
  fetchedAt: "2026-09-19T00:03:00.000Z",
  partial: null,
  requestedLimit: 20,
  returnedCount: 1,
  hasMore: false,
  truncated: false,
  items: [
    {
      id: "skill_example",
      name: "TypeScript",
      source: "github",
      verificationMethod: "repository",
      verifiedBy: "example-verifier",
      verifiedAt: "2026-08-01T00:00:00.000Z",
      visible: true,
      visibility: { profile: false, skills: null },
    },
  ],
};

describe("server-rendered OIDC demo", () => {
  it("starts a POST login and explains the public client without loading external assets", () => {
    const html = renderHome(anonymous);
    expect(html).toContain('action="/login" method="post"');
    expect(html).toContain("미지로 로그인");
    expect(html).toContain("CIMD · 공개 클라이언트");
    expect(html).not.toContain("서버 검증 완료");
    expect(html).not.toMatch(/<script|<link|<img|<iframe/i);
    expect(html).toContain("https://github.com/mijiworld/mizi-oidc-example");
    expect(html).toContain("https://mcp-auth.cccv.ai/developer/guide/oidc");
    expect(renderHome({ ...anonymous, clientId: "mzp_local" })).toContain(
      "등록형 공개 클라이언트",
    );
  });

  it("shows only verified identity and explicitly limits logout to the demo", () => {
    const html = renderHome(verified);
    expect(html).toContain("서버 검증 완료");
    expect(html).toContain("테스트 회원");
    expect(html).toContain("usr_verified");
    expect(html).toContain("2026-09-19T00:00:02.000Z");
    expect(html).toContain('action="/logout" method="post"');
    expect(html).toContain("이 데모에서 로그아웃");
    expect(html).toContain("미지·Google의 로그인까지 종료하지 않습니다");
    expect(html).not.toContain('action="/login"');
  });

  it.each([
    { profile: undefined },
    { verification: undefined },
    { verification: { ...verified.verification, sub: "usr_other" } },
    {
      verification: {
        ...verified.verification,
        issuer: "https://other.example",
      },
    },
    { verification: { ...verified.verification, audience: "other-client" } },
    { verification: { ...verified.verification, signature: false } },
    { verification: { ...verified.verification, userInfoSubject: false } },
  ])(
    "does not label incomplete or mismatched evidence as success: %j",
    (override) => {
      const html = renderHome({ ...verified, ...override } as HomeViewModel);
      expect(html).not.toContain("서버 검증 완료");
      expect(html).not.toContain("usr_verified");
      expect(html).not.toContain("테스트 회원");
      expect(html).toContain("검증된 로그인 정보를 확인할 수 없습니다");
    },
  );

  it("escapes profile, configuration and error text instead of interpreting HTML", () => {
    const html = renderHome({
      ...verified,
      profile: {
        sub: "usr_verified",
        nickname: '<img src=x onerror="alert(1)"> & 회원',
      },
    });
    expect(html).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; 회원",
    );
    expect(html).not.toContain("<img");
    const error = renderHome({
      ...anonymous,
      clientId: "<script>client</script>",
      error: '<script>alert("error")</script>',
    });
    expect(error).toContain("&lt;script&gt;client&lt;/script&gt;");
    expect(error).toContain(
      "&lt;script&gt;alert(&quot;error&quot;)&lt;/script&gt;",
    );
    expect(error).not.toContain("<script");
  });

  it("does not render token or callback fields accidentally added to the model", () => {
    const extra = {
      ...verified,
      access_token: "raw-access-token",
      id_token: "raw-id-token",
      code: "raw-code",
      error: "다시 시작해 주세요.",
    };
    const html = renderHome(extra);
    expect(html).not.toContain("raw-access-token");
    expect(html).not.toContain("raw-id-token");
    expect(html).not.toContain("raw-code");
    expect(html).toContain("서버 검증 완료");
    expect(html).toContain("다시 시작해 주세요.");
  });

  it("keeps an existing login but requires additional consent before the API and service steps", () => {
    const html = renderHome({
      ...verified,
      page: "profile",
      projectGoal: "website",
    });
    expect(html).toContain('action="/logout"');
    expect(html).toContain('href="/profile" aria-current="page"');
    expect(html).toContain('action="/connect-profile" method="post"');
    expect(html).toContain("내 미지 정보 가져오기");
    expect(html).toContain("user:profile");
    expect(html).toContain("GET /v1/me");
    expect(html).not.toContain("회원 API 조회 완료");
    expect(html).not.toContain('action="/service/goal"');
    expect(html).not.toContain("이 데모에 저장됨");
    const project = renderHome({
      ...verified,
      page: "projects",
      projectGoal: "website",
    });
    expect(project).toContain('href="/profile"');
    expect(project).not.toContain('action="/service/goal"');
    expect(project).not.toContain("이 데모에 저장됨");
  });

  it.each([
    "scope_missing",
    "unauthorized",
    "forbidden",
    "unavailable",
    "invalid_response",
  ] as const)(
    "explains %s without inventing API data and offers a new connection",
    (reason) => {
      const html = renderHome({
        ...verified,
        page: "profile",
        memberApi: {
          status: "error",
          reason,
          fetchedAt: "2026-09-19T00:01:00.000Z",
        },
      });
      expect(html).toContain('role="alert"');
      expect(html).toContain('action="/connect-profile" method="post"');
      expect(html).not.toContain("회원 API 조회 완료");
      expect(html).not.toContain('action="/service/goal"');
    },
  );

  it("does not show another member or unlock the service when API identity differs from OIDC", () => {
    const html = renderHome({
      ...verified,
      page: "profile",
      projectGoal: "assistant",
      memberApi: {
        status: "success",
        fetchedAt: "2026-09-19T00:01:00.000Z",
        profile: {
          id: "usr_someone_else",
          nickname: "다른 사람",
          githubConnected: true,
        },
      },
    });
    expect(html).toContain(
      "로그인한 계정과 일치하는 회원 정보를 확인하지 못했어요",
    );
    expect(html).not.toContain("다른 사람");
    expect(html).not.toContain("회원 API 조회 완료");
    expect(html).not.toContain('action="/service/goal"');
    expect(html).not.toContain("이 데모에 저장됨");
  });

  it.each([
    [true, "연결됨"],
    [false, "연결 안 됨"],
    [null, "확인할 수 없음"],
  ] as const)(
    "preserves GitHub connection state %s as %s",
    (githubConnected, label) => {
      const html = renderHome({
        ...verified,
        page: "profile",
        memberApi: {
          status: "success",
          fetchedAt: "2026-09-19T00:01:00.000Z",
          profile: {
            id: "usr_verified",
            nickname: "API에서 읽은 이름",
            githubConnected,
          },
        },
      });
      expect(html).toContain("회원 API 조회 완료");
      expect(html).toContain("API에서 읽은 이름");
      expect(html).toContain(`GitHub 연결 여부</dt><dd><code>${label}</code>`);
      expect(html).toContain("2026-09-19T00:01:00.000Z");
      expect(html).not.toContain('action="/service/goal"');
      expect(html).toContain('action="/connect-profile" method="post"');
      expect(html).toContain("프로필 다시 연결하기");
      expect(html).toContain(
        "한 번 다시 연결하면 다음부터는 이 화면에서 바로 다시 가져올 수 있어요",
      );
      expect(html).not.toContain("현재 프로젝트 선택은 초기화됩니다");
    },
  );

  it("renders only the selected example plan and explains its local session lifetime", () => {
    const html = renderHome({
      ...verified,
      page: "projects",
      projectGoal: "automation",
      memberApi: {
        status: "success",
        fetchedAt: "2026-09-19T00:01:00.000Z",
        profile: {
          id: "usr_verified",
          nickname: "API 회원",
          githubConnected: null,
        },
      },
    });
    expect(html).toContain('value="automation" aria-pressed="true"');
    expect(html).toContain('value="website" aria-pressed="false"');
    expect(html).toContain("업무 자동화 시작 목록");
    expect(html).not.toContain("웹 서비스 시작 목록");
    expect(html).toContain("이 데모에 저장됨");
    expect(html).toContain("유효한 로그인 세션");
    expect(html).toContain("세션 만료나 로그아웃 시 사라집니다");
    expect(html).toContain("선택을 미지에 저장하지 않습니다");
    expect(html).toContain("strict-origin");
    expect(html).toContain('id="project-board"');
    expect(html).toContain("실제 프로젝트나 코드를 생성하지 않습니다");
    expect(html).not.toContain("API에서 읽은 닉네임");
    expect(html).not.toContain('action="/connect-profile"');
  });

  it("escapes API fields and service errors while preserving verified login and API results", () => {
    const html = renderHome({
      ...verified,
      page: "profile",
      serviceError: "<script>save-error</script>",
      memberApi: {
        status: "success",
        fetchedAt: "2026-09-19T00:01:00.000Z",
        profile: {
          id: "usr_verified",
          nickname: '<img src=x onerror="api()">',
          githubConnected: false,
        },
      },
    });
    expect(html).toContain("&lt;img src=x onerror=&quot;api()&quot;&gt;");
    expect(html).toContain("&lt;script&gt;save-error&lt;/script&gt;");
    expect(html).toContain('action="/logout"');
    expect(html).toContain("회원 API 조회 완료");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
  });

  it.each([anonymous, verified])(
    "shows service errors even before the API step is available",
    (model) => {
      const html = renderHome({
        ...model,
        serviceError: "<script>세션을 다시 확인해 주세요</script>",
      });
      expect(html).toContain('role="alert"');
      expect(html).toContain(
        "&lt;script&gt;세션을 다시 확인해 주세요&lt;/script&gt;",
      );
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("회원 API 조회 완료");
      expect(html).not.toContain('action="/service/goal"');
    },
  );

  it("keeps an existing verified identity and labels API data as the earlier snapshot after failed consent", () => {
    const html = renderHome({
      ...verified,
      page: "profile",
      error: "추가 동의를 완료하지 못했습니다.",
      memberApi: {
        status: "success",
        fetchedAt: "2026-09-19T00:01:00.000Z",
        profile: {
          id: "usr_verified",
          nickname: "이전 API 이름",
          githubConnected: true,
        },
      },
    });
    expect(html).toContain('action="/logout"');
    expect(html).toContain("추가 동의를 완료하지 못했습니다.");
    expect(html).toContain("기존 로그인은 유지됩니다");
    expect(html).toContain("이전 조회 결과");
    expect(html).toContain("조회 시점의 정보");
    expect(html).toContain("2026-09-19T00:01:00.000Z");
    expect(html).toContain("이전 API 이름");
    expect(html).not.toContain('action="/login"');
  });

  it("keeps the home concise even when every API result and a project selection are present", () => {
    const html = renderHome({
      ...verified,
      memberApi,
      profileDetails,
      skillsApi,
      projectGoal: "assistant",
    });
    expect(html).toContain("로그인이 완료됐어요");
    expect(html).toContain("테스트 회원");
    expect(html).toContain("AI 도구 시작 보드");
    expect(html).toContain('href="/profile"');
    expect(html).toContain('href="/skills"');
    expect(html).toContain('href="/projects"');
    expect(html).not.toContain('action="/connect-profile"');
    expect(html).not.toContain('action="/connect-skills"');
    expect(html).not.toContain('action="/service/goal"');
    expect(html).not.toContain("작은 도구를 만듭니다.");
    expect(html).not.toContain("TypeScript");
    expect(html).not.toContain('id="project-board"');
  });

  it.each([
    ["home", "/"],
    ["profile", "/profile"],
    ["skills", "/skills"],
    ["projects", "/projects"],
  ] as const)(
    "marks only the current %s page and keeps private content out of anonymous views",
    (page, path) => {
      const html = renderHome({ ...verified, page });
      expect(html).toContain(`href="${path}" aria-current="page"`);
      expect(html.match(/<a[^>]+aria-current="page"/g)).toHaveLength(1);
      const loggedOut = renderHome({
        ...anonymous,
        page,
        memberApi,
        profileDetails,
        skillsApi,
      });
      expect(loggedOut).toContain('action="/login" method="post"');
      expect(loggedOut).not.toMatch(/<a[^>]+aria-current="page"/);
      expect(loggedOut).not.toContain("작은 도구를 만듭니다.");
      expect(loggedOut).not.toContain("TypeScript");
      expect(loggedOut).not.toContain("API 회원");
    },
  );

  it("shows only profile fields and preserves the source snapshot without treating partial data as complete", () => {
    const html = renderHome({
      ...verified,
      page: "profile",
      memberApi,
      profileDetails: { ...profileDetails, partial: true },
      skillsApi,
    });
    expect(html).toContain("작은 도구를 만듭니다.");
    expect(html).toContain("회원이 작성한 소개와 관심 분야입니다");
    expect(html).toContain("개발자");
    expect(html).toContain("<li>웹</li>");
    expect(html).toContain("일부 정보만 가져왔어요");
    expect(html).toContain(profileDetails.fetchedAt);
    expect(html).toContain(profileDetails.endpoint);
    expect(html).toContain("usr_verified");
    expect(html).toContain("다시 연결할 때 스킬 조회 기록이 있다면");
    expect(html).toContain(
      "다시 가져오기는 이 두 API만 갱신하고 스킬 목록은 유지합니다",
    );
    expect(html).not.toContain("TypeScript");
    expect(html).not.toContain('action="/connect-skills"');
    expect(html).not.toContain('action="/service/goal"');
  });

  it("distinguishes absent profile fields from explicitly empty interests", () => {
    const html = renderHome({
      ...verified,
      page: "profile",
      memberApi,
      profileDetails: {
        ...profileDetails,
        partial: null,
        profile: { bio: null, role: null, interests: null },
      },
    });
    expect(html).toContain("이번 응답에 소개 정보가 없어요");
    expect(html).toContain("이번 응답에 역할 정보가 없어요");
    expect(html).toContain("이번 응답에 관심 분야 정보가 없어요");
    expect(html).toContain("전체 정보가 포함됐는지는 확인할 수 없어요");
    expect(html).not.toContain("관심 분야가 비어 있어요");
    const empty = renderHome({
      ...verified,
      page: "profile",
      memberApi,
      profileDetails: {
        ...profileDetails,
        profile: { ...profileDetails.profile, interests: [] },
      },
    });
    expect(empty).toContain("이번 조회에서 관심 분야가 비어 있어요");
    expect(empty).not.toContain("이번 응답에 관심 분야 정보가 없어요");
  });

  it("escapes expanded profile fields and does not render unprojected contact data", () => {
    const extra = {
      ...profileDetails,
      profile: {
        bio: "<script>bio</script>",
        role: '<img src=x onerror="role()">',
        interests: ['<svg onload="interest()">'],
        contact: "private@example.com",
        location: "private-location",
      },
    };
    const html = renderHome({
      ...verified,
      page: "profile",
      memberApi,
      profileDetails: extra,
    });
    expect(html).toContain("&lt;script&gt;bio&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;role()&quot;&gt;");
    expect(html).toContain("&lt;svg onload=&quot;interest()&quot;&gt;");
    expect(html).not.toMatch(/<script|<img|<svg/);
    expect(html).not.toContain("private@example.com");
    expect(html).not.toContain("private-location");
  });

  it("keeps the member snapshot when profile expansion fails, but hides another subject’s profile", () => {
    for (const details of [
      { ...profileDetails, subject: "usr_other" },
      {
        status: "error",
        subject: "usr_verified",
        endpoint: profileDetails.endpoint,
        fetchedAt: profileDetails.fetchedAt,
        reason: "unavailable",
      },
    ] as NonNullable<HomeViewModel["profileDetails"]>[]) {
      const html = renderHome({
        ...verified,
        page: "profile",
        memberApi,
        profileDetails: details,
      });
      expect(html).toContain("회원 API 조회 완료");
      expect(html).toContain("소개와 관심 분야를 가져오지 못했어요");
      expect(html).toContain('action="/logout"');
      expect(html).not.toContain("작은 도구를 만듭니다.");
      expect(html).not.toContain("usr_other");
      expect(html).not.toContain('action="/login"');
    }
  });

  it("offers a separate skills consent without representing a successful API call", () => {
    const html = renderHome({ ...verified, page: "skills" });
    expect(html).toContain('action="/connect-skills" method="post"');
    expect(html).toContain("프로필·스킬 읽기에 동의하면");
    expect(html).toContain("user:profile");
    expect(html).toContain("user:skills");
    expect(html).toContain("GET /v1/me/skills?limit=20");
    expect(html).toContain("이 단계를 건너뛰어도 로그인은 완료된 상태예요");
    expect(html).not.toContain("조회한 스킬 목록");
    expect(html).not.toContain('action="/service/goal"');
  });

  it.each([
    "scope_missing",
    "unauthorized",
    "forbidden",
    "unavailable",
    "invalid_response",
  ] as const)(
    "keeps login after a skills %s error and offers another consent attempt",
    (reason) => {
      const html = renderHome({
        ...verified,
        page: "skills",
        skillsApi: {
          status: "error",
          subject: "usr_verified",
          endpoint: skillsApi.endpoint,
          fetchedAt: skillsApi.fetchedAt,
          reason,
        },
      });
      expect(html).toContain('role="alert"');
      expect(html).toContain('action="/connect-skills" method="post"');
      expect(html).toContain('action="/logout"');
      expect(html).not.toContain("조회한 스킬 목록");
      expect(html).not.toContain('action="/login"');
    },
  );

  it("shows actual skill provenance and distinguishes provided verification time from fetch time", () => {
    const html = renderHome({
      ...verified,
      page: "skills",
      memberApi,
      profileDetails,
      skillsApi,
    });
    expect(html).toContain("TypeScript");
    expect(html).toContain("원출처 · github");
    expect(html).toContain("검증 방법</dt><dd><code>repository");
    expect(html).toContain("검증 주체</dt><dd><code>example-verifier");
    expect(html).toContain(
      "제공된 검증 시각</dt><dd><code>2026-08-01T00:00:00.000Z",
    );
    expect(html).toContain(skillsApi.fetchedAt);
    expect(html).toContain("프로필 표시</dt><dd><code>숨김");
    expect(html).toContain("스킬 목록 표시</dt><dd><code>정보 없음");
    expect(html).toContain("조회 대상 · 로그인 회원");
    expect(html).toContain(
      "개별 스킬의 소유자 정보는 이 API 응답에 포함되지 않습니다",
    );
    expect(html).not.toContain("작은 도구를 만듭니다.");
    expect(html).not.toContain('action="/service/goal"');
  });

  it("does not invent verification claims or replace unknown verification time with fetch time", () => {
    const html = renderHome({
      ...verified,
      page: "skills",
      skillsApi: {
        ...skillsApi,
        items: [
          {
            ...skillsApi.items[0]!,
            verificationMethod: null,
            verifiedBy: null,
            verifiedAt: null,
          },
        ],
      },
    });
    expect(html).toContain("검증 방법</dt><dd><code>정보 없음");
    expect(html).toContain("검증 주체</dt><dd><code>정보 없음");
    expect(html).toContain(
      "제공된 검증 시각</dt><dd><code>검증 시각 정보 없음",
    );
    expect(html).not.toContain(
      `제공된 검증 시각</dt><dd><code>${skillsApi.fetchedAt}`,
    );
    expect(html).not.toContain("검증된 스킬");
  });

  it("makes known sources readable while retaining original provenance values and unknown strings", () => {
    const sources = [
      "github_analysis",
      "national_cert",
      "language_test",
      "degree",
      "license",
      "future_source",
      "__proto__",
    ];
    const html = renderHome({
      ...verified,
      page: "skills",
      skillsApi: {
        ...skillsApi,
        items: sources.map((source, index) => ({
          ...skillsApi.items[0]!,
          id: `skill_${index}`,
          source,
          verificationMethod:
            index === 0 ? "github_analysis" : "unknown_method",
        })),
        returnedCount: sources.length,
      },
    });
    for (const label of [
      "GitHub 분석",
      "국가 자격",
      "어학 시험",
      "학위",
      "면허",
      "future_source",
      "__proto__",
    ]) {
      expect(html).toContain(`원출처 · ${label}`);
    }
    for (const source of sources)
      expect(html).toContain(`원출처 코드</dt><dd><code>${source}`);
    expect(html).toContain("검증 방법</dt><dd><code>GitHub 분석");
    expect(html).toContain("검증 방법 원문</dt><dd><code>github_analysis");
    expect(html).toContain("검증 방법</dt><dd><code>unknown_method");
  });

  it("uses a snapshot-specific empty state and never claims the member has no skills", () => {
    const html = renderHome({
      ...verified,
      page: "skills",
      skillsApi: { ...skillsApi, items: [], returnedCount: 0 },
    });
    expect(html).toContain("이번 조회에서 표시할 스킬이 없어요");
    expect(html).toContain("전체 정보가 포함됐는지는 확인할 수 없어요");
    expect(html).toContain('action="/connect-skills"');
    expect(html).not.toContain("스킬이 전혀 없");
    expect(html).not.toContain("TypeScript");
  });

  it("asks legacy clipped snapshots to refresh without inventing a local next page", () => {
    const html = renderHome({
      ...verified,
      page: "skills",
      skillsApi: {
        ...skillsApi,
        items: Array.from({ length: 20 }, (_, i) => ({
          ...skillsApi.items[0]!,
          id: `skill_${i}`,
          name: `스킬 ${i}`,
        })),
        returnedCount: 31,
        hasMore: false,
        truncated: true,
      },
    });
    expect(html).toContain("가져온 20개 중 20개 표시");
    expect(html).toContain(
      "이전에 저장한 목록입니다. 아래 버튼으로 최신 목록을 가져오세요",
    );
    expect(html).toContain("마지막 응답의 후속 페이지 안내</dt><dd><code>없음");
    expect(html).toContain(
      "읽은 API 응답 항목 수 · 중복 포함</dt><dd><code>31",
    );
    expect(html).not.toContain('href="/skills?shown=');
    expect(html).not.toContain("전체 20개");
    expect(html).not.toContain("모든 스킬");
    const next = renderHome({
      ...verified,
      page: "skills",
      skillsApi: { ...skillsApi, hasMore: true },
    });
    expect(next).toContain("이전에 저장한 목록입니다");
    expect(next).toContain('action="/connect-skills" method="post"');
    expect(next).not.toContain('href="/skills?shown=');
    expect(
      renderHome({ ...verified, page: "skills", skillsApi }),
    ).not.toContain("이전에 저장한 목록입니다");
  });

  function collectedSkills(count: number): typeof skillsApi {
    return {
      ...skillsApi,
      items: Array.from({ length: count }, (_, index) => ({
        ...skillsApi.items[0]!,
        id: `source_${index + 1}`,
        name: `Skill ${index + 1}`,
      })),
      returnedCount: count,
      collection: {
        pages: Math.max(1, Math.ceil(count / 20)),
        startedAt: "2026-09-19T00:02:58.000Z",
        stoppedReason: "cursor_exhausted",
        duplicateCount: 0,
      },
    };
  }

  it("opens saved skills 20 at a time and anchors the new rows without starting another consent", () => {
    const snapshot = collectedSkills(45);
    const first = renderHome({
      ...verified,
      page: "skills",
      skillsApi: snapshot,
      projectGoal: "assistant",
    });
    expect(first).toContain("가져온 45개 중 20개 표시");
    expect(first.match(/<li class="skill-item"/g)).toHaveLength(20);
    expect(first).toContain('id="skill-20"');
    expect(first).not.toContain('id="skill-21"');
    expect(first).toContain('href="/skills?shown=40#skill-21">20개 더 보기');
    expect(first).toContain(
      "다시 동의할 필요 없이 현재 프로젝트 선택도 유지돼요",
    );
    expect(first).not.toContain("가져온 목록을 모두 표시했어요");
    expect(first).not.toMatch(/<script|onclick=/);
    const second = renderHome({
      ...verified,
      page: "skills",
      skillsApi: snapshot,
      skillsVisibleCount: 40,
    });
    expect(second).toContain("가져온 45개 중 40개 표시");
    expect(second.match(/<li class="skill-item"/g)).toHaveLength(40);
    expect(second).toContain('id="skill-1"');
    expect(second).toContain('id="skill-21"');
    expect(second).not.toContain('id="skill-41"');
    expect(second).toContain('href="/skills?shown=60#skill-41">5개 더 보기');
    const last = renderHome({
      ...verified,
      page: "skills",
      skillsApi: snapshot,
      skillsVisibleCount: 60,
    });
    expect(last).toContain("가져온 45개 중 45개 표시");
    expect(last.match(/<li class="skill-item"/g)).toHaveLength(45);
    expect(last).toContain('id="skill-41"');
    expect(last).toContain("가져온 목록을 모두 표시했어요");
    expect(last).not.toContain('href="/skills?shown=');
    expect(last).toContain("스킬 다시 연결하기");
    expect(last).not.toContain("현재 프로젝트 선택은 초기화됩니다");
    expect(snapshot.items).toHaveLength(45);
  });

  it("bases local expansion on saved items even when the API has no next cursor", () => {
    const snapshot = collectedSkills(200);
    snapshot.collection!.stoppedReason = "item_limit";
    snapshot.truncated = true;
    snapshot.hasMore = false;
    const first = renderHome({
      ...verified,
      page: "skills",
      skillsApi: snapshot,
    });
    expect(first).toContain('href="/skills?shown=40#skill-21"');
    expect(first).toContain("200개까지 저장했어요");
    const last = renderHome({
      ...verified,
      page: "skills",
      skillsApi: snapshot,
      skillsVisibleCount: 200,
    });
    expect(last).toContain("가져온 200개 중 200개 표시");
    expect(last).toContain('id="skill-200"');
    expect(last).toContain("가져온 목록을 모두 표시했어요");
    expect(last).not.toContain('href="/skills?shown=');
    expect(last).not.toContain("모든 스킬");
    expect(last).toContain("아직 가져오지 못한 스킬이 있을 수 있어요");
  });

  it.each([
    ["byte_limit", "보관할 수 있는 정보량에 도달해"],
    ["time_limit", "조회 시간이 길어져"],
    ["page_limit", "이번 조회에서 읽을 수 있는 범위까지"],
    ["upstream_error", "이후 목록을 가져오지 못해"],
    ["invalid_response", "이후 응답을 확인하지 못해"],
    ["cursor_cycle", "다음 목록이 반복되어"],
    ["unknown_cursor", "다음 목록이 있는지 확인할 수 없어"],
  ] as const)(
    "explains a %s collection stop while still offering saved rows",
    (stoppedReason, explanation) => {
      const snapshot = collectedSkills(25);
      snapshot.collection!.stoppedReason = stoppedReason;
      snapshot.truncated = true;
      snapshot.hasMore = true;
      const html = renderHome({
        ...verified,
        page: "skills",
        skillsApi: snapshot,
      });
      expect(html).toContain(explanation);
      expect(html).toContain("가져온 25개 중 20개 표시");
      expect(html).toContain('href="/skills?shown=40#skill-21">5개 더 보기');
      expect(html).toContain(`수집 종료 이유</dt><dd><code>${stoppedReason}`);
      expect(html).not.toContain("이전에 저장한 목록입니다");
    },
  );

  it("reports collection provenance separately from the saved unique item count", () => {
    const snapshot = collectedSkills(21);
    snapshot.returnedCount = 23;
    snapshot.collection!.duplicateCount = 2;
    const html = renderHome({
      ...verified,
      page: "skills",
      skillsApi: snapshot,
    });
    expect(html).toContain("가져온 21개 중 20개 표시");
    expect(html).toContain(
      "읽은 API 응답 항목 수 · 중복 포함</dt><dd><code>23",
    );
    expect(html).toContain("중복으로 제외한 항목 수</dt><dd><code>2");
    expect(html).toContain("읽은 API 페이지 수</dt><dd><code>2");
    expect(html).toContain("192KiB");
    expect(html).toContain("ID 토큰은 보관하지 않습니다");
    expect(html).toContain(
      "API를 다시 호출하지 않습니다",
    );
  });

  it("keeps later rows out of the first response and escapes them when expanded", () => {
    const snapshot = collectedSkills(21);
    snapshot.items[20] = {
      ...snapshot.items[20]!,
      name: "<script>later-row</script>",
      id: '" onload="bad',
    };
    const first = renderHome({
      ...verified,
      page: "skills",
      skillsApi: snapshot,
    });
    expect(first).not.toContain("later-row");
    const expanded = renderHome({
      ...verified,
      page: "skills",
      skillsApi: snapshot,
      skillsVisibleCount: 40,
    });
    expect(expanded).toContain('id="skill-21"');
    expect(expanded).toContain("&lt;script&gt;later-row&lt;/script&gt;");
    expect(expanded).toContain("&quot; onload=&quot;bad");
    expect(expanded).not.toMatch(/<script| onload="/);
  });

  it("hides skills for another subject even if other session API results succeeded", () => {
    const html = renderHome({
      ...verified,
      page: "skills",
      memberApi,
      skillsApi: { ...skillsApi, subject: "usr_other" },
    });
    expect(html).toContain(
      "로그인한 계정의 스킬 조회 결과를 확인하지 못했어요",
    );
    expect(html).not.toContain("TypeScript");
    expect(html).not.toContain("조회한 스킬 목록");
    expect(html).not.toContain("usr_other");
  });

  it("escapes skill fields and preserves snapshots when a later consent is denied", () => {
    const html = renderHome({
      ...verified,
      page: "skills",
      memberApi,
      error: "추가 동의를 취소했습니다.",
      skillsApi: {
        ...skillsApi,
        items: [
          {
            ...skillsApi.items[0]!,
            id: "<img src=x>",
            name: "<script>name</script>",
            source: "<svg source>",
            verificationMethod: "<b>method</b>",
            verifiedBy: "<iframe verifier>",
          },
        ],
      },
    });
    expect(html).toContain("&lt;script&gt;name&lt;/script&gt;");
    expect(html).toContain("&lt;svg source&gt;");
    expect(html).toContain("&lt;b&gt;method&lt;/b&gt;");
    expect(html).toContain("&lt;iframe verifier&gt;");
    expect(html).toContain("&lt;img src=x&gt;");
    expect(html).toContain("기존 로그인은 유지됩니다");
    expect(html).toContain("조회 시점의 정보");
    expect(html).not.toMatch(/<script|<img|<svg|<iframe/);
  });

  it.each(["profile", "skills"] as const)(
    "uses the existing API connection to refresh only the %s page",
    (page) => {
      const html = renderHome({
        ...verified,
        page,
        memberApi,
        profileDetails,
        skillsApi,
        apiConnection: { profile: "ready", skills: "ready" },
        projectGoal: "assistant",
      });
      expect(html).toContain(`action="/refresh-${page}" method="post"`);
      expect(html).not.toContain(`action="/connect-${page}"`);
      expect(html).not.toContain(
        `action="/refresh-${page === "profile" ? "skills" : "profile"}"`,
      );
      expect(html).toContain(
        "미지 화면으로 이동하지 않고 이 화면의 정보만 새로 가져옵니다",
      );
      expect(html).toContain("프로젝트 선택은 그대로 유지돼요");
      expect(html).toContain('action="/logout"');
      expect(html).not.toContain("프로젝트 선택은 초기화");
      expect(html).not.toMatch(/<script|http-equiv="refresh"/);
    },
  );

  it.each(["profile", "skills"] as const)(
    "keeps a failed first %s read retryable when the API connection is ready",
    (page) => {
      const html = renderHome({
        ...verified,
        page,
        apiConnection: { profile: "ready", skills: "ready" },
        memberApi: {
          status: "error",
          reason: "unavailable",
          fetchedAt: memberApi.fetchedAt,
        },
        skillsApi: {
          status: "error",
          reason: "unavailable",
          subject: "usr_verified",
          endpoint: skillsApi.endpoint,
          fetchedAt: skillsApi.fetchedAt,
        },
      });
      expect(html).toContain(`action="/refresh-${page}" method="post"`);
      expect(html).not.toContain(`action="/connect-${page}"`);
      expect(html).not.toContain("회원 API 조회 완료");
      expect(html).not.toContain("조회한 스킬 목록");
    },
  );

  it.each(["profile", "skills"] as const)(
    "offers an explicit %s reconnect while retaining an old snapshot",
    (page) => {
      const html = renderHome({
        ...verified,
        page,
        memberApi,
        profileDetails,
        skillsApi,
        apiConnection: { profile: "reconnect", skills: "reconnect" },
      });
      expect(html).toContain(`action="/connect-${page}" method="post"`);
      expect(html).toContain(
        `${page === "profile" ? "프로필" : "스킬"} 다시 연결하기`,
      );
      expect(html).toContain(
        "한 번 다시 연결하면 다음부터는 이 화면에서 바로 다시 가져올 수 있어요",
      );
      expect(html).toContain(
        page === "profile" ? memberApi.fetchedAt : skillsApi.fetchedAt,
      );
      expect(html).not.toContain('action="/refresh-');
      expect(html).not.toMatch(/<script|http-equiv="refresh"/);
    },
  );

  it.each(["profile", "skills"] as const)(
    "offers first consent without claiming a %s refresh succeeded",
    (page) => {
      const html = renderHome({
        ...verified,
        page,
        apiConnection: { profile: "connect", skills: "connect" },
      });
      expect(html).toContain(`action="/connect-${page}" method="post"`);
      expect(html).toContain("다음 미지 화면에서 정보 제공을 허용해 주세요");
      expect(html).not.toContain("다시 연결하기</button>");
      expect(html).not.toContain('action="/refresh-');
      expect(html).not.toContain("정보를 다시 가져왔어요");
    },
  );

  it.each(["unavailable", "reconnect_required", "invalid_response"] as const)(
    "labels retained results as old after %s and never invents a fresh timestamp",
    (refreshFeedback) => {
      const html = renderHome({
        ...verified,
        page: "skills",
        skillsApi,
        refreshFeedback,
        apiConnection: {
          profile: "ready",
          skills:
            refreshFeedback === "reconnect_required" ? "reconnect" : "ready",
        },
      });
      expect(html).toContain('role="alert"');
      expect(html).toContain("표시된 정보와 조회 시각은 이전 조회 결과입니다");
      expect(html).toContain(skillsApi.fetchedAt);
      expect(html).toContain("TypeScript");
      expect(html).not.toContain("정보를 다시 가져왔어요");
      expect(html).not.toContain('action="/login"');
      expect(html).toContain(
        refreshFeedback === "reconnect_required"
          ? "스킬 다시 연결하기"
          : "스킬 다시 가져오기",
      );
    },
  );

  it("shows successful and partial refresh feedback without erasing independent query times", () => {
    const updated = renderHome({
      ...verified,
      page: "profile",
      memberApi,
      profileDetails,
      refreshFeedback: "updated",
      apiConnection: { profile: "ready", skills: "connect" },
    });
    expect(updated).toContain('role="status">정보를 다시 가져왔어요');
    expect(updated).not.toContain("이전 조회 결과입니다");
    const partial = renderHome({
      ...verified,
      page: "profile",
      memberApi,
      profileDetails: {
        ...profileDetails,
        fetchedAt: "2026-09-19T00:05:00.000Z",
      },
      refreshFeedback: "partial",
      apiConnection: { profile: "ready", skills: "ready" },
    });
    expect(partial).toContain(
      "일부 정보만 새로 가져왔어요. 각 조회 시각을 확인해 주세요",
    );
    expect(partial).toContain(memberApi.fetchedAt);
    expect(partial).toContain("2026-09-19T00:05:00.000Z");
    expect(partial).not.toContain("정보를 다시 가져왔어요");
  });

  it("does not claim an old snapshot exists when an initial refresh fails without data", () => {
    const html = renderHome({
      ...verified,
      page: "profile",
      refreshFeedback: "unavailable",
      apiConnection: { profile: "ready", skills: "connect" },
    });
    expect(html).toContain("새 정보를 가져오지 못했어요");
    expect(html).not.toContain(
      "표시된 정보와 조회 시각은 이전 조회 결과입니다",
    );
    expect(html).not.toContain("회원 API 조회 완료");
  });

  it("never renders server-only credentials or unrecognized feedback attached to a view model", () => {
    const extra = {
      ...verified,
      page: "skills" as const,
      skillsApi,
      apiConnection: { profile: "ready" as const, skills: "ready" as const },
      apiGrant: {
        accessToken: "server-private-access-token",
        refreshToken: "server-private-refresh-token",
        scope: "private-scope-value",
      },
      refreshFeedback: "<script>untrusted-feedback</script>",
    };
    const html = renderHome(extra as unknown as HomeViewModel);
    expect(html).not.toContain("server-private-access-token");
    expect(html).not.toContain("server-private-refresh-token");
    expect(html).not.toContain("private-scope-value");
    expect(html).not.toContain("untrusted-feedback");
    expect(html).not.toContain("<script");
    expect(html).toContain('action="/refresh-skills"');
  });
});
