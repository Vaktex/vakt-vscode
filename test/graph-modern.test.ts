import { test } from "node:test";
import * as assert from "node:assert/strict";
import { extractFile, extractFileAsync } from "../src/graph/extract";
import { buildSnapshotAsync } from "../src/graph/build";
const fixtures: Record<string, string> = {
  py: 'import os\ndef caller():\n    helper()\ndef helper():\n    pass\n',
  go: 'package main\nimport "fmt"\nfunc caller() { helper() }\nfunc helper() {}',
  rs: 'use std::io; fn caller() { helper(); } fn helper() {}',
  java: 'import java.util.List; class Demo { void caller() { helper(); } void helper() {} }',
  kt: 'import demo.tool\nfun caller() { helper() }\nfun helper() {}',
  swift: 'import Foundation\nfunc caller() { helper() }\nfunc helper() {}',
  cs: 'using System; class Demo { void caller() { helper(); } void helper() {} }',
  php: '<?php use Demo\\Tool; function caller() { helper(); } function helper() {}',
  rb: 'require "demo"\ndef caller\n helper()\nend\ndef helper\nend',
  dart: 'import "demo.dart"; void caller() { helper(); } void helper() {}',
  c: '#include <stdio.h>\nvoid caller() { helper(); } void helper() {}',
  cpp: '#include <cstdio>\nvoid caller() { helper(); } void helper() {}',
  m: '#include <stdio.h>\nvoid caller() { helper(); } void helper() {}',
  scala: 'import demo.tool\nobject Demo { def caller() = { helper() }; def helper() = {} }',
  ex: 'defmodule Demo do\n alias Demo.Tool\n def caller() do\n helper()\n end\n def helper() do\n :ok\n end\nend',
  sol: 'import "demo.sol"; contract Demo { function caller() public { helper(); } function helper() public {} }',
  sh: 'source demo.sh\ncaller() { helper; }\nhelper() { echo ok; }',
};
for (const [ext, source] of Object.entries(fixtures)) test(`WASM ${ext}: definitions, imports and owned calls`, async () => {
  const f = await extractFileAsync(`demo.${ext}`, source);
  assert.match(f.extractor, /^tree-sitter:/);
  assert.ok(f.definitions.some(d => d.name === "caller"), JSON.stringify(f.definitions.map(d => [d.name, d.code])));
  assert.ok(f.calls.some(c => c.target === "helper" && c.owner?.name === "caller"), JSON.stringify(f.calls.map(c => [c.target, c.owner?.name])));
  assert.ok(f.imports.length, "missing imports");
  for (const d of f.definitions) assert.equal(source.slice(d.start, d.end), d.code);
});
test("Unicode offsets and nested owner are original source code units", async () => {
  const source = '# 😀 é\ns = "def fake(): evil()"\n# def phantom():\ndef outer():\n    def inner():\n        helper()\n    inner()\n';
  const f = await extractFileAsync("u.py", source);
  assert.deepEqual(f.definitions.map(d => d.name), ["outer", "inner"]);
  assert.equal(f.definitions[0].start, source.indexOf("def outer"));
  assert.equal(f.calls.find(c => c.target === "helper")?.owner?.name, "inner");
  assert.equal(f.calls.find(c => c.target === "inner")?.owner?.name, "outer");
});
test("unsupported and synchronous languages truthfully report no extractor", async () => {
  assert.equal((await extractFileAsync("x.unknown", "function fake() {} ")).extractor, "none");
  assert.equal(extractFile("x.py", fixtures.py).extractor, "none");
});
test("modern name matches never become resolved edges", async () => {
  const graph = await buildSnapshotAsync([{ path: "demo.py", code: fixtures.py }], { installSalt: "test", workspacePath: "/test" });
  const calls = graph.chunks.flatMap(c => c.edges).filter(e => e.kind === "call");
  assert.ok(calls.some(c => c.resolution === "candidate-set"));
  assert.ok(calls.every(c => c.to === null && c.resolution !== "resolved"));
  assert.equal(graph.chunks[0].coverage.python.resolved, 0);
});
