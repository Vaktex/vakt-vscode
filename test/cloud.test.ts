import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalCode, CloudClient, CloudError, CloudReview, cloudLanguage, codeMd5, IMPORTANT_PER_HOUR, parseVerdict, ReviewDeps, VerdictCache } from "../src/cloud";
import { MAX_CAP_PAUSE_MS } from "../src/cloud";
import { detailHtml } from "../src/detailHtml";
import { importance, IMPORTANT } from "../src/heuristics";
import { FAMILIES } from "../src/families";
import { Ignores } from "../src/ignores";
import { redact, restore } from "../src/redact";
import { Unit } from "../src/report";
import { ResultStore } from "../src/store";
import { VOCAB_VERSION } from "../src/anonymize";

test("cloud: every outbound code and explanation is anonymous; fix maps stay local", async () => {
  const source = 'function AcmeClient(name) { // Acme confidential comment\n return "eoin@acme.com" + name + "sk-abcdefghijklmnopqrstuvwxyz123456"; }';
  const requests: string[] = [];
  const client = new CloudClient({ version: "test", fetch: (async (_url, init) => {
    const raw = String(init?.body);
    requests.push(raw);
    const body = JSON.parse(raw);
    assert.equal(body.anon, VOCAB_VERSION);
    assert.doesNotMatch(raw, /Acme|confidential|eoin@|acme\.com|abcdefghijklmnopqrstuvwxyz|"names"|"secrets"/);
    return new Response(JSON.stringify({ fixed: true, code: body.code ?? "", summary: "Fixed" }));
  }) as typeof fetch });
  await client.review({ mode: "validate", language: "javascript", functions: [{ id: "1", code: source, local: { flagged: true, severity: 1, top_family: "other", families: {} } }] });
  await client.lookup({ items: [] });
  await client.feedback({ kind: "ignore", scope: "unit", language: "javascript", findings: [{ code: source, shown: { top_family: "other", severity: 1, explanation: "Acme eoin@acme.com" }, families: {} }] });
  const fix = await client.fix({ language: "javascript", code: source, family: "other", explanation: "Acme eoin@acme.com" });
  assert.match(fix.code, /AcmeClient/);
  assert.match(fix.code, /sk-abcdefghijklmnopqrstuvwxyz123456/);
  assert.equal(requests.length, 4);
});

const G = { threshold: 0.95, minConfidence: 0.9 };
const CODE = `def get_user(db, name):\n    return db.execute("SELECT * FROM users WHERE name = '" + name + "'")`;

function unit(over: Partial<Unit> = {}): Unit {
  const families: Record<string, number> = Object.fromEntries(FAMILIES.map((f) => [f, 0.01]));
  families.data_neutralization = 0.9929;
  return {
    file: "src/app.py", language: "Python", kind: "function", name: "get_user",
    start_line: 4, end_line: 8, tokens: 80, severity: 0.9996, families,
    top_family: "data_neutralization", top_family_prob: 0.9929, flagged: true, ...over,
  };
}

type Answer = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

/** A fetch that records requests and answers from a script. */
function fakeFetch(answer: (body: { functions?: { id: string }[] }) => Answer) {
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const a = answer(JSON.parse(String(init.body)));
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: a.headers });
  }) as unknown as typeof fetch;
  return { fn, sent };
}

function setup(answer: (body: { functions?: { id: string }[] }) => Answer, enabled = true) {
  const f = fakeFetch(answer);
  let now = 1_000_000;
  const client = new CloudClient({ version: "0.1.0", base: "http://cloud", fetch: f.fn, now: () => now });
  let changes = 0;
  let done!: () => void;
  const settled = new Promise<void>((r) => (done = r));
  const deps: ReviewDeps = {
    client,
    enabled: () => enabled,
    read: async () => ({ code: CODE, language: "Python" }),
    changed: () => {
      changes++;
      done();
    },
  };
  const review = new CloudReview(deps);
  const store = new ResultStore();
  store.view = (root, u, g) => review.view(root, u, g);
  return { review, store, client, sent: f.sent, settled, changes: () => changes, advance: (ms: number) => (now += ms) };
}

