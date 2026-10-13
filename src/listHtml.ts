// HTML for the findings list in the sidebar. No vscode import: it is a pure
// function of the data, so it can be unit-tested and previewed in a browser.
//
// The page shows the first-run checklist until there are results, then the
// findings grouped by file and by family. Grouping, the severity chips, the
// filter box and collapsed groups are handled in the page and remembered with
// the webview's own state, so they survive re-renders. Repo-derived text is
// HTML-escaped and the CSP allows only our nonce'd script. Every page ends
// with the same footer slot: ignored findings and the Vaktex account line.

import { accountLine, AccountView } from "./account";
import { esc } from "./detailHtml";
import { issueFor, severityLabel } from "./families";
import { unitName } from "./present";
import { Unit } from "./report";
import { fontFace, THEME_CSS } from "./theme";
import { happyVexie, VEXIE_CSS } from "./vexie";

export interface ListItem {
  key: string;
  title: string;
  fn: string;
  /** Workspace-relative file, prefixed with the folder name in multi-root workspaces. */
  file: string;
  /** Shortest unambiguous label for the file group. */
  fileLabel: string;
  level: "c" | "h" | "m" | "l";
  fresh: boolean;
  selected: boolean;
}

export interface ListModel {
  items: ListItem[];
  /** Whether any scan has finished: before that the page shows the setup checklist. */
  hasResults: boolean;
  /** What is being scanned, while a scan runs. */
  scanning?: string;
  stats: { units: number; files: number };
  ignored: number;
  /** signedIn is undefined when nothing would use the account (fully local, or cloud review off): no step for it. */
  setup: { binary: boolean; model: boolean; signedIn?: boolean };
  /** The account line in the footer; undefined hides it. */
  account?: AccountView;
}

const LEVELS = [
  { id: "c", label: "Critical" },
  { id: "h", label: "High" },
  { id: "m", label: "Medium" },
  { id: "l", label: "Low" },
] as const;

/**
 * A row's id, sent back by the page when the row is clicked. Each part is
 * URI-encoded so the id survives the HTML attribute intact (a NUL separator,
 * for one, is replaced by the HTML parser and the click would match nothing).
 */
export function findingKey(root: string, u: Unit): string {
  return [root, u.file, String(u.start_line), u.name ?? ""].map(encodeURIComponent).join("/");
}

/** List rows for findings (worst first), with file labels shortened to the basename where that is unique. */
export function listItems(
  findings: readonly { root: string; unit: Unit }[],
  o: { selected?: string; fresh?: ReadonlySet<string>; rootName?: (root: string) => string | undefined } = {},
): ListItem[] {
  const files = findings.map(({ root, unit }) => {
    const prefix = o.rootName?.(root);
    return prefix ? `${prefix}/${unit.file}` : unit.file;
  });
  const base = (f: string) => f.slice(f.lastIndexOf("/") + 1);
  const owners = new Map<string, Set<string>>();
  for (const f of files) owners.set(base(f), (owners.get(base(f)) ?? new Set()).add(f));
  return findings.map(({ root, unit }, i) => {
    const key = findingKey(root, unit);
    const file = files[i];
    return {
      key,
      title: issueFor(unit.top_family).title,
      fn: unitName(unit),
      file,
      fileLabel: owners.get(base(file))!.size > 1 ? file : base(file),
      level: severityLabel(unit.severity)[0].toLowerCase() as ListItem["level"],
      fresh: o.fresh?.has(key) ?? false,
      selected: key === o.selected,
    };
  });
}

function plural(n: number, one: string, many = one + "s"): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

const ICON = {
  scan: `<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>`,
  x: `<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`,
  search: `<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>`,
  chevron: `<path d="m9 18 6-6-6-6"/>`,
  check: `<path d="M20 6 9 17l-5-5"/>`,
  eyeOff: `<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>`,
};

