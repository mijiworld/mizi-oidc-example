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
    expect(html).not.toContain("서버 검증 완료");
    expect(html).toContain("다시 시작해 주세요.");
  });
});