const verdict = (operation: string, families: string[] = []) => (b: { functions?: { id: string }[] }) => ({
  body: { engine: "vakt-cloud/3", results: (b.functions ?? []).map((f) => ({ id: f.id, operation, vulnerable: families.length > 0, families, explanation: "Because." })) },
});

test("cloud: a finding is held back until its verdict, then confirmed", async () => {
  const t = setup(verdict("confirm", ["data_neutralization"]));
  t.store.setFile("/r", "src/app.py", [unit()]);
  assert.equal(t.store.findings(G).length, 0, "pending: hidden");
  t.review.validate(t.store.candidates(G));
  await t.settled;
  const [f] = t.store.findings(G);
  assert.equal(f.unit.cloud?.operation, "confirm");
  assert.equal(f.unit.explanation, "Because.");
});

test("cloud: a rejected finding never shows; a reclassified one shows the cloud's family", async () => {
  const rej = setup(verdict("reject"));
  rej.store.setFile("/r", "src/app.py", [unit()]);
  rej.review.validate(rej.store.candidates(G));
  await rej.settled;
  assert.equal(rej.store.findings(G).length, 0);

  const re = setup(verdict("reclassify", ["web_security", "other"]));
  re.store.setFile("/r", "src/app.py", [unit()]);
  re.review.validate(re.store.candidates(G));
  await re.settled;
  assert.equal(re.store.findings(G)[0].unit.top_family, "web_security");
});

test("cloud: a rescan can add a function DOM-0.8B passed", async () => {
  const t = setup((b) => ({ body: { engine: "m", results: (b.functions ?? []).map((f) => ({ id: f.id, operation: "add", families: ["file_and_path"], explanation: "" })) } }));
  const passed = unit({ severity: 0.2, top_family_prob: 0.3, flagged: false });
  t.store.setFile("/r", "src/app.py", [passed]);
  assert.equal(t.store.findings(G).length, 0);
  await t.review.rescan("/r", t.store.units("/r", "src/app.py"), G);
  const [f] = t.store.findings(G);
  assert.equal(f.unit.top_family, "file_and_path");
  assert.equal(f.unit.cloud?.operation, "add");
  assert.equal(JSON.parse(t.sent[0].body).mode, "rescan");
  assert.equal(JSON.parse(t.sent[0].body).functions[0].local.flagged, false);
});

test("cloud: an outage shows the local finding and pauses further calls", async () => {
  const t = setup(() => new Error("ECONNREFUSED"));
  t.store.setFile("/r", "src/app.py", [unit()]);
  t.review.validate(t.store.candidates(G));
  await t.settled;
  assert.equal(t.store.findings(G).length, 1, "falls back to DOM-0.8B");
  assert.equal(t.client.available, false);
  // While paused, new findings show at once and nothing is sent.
  t.store.setFile("/r", "src/b.py", [unit({ file: "src/b.py" })]);
  t.review.validate(t.store.candidates(G));
  assert.equal(t.store.findings(G).length, 2);
  assert.equal(t.sent.length, 1);
  t.advance(5 * 60_000);
  assert.equal(t.client.available, true);
});

test("cloud: disabled means local results and no requests", () => {
  const t = setup(verdict("reject"), false);
  t.store.setFile("/r", "src/app.py", [unit()]);
  t.review.validate(t.store.candidates(G));
  assert.equal(t.store.findings(G).length, 1);
  assert.equal(t.sent.length, 0);
});

