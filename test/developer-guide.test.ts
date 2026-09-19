import { describe, expect, it } from 'vitest';
import { renderDeveloperGuide } from '../src/developer-guide.js';

const model = { issuer: 'https://issuer.example/tenant', clientId: 'mzp_example', baseUrl: 'https://demo.example' };

describe('public developer guide', () => {
  it('escapes configuration in text, attributes and code examples without creating executable markup', () => {
    const attack = '\"><img src=x onerror=alert(1)><script>alert(1)</script>&';
    const html = renderDeveloperGuide({ issuer: `https://issuer.example/${attack}`, clientId: attack,
      baseUrl: `https://demo.example/${attack}` });
    expect(html).not.toMatch(/<script\b|<img\b|<input\b|<form\b/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).not.toContain(`href="${attack}`);
    const badScheme = renderDeveloperGuide({ issuer: 'javascript:alert(1)', clientId: attack, baseUrl: 'javascript:alert(2)' });
    expect(badScheme).not.toMatch(/href="javascript:/i);
  });

  it('derives fixed API targets from the issuer origin and labels all response samples as fictional subsets', () => {
    const html = renderDeveloperGuide(model);
    expect(html).toContain('https://issuer.example/v1/me');
    expect(html).not.toContain('https://issuer.example/tenant/v1/me');
    expect(html).toContain('https://issuer.example/tenant/.well-known/openid-configuration');
    expect(html.match(/설명용 일부 필드 예제 · 가상 JSON/g)).toHaveLength(6); // caption and accessible label
    expect(html).toContain('가상 자료');
    expect(html).toContain('usr_example');
    expect(html).toContain('skl_example');
    expect(html).toContain('Bearer &lt;ACCESS_TOKEN&gt;');
    expect(html).not.toMatch(/dgt_[A-Za-z0-9_-]{43}/);
    expect(html).not.toMatch(/<script\b|<input\b|<form\b/i);
  });

  it('links its contents to real sections and the four implementation files', () => {
    const html = renderDeveloperGuide(model);
    for (const match of html.matchAll(/href="#([^"]+)"/g)) expect(html).toContain(`id="${match[1]}"`);
    for (const filename of ['oidc', 'member-api', 'extra-api', 'store']) {
      expect(html).toContain(`https://github.com/mijiworld/mizi-oidc-example/blob/main/src/${filename}.ts`);
    }
    expect(html).toContain('href="/"');
    expect(html).toContain('application/problem+json');
    expect(html).toContain('opaque');
    expect(html).toContain('user:profile');
    expect(html).toContain('user:skills');
  });
});
