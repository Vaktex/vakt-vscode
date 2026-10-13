import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildGraph, fileId, repoId } from "../src/graph/build";
import { extractFile } from "../src/graph/extract";

const options = { installSalt: "local-secret", workspacePath: "/Acme/work", snapshot: "f91ed640-6a23-44c5-8fc8-5f3914d8476b" };
const inputs = [
  { path: "src/auth.ts", code: 'export function requireAuth() { return true; }' },
  { path: "src/routes/Acme/+server.ts", code: `import { requireAuth } from '../../auth';
// Acme confidential contact person@acme.com
export const GET = () => { requireAuth(); fetch('https://Acme.com/person@acme.com'); return 1; };` },
  { path: "src/hooks.server.ts", code: "export const handle = () => { return 2; };" },
];
test("compiler extracts definitions, import calls, route and hooks; wire is anonymous", () => {
  const built = buildGraph(inputs, options);
  const nodes = built.chunks.flatMap(c => c.nodes);
  const edges = built.chunks.flatMap(c => c.edges);
  assert.equal(nodes.length, 3);
  assert.ok(edges.some(e => e.kind === "call" && e.resolution === "resolved"));
  assert.ok(edges.some(e => e.kind === "import" && e.resolution === "resolved"));
  assert.ok(edges.some(e => e.kind === "route" && e.method === "GET"));
  assert.ok(edges.some(e => e.kind === "guard" && e.target === "sveltekit-hook"));
  assert.ok(edges.some(e => e.kind === "data" && e.target === "http-out"));
  assert.ok(edges.some(e => e.kind === "call" && e.resolution === "unresolved"));
  const json = JSON.stringify(built.chunks) + JSON.stringify([...built.code.values()]);
  assert.doesNotMatch(json, /Acme|confidential|person@|acme\.com/);
  for (const n of nodes) {
    assert.match(n.id, /^[a-f0-9]{32}$/);
    const local = built.code.get(n.id)!;
    assert.equal(n.id, createHash("md5").update(local.code).digest("hex"));
  }
  assert.equal(built.repo, repoId(options.installSalt, options.workspacePath));
  assert.notEqual(fileId("a", "src/auth.ts"), fileId("b", "src/auth.ts"));
  assert.deepEqual(buildGraph([...inputs].reverse(), options).chunks, built.chunks);
});

test("Svelte scripts retain original offsets and unsupported languages report none", () => {
  const source = '<h1>Acme</h1>\n<script lang="ts">\nconst load = () => fetch("/api");\n</script>\n<p>ok</p>';
  const svelte = extractFile("src/App.svelte", source);
  assert.equal(svelte.definitions[0].startLine, 3);
  assert.equal(svelte.definitions[0].code, '() => fetch("/api")');
  assert.equal(svelte.calls[0].line, 3);
  const built = buildGraph([{ path: "Acme.py", code: "def secret(): pass" }], options);
  assert.equal(built.chunks[0].coverage.python.extractor, "none");
  assert.equal(built.chunks[0].coverage.python.functions, 0);
});

test("ambiguous candidates are not guessed and chunk limits hold", () => {
  const built = buildGraph([{ path: "src/a.ts", code: `function first() { return 1; }
function second(value: string) { return value; }
const choose = Math.random() ? first : second;
function run() { choose(); missing(); }` }], { ...options, maxNodes: 1, maxEdges: 1, maxBytes: 1600 });
  for (const c of built.chunks) {
    assert.ok(c.nodes.length <= 1);
    assert.ok(c.edges.length <= 1);
    assert.ok(Buffer.byteLength(JSON.stringify(c)) <= 1600);
    assert.equal(c.chunk.total, built.chunks.length);
  }
  const calls = built.chunks.flatMap(c => c.edges).filter(e => e.kind === "call");
  assert.ok(calls.some(e => e.resolution === "candidate-set" && e.to === null));
  assert.ok(calls.some(e => e.resolution === "unresolved" && e.to === null));
  assert.throws(() => buildGraph([{ path: "../escape.ts", code: "" }], options));
  assert.throws(() => buildGraph(inputs, { ...options, maxBytes: 20 }));
});
