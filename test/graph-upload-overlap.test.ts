import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildGraph } from "../src/graph/build";
import { GraphUploader, GraphClient } from "../src/graph/upload";

test("graph uploads do not overlap; zero needCode never sends code", async () => {
  const graph = buildGraph([{ path: "src/a.ts", code: "export function main() { return true; }" }], { installSalt: "test", workspacePath: "/local" });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let ingests = 0;
  let codes = 0;
  const client: GraphClient = {
    available: true,
    async graphIngest() { ingests++; await pending; return { snapshot: graph.snapshot, needCode: [] }; },
    async graphCode() { codes++; },
    async graphCommit() {},
    async graphStatus() { return { state: "done", progress: { done: 1, total: 1 } }; },
  };
  const uploader = new GraphUploader({ client, enabled: () => true });
  const first = uploader.upload(graph);
  assert.equal(await uploader.upload(graph), "stopped");
  release();
  assert.equal(await first, "done");
  assert.equal(ingests, 1);
  assert.equal(codes, 0);
});
