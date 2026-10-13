import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildGraph } from "../src/graph/build";
import { CloudClient } from "../src/cloud";
import { GraphUploader, GraphClient } from "../src/graph/upload";

const build = (count = 2) => buildGraph([{ path: "src/Privatecustomer.ts", code: Array.from({ length: count }, (_, i) => `export function secret${i}() { return ${i}; }`).join("\n") }], { installSalt: "private-salt", workspacePath: "/private/customer/root", snapshot: "f91ed640-6a23-44c5-8fc8-5f3914d8476b" });
function fake(graph = build()) {
  const calls: { route: string; body: unknown }[] = [];
  const client: GraphClient = {
    available: true,
    async graphIngest(body) { calls.push({ route: "ingest", body }); return { snapshot: graph.snapshot, needCode: [...body.nodes.map(n => n.id), "unrequested"] }; },
    async graphCode(body) { calls.push({ route: "code", body }); },
    async graphCommit(body) { calls.push({ route: "commit", body }); },
    async graphStatus(body) { calls.push({ route: "status", body }); return { state: "done", progress: { done: 1, total: 1 } }; },
  };
  return { client, calls, graph };
}
test("graph sends ingest, requested anonymous code, commit, status sequentially and refreshes", async () => {
  const { graph, client, calls } = fake();
  let refreshed = 0;
  assert.equal(await new GraphUploader({ client, enabled: () => true, done: () => { refreshed++; } }).upload(graph), "done");
  assert.deepEqual(calls.map(c => c.route), ["ingest", "code", "commit", "status"]);
  const code = calls[1].body as { items: { md5: string }[] };
  assert.equal(code.items.length, graph.code.size);
  assert.ok(code.items.every(i => graph.code.has(i.md5)));
  assert.doesNotMatch(JSON.stringify(calls), /Privatecustomer|private-salt|private\/customer|unrequested/);
  assert.equal(refreshed, 1);
});
test("only needCode is sent and absent/oversized code is skipped", async () => {
  const { graph, client, calls } = fake();
  client.graphIngest = async body => { calls.push({ route: "ingest", body }); return { snapshot: graph.snapshot, needCode: [body.nodes[0].id] }; };
  const id = graph.chunks[0].nodes[0].id;
  graph.code.set(id, { md5: id, language: "typescript", code: "x".repeat(8001) });
  await new GraphUploader({ client, enabled: () => true }).upload(graph);
  assert.deepEqual(calls.map(c => c.route), ["ingest", "commit", "status"]);
});
test("graph gate is checked between requests and before any upload", async () => {
  const { graph, client, calls } = fake();
  let enabled = false;
  const uploader = new GraphUploader({ client, enabled: () => enabled });
  assert.equal(await uploader.upload(graph), "stopped");
  assert.equal(calls.length, 0);
  enabled = true;
  client.graphIngest = async body => { calls.push({ route: "ingest", body }); enabled = false; return { snapshot: graph.snapshot, needCode: body.nodes.map(n => n.id) }; };
  assert.equal(await uploader.upload(graph), "stopped");
  assert.equal(calls.length, 1);
});
test("backoff and cancellation stop all subsequent graph requests", async () => {
  for (const cancel of [false, true]) {
    const { graph, client, calls } = fake();
    const controller = new AbortController();
    client.graphIngest = async body => { calls.push({ route: "ingest", body }); if (cancel) controller.abort(); else Object.defineProperty(client, "available", { value: false }); return { snapshot: graph.snapshot, needCode: [] }; };
    assert.equal(await new GraphUploader({ client, enabled: () => true }).upload(graph, controller.signal), "stopped");
    assert.equal(calls.length, 1);
  }
});
test("invalid large chunks are rejected before network and polls are bounded", async () => {
  const { graph, client, calls } = fake();
  graph.chunks[0].coverage = { huge: { files: 1, functions: 0, calls: 0, resolved: 0, extractor: "x".repeat(1024 * 1024) } };
  await assert.rejects(new GraphUploader({ client, enabled: () => true }).upload(graph), /Invalid graph chunk/);
  assert.equal(calls.length, 0);
  const next = fake();
  next.client.graphStatus = async body => { next.calls.push({ route: "status", body }); return { state: "queued", progress: { done: 0, total: 1 } }; };
  assert.equal(await new GraphUploader({ client: next.client, enabled: () => true, polls: 3, wait: async () => {} }).upload(next.graph), "pending");
  assert.equal(next.calls.filter(c => c.route === "status").length, 3);
});
test("CloudClient rechecks the local gate after asynchronous auth and combines cancellation", async () => {
  let enabled = true;
  let calls = 0;
  const client = new CloudClient({ version: "test", token: async () => { enabled = false; return undefined; }, fetch: async () => { calls++; return new Response("{}"); } });
  await assert.rejects(client.graphCommit({ snapshot: "test" }, { beforeRequest: () => enabled }));
  assert.equal(calls, 0);
});
test("code uploads never exceed eight batches of eight", async () => {
  // Long numeric constants remain distinct under anonymisation below six digits.
  const { graph, client, calls } = fake(build(100));
  await new GraphUploader({ client, enabled: () => true }).upload(graph);
  const batches = calls.filter(c => c.route === "code").map(c => (c.body as { items: unknown[] }).items);
  assert.equal(batches.length, 8);
  assert.ok(batches.every(b => b.length <= 8));
  assert.equal(batches.flat().length, 64);
});
