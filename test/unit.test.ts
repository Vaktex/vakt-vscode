import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { classifyError, escapeGlob, JsonlReader, LiveScorer, modelCached, patrolArgs, resolveBinary, runPatrol, runResults, ScanError, ScanSettings, serveArgs } from "../src/cli";
import { DEFAULT_THRESHOLDS, FAMILIES, rankFamilies } from "../src/families";
import { agentTarget, diagnosticMessage, hasGrammar, reviewPrompt, unitName } from "../src/present";
import { isFinding, isSafeRelPath, parseReport, Report, sanitize, Unit } from "../src/report";
import { Scheduler } from "../src/scheduler";
import { ResultStore } from "../src/store";
import { Ignores, IgnoreState } from "../src/ignores";
import { detailHtml } from "../src/detailHtml";
import { highlightLines } from "../src/highlight";
import { findingKey, listHtml, listItems } from "../src/listHtml";

const S: ScanSettings = { threshold: 0.95, minConfidence: 0.9, precision: "auto", device: "auto", topLevel: false, noRepoIgnores: false };

function unit(over: Partial<Unit> = {}): Unit {
  const families: Record<string, number> = Object.fromEntries(FAMILIES.map((f) => [f, 0.01]));
  families.data_neutralization = 0.9929;
  return {
    file: "app.py", language: "Python", kind: "function", name: "get_user",
    start_line: 4, end_line: 8, tokens: 80, severity: 0.9996, families,
    top_family: "data_neutralization", top_family_prob: 0.9929, flagged: true, ...over,
  };
}

function report(units: Unit[]): Report {
  return {
    schema_version: "1",
    tool: { name: "Vaktex OSS", binary: "vakt", version: "v0.2.2", commit: "x" },
    model: { repo: "vaktex/dom-oss-0.8b", revision: "d11d4db", sha256: "a1", backend: "metal", device: "gpu", precision: "fp16" },
    scan: { root: "/r", started_at: "", duration_ms: 1, files: 1, units: units.length, tokens: 1, tokens_per_sec: 1, cache_hits: 0, skipped: null },
    units,
    summary: { threshold: 0.95, flagged_units: 0, flagged_files: 0 },
  };
}

// ---- families: must agree with internal/labels

test("top family routes on cut-off ratio, not raw probability", () => {
  // 0.30 'other' (cut-off 0.077) clears its cut-off by more than 0.60 'access_control' (0.307).
  const r = rankFamilies({ access_control: 0.6, other: 0.3 }, 2);
  assert.equal(r[0].family, "other");
  assert.equal(r[1].family, "access_control");
  assert.equal(FAMILIES.length, 18);
  assert.equal(Object.keys(DEFAULT_THRESHOLDS).length, 18);
});

// ---- report validation (repo-controlled input)

test("parseReport accepts a real v1 report", () => {
  const r = parseReport(JSON.stringify(report([unit()])));
  assert.equal(r.units[0].name, "get_user");
});

test("parseReport rejects other schemas, bad paths, scores and families", () => {
  assert.throws(() => parseReport("not json"), /did not return JSON/);
  assert.throws(() => parseReport(JSON.stringify({ units: [] })), /schema_version missing/);
  assert.throws(() => parseReport(JSON.stringify({ ...report([]), schema_version: "2" })), /unsupported/);
  for (const file of ["../etc/passwd", "/etc/passwd", "a/../../b", "C:/x", "a\\b", "a//b"]) {
    assert.throws(() => parseReport(JSON.stringify(report([unit({ file })]))), /unsafe file path/, file);
  }
  assert.throws(() => parseReport(JSON.stringify(report([unit({ severity: 1.5 })]))), /outside/);
  assert.throws(() => parseReport(JSON.stringify(report([unit({ start_line: 0 })]))), /line span/);
  assert.throws(() => parseReport(JSON.stringify(report([unit({ top_family: "evil" })]))), /top_family/);
});

