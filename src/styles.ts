export const styles = `
:root {
  color-scheme: light;
  --paper: #f6f5f1;
  --card: #fff;
  --ink: #202822;
  --muted: #657168;
  --line: #dde3db;
  --green: #21533b;
  --green-soft: #eaf2e9;
  --red: #913c30;
  --red-soft: #fff1ee;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); line-height: 1.65; }
a { color: inherit; text-underline-offset: .24em; }
button, input { font: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
button { cursor: pointer; }
:focus-visible { outline: 3px solid #57886a; outline-offset: 5px; }
.wrap { width: min(1080px, calc(100% - 64px)); margin: auto; }
.header { display: flex; justify-content: space-between; align-items: center; gap: 20px; padding: 28px 0; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: baseline; gap: 12px; text-decoration: none; }
.brand strong { font-size: 22px; letter-spacing: -.05em; }
.brand span { color: var(--muted); font-size: 13px; }
.header-link { font-size: 13px; font-weight: 600; white-space: nowrap; }
.eyebrow { color: var(--green); font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
main { padding: 72px 0 48px; }
.intro { max-width: 760px; }
h1, h2, p { margin: 0; }
h1 { margin-top: 14px; font-size: clamp(32px, 4.5vw, 48px); font-weight: 650; letter-spacing: -.055em; line-height: 1.3; word-break: keep-all; }
.lead { margin-top: 20px; color: var(--muted); font-size: 17px; max-width: 650px; word-break: keep-all; }
.grid { display: grid; grid-template-columns: 1.12fr 1fr; gap: 24px; margin-top: 36px; align-items: start; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 32px; min-width: 0; }
.card h2 { font-size: 21px; letter-spacing: -.035em; line-height: 1.4; }
.subtle { margin-top: 10px; color: var(--muted); font-size: 14px; word-break: keep-all; }
.tags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 22px; }
.tag { padding: 4px 10px; border-radius: 6px; background: var(--paper); color: var(--muted); font-size: 12px; }
.login-form { margin-top: 28px; }
.button { display: inline-flex; justify-content: center; align-items: center; gap: 12px; min-height: 48px; padding: 10px 20px; border-radius: 9px; border: 1px solid transparent; text-decoration: none; font-size: 15px; font-weight: 650; }
.primary { width: 100%; background: var(--green); color: #fff; }
.primary:hover { background: #173f2b; }
.secondary { background: var(--card); border-color: var(--line); color: var(--ink); }
.secondary:hover { background: var(--paper); }
.fine { margin-top: 12px; font-size: 12px; line-height: 1.65; color: var(--muted); }
.flow { list-style: none; margin: 24px 0 0; padding: 0; counter-reset: step; }
.flow li { position: relative; padding: 0 0 24px 42px; counter-increment: step; }
.flow li:last-child { padding-bottom: 0; }
.flow li::before { content: counter(step); position: absolute; left: 0; top: 1px; width: 26px; height: 26px; display: grid; place-items: center; background: var(--green-soft); color: var(--green); border-radius: 50%; font-size: 12px; font-weight: 650; }
.flow strong { display: block; font-size: 14px; }
.flow p { margin-top: 4px; color: var(--muted); font-size: 13px; }
.resources { margin-top: 28px; padding-top: 22px; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 12px 24px; font-size: 13px; font-weight: 600; }
.error { margin-top: 28px; background: var(--red-soft); border: 1px solid #eccfc8; color: var(--red); border-radius: 12px; padding: 20px 24px; }
.error h2 { font-size: 16px; }
.error p { margin-top: 6px; font-size: 14px; overflow-wrap: anywhere; }
.status { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 6px; background: var(--green-soft); color: var(--green); font-size: 12px; font-weight: 650; }
.person { margin: 22px 0 24px; }
.person h2 { font-size: 28px; overflow-wrap: anywhere; }
.data { margin: 0; }
.data > div { padding: 13px 0; border-top: 1px solid var(--line); }
.data dt { color: var(--muted); font-size: 12px; }
.data dd { margin: 5px 0 0; font-size: 13px; overflow-wrap: anywhere; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .94em; }
.checks { list-style: none; margin: 22px 0 0; padding: 0; }
.checks li { position: relative; padding: 0 0 20px 28px; }
.checks li:last-child { padding-bottom: 0; }
.checks li::before { content: "✓"; position: absolute; left: 0; color: var(--green); font-weight: 700; }
.checks strong { display: block; font-size: 14px; }
.checks span { display: block; margin-top: 3px; font-size: 12px; color: var(--muted); }
.logout { margin-top: 24px; }
.config { margin-top: 24px; border: 1px solid var(--line); border-radius: 12px; padding: 18px 24px; }
.config summary { font-size: 13px; color: var(--muted); cursor: pointer; }
.config .data { margin-top: 16px; }
.footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 24px; border-top: 1px solid var(--line); padding: 22px 0 30px; color: var(--muted); font-size: 12px; }
@media (max-width: 720px) {
  .wrap { width: calc(100% - 40px); }
  .header { padding: 20px 0; }
  .brand { gap: 8px; }
  .brand span { font-size: 11px; }
  .header-link { font-size: 12px; }
  main { padding: 42px 0 32px; }
  .lead { font-size: 15px; }
  .grid { grid-template-columns: 1fr; gap: 18px; margin-top: 28px; }
  .card { padding: 25px 22px; border-radius: 14px; }
  .config { padding: 16px 20px; }
  .footer { display: block; }
  .footer p + p { margin-top: 6px; }
}
`;
