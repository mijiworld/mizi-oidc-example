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
    expect(html).toContain("미지 계정은 로그아웃되지 않습니다");
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
    const html = renderHome({ ...verified, projectGoal: "website" });
    expect(html).toContain("서버 검증 완료");
    expect(html).toContain('action="/connect-profile" method="post"');
    expect(html).toContain("내 미지 정보 가져오기");
    expect(html).toContain("user:profile");
    expect(html).toContain("GET /v1/me");
    expect(html).not.toContain("회원 API 조회 완료");
    expect(html).not.toContain('action="/service/goal"');
    expect(html).not.toContain("이 데모에 저장됨");
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
      expect(html).toContain('action="/service/goal" method="post"');
      expect(html).toContain('action="/connect-profile" method="post"');
      expect(html).toContain('프로필 다시 가져오기');
      expect(html).toContain('현재 프로젝트 선택은 초기화됩니다');
    },
  );

  it("renders only the selected example plan and explains its local session lifetime", () => {
    const html = renderHome({
      ...verified,
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
    expect(html).toContain("30분 세션");
    expect(html).toContain("세션 만료나 로그아웃 시 사라집니다");
    expect(html).toContain("선택을 미지에 저장하지 않습니다");
    expect(html).toContain("strict-origin");
    expect(html).toContain('id="project-board"');
  });

  it("escapes API fields and service errors while preserving verified login and API results", () => {
    const html = renderHome({
      ...verified,
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
    expect(html).toContain("서버 검증 완료");
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
    expect(html).toContain("서버 검증 완료");
    expect(html).toContain("테스트 회원");
    expect(html).toContain("추가 동의를 완료하지 못했습니다.");
    expect(html).toContain("기존 로그인은 유지됩니다");
    expect(html).toContain("이전 조회 결과");
    expect(html).toContain("조회 시점의 정보");
    expect(html).toContain("2026-09-19T00:01:00.000Z");
    expect(html).toContain("이전 API 이름");
    expect(html).not.toContain('action="/login"');
  });
});