// Lucide icons (https://lucide.dev, ISC), as on vaktex.com.
function icon(name: keyof typeof ICON, size = 15, stroke = 2): string {
  return `<svg class="lucide" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
}

function setupSteps(m: ListModel): string {
  const steps = [
    { text: "Extension installed", done: true, extra: "" },
    {
      text: "VAKT installed",
      done: m.setup.binary,
      extra: `<button type="button" class="pill" data-cmd="install">Install VAKT</button>`,
    },
    {
      text: "Set up the model",
      done: m.setup.model,
      extra:
        `<span class="note">Needs Hugging Face access to <code>vaktex/dom-oss-0.8b</code></span>` +
        `<button type="button" class="pill" data-cmd="setup">Set up model</button>`,
    },
    ...(m.setup.signedIn === undefined
      ? []
      : [
          {
            text: "Create a free account",
            done: m.setup.signedIn,
            extra:
              `<span class="note">$30 in value.</span>` +
              `<button type="button" class="pill" data-cmd="signIn">Create account</button>`,
          },
        ]),
    { text: "Scan your workspace", done: false, extra: "" },
  ];
  const current = steps.findIndex((s) => !s.done);
  const ready = current === steps.length - 1;
  return `
<main class="empty">
  <h1>No scan yet</h1>
  <ol class="steps">
    ${steps
      .map((s, i) => {
        const state = s.done ? "done" : i === current ? "current" : "todo";
        return `<li class="step ${state}"${state === "current" ? ` aria-current="step"` : ""}>
          <div class="rail"><span class="marker">${s.done ? icon("check", 12, 3) : i + 1}</span>${i < steps.length - 1 ? `<span class="line"></span>` : ""}</div>
          <div class="step-body"><span class="step-text">${s.text}</span>${state === "current" ? s.extra : ""}</div>
        </li>`;
      })
      .join("")}
  </ol>
  <button type="button" class="wide${ready ? " primary" : ""}" data-cmd="scan">Scan workspace</button>
  ${footer(m, { ignored: false, signIn: m.setup.signedIn === undefined })}
</main>`;
}

/** A finished scan with nothing to show. */
function noFindings(m: ListModel): string {
  return `
<main class="empty clear">
  <section class="clear-head" aria-live="polite">
    ${happyVexie(76)}
    <h1>No findings</h1>
    <p class="lead">Nothing in ${plural(m.stats.units, "function")} across ${plural(m.stats.files, "file")} is at or above your thresholds.</p>
  </section>
  <div class="clear-actions">
    <button type="button" class="wide primary" data-cmd="scan">${icon("scan", 15)}Scan again</button>
    <button type="button" class="wide" data-cmd="settings">Adjust settings</button>
  </div>
  ${footer(m, { ignored: false, signIn: true })}
</main>`;
}

function group(id: string, title: string, rows: ListItem[], sub: (r: ListItem) => [string, string]): string {
  return `
    <div class="group" data-group="${esc(id)}">
      <button type="button" class="group-head" data-toggle="${esc(id)}" aria-expanded="true">
        ${icon("chevron", 14)}<span class="group-title">${esc(title)}</span><span class="count">${rows.length}</span>
      </button>
      <div class="rows" role="group">
        ${rows
          .map((r) => {
            const [line1, line2] = sub(r);
            return `<button type="button" class="row${r.selected ? " selected" : ""}" data-cmd="open" data-key="${esc(r.key)}" data-level="${r.level}"
              data-file="${esc(r.file)}" data-search="${esc(`${r.title} ${r.fn} ${r.file}`.toLowerCase())}"${r.selected ? ` aria-current="true"` : ""}>
              <span class="dot ${r.level}" title="${LEVELS.find((l) => l.id === r.level)!.label}"></span>
              <span class="row-text">
                <span class="row-title"><span class="ellipsis">${esc(line1)}</span>${r.fresh ? `<span class="new">New</span>` : ""}</span>
                <span class="row-sub ellipsis">${esc(line2)}</span>
              </span>
            </button>`;
          })
          .join("")}
      </div>
    </div>`;
}

function grouped(items: ListItem[], keyOf: (r: ListItem) => string): Map<string, ListItem[]> {
  const out = new Map<string, ListItem[]>();
  for (const r of items) out.set(keyOf(r), [...(out.get(keyOf(r)) ?? []), r]);
  return out;
}

function findingsList(m: ListModel): string {
  const byFile = [...grouped(m.items, (r) => r.file)].map(([file, rows]) =>
    group(`f:${file}`, rows[0].fileLabel, rows, (r) => [r.title, r.fn]),
  );
  const byFamily = [...grouped(m.items, (r) => r.title)].map(([title, rows]) =>
    group(`t:${title}`, title, rows, (r) => [r.fn, r.file]),
  );
  const files = new Set(m.items.map((r) => r.file)).size;
  const count = `${plural(m.items.length, "finding")} in ${plural(files, "file")}`;
  const head = m.scanning
    ? `<section class="summary" aria-live="polite">
        <div class="summary-row">
          <div class="summary-text" data-slot="summary">
            <h1>Scanning ${esc(m.scanning)}</h1>
            <span class="sub"><span data-count>${count}</span> so far</span>
          </div>
          <button type="button" class="round" data-cmd="cancel" aria-label="Cancel scan" title="Cancel scan">${icon("x")}</button>
        </div>
        <div class="progress" role="progressbar" aria-label="Scan in progress"><div class="sweep"></div></div>
      </section>`
    : `<section class="summary">
        <div class="summary-row">
          <div class="summary-text" data-slot="summary">
            <h1 data-count>${count}</h1>
            <span class="sub">${plural(m.stats.units, "function")} found in ${plural(m.stats.files, "file")}</span>
          </div>
          <button type="button" class="round" data-cmd="scan" aria-label="Scan workspace" title="Scan workspace">${icon("scan")}</button>
        </div>
      </section>`;
  const chips = LEVELS.map((l) => ({ ...l, n: m.items.filter((r) => r.level === l.id).length }))
    .filter((l) => l.n > 0 || l.id !== "l")
    .map((l) => `<button type="button" class="chip ${l.id}" data-chip="${l.id}" aria-pressed="true">${l.label}<span class="n">${l.n}</span></button>`)
    .join("");
  return `
<main class="list">
  ${head}
  <label class="search">${icon("search", 14)}<input type="search" data-filter aria-label="Filter findings" placeholder="Filter by file, function or family"></label>
  <div class="chips" role="group" aria-label="Severity" data-slot="chips">${chips}</div>
  <div class="tabs" role="tablist" aria-label="Group findings">
    <button type="button" role="tab" data-tab="file" aria-selected="true">By file</button>
    <button type="button" role="tab" data-tab="family" aria-selected="false">By family</button>
  </div>
  <div class="tree" data-view="file" data-slot="file">${byFile.join("")}</div>
  <div class="tree" data-view="family" data-slot="family" hidden>${byFamily.join("")}</div>
  <p class="none" data-slot="none" hidden>${m.items.length ? "No findings match." : m.scanning ? "No findings yet." : "No findings at the current thresholds."}</p>
  ${footer(m, { ignored: true, signIn: true })}
</main>`;
}

/**
 * The footer slot: ignored findings (list page only) and the account line.
 * `signIn: false` drops the signed-out line where the checklist already asks.
 */
function footer(m: ListModel, o: { ignored: boolean; signIn: boolean }): string {
  const rows: string[] = [];
  if (o.ignored && m.ignored) {
    rows.push(`<div class="foot-row">
      <span class="ignored">${icon("eyeOff", 13)}${m.ignored.toLocaleString("en-US")} ignored</span>
      <a href="#" data-cmd="restore">Restore</a>
    </div>`);
  }
  if (m.account && (m.account.signedIn || o.signIn)) {
    const a = accountLine(m.account);
    rows.push(`<div class="foot-row account">
      <span class="account-text"><span class="account-status">${esc(a.status)}</span>${a.usage ? `<span>${esc(a.usage)}</span>` : ""}</span>
      <a href="#" data-cmd="${a.link.cmd}">${a.link.label}</a>
    </div>`);
  }
  return `<div class="slot" data-slot="footer">${rows.length ? `<footer>${rows.join("")}</footer>` : ""}</div>`;
}

/** The page's body. Sent alone (listBody) to update a loaded page in place. */
export function listBody(m: ListModel): string {
  if (isClear(m)) return noFindings(m);
  return m.hasResults || m.scanning ? findingsList(m) : setupSteps(m);
}

/** A finished scan that left nothing to list. */
const isClear = (m: ListModel) => m.hasResults && !m.scanning && m.items.length === 0;

/**
 * Pages of the same shape differ only inside their data-slot elements, so one
 * can be patched into the other; a different shape needs a new page.
 */
export function listShape(m: ListModel): string {
  // Only the footer is a slot: any other change to what it says is a new page (rare: it is static).
  if (isClear(m)) return `clear:${m.stats.units}:${m.stats.files}`;
  if (m.hasResults || m.scanning) return m.scanning ? "scanning" : "list";
  // The checklist's only slot is the footer: each state of the steps is its own page.
  return `setup:${m.setup.binary}:${m.setup.model}:${m.setup.signedIn}`;
}

export function listHtml(m: ListModel, opts: { nonce: string; cspSource: string; fontUri?: string }): string {
  const body = listBody(m);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${opts.cspSource}; style-src ${opts.cspSource} 'nonce-${opts.nonce}'; script-src 'nonce-${opts.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VAKT findings</title>
<style nonce="${opts.nonce}">${opts.fontUri ? fontFace(opts.fontUri) : ""}${THEME_CSS}${CSS}${VEXIE_CSS}</style>
</head>
<body>
${body}
<script nonce="${opts.nonce}">${SCRIPT}</script>
</body>
</html>`;
}