test("cloud: a 429 pauses for Retry-After; a 400 only fails that request", async () => {
  const client = new CloudClient({ version: "0.1.0", base: "http://c", fetch: fakeFetch(() => ({ status: 429, body: { error: "Too many requests." }, headers: { "retry-after": "120" } })).fn, now: () => 0 });
  await assert.rejects(client.fix({ language: "Python", code: CODE, family: "data_neutralization" }), (e: CloudError) => e.status === 429 && /Too many/.test(e.message));
  assert.equal(client.available, false);
  const ok = new CloudClient({ version: "0.1.0", base: "http://c", fetch: fakeFetch(() => ({ status: 400, body: { error: "Invalid" } })).fn });
  await assert.rejects(ok.fix({ language: "Python", code: CODE, family: "x" }));
  assert.equal(ok.available, true);
});

test("cloud: sends only redacted code, language and scores, never the path", async () => {
  const t = setup(verdict("confirm", ["data_neutralization"]));
  t.store.setFile("/r", "src/app.py", [unit()]);
  t.review.validate(t.store.candidates(G));
  await t.settled;
  // First by hash: only MD5s and labels.
  assert.equal(t.sent[0].url, "http://cloud/api/vakt/lookup");
  assert.deepEqual(Object.keys(JSON.parse(t.sent[0].body).items[0]).sort(), ["local", "md5"]);
  assert.ok(!t.sent[0].body.includes("SELECT"), "no code in a lookup");
  const { url, headers, body } = t.sent[1];
  assert.equal(url, "http://cloud/api/vakt/review");
  assert.equal(headers["x-vakt-client"], "vscode/0.1.0");
  assert.ok(!body.includes("app.py") && !body.includes("/r"), "no file or root in the request");
  assert.deepEqual(Object.keys(JSON.parse(body).functions[0]).sort(), ["code", "id", "local"]);
});

test("cloud: a fix is redacted on the way out and restored on the way back", async () => {
  const src = `def f():\n    key = "AKIAABCDEFGHIJKLMNOP"\n    return call(key)`;
  const f = fakeFetch((b) => ({ body: { fixed: true, code: (b as unknown as { code: string }).code.replace(/(\w+\(key)\)/, "$1, timeout=5)"), summary: "Added a timeout." } }));
  const client = new CloudClient({ version: "0.1.0", base: "http://c", fetch: f.fn });
  const fix = await client.fix({ language: "Python", code: src, family: "other" });
  assert.ok(!f.sent[0].body.includes("AKIA"), "the key never leaves");
  assert.equal(fix.code, src.replace("call(key)", "call(key, timeout=5)"));
});

test("redact: numbered placeholders, same value same placeholder", () => {
  const r = redact(`a = "ada@lab.io"; b = "ada@lab.io"; c = "postgres://u:pw@db/x"; d = "ghp_${"x".repeat(36)}"`);
  assert.equal(r.code, `a = "REDACTED_SECRET_3"; b = "REDACTED_SECRET_3"; c = "postgres://REDACTED_SECRET_2@db/x"; d = "REDACTED_SECRET_1"`);
  assert.equal(restore(r.code, r.secrets), `a = "ada@lab.io"; b = "ada@lab.io"; c = "postgres://u:pw@db/x"; d = "ghp_${"x".repeat(36)}"`);
  assert.equal(redact(CODE).code, CODE);
});

test("cloud: verdicts are validated, cached and bounded", () => {
  assert.equal(parseVerdict({ operation: "reclassify", families: [] }, "m"), undefined);
  assert.equal(parseVerdict({ operation: "error" }, "m"), undefined);
  assert.deepEqual(parseVerdict({ operation: "add", families: ["nope", "web_security"], explanation: 3 }, "m"), { operation: "add", families: ["web_security"], explanation: "", engine: "m" });
  let saved: Record<string, unknown> = {};
  const c = new VerdictCache(undefined, (s) => (saved = s), 2);
  const v = { operation: "confirm" as const, families: [], explanation: "", engine: "m" };
  c.set("a", v);
  c.set("b", v);
  c.set("c", v);
  c.flush();
  assert.deepEqual(Object.keys(saved), ["b", "c"]);
  assert.equal(cloudLanguage("C++", "cpp"), "C++");
  assert.equal(cloudLanguage("<x>", "typescriptreact"), "x");
});

