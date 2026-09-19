import { describe, expect, it } from "vitest";
import { renderDeveloperGuide } from "../src/developer-guide.js";

const model = {
  issuer: "https://issuer.example/tenant",
  clientId: "mzp_example",
  baseUrl: "https://demo.example",
};

describe("public developer guide", () => {
  it("escapes configuration in text, attributes and code examples without creating executable markup", () => {
    const attack = '\"><img src=x onerror=alert(1)><script>alert(1)</script>&';
    const html = renderDeveloperGuide({
      issuer: `https://issuer.example/${attack}`,
      clientId: attack,
      baseUrl: `https://demo.example/${attack}`,
    });
    expect(html).not.toMatch(/<script\b|<img\b|<input\b|<form\b/i);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).not.toContain(`href="${attack}`);
    const badScheme = renderDeveloperGuide({
      issuer: "javascript:alert(1)",
      clientId: attack,
      baseUrl: "javascript:alert(2)",
    });
    expect(badScheme).not.toMatch(/href="javascript:/i);
  });

  it("derives fixed API targets from the issuer origin and labels all response samples as fictional subsets", () => {
    const html = renderDeveloperGuide(model);
    expect(html).toContain("https://issuer.example/v1/me");
    expect(html).not.toContain("https://issuer.example/tenant/v1/me");
    expect(html).toContain(
      "https://issuer.example/tenant/.well-known/openid-configuration",
    );
    expect(html.match(/설명용 일부 필드 예제 · 가상 JSON/g)).toHaveLength(6); // caption and accessible label
    expect(html).toContain("가상 자료");
    expect(html).toContain("usr_example");
    expect(html).toContain("skl_example");
    expect(html).toContain("Bearer &lt;ACCESS_TOKEN&gt;");
    expect(html).not.toMatch(/dgt_[A-Za-z0-9_-]{43}/);
    expect(html).not.toMatch(/<script\b|<input\b|<form\b/i);
  });

  it("links its contents to real sections and the implementation files", () => {
    const html = renderDeveloperGuide(model);
    for (const match of html.matchAll(/href="#([^"]+)"/g))
      expect(html).toContain(`id="${match[1]}"`);
    for (const filename of [
      "oidc",
      "member-api",
      "extra-api",
      "api-grant",
      "api-refresh",
      "store",
    ]) {
      expect(html).toContain(
        `https://github.com/mijiworld/mizi-oidc-example/blob/main/src/${filename}.ts`,
      );
    }
    expect(html).toContain('href="/"');
    expect(html).toContain("application/problem+json");
    expect(html).toContain("opaque");
    expect(html).toContain("user:profile");
    expect(html).toContain("user:skills");
  });

  it("distinguishes private access-token reuse from explicit OAuth reconnection and preserves session boundaries", () => {
    const html = renderDeveloperGuide(model);
    expect(html).toContain("POST /refresh-profile");
    expect(html).toContain("POST /refresh-skills");
    expect(html).toContain("접근 토큰만 서버 전용 DynamoDB 필드");
    expect(html).toContain("저장 시 암호화(SSE)");
    expect(html).toContain("ID 토큰과 갱신 토큰은 보관하지 않습니다");
    expect(html).toContain("3600초");
    expect(html).toContain("30분 세션 만료 중 이른 시각");
    expect(html).toContain(
      "다른 화면의 조회 결과와 프로젝트 선택, 세션 ID·만료 시각은 바꾸지 않습니다",
    );
    expect(html).toContain("조회 실패 시 이전 결과와 조회 시각을 유지합니다");
    expect(html).toContain(
      "자동 OAuth 이동이나 갱신 토큰을 통한 자동 갱신은 구현하지 않습니다",
    );
    expect(html).toContain("TTL 삭제는 지연될 수 있지만");
    expect(html).not.toContain(
      "접근·ID·갱신 토큰 원문을 브라우저, 세션, 로그에 보관하지 않습니다",
    );
    expect(html).not.toContain("이전 프로젝트 선택을 초기화합니다");
    expect(html).not.toMatch(/<form\b|<input\b|<script\b/);
  });
});