// Runs in the webview. View state (grouping, severity filter, text filter,
// collapsed groups) lives in vscode.getState so it survives a new page.
// Updates arrive as messages and replace only the data-slot elements, so the
// scanning bar, the filter box (and its focus) and scroll positions are left
// alone: replacing the whole page many times a second made it flicker.
const SCRIPT = `
const vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage: (m) => console.log(m), getState: () => undefined, setState: () => {} };
const state = Object.assign({ view: "file", off: [], closed: [], q: "", scroll: {} }, vscode.getState() || {});
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const filter = $("[data-filter]");
if (filter) filter.value = state.q;

function plural(n, one) { return n.toLocaleString("en-US") + " " + (n === 1 ? one : one + "s"); }

function apply() {
  vscode.setState(state);
  if (!$("main.list")) return;
  const q = state.q.trim().toLowerCase();
  for (const tab of $$("[data-tab]")) tab.setAttribute("aria-selected", String(tab.dataset.tab === state.view));
  for (const chip of $$("[data-chip]")) chip.setAttribute("aria-pressed", String(!state.off.includes(chip.dataset.chip)));
  let shown = [];
  for (const tree of $$(".tree")) {
    const active = tree.dataset.view === state.view;
    tree.hidden = !active;
    for (const g of $$(".group", tree)) {
      let n = 0;
      for (const row of $$(".row", g)) {
        const hide = state.off.includes(row.dataset.level) || (q && !row.dataset.search.includes(q));
        row.hidden = hide;
        if (!hide) { n++; if (active) shown.push(row); }
      }
      g.hidden = n === 0;
      const open = !state.closed.includes(g.dataset.group);
      $(".group-head", g).setAttribute("aria-expanded", String(open));
      $(".rows", g).hidden = !open;
    }
  }
  $(".none").hidden = shown.length > 0;
  const files = new Set(shown.map((r) => r.dataset.file)).size;
  for (const el of $$("[data-count]")) el.textContent = plural(shown.length, "finding") + " in " + plural(files, "file");
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-cmd], [data-chip], [data-tab], [data-toggle]");
  if (!el) return;
  e.preventDefault();
  if (el.dataset.cmd) return vscode.postMessage({ cmd: el.dataset.cmd, key: el.dataset.key });
  if (el.dataset.chip) {
    const id = el.dataset.chip;
    state.off = state.off.includes(id) ? state.off.filter((x) => x !== id) : [...state.off, id];
  } else if (el.dataset.tab) {
    state.view = el.dataset.tab;
  } else {
    const id = el.dataset.toggle;
    state.closed = state.closed.includes(id) ? state.closed.filter((x) => x !== id) : [...state.closed, id];
  }
  apply();
});
if (filter) filter.addEventListener("input", () => { state.q = filter.value; apply(); });
window.addEventListener("message", (e) => {
  if (!e.data || e.data.type !== "update" || typeof e.data.body !== "string") return;
  const next = new DOMParser().parseFromString(e.data.body, "text/html");
  for (const slot of $$("[data-slot]")) {
    const fresh = $('[data-slot="' + slot.dataset.slot + '"]', next);
    if (fresh) slot.innerHTML = fresh.innerHTML;
  }
  apply();
});
apply();
vscode.postMessage({ cmd: "ready" });
// A new page (the view was hidden, or its shape changed): put each list back where it was scrolled to.
for (const tree of $$(".tree")) {
  tree.scrollTop = state.scroll[tree.dataset.view] || 0;
  tree.addEventListener("scroll", () => { state.scroll[tree.dataset.view] = tree.scrollTop; vscode.setState(state); }, { passive: true });
}
`;