test("cloud: an ignored finding is reported as shown, with redacted code", async () => {
  const f = fakeFetch(() => ({ body: { ok: true } }));
  const client = new CloudClient({ version: "0.1.0", base: "http://c", fetch: f.fn });
  const review = new CloudReview({
    client,
    enabled: () => true,
    read: async () => ({ code: `${CODE}\n# owner: ada@lab.io`, language: "Python" }),
    changed: () => {},
    localModel: () => "d11d4db",
  });
  const shown = { ...unit(), top_family: "web_security", explanation: "XSS.", cloud: { operation: "reclassify" as const, engine: "m" } };
  await review.reportFeedback("ignore", "/r", "unit", [shown]);
  const body = JSON.parse(f.sent[0].body);
  assert.equal(f.sent[0].url, "http://c/api/vakt/feedback");
  assert.deepEqual({ kind: body.kind, scope: body.scope, local_model: body.local_model }, { kind: "ignore", scope: "unit", local_model: "d11d4db" });
  assert.deepEqual(body.findings[0].shown, { top_family: "web_security", severity: 0.9996, explanation: "XSS.", cloud_operation: "reclassify" });
  assert.ok(!f.sent[0].body.includes("ada@lab.io") && !f.sent[0].body.includes("app.py"));
  await review.reportFeedback("rescan", "/r", "file", [unit()]);
  assert.deepEqual([JSON.parse(f.sent[1].body).kind, JSON.parse(f.sent[1].body).scope], ["rescan", "file"]);

  // Off: nothing is sent.
  const off = fakeFetch(() => ({ body: {} }));
  await new CloudReview({ client: new CloudClient({ version: "0.1.0", fetch: off.fn }), enabled: () => false, read: async () => ({ code: CODE, language: "Python" }), changed: () => {} }).reportFeedback("ignore", "/r", "unit", [unit()]);
  assert.equal(off.sent.length, 0);
});

test("ignores: onWillIgnore fires once per new ignore, before it is hidden", () => {
  const ig = new Ignores(undefined, () => {});
  const seen: string[] = [];
  ig.onWillIgnore((e) => seen.push(`${e.unit ? "unit" : "file"}:${e.file}:${ig.has(e.root, e.unit ?? unit({ file: e.file }))}`));
  ig.ignoreUnit("/r", unit());
  ig.ignoreUnit("/r", unit());
  ig.ignoreFile("/r", "src/b.py");
  assert.deepEqual(seen, ["unit:src/app.py:false", "file:src/b.py:false"]);
});


/** A server that knows some hashes: answers lookups from `known` and counts reviews. */
function knowingServer(known: Record<string, { advice: string; reason: string; operation?: string; families?: string[] }>, review: (b: { functions?: { id: string }[] }) => Answer = verdict("confirm", ["data_neutralization"])) {
  return (b: { functions?: { id: string }[]; items?: { md5: string }[] }) =>
    b.items
      ? { body: { engine: "m", results: b.items.map((i) => ({ md5: i.md5, explanation: "Known.", ...(known[i.md5] ?? { advice: "review", reason: "unknown" }) })) } }
      : review(b);
}

test("cloud: a known hash is applied without sending code; a stale one shows, then is re-reviewed", async () => {
  const md5 = codeMd5(redact(CODE).code);
  const known = setup(knowingServer({ [md5]: { advice: "apply", reason: "known", operation: "reject", families: [] } }));
  known.store.setFile("/r", "src/app.py", [unit()]);
  known.review.validate(known.store.candidates(G));
  await known.settled;
  assert.equal(known.store.findings(G).length, 0, "rejected by what the cloud already knew");
  assert.deepEqual(known.sent.map((r) => r.url), ["http://cloud/api/vakt/lookup"], "no review, no code sent");

  const stale = setup(knowingServer({ [md5]: { advice: "review", reason: "stale", operation: "reclassify", families: ["web_security"] } }));
  stale.store.setFile("/r", "src/app.py", [unit()]);
  stale.review.validate(stale.store.candidates(G));
  await stale.settled;
  assert.deepEqual(stale.sent.map((r) => r.url.split("/").pop()), ["lookup", "review"]);
  assert.equal(stale.store.findings(G)[0].unit.top_family, "data_neutralization", "the fresh review wins");
});

