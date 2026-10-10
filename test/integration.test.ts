// Runs the real vakt binary and DOM-0.8B. Skipped unless VAKT_BIN points at
// an installed vakt with the model cached (`vakt summon`).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { runPatrol } from "../src/cli";
import { isFinding } from "../src/report";

const bin = process.env.VAKT_BIN;
const S = { threshold: 0.95, minConfidence: 0.9, precision: "auto", device: "auto", topLevel: false, noRepoIgnores: false };

test("real vakt: single-file scan of a bracketed route path flags the SQL injection", { skip: !bin }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "vakt-it-"));
  mkdirSync(path.join(root, "app", "[id]"), { recursive: true });
  const src = [
    "import sqlite3",
    "from flask import request",
    "",
    "def get_user(db):",
    '    name = request.args.get("name")',
    "    cur = db.cursor()",
    `    cur.execute("SELECT * FROM users WHERE name = '" + name + "'")`,
    "    return cur.fetchall()",
    "",
  ].join("\n");
  writeFileSync(path.join(root, "app", "[id]", "page.py"), src);
  writeFileSync(path.join(root, "other.py"), src);

  const rep = await runPatrol(bin!, root, ["app/[id]/page.py"], S);
  assert.deepEqual([...new Set(rep.units.map((u) => u.file))], ["app/[id]/page.py"], "only the requested file is scanned");
  const u = rep.units.find((x) => x.name === "get_user");
  if (!u) return assert.fail("get_user was not scored");
  assert.equal(u.start_line, 4);
  assert.equal(u.top_family, "data_neutralization");
  assert.ok(isFinding(u, S), `expected a finding, got severity ${u.severity} / ${u.top_family_prob}`);
});