const CSS = `
* { box-sizing: border-box; }
body {
  margin: 0; padding: 16px 12px 20px;
  font-family: var(--sans); font-size: 13px; line-height: 1.45; letter-spacing: -0.01em;
  color: var(--ink); background: var(--bg);
}
html, body { height: 100%; }
body { overflow: hidden; }
main { display: flex; flex-direction: column; gap: 14px; height: 100%; min-height: 0; }
/* A wrapper only there to be patched: no box, so no gap when empty. */
.slot { display: contents; }
/* Only the findings scroll; the summary, filters and footer stay put. */
main.list > * { flex: none; }
main.list > .tree { flex: 1 1 auto; min-height: 0; overflow-y: auto; margin: 0 -12px; padding: 0 12px 4px; }
main.empty { overflow-y: auto; }
[hidden] { display: none !important; }
a { color: var(--ink); font-weight: 600; }
a:hover { opacity: 0.75; }
button { font: inherit; color: inherit; cursor: pointer; }
/* Fixed-height controls centre one line of text: no inherited line-height. */
.chip, .tabs button, .pill, .wide, .round, .count, .new { line-height: 1; }
a:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
svg.lucide { flex: none; }
.ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
h1 { margin: 0; font-size: 16px; line-height: 1.3; font-weight: 600; letter-spacing: -0.01em; }
code { font-family: var(--mono); font-size: 11.5px; letter-spacing: 0; }

.summary { display: flex; flex-direction: column; gap: 12px; padding: 0 4px; }
.summary-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.summary-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sub { font-size: 12px; line-height: 1.4; color: var(--muted); }
.round { flex: none; width: 32px; height: 32px; padding: 0; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); display: grid; place-items: center; }
.round:hover { background: var(--panel); }
.progress { position: relative; height: 3px; border-radius: 999px; background: var(--panel2); overflow: hidden; }
.sweep { position: absolute; top: 0; bottom: 0; left: 0; width: 40%; border-radius: 999px; background: var(--bar); animation: sweep 1.4s ease-in-out infinite; }
@keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
@media (prefers-reduced-motion: reduce) { .sweep { animation: none; width: 100%; opacity: 0.5; } }

.search { display: flex; align-items: center; gap: 8px; height: 34px; padding: 0 12px; border-radius: 999px; background: var(--panel); color: var(--muted); }
.search input { flex: 1; min-width: 0; height: 100%; margin: 0; padding: 0; border: 0; outline: 0; background: transparent; font: inherit; font-size: 13px; line-height: normal; color: var(--ink); -webkit-appearance: none; appearance: none; }
.search input::-webkit-search-decoration, .search input::-webkit-search-cancel-button { -webkit-appearance: none; }
.search svg { display: block; }
.search input::placeholder { color: inherit; opacity: 0.7; }
.search:focus-within { outline: 2px solid var(--focus); outline-offset: 2px; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; font-size: 12px; font-weight: 600; }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--muted); font-weight: 600; }
.chip .n { font-variant-numeric: tabular-nums; opacity: 0.75; }
.chip[aria-pressed="true"] { border-color: transparent; }
.chip.c[aria-pressed="true"] { background: var(--crit-bg); color: var(--crit); }
.chip.h[aria-pressed="true"] { background: var(--high-bg); color: var(--high); }
.chip.m[aria-pressed="true"] { background: var(--med-bg); color: var(--med); }
.chip.l[aria-pressed="true"] { background: var(--low-bg); color: var(--low); }

.tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 3px; border-radius: 999px; background: var(--panel); font-size: 12.5px; font-weight: 600; }
.tabs button { height: 30px; border: 0; border-radius: 999px; background: transparent; color: var(--muted); font-weight: 600; }
.tabs button[aria-selected="true"] { background: var(--bg); color: var(--ink); box-shadow: 0 1px 2px rgba(20, 20, 19, 0.12); }

.tree { display: flex; flex-direction: column; gap: 6px; }
.none { flex: 1 1 auto; }
.group { display: flex; flex-direction: column; }
.group-head { display: flex; align-items: center; gap: 6px; min-height: 32px; padding: 0 8px 0 4px; border: 0; border-radius: 10px; background: transparent; text-align: left; }
.group-head:hover { background: var(--panel); }
.group-head svg { color: var(--muted); transition: transform 0.15s; }
.group-head[aria-expanded="true"] svg { transform: rotate(90deg); }
.group-title { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.count { flex: none; min-width: 20px; padding: 0 6px; border-radius: 999px; background: var(--panel2); font-size: 11.5px; font-weight: 600; text-align: center; font-variant-numeric: tabular-nums; }
.rows { display: flex; flex-direction: column; gap: 2px; padding-left: 10px; }
.row { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 10px; border: 0; border-radius: 10px; background: transparent; text-align: left; }
.row:hover { background: var(--panel); }
.row.selected { background: var(--panel2); }
.dot { flex: none; width: 8px; height: 8px; border-radius: 999px; }
.dot.c { background: var(--dot-c); } .dot.h { background: var(--dot-h); } .dot.m { background: var(--dot-m); } .dot.l { background: var(--dot-l); }
.row-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.row-title { display: flex; align-items: center; gap: 6px; min-width: 0; font-weight: 500; }
.row-sub { font-size: 12px; color: var(--muted); }
.new { flex: none; padding: 0 6px; border-radius: 999px; background: var(--new-bg); color: var(--new); font-size: 10.5px; font-weight: 700; letter-spacing: 0.02em; }
.none { margin: 8px 4px; color: var(--muted); }

footer { flex: none; margin-top: auto; display: flex; flex-direction: column; gap: 10px; padding: 12px 4px 0; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
.foot-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.foot-row a { flex: none; }
.ignored { display: flex; align-items: center; gap: 6px; }
.account-text { display: flex; flex-direction: column; min-width: 0; text-wrap: pretty; }
.account-status { color: var(--ink); font-weight: 600; }

.empty { gap: 22px; }
.empty h1 { padding: 0 4px; font-size: 18px; letter-spacing: -0.015em; }
.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.step { display: flex; gap: 12px; padding: 0 4px; }
.rail { display: flex; flex-direction: column; align-items: center; flex: none; }
.marker { width: 24px; height: 24px; border-radius: 999px; display: grid; place-items: center; font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums; background: var(--panel2); color: var(--muted); }
.step.done .marker { background: var(--ok-bg); color: var(--ok); }
.step.current .marker { background: var(--primary); color: var(--on-primary); }
.line { flex: 1; width: 1px; min-height: 14px; background: var(--line); }
.step-body { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 2px 0 18px; min-width: 0; }
.step:last-child .step-body { padding-bottom: 0; }
.step-text { font-size: 13.5px; line-height: 20px; font-weight: 500; }
.step.done .step-text { color: var(--muted); }
.step.current .step-text { font-weight: 600; }
.note { font-size: 12px; color: var(--muted); }
.pill { margin-top: 8px; height: 32px; padding: 0 14px; border: 1px solid var(--line); border-radius: 999px; background: var(--bg); font-size: 12.5px; font-weight: 600; }
.pill:hover { background: var(--panel); }
.wide { height: 44px; border: 0; border-radius: 999px; font-size: 14px; font-weight: 600; background: var(--panel2); color: var(--muted); }
.wide.primary { background: var(--primary); color: var(--on-primary); }
.wide:hover { opacity: 0.88; }

/* No findings: centred in the panel, VEXIE, a short lead and two actions. */
main.clear { justify-content: center; gap: 20px; padding: 0 4px; }
/* With a footer, centre the rest in the space above it. */
main.clear > .clear-head { margin-top: auto; }
main.clear > .clear-actions { margin-bottom: auto; }
main.clear footer { margin: 0 -4px; }
.clear-head { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
.clear-head h1 { padding: 0; font-size: 18px; letter-spacing: -0.015em; }
.lead { margin: 0; max-width: 26em; font-size: 13px; line-height: 1.45; color: var(--muted); text-wrap: pretty; }
.clear-actions { display: flex; flex-direction: column; gap: 8px; }
.clear-actions .wide { display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
`;