test("cloud: refresh picks up a changed verdict by hash and never downgrades on failure", async () => {
  let server: Record<string, { advice: string; reason: string; operation?: string; families?: string[] }> = {};
  const t = setup((b) => knowingServer(server)(b));
  t.store.setFile("/r", "src/app.py", [unit()]);
  t.review.validate(t.store.candidates(G));
  await t.settled;
  assert.equal(t.store.findings(G)[0].unit.cloud?.operation, "confirm");
  // Later the server re-reviewed it with a better model: now relabelled.
  server = { [codeMd5(redact(CODE).code)]: { advice: "apply", reason: "known", operation: "reclassify", families: ["web_security"] } };
  t.review.refresh(t.store.candidates(G));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(t.store.findings(G)[0].unit.top_family, "web_security");
});

test("cloud: the sweep checks important functions DOM-0.8B passed, and only those", async () => {
  const added = (b: { functions?: { id: string }[] }) => ({ body: { engine: "m", results: (b.functions ?? []).map((f) => ({ id: f.id, operation: "add", families: ["data_neutralization"], explanation: "Injection." })) } });
  const t = setup(knowingServer({}, added));
  const quiet = unit({ severity: 0.1, top_family_prob: 0.2, flagged: false, file: "src/api/users.py" });
  const ui = unit({ severity: 0.1, top_family_prob: 0.2, flagged: false, file: "src/components/ui/button.ts", name: "render", start_line: 30 });
  t.store.setFile("/r", "src/api/users.py", [quiet]);
  t.store.setFile("/r", "src/components/ui/button.ts", [ui]);
  t.review.sweep(t.store.all(), G);
  assert.equal(t.review.pending, 0, "background checks do not count as busy");
  await new Promise((r) => setTimeout(r, 30));
  const [f] = t.store.findings(G);
  assert.equal(f.unit.file, "src/api/users.py");
  assert.equal(f.unit.cloud?.operation, "add");
  assert.equal(t.store.findings(G).length, 1);
  // Screened once: a second sweep sends nothing new.
  const sent = t.sent.length;
  t.review.sweep(t.store.all(), G);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(t.sent.length, sent);
  assert.ok(IMPORTANT_PER_HOUR > 0);
});

test("heuristics: path and code add up; tests and UI count against", () => {
  assert.ok(importance("src/routes/api/users/+server.ts", CODE).score >= IMPORTANT);
  assert.ok(importance("app/auth/login.py", "def check(password):\n    return bcrypt.verify(password, h)").score >= IMPORTANT);
  assert.ok(importance("src/lib/util.ts", "export const add = (a: number, b: number) => a + b;").score < IMPORTANT);
  assert.ok(importance("tests/api/users.test.ts", CODE).score < importance("src/api/users.ts", CODE).score);
  assert.ok(importance("src/lib/run.ts", "child_process.exec('ls ' + dir)").reasons[0].startsWith("runs commands"));
});

test("cloud: MD5 matches the server's canonical form", () => {
  assert.equal(codeMd5("hello"), "5d41402abc4b2a76b9719d911017c592");
  assert.equal(canonicalCode("a  \r\nb\t\r\n\n"), "a\nb");
  assert.equal(codeMd5("a  \r\nb"), codeMd5("a\nb"));
});