test("safe paths and sanitising", () => {
  assert.ok(isSafeRelPath("src/deep/[id]/page.tsx"));
  assert.ok(!isSafeRelPath(""));
  assert.equal(sanitize("ok\u202Eevil\u001b[31m"), "okevil[31m");
});

test("isFinding applies both gates like report.ApplyConfidence", () => {
  assert.ok(isFinding(unit(), { threshold: 0.95, minConfidence: 0.9 }));
  assert.ok(!isFinding(unit({ top_family_prob: 0.5 }), { threshold: 0.95, minConfidence: 0.9 }));
  assert.ok(isFinding(unit({ top_family_prob: 0.5 }), { threshold: 0.95, minConfidence: 0 }));
  assert.ok(!isFinding(unit({ severity: 0.9 }), { threshold: 0.95, minConfidence: 0 }));
});

// ---- CLI arguments

test("escapeGlob makes bracketed route paths literal", () => {
  assert.equal(escapeGlob("src/app/[id]/page.tsx"), "src/app/\\[id\\]/page.tsx");
  assert.equal(escapeGlob("a/{x,y}/*.ts?"), "a/\\{x,y\\}/\\*.ts\\?");
});

test("patrolArgs", () => {
  const a = patrolArgs("/r", ["a.py", "b/[c].py"], { ...S, topLevel: true, noRepoIgnores: true });
  assert.deepEqual(a.slice(0, 7), ["patrol", "/r", "--format", "jsonl", "--out", "-", "--save-results"]);
  assert.deepEqual(patrolArgs("/r", [], S, "json").slice(0, 6), ["patrol", "/r", "--format", "json", "--out", "-"]);
  assert.ok(!patrolArgs("/r", [], S, "json").includes("--save-results"), "an old vakt has no --save-results");
  assert.ok(a.includes("--no-repo-ignores") && a.includes("--top-level"));
  assert.deepEqual(a.slice(-4), ["--include", "a.py", "--include", "b/\\[c\\].py"]);
  assert.ok(!patrolArgs("/r", [], S).includes("--include"));
});

test("classifyError maps vakt's real stderr", () => {
  assert.equal(classifyError("vakt: not signed in to Hugging Face (model repo is gated or private: ...)", 2).kind, "auth");
  assert.equal(classifyError("vakt: model not found: nope/nope@main (check ...)", 2).kind, "not-found");
  assert.equal(classifyError("vakt: engine: native backend unavailable", 2).kind, "no-engine");
  assert.equal(classifyError("vakt: --threshold must be in (0, 1]", 2).kind, "usage");
  assert.equal(classifyError("", 2).message, "vakt exited with status 2");
});

// ---- running a (fake) binary

