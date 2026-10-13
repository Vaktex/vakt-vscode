// HTML for the finding detail panel. No vscode import: it is a pure function
// of the data, so it can be unit-tested and previewed in a browser.
//
// Everything repo-derived (names, paths, source) is HTML-escaped, and the
// page runs under a CSP that allows only our own nonce'd script and no
// network access at all.

import { cweUrl, displayTitle, FAMILIES, issueFor, rankFamilies, severityLabel } from "./families";
import { highlightLines } from "./highlight";
import { fmt, unitName } from "./present";
import { sanitize, Unit } from "./report";
import { fontFace, THEME_CSS } from "./theme";

export interface DetailModel {
  unit: Unit;
  /** Source lines of the function (already read from disk / the open document). */
  source: string[];
  /** VS Code language id of the file, for syntax highlighting. */
  languageId?: string;
  findingIndex?: number;
  findingCount?: number;
  threshold: number;
  minConfidence: number;
  ignored: boolean;
  model: { repo: string; revision: string; backend: string; device: string; precision: string } | undefined;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const LEVEL_CLASS: Record<string, string> = { CRITICAL: "c", HIGH: "h", MEDIUM: "m", LOW: "l" };

/** One-letter badge, as used in the tree. */
export function levelLetter(score: number): string {
  return severityLabel(score)[0];
}

/** What cloud review did to a finding, as a tag. */
const CLOUD_TAG: Record<NonNullable<Unit["cloud"]>["operation"], string> = {
  confirm: "Cloud verified",
  reclassify: "Relabelled by cloud",
  add: "Found by cloud",
};

/** Families shown as bars; the rest above 0.01 go in the "more" disclosure. */
const SHOWN_FAMILIES = 2;

// Lucide icons (https://lucide.dev, ISC), the set vaktex.com uses. Copied as
// paths so the page needs no script or network to draw them.
const LUCIDE: Record<string, string> = {
  "chevron-left": `<path d="m15 18-6-6 6-6"/>`,
  "chevron-right": `<path d="m9 18 6-6-6-6"/>`,
};

function icon(name: keyof typeof LUCIDE, size = 16): string {
  return `<svg class="lucide" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LUCIDE[name]}</svg>`;
}

export function detailHtml(m: DetailModel, opts: { nonce: string; cspSource: string; fontUri?: string }): string {
  const u = m.unit;
  const level = severityLabel(u.severity);
  const issue = issueFor(u.top_family);
  const url = issue.cwe ? cweUrl(issue.cwe) : undefined;
  const ranked = rankFamilies(u.families, FAMILIES.length);
  const shown = ranked.slice(0, SHOWN_FAMILIES);
  const rest = ranked.slice(SHOWN_FAMILIES).filter((r) => r.prob >= 0.01);
  const name = unitName(u);

  // The CSP has no 'unsafe-inline', so style="" attributes are dropped: bar
  // geometry goes in the nonce'd stylesheet instead, one rule per row.
  const barCss = [...shown, ...rest]
    .map((r, n) => `#fam${n} .fill{width:${Math.min(100, r.prob * 100).toFixed(1)}%}#fam${n} .cut{left:${Math.min(100, r.cutoff * 100).toFixed(1)}%}`)
    .join("");

  const famRow = (r: (typeof ranked)[number], n: number) => {
    const i = issueFor(r.family);
    const top = n === 0;
    return `
      <div class="fam${top ? " top" : ""}${r.prob >= r.cutoff ? " over" : ""}" id="fam${n}">
        <div class="fam-head">
          <span class="fam-name">${esc(i.title)}</span>
          <span class="fam-score">${fmt(r.prob)}</span>
        </div>
        <div class="bar" role="img" aria-label="${esc(i.title)} ${fmt(r.prob)}, cut-off ${r.cutoff.toFixed(2)}">
          <div class="fill"></div>
          <div class="cut" title="Published cut-off ${r.cutoff.toFixed(2)}"></div>
        </div>
      </div>`;
  };


  const first = u.start_line;
  const clean = m.source.map((line) => sanitize(line, 2000));
  // highlight.js escapes the text it is given; without a grammar we escape it ourselves.
  const lit = highlightLines(clean, m.languageId) ?? clean.map(esc);
  const code = lit.map((html, i) => `<tr><td class="ln">${first + i}</td><td class="src">${html || " "}</td></tr>`).join("");

  const parts = (u.parts ?? [])
    .map(
      (p) =>
        `<li>Part ${p.split_part}: lines ${p.start_line}–${p.end_line}, severity <b>${fmt(p.severity)}</b>, ${esc(issueFor(p.top_family).title)} ${fmt(p.top_family_prob)}</li>`,
    )
    .join("");

  const notes: string[] = [];
  if (u.truncated) notes.push("Truncated to the model's 16,384-token context.");
  if (u.cached) notes.push("Score from the local cache (function unchanged since it was last scored).");

  const nav =
    m.findingCount && m.findingCount > 1
      ? `<nav class="pager" aria-label="Findings">
          <button class="icon" data-cmd="prev" title="Previous finding (k)" aria-label="Previous finding">${icon("chevron-left", 14)}</button>
          <span class="num">${(m.findingIndex ?? 0) + 1} of ${m.findingCount}</span>
          <button class="icon" data-cmd="next" title="Next finding (j)" aria-label="Next finding">${icon("chevron-right", 14)}</button>
        </nav>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${opts.cspSource}; style-src ${opts.cspSource} 'nonce-${opts.nonce}'; script-src 'nonce-${opts.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(displayTitle(u.top_family))}</title>
<style nonce="${opts.nonce}">${opts.fontUri ? fontFace(opts.fontUri) : ""}${THEME_CSS}${CSS}${barCss}</style>
</head>
<body>
<main>
<div class="title-row">
  <h1>${esc(issue.title)}<span class="fn" title="${esc(name)}">${esc(name)}</span></h1>
  ${nav}
</div>

<header>
  <div class="tags">
    <span class="tag sev ${LEVEL_CLASS[level]}" title="Severity ${fmt(u.severity)}">${level[0] + level.slice(1).toLowerCase()}</span>
    ${issue.cwe && url ? `<a class="tag cwe" href="${url}">${esc(issue.cwe)}</a>` : ""}
    <span class="tag">${esc(sanitize(u.language, 40))}</span>
    ${u.cloud ? `<span class="tag" title="Cloud review">${CLOUD_TAG[u.cloud.operation]}</span>` : ""}
    ${m.ignored ? `<span class="tag">Ignored</span>` : ""}
  </div>
  <p class="desc">${esc(issue.description)}</p>
  ${issue.cwe && url ? `<a class="source muted small" href="${url}">MITRE ${esc(issue.cwe)}</a>` : ""}
</header>

<section aria-labelledby="code-h">
  <div class="section-head">
    <h2 id="code-h">Code snippet</h2>
    <a href="#" data-cmd="open" title="Go to ${esc(u.file)}:${u.start_line}">View in editor</a>
  </div>
  <div class="code"><table>${code}</table></div>
  ${parts ? `<details><summary>${icon("chevron-right", 14)}Scored in ${u.parts!.length} parts (highest shown)</summary><ul class="parts">${parts}</ul></details>` : ""}
  ${notes.map((n) => `<p class="muted small">${esc(n)}</p>`).join("")}
</section>


<section class="fams" aria-label="Family scores">
  ${shown.map(famRow).join("")}
  ${rest.length ? `<details><summary>${icon("chevron-right", 14)}${rest.length} more famil${rest.length === 1 ? "y" : "ies"} scored above 0.01</summary><div class="rest">${rest.map((r, n) => famRow(r, n + SHOWN_FAMILIES)).join("")}</div></details>` : ""}
</section>

<div class="actions">
  <button class="primary" data-cmd="review" title="Ask your coding agent to review this finding and fix it, or VAKT Cloud if this editor has no agent">Resolve</button>
  <div class="pair">
    <button data-cmd="rescan" title="Scan ${esc(u.file)} again">Rescan</button>
    <button data-cmd="ignoreUnit" title="Hide this finding in this workspace" ${m.ignored ? "disabled" : ""}>${m.ignored ? "Ignored" : "Ignore"}</button>
  </div>
</div>
</main>

<script nonce="${opts.nonce}">
  const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage: (m) => console.log(m) };
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-cmd]");
    if (!el || el.disabled) return;
    e.preventDefault();
    vscode.postMessage({ cmd: el.dataset.cmd });
  });
  // The extension sizes the panel's column from this (see DetailPanel.fitWidth).
  vscode.postMessage({ cmd: "width", width: window.innerWidth });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("button, a, summary")) return;
    if (e.key === "j" || e.key === "ArrowDown" && e.altKey) vscode.postMessage({ cmd: "next" });
    if (e.key === "k" || e.key === "ArrowUp" && e.altKey) vscode.postMessage({ cmd: "prev" });
  });
</script>
</body>
</html>`;
}

const CSS = `
* { box-sizing: border-box; }
body {
  margin: 0; padding: 24px 28px 28px;
  font-family: var(--sans); font-size: 14px; line-height: 1.5; letter-spacing: -0.01em;
  color: var(--ink); background: var(--bg);
}
main { max-width: 640px; display: flex; flex-direction: column; gap: 22px; }
a { color: inherit; }
a:hover { opacity: 0.75; }
a:focus-visible, button:focus-visible, summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
.num { font-variant-numeric: tabular-nums; }

.title-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
h1 { margin: 0; font-size: 28px; line-height: 1.2; font-weight: 700; letter-spacing: -0.02em; min-width: 0; text-wrap: balance; }
h1 .fn { display: block; margin-top: 6px; font-family: var(--mono); font-size: 15px; line-height: 1.4; font-weight: 500; letter-spacing: 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.02em; }
.pager { display: flex; align-items: center; gap: 2px; flex: none; margin-top: 4px; padding: 2px; border-radius: 999px; background: var(--panel); font-size: 12.5px; font-weight: 500; }
.pager .num { padding: 0 4px; }

header { display: flex; flex-direction: column; gap: 14px; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; font-size: 12.5px; font-weight: 600; }
.tag { padding: 3px 10px; border-radius: 999px; background: var(--panel2); color: var(--ink); text-decoration: none; }
.tag.sev.c { background: var(--crit-bg); color: var(--crit); }
.tag.sev.h { background: var(--high-bg); color: var(--high); }
.tag.sev.m { background: var(--med-bg); color: var(--med); }
.tag.sev.l { background: var(--low-bg); color: var(--low); }
.tag.cwe { background: var(--blue-bg); color: var(--blue); }
.desc { margin: 0; font-size: 15px; line-height: 1.55; }
.source { align-self: flex-start; margin-top: -8px; }

section { display: flex; flex-direction: column; gap: 10px; }
.section-head { display: flex; align-items: center; justify-content: space-between; }
.section-head a { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; font-weight: 500; text-decoration: none; }
.code { background: var(--code); border: 1px solid var(--line); border-radius: 14px; overflow: auto; max-height: 360px; }
.code table { border-collapse: separate; border-spacing: 0; font-family: var(--mono); font-size: 12.5px; line-height: 1.75; letter-spacing: 0; }
.code td { white-space: pre; vertical-align: top; }
/* Line numbers stay put while the code scrolls sideways. */
.code .ln { position: sticky; left: 0; z-index: 1; background: var(--code); width: 1%; min-width: 40px; text-align: right; padding: 0 12px 0 14px; border-right: 1px solid var(--line); color: var(--muted); user-select: none; }
.code .src { padding: 0 16px 0 14px; }
.code tr:first-child td { padding-top: 12px; }
.code tr:last-child td { padding-bottom: 12px; }
/* Syntax colours: VS Code's Light+ and Dark+ themes. */
:root {
  --tok-keyword: #0000ff; --tok-control: #af00db; --tok-string: #a31515; --tok-comment: #008000; --tok-number: #098658;
  --tok-function: #795e26; --tok-type: #267f99; --tok-variable: #001080; --tok-regexp: #811f3f;
}
body.vscode-dark, body.vscode-high-contrast {
  --tok-keyword: #569cd6; --tok-control: #c586c0; --tok-string: #ce9178; --tok-comment: #6a9955; --tok-number: #b5cea8;
  --tok-function: #dcdcaa; --tok-type: #4ec9b0; --tok-variable: #9cdcfe; --tok-regexp: #d16969;
}
.code .hljs-keyword, .code .hljs-literal, .code .hljs-meta .hljs-keyword { color: var(--tok-keyword); }
.code .hljs-built_in, .code .hljs-type, .code .hljs-title.class_ { color: var(--tok-type); }
.code .hljs-string, .code .hljs-meta .hljs-string { color: var(--tok-string); }
.code .hljs-comment, .code .hljs-doctag { color: var(--tok-comment); font-style: normal; }
.code .hljs-number { color: var(--tok-number); }
.code .hljs-title.function_, .code .hljs-meta { color: var(--tok-function); }
.code .hljs-params, .code .hljs-variable, .code .hljs-attr, .code .hljs-property, .code .hljs-subst { color: var(--tok-variable); }
.code .hljs-regexp, .code .hljs-symbol { color: var(--tok-regexp); }
.code .hljs-subst .hljs-string { color: var(--tok-string); }
.parts { margin: 0; padding-left: 18px; font-size: 13px; }


.fams { gap: 14px; }
.fam { display: flex; flex-direction: column; gap: 6px; }
.fam-head { display: flex; align-items: baseline; gap: 8px; }
.fam.top .fam-name { font-weight: 600; }
.fam-score { margin-left: auto; font-weight: 600; font-variant-numeric: tabular-nums; }
.bar { position: relative; height: 8px; border-radius: 999px; background: var(--track); }
.fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; background: var(--bar-dim); }
.fam.top.over .fill { background: var(--bar); }
.cut { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--muted); }
.fam.top .cut { background: var(--tick); }
details { font-size: 13px; color: var(--muted); }
summary { cursor: pointer; font-weight: 500; list-style: none; display: inline-flex; align-items: center; gap: 6px; }
summary::-webkit-details-marker { display: none; }
summary svg.lucide { transition: transform 0.15s; }
details[open] > summary svg.lucide { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) { summary svg.lucide { transition: none; } }
.rest { margin-top: 14px; display: flex; flex-direction: column; gap: 14px; color: var(--ink); font-size: 14px; }

.actions { display: flex; flex-direction: column; gap: 8px; }
.pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
button { font: inherit; font-weight: 600; cursor: pointer; border-radius: 999px; }
/* One button style: same height, type, radius and border box; only the fill differs. */
.actions button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 44px; padding: 0 16px; font-size: 14px; line-height: 1; border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
.actions button:hover:not(:disabled) { background: var(--panel); }
.actions button.primary { border-color: var(--primary); background: var(--primary); color: var(--on-primary); }
.actions button.primary:hover { opacity: 0.88; background: var(--primary); }
button:disabled { opacity: 0.5; cursor: default; }
svg.lucide { flex: none; }
button.icon { width: 30px; height: 30px; border: 0; background: transparent; color: inherit; display: grid; place-items: center; }
button.icon:hover { background: var(--panel2); }

@media (max-width: 420px) { body { padding: 18px 16px 24px; } h1 { font-size: 24px; } }
`;