test("cloud: sends the install id, and a Bearer token only when there is one", async () => {
  const f = fakeFetch(() => ({ body: { ok: true } }));
  const install = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  await new CloudClient({ version: "0.1.0", base: "http://c", fetch: f.fn, installId: install }).feedback({ kind: "ignore", scope: "unit", language: "Python", findings: [] });
  assert.equal(f.sent[0].headers["x-vakt-install"], install);
  assert.equal(f.sent[0].headers.authorization, undefined);
  await new CloudClient({ version: "0.1.0", base: "http://c", fetch: f.fn, installId: install, token: async () => "vkx_t" }).feedback({ kind: "ignore", scope: "unit", language: "Python", findings: [] });
  assert.equal(f.sent[1].headers.authorization, "Bearer vkx_t");
  await new CloudClient({ version: "0.1.0", base: "http://c", fetch: f.fn }).feedback({ kind: "ignore", scope: "unit", language: "Python", findings: [] });
  assert.equal(f.sent[2].headers["x-vakt-install"], undefined);
});

test("cloud: a 402 pauses until resetsAt, says so once, and lifts after", async () => {
  let now = Date.parse("2026-10-11T12:00:00Z");
  const capped: { resetsAt: string; signIn: boolean }[] = [];
  const logs: string[] = [];
  const f = fakeFetch(() => ({ status: 402, body: { error: "This month's cloud review limit is reached.", resetsAt: "2026-11-01T00:00:00.000Z", signIn: true }, headers: { "retry-after": "1771200" } }));
  const client = new CloudClient({ version: "0.1.0", base: "http://c", fetch: f.fn, now: () => now, log: (m) => logs.push(m), onCapped: (c) => capped.push(c) });
  await assert.rejects(client.review({ mode: "validate", language: "Python", functions: [] }), (e: CloudError) => e.status === 402);
  assert.equal(client.available, false);
  assert.deepEqual(client.capped, { resetsAt: "2026-11-01T00:00:00.000Z", signIn: true });
  // Paused: no further request reaches the server, and no second message.
  await assert.rejects(client.review({ mode: "validate", language: "Python", functions: [] }));
  assert.equal(f.sent.length, 1);
  assert.equal(capped.length, 1);
  assert.equal(logs.filter((l) => /limit/.test(l)).length, 1);
  now = Date.parse("2026-11-01T00:00:01Z");
  assert.equal(client.available, true);
  assert.equal(client.capped, undefined);
});

test("cloud: a 402 never pauses for more than 31 days", async () => {
  const now = Date.parse("2026-10-11T12:00:00Z");
  const f = fakeFetch(() => ({ status: 402, body: { error: "x", resetsAt: "2030-01-01T00:00:00Z", signIn: false } }));
  const client = new CloudClient({ version: "0.1.0", base: "http://c", fetch: f.fn, now: () => now });
  await assert.rejects(client.lookup({ items: [] }));
  assert.equal(client.capped?.resetsAt, new Date(now + MAX_CAP_PAUSE_MS).toISOString());
  assert.equal(client.capped?.signIn, false);
});

test("cloud: verdicts carry the engine, and no model name reaches the detail panel", async () => {
  const t = setup((b) => ({ body: { engine: "vakt-cloud/3", model: "@cf/zai-org/glm-5.3-flash", results: (b.functions ?? []).map((f) => ({ id: f.id, operation: "confirm", families: ["data_neutralization"], explanation: "Injection." })) } }));
  t.store.setFile("/r", "src/app.py", [unit()]);
  t.review.validate(t.store.all());
  await t.settled;
  await new Promise((r) => setTimeout(r, 10));
  const [f] = t.store.findings(G);
  assert.deepEqual(f.unit.cloud, { operation: "confirm", engine: "vakt-cloud/3" });
  const html = detailHtml({ unit: f.unit, source: [CODE], threshold: 0.95, minConfidence: 0.9, ignored: false, model: undefined }, { nonce: "N", cspSource: "c" });
  assert.match(html, /title="Cloud review"/);
  assert.doesNotMatch(html, /@cf\/|glm|clef|vakt-cloud\//i);
});