function fakeVakt(script: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vakt-fake-"));
  const bin = path.join(dir, "vakt");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("runPatrol: exit 1 (findings) still yields the report, on a vakt without jsonl", async () => {
  const json = JSON.stringify(report([unit()]));
  // An older vakt: rejects --format jsonl, so the extension falls back to json.
  const bin = fakeVakt(`case "$*" in *jsonl*) echo "vakt: --format must be pretty, json or both (got \"jsonl\")" >&2; exit 2;; esac\ncat <<'EOF'\n${json}\nEOF\nexit 1`);
  const r = await runPatrol(bin, tmpdir(), [], S);
  assert.equal(r.units.length, 1);
});

test("runPatrol streams units from --format jsonl, then returns the report", async () => {
  const u = unit();
  const lines = [
    { type: "start", schema_version: "1" },
    { type: "unit", unit: u },
    { type: "progress", units: 1, units_scored: 1 },
    { type: "report", report: report([u]) },
  ].map((l) => JSON.stringify(l)).join("\n");
  const bin = fakeVakt(`case "$*" in *"--format jsonl"*"--save-results"*) ;; *) exit 2;; esac\ncat <<'EOF'\n${lines}\nEOF\nexit 1`);
  const seen: string[] = [];
  const r = await runPatrol(bin, tmpdir(), [], S, { onUnit: (x) => seen.push(x.name!) });
  assert.deepEqual(seen, ["get_user"]);
  assert.equal(r.units.length, 1);
});

test("JsonlReader rejects unsafe streamed units and a missing report", () => {
  const rd = new JsonlReader();
  assert.throws(() => rd.push(JSON.stringify({ type: "unit", unit: unit({ file: "../etc/passwd" }) }) + "\n"), /unsafe file path/);
  const r2 = new JsonlReader();
  r2.push('{"type":"start"}\n{"type":"unit","unit":' + JSON.stringify(unit()) + "}");
  assert.throws(() => r2.end(), /without a report/);
});

test("runResults reads vakt results, and tolerates a vakt without the command", async () => {
  const json = JSON.stringify(report([unit()]));
  const ok = fakeVakt(`[ "$1" = results ] || exit 2\ncat <<'EOF'\n${json}\nEOF`);
  assert.equal((await runResults(ok, tmpdir(), S))?.units.length, 1);
  const old = fakeVakt(`echo 'Error: unknown command "results" for "vakt"' >&2; exit 2`);
  assert.equal(await runResults(old, tmpdir(), S), undefined);
});

test("LiveScorer talks to vakt serve: results, superseded and errors", async () => {
  // A fake serve in Node: answers each request by its id; id 2 is "superseded", id 3 an error.
  const js = path.join(mkdtempSync(path.join(tmpdir(), "vakt-serve-")), "serve.js");
  writeFileSync(
    js,
    `const u = ${JSON.stringify(unit())};
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
if (process.argv[2] !== "serve") process.exit(2);
out({ type: "start", schema_version: "1" });
require("node:readline").createInterface({ input: process.stdin }).on("line", (l) => {
  const { id } = JSON.parse(l);
  if (id === 2) out({ id, type: "superseded" });
  else if (id === 3) out({ id, type: "error", message: "model not cached; run vakt summon first" });
  else out({ id, type: "result", file: "app.py", units: [u] });
});`,
  );
  const bin = fakeVakt(`exec "${process.execPath}" "${js}" "$@"`);
  const live = new LiveScorer(bin, serveArgs(S));
  try {
    assert.equal((await live.score("/r", "app.py", "def get_user(): pass"))?.length, 1);
    assert.equal(await live.score("/r", "app.py", "x"), undefined);
    await assert.rejects(live.score("/r", "app.py"), /not cached/);
  } finally {
    live.stop();
  }
  const old = new LiveScorer(fakeVakt(`echo 'Error: unknown command "serve" for "vakt"' >&2; exit 2`), ["serve"]);
  await assert.rejects(old.score("/r", "a.py", "x"));
  assert.equal(old.supported, false);
});

test("modelCached looks in vakt's own cache", () => {
  const cache = mkdtempSync(path.join(tmpdir(), "vakt-cache-"));
  assert.equal(modelCached({ VAKT_CACHE: cache }), false);
  const snap = path.join(cache, "hub", "models--vaktex--dom-oss-0.8b", "snapshots", "d11d4db");
  mkdirSync(snap, { recursive: true });
  writeFileSync(path.join(snap, "model.safetensors"), "");
  assert.equal(modelCached({ VAKT_CACHE: cache }), true);
});

test("runPatrol: exit 2 becomes a classified ScanError", async () => {
  const bin = fakeVakt(`echo "vakt: not signed in to Hugging Face (x)" >&2; exit 2`);
  await assert.rejects(runPatrol(bin, tmpdir(), [], S), (e: ScanError) => e.kind === "auth");
});

test("runPatrol: abort interrupts a running scan", async () => {
  const bin = fakeVakt(`trap 'exit 130' INT; sleep 10 & wait`);
  const ctrl = new AbortController();
  const p = runPatrol(bin, tmpdir(), [], S, { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 100);
  const t0 = Date.now();
  await assert.rejects(p, (e: ScanError) => e.kind === "cancelled");
  assert.ok(Date.now() - t0 < 5000);
});

test("resolveBinary honours an explicit path and rejects a missing one", () => {
  const bin = fakeVakt("exit 0");
  assert.equal(resolveBinary(bin), bin);
  assert.equal(resolveBinary("/nonexistent/vakt"), undefined);
  assert.equal(resolveBinary("", { PATH: path.dirname(bin) }) !== undefined, true);
});

// ---- store

test("store: a file rescan replaces only that file; empty result clears it", () => {
  const s = new ResultStore();
  const g = { threshold: 0.95, minConfidence: 0.9 };
  s.apply("/r", report([unit(), unit({ file: "b.py" })]));
  assert.equal(s.findings(g).length, 2);
  s.apply("/r", report([]), ["app.py"]); // fixed
  assert.deepEqual(s.findings(g).map((f) => f.unit.file), ["b.py"]);
  s.apply("/r", report([unit({ file: "c.py" })])); // full scan replaces everything
  assert.deepEqual(s.findings(g).map((f) => f.unit.file), ["c.py"]);
});

// ---- scheduler

test("scheduler runs one scan at a time and coalesces saves", async () => {
  const runs: string[] = [];
  let release!: () => void;
  const s = new Scheduler(async (job) => {
    runs.push(job.files ? job.files.join(",") : "*");
    if (runs.length === 1) await new Promise<void>((r) => (release = r));
  }, 0);
  s.enqueue({ root: "/r", files: ["a"] }, true);
  await new Promise((r) => setTimeout(r, 10));
  s.enqueue({ root: "/r", files: ["b"] });
  s.enqueue({ root: "/r", files: ["c"] });
  s.enqueue({ root: "/r", files: ["b"] });
  release();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(runs, ["a", "b,c"]);
  assert.equal(s.busy, false);
});

test("scheduler: a whole-root scan absorbs pending file scans", async () => {
  const runs: string[] = [];
  const s = new Scheduler(async (job) => void runs.push(job.files ? job.files.join(",") : "*"), 5);
  s.enqueue({ root: "/r", files: ["a"] });
  s.enqueue({ root: "/r" });
  s.enqueue({ root: "/r", files: ["b"] });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(runs, ["*"]);
});

// ---- ignores + detail panel

test("ignores survive line shifts and hide findings from the store", () => {
  let saved: unknown;
  const ig = new Ignores(undefined, (s) => (saved = s));
  const s = new ResultStore();
  s.hide = (root, u) => ig.has(root, u);
  const g = { threshold: 0.95, minConfidence: 0.9 };
  s.apply("/r", report([unit(), unit({ file: "b.py" })]));
  ig.ignoreUnit("/r", unit());
  assert.deepEqual(s.findings(g).map((f) => f.unit.file), ["b.py"]);
  assert.ok(ig.has("/r", unit({ start_line: 40, end_line: 44 })), "keyed by name, not line");
  ig.ignoreFile("/r", "b.py");
  assert.equal(s.findings(g).length, 0);
  const restored = new Ignores(saved as IgnoreState, () => {});
  assert.ok(restored.has("/r", unit({ file: "b.py", name: "other" })));
  assert.ok(!restored.has("/other-root", unit()));
});

test("detail panel escapes repo-controlled strings and locks down the CSP", () => {
  const evil = unit({ name: `<img src=x onerror=alert(1)>`, file: `a/"><script>x</script>.py` });
  const html = detailHtml(
    { unit: evil, source: [`</td><script>alert(2)</script>`], threshold: 0.95, minConfidence: 0.9, ignored: false, model: undefined },
    { nonce: "N0NCE", cspSource: "vscode-resource:" },
  );
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<script>alert(2)"));
  assert.ok(!html.includes("<script>x</script>"));
  assert.equal((html.match(/<script/g) ?? []).length, 1, "only our nonce'd script");
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-N0NCE'/);
  assert.match(html, /SQL injection/);
  assert.match(html, /CWE-89/);
  assert.match(html, /constructs all or part of an SQL command/, "CWE description");
  assert.match(html, /data-cmd="review"[^>]*>Resolve</);
  assert.match(html, />Critical</, "severity tag carries the level only");
});

test("detail panel shows two family bars and folds the rest", () => {
  const families: Record<string, number> = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
  Object.assign(families, { data_neutralization: 0.96, serialization_and_parsing: 0.35, data_processing: 0.07, web_security: 0.05 });
  const html = detailHtml(
    { unit: unit({ families, top_family_prob: 0.96 }), source: ["x"], findingIndex: 0, findingCount: 2, threshold: 0.95, minConfidence: 0.9, ignored: true, model: undefined },
    { nonce: "N", cspSource: "c" },
  );
  assert.equal((html.match(/class="fam[ "]/g) ?? []).length, 4, "two shown, two folded, all with bars");
  assert.match(html, /#fam3 \.fill\{width:5\.0%\}/);
  assert.match(html, /2 more families scored above 0\.01/);
  assert.match(html, /1 of 2/);
  assert.match(html, /data-cmd="ignoreUnit"[^>]*disabled/);
  assert.ok(!/\sstyle="/.test(html), "the CSP drops inline style attributes");
  assert.match(html, /#fam0 \.fill\{width:96\.0%\}/);
  const withFont = detailHtml({ unit: unit(), source: [], threshold: 0.95, minConfidence: 0.9, ignored: false, model: undefined }, { nonce: "N", cspSource: "c", fontUri: "c/f.woff2" });
  assert.match(withFont, /font-src c;/);
  assert.match(withFont, /@font-face\{font-family:"Vaktex Sans";src:url\("c\/f\.woff2"\)/);
});

// ---- presentation

test("unnamed units are named by their line", () => {
  assert.equal(unitName(unit({ name: undefined, kind: "file", start_line: 1 })), "Line 1");
  assert.equal(unitName(unit({ name: "", kind: "residual", start_line: 12 })), "Line 12");
  assert.equal(unitName(unit()), "get_user");
});

test("presentation strings", () => {
  assert.equal(diagnosticMessage(unit()), "SQL injection (CWE-89): Untrusted input may reach a SQL query without being escaped or parameterised.");
  assert.ok(!/severity|confidence|CRITICAL|\d\.\d/.test(diagnosticMessage(unit())), "no scores in the message");
  assert.equal(diagnosticMessage(unit({ explanation: "q flows into\u202E execute" })), "SQL injection (CWE-89): q flows into execute");
  assert.ok(reviewPrompt(unit(), "a ``` b", "python").includes("~~~~python"));
  assert.ok(hasGrammar("src/x.tsx") && !hasGrammar("README.md") && !hasGrammar("Makefile"));
});

test("highlighting escapes source and keeps each line self-contained", () => {
  const lines = highlightLines(['s = """a', '</td><script>x</script>', 'b"""', "def f(): return 1"], "python")!;
  assert.equal(lines.length, 4);
  assert.ok(!lines.join("").includes("<script>"), "source is escaped");
  for (const l of lines) assert.equal((l.match(/<span /g) ?? []).length, (l.match(/<\/span>/g) ?? []).length, l);
  assert.match(lines[1], /^<span class="hljs-string">/, "multi-line string reopens on the next line");
  assert.match(lines[3], /hljs-keyword/);
  assert.equal(highlightLines(["x"], "plaintext"), undefined);
  assert.ok(highlightLines(["const a = 1"], "typescriptreact"));
  const html = detailHtml(
    { unit: unit(), source: ["<img src=x>", "def f(): pass"], languageId: "python", threshold: 0.95, minConfidence: 0.9, ignored: false, model: undefined },
    { nonce: "N", cspSource: "c" },
  );
  assert.ok(!html.includes("<img src=x>"));
  assert.match(html, /hljs-keyword/);
  assert.ok(!/\sstyle="/.test(html));
});

test("findings list escapes repo text, disambiguates files and marks state", () => {
  const evil = unit({ name: `<img src=x>`, file: "a/app.py" });
  const items = listItems(
    [{ root: "/r", unit: evil }, { root: "/r", unit: unit({ file: "b/app.py", start_line: 9 }) }, { root: "/r", unit: unit({ file: "c/solo.py", severity: 0.75 }) }],
    { selected: findingKey("/r", evil), fresh: new Set([findingKey("/r", evil)]) },
  );
  assert.deepEqual(items.map((i) => i.fileLabel), ["a/app.py", "b/app.py", "solo.py"], "basename only when unique");
  assert.deepEqual(items.map((i) => i.level), ["c", "c", "h"]);
  const html = listHtml(
    { items, hasResults: true, stats: { units: 212, files: 37 }, ignored: 1, setup: { binary: true, model: true } },
    { nonce: "N", cspSource: "c" },
  );
  assert.ok(!html.includes("<img src=x>"));
  assert.ok(!/\sstyle="/.test(html), "the CSP drops inline style attributes");
  assert.equal((html.match(/<script/g) ?? []).length, 1);
  assert.match(html, /3 findings in 3 files/);
  assert.match(html, /212 functions found in 37 files/);
  assert.match(html, /class="new">New</);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /data-cmd="restore"/);
  const scanning = listHtml({ items: [], hasResults: false, scanning: "repo", stats: { units: 0, files: 0 }, ignored: 0, setup: { binary: true, model: true } }, { nonce: "N", cspSource: "c" });
  assert.match(scanning, /Scanning repo/);
  assert.match(scanning, /data-cmd="cancel"/);
});

test("setup checklist puts the first unfinished step first", () => {
  const html = (setup: { binary: boolean; model: boolean }) =>
    listHtml({ items: [], hasResults: false, stats: { units: 0, files: 0 }, ignored: 0, setup }, { nonce: "N", cspSource: "c" });
  assert.match(html({ binary: false, model: false }), /step current"[^>]*>[\s\S]*?VAKT installed[\s\S]*?data-cmd="install"/);
  assert.match(html({ binary: true, model: false }), /step current"[^>]*>[\s\S]*?Set up the model[\s\S]*?data-cmd="setup"/);
  const ready = html({ binary: true, model: true });
  assert.match(ready, /step current"[^>]*>[\s\S]*?Scan your workspace/);
  assert.match(ready, /class="wide primary" data-cmd="scan"/);
});

test("row ids survive the HTML attribute, so clicks find their finding", () => {
  const u = unit({ name: `a"b<c>&`, file: "src/x y.ts" });
  const key = findingKey("/Users/me/my repo", u);
  assert.ok(!/[\u0000-\u001f"<>&]/.test(key), "no control or markup characters in the id");
  const html = listHtml(
    { items: listItems([{ root: "/Users/me/my repo", unit: u }]), hasResults: true, stats: { units: 1, files: 1 }, ignored: 0, setup: { binary: true, model: true } },
    { nonce: "N", cspSource: "c" },
  );
  assert.ok(html.includes(`data-key="${key}"`));
  assert.notEqual(findingKey("/r", unit({ start_line: 4 })), findingKey("/r", unit({ start_line: 40 })));
});

test("Resolve picks the editor's agent, else the clipboard", () => {
  const chat = ["workbench.action.chat.open", "other"];
  assert.equal(agentTarget("Cursor", chat), "cursor");
  assert.equal(agentTarget("Visual Studio Code", chat), "vscode-agent");
  assert.equal(agentTarget("Visual Studio Code", ["other"]), "clipboard");
  const p = reviewPrompt(unit(), "def get_user(name): ...", "python");
  assert.match(p, /fix it in place/);
  assert.match(p, /change nothing/);
  assert.match(p, /File: app\.py, lines 4-8/);
});
