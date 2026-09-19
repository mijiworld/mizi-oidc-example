export const developerGuideStyles = `
.dev-guide { min-width: 0; max-width: 100%; }
.dev-guide h2 { font-size: 23px; letter-spacing: -.035em; line-height: 1.4; }
.dev-guide h3 { margin: 0; font-size: 17px; letter-spacing: -.02em; }
.dev-guide p, .dev-guide li, .dev-guide dd { overflow-wrap: anywhere; }
.dev-guide p + p { margin-top: 12px; }
.dg-hero { max-width: 760px; }
.dg-links { display: flex; flex-wrap: wrap; gap: 12px 22px; margin-top: 24px; font-size: 14px; font-weight: 600; }
.dg-toc { margin: 32px 0; padding: 18px 22px; border: 1px solid var(--line); border-radius: 12px; }
.dg-toc strong { display: block; color: var(--muted); font-size: 12px; }
.dg-toc ol { display: flex; flex-wrap: wrap; gap: 8px 24px; list-style: none; margin: 10px 0 0; padding: 0; font-size: 14px; }
.dg-section { margin-top: 24px; padding: 30px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; scroll-margin-top: 24px; min-width: 0; }
.dg-section > p { margin-top: 14px; color: var(--muted); font-size: 14px; }
.dg-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; list-style: none; padding: 0; margin: 24px 0 0; counter-reset: guide-step; }
.dg-steps li { border-top: 2px solid var(--green); padding-top: 14px; counter-increment: guide-step; min-width: 0; }
.dg-steps li::before { content: "0" counter(guide-step); display: block; color: var(--green); font-size: 12px; font-weight: 700; margin-bottom: 8px; }
.dg-steps strong { font-size: 16px; }
.dg-steps p { margin-top: 8px; font-size: 13px; color: var(--muted); }
.dg-detail { margin-top: 22px; border-top: 1px solid var(--line); padding-top: 16px; min-width: 0; }
.dg-detail > summary { cursor: pointer; color: var(--green); font-size: 14px; font-weight: 600; padding: 4px 0; }
.dg-detail > p, .dg-detail > ul { margin-top: 14px; color: var(--muted); font-size: 14px; }
.dg-detail > ul, .dg-list { padding-left: 22px; }
.dg-list { margin: 18px 0 0; font-size: 14px; }
.dg-list li + li { margin-top: 10px; }
.dg-code { margin: 16px 0; border: 1px solid var(--line); border-radius: 10px; overflow: hidden; min-width: 0; max-width: 100%; background: var(--paper); }
.dg-code figcaption { padding: 9px 15px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 11px; letter-spacing: .03em; }
.dg-code pre { margin: 0; padding: 16px; max-width: 100%; min-width: 0; overflow-x: auto; overscroll-behavior-x: contain; white-space: pre; font-size: 12px; line-height: 1.75; tab-size: 2; }
.dg-code code { font-size: inherit; }
.dg-table-wrap { margin-top: 20px; max-width: 100%; overflow-x: auto; }
.dg-table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
.dg-table th { color: var(--muted); font-size: 12px; font-weight: 500; }
.dg-table th, .dg-table td { padding: 12px 14px 12px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
.dg-table td:first-child { font-weight: 600; }
.dg-table code { white-space: nowrap; }
.dg-note { margin-top: 18px; padding: 14px 18px; border-radius: 9px; background: var(--green-soft); font-size: 13px; color: var(--green); overflow-wrap: anywhere; }
.dg-endpoint { margin-top: 26px; padding-top: 22px; border-top: 1px solid var(--line); scroll-margin-top: 24px; min-width: 0; }
.dg-endpoint > p { margin-top: 10px; color: var(--muted); font-size: 14px; }
.dg-endpoint h3 code { overflow-wrap: anywhere; }
.dg-config { margin: 18px 0 0; font-size: 13px; }
.dg-config > div { padding: 10px 0; border-top: 1px solid var(--line); }
.dg-config dt { color: var(--muted); font-size: 12px; }
.dg-config dd { margin: 5px 0 0; }
.dg-source-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 20px; }
.dg-source-list a { border: 1px solid var(--line); border-radius: 10px; padding: 16px; text-decoration: none; min-width: 0; overflow-wrap: anywhere; }
.dg-source-list a:hover { border-color: var(--green); }
.dg-source-list strong { display: block; font-size: 14px; color: var(--green); }
.dg-source-list span { display: block; margin-top: 6px; color: var(--muted); font-size: 12px; }
@media (max-width: 720px) {
  .dg-section { padding: 24px 20px; border-radius: 14px; }
  .dg-steps, .dg-source-list { grid-template-columns: 1fr; }
  .dg-steps { gap: 22px; }
  .dg-toc { padding: 16px 18px; }
  .dg-toc ol { gap: 8px 18px; }
  .dg-table { min-width: 510px; }
  .dg-code pre { padding: 14px; }
  .dev-guide h2 { font-size: 21px; }
}
`;
