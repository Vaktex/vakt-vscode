import assert from "node:assert/strict";
import { test } from "node:test";
import { callbackUri, isState, isToken, newState, PENDING_TTL_MS, PendingSignIns, readCallback, REDIRECT, signInUrl } from "../src/authFlow";
import { CloudClient, CloudError } from "../src/cloud";

const TOKEN = "vkx_" + "A".repeat(43);

test("newState: url-safe, long enough for the server, never repeats", () => {
  const a = newState();
  assert.ok(isState(a));
  assert.equal(a.length, 43);
  assert.notEqual(newState(), a);
});

test("callbackUri: one per editor scheme, all accepted by the server's pattern", () => {
  for (const s of ["vscode", "cursor", "vscode-insiders", "windsurf", "vscodium"]) {
    assert.ok(REDIRECT.test(callbackUri(s)), s);
  }
  assert.ok(!REDIRECT.test(callbackUri("evil")));
});

test("signInUrl: encodes state and redirect; refuses a redirect the server would refuse", () => {
  const state = "s".repeat(20);
  const url = signInUrl("https://vaktex.com/", state, "cursor://vaktex.vakt-vscode/auth");
  assert.equal(url, `https://vaktex.com/extension/sign-in?state=${state}&redirect=cursor%3A%2F%2Fvaktex.vakt-vscode%2Fauth`);
  const parsed = new URL(url!);
  assert.equal(parsed.searchParams.get("redirect"), "cursor://vaktex.vakt-vscode/auth");
  assert.equal(signInUrl("https://vaktex.com", state, "https://vscode.dev/callback"), null);
  assert.equal(signInUrl("https://vaktex.com", "short", "vscode://vaktex.vakt-vscode/auth"), null);
});

test("readCallback: accepts our state once, with a well-formed token", () => {
  const pending = new PendingSignIns();
  const state = pending.start();
  const q = `token=${TOKEN}&state=${state}`;
  assert.deepEqual(readCallback("/auth", q, pending), { ok: true, token: TOKEN });
  assert.deepEqual(readCallback("/auth", q, pending), { ok: false, reason: "state" }, "replay refused");
});

test("readCallback: refuses other paths, unknown states and bad tokens", () => {
  const pending = new PendingSignIns();
  const state = pending.start();
  assert.deepEqual(readCallback("/other", `token=${TOKEN}&state=${state}`, pending), { ok: false, reason: "path" });
  assert.deepEqual(readCallback("/auth", `token=${TOKEN}&state=${"x".repeat(43)}`, pending), { ok: false, reason: "state" });
  assert.deepEqual(readCallback("/auth", `token=nope&state=${state}`, pending), { ok: false, reason: "token" });
  assert.ok(!isToken("vkx_short"));
});

test("PendingSignIns: a state expires after 10 minutes", () => {
  let now = 1_000;
  const pending = new PendingSignIns(() => now);
  const state = pending.start();
  assert.equal(pending.size, 1);
  now += PENDING_TTL_MS;
  assert.equal(pending.take(state), false);
  assert.equal(pending.size, 0);
});

test("CloudClient: sends the token as Bearer, and reports a 401 for it", async () => {
  const sent: Record<string, string>[] = [];
  let status = 200;
  let unauthorized = 0;
  let token: string | undefined = TOKEN;
  const client = new CloudClient({
    version: "0.1.0",
    base: "http://x",
    token: async () => token,
    onUnauthorized: () => unauthorized++,
    fetch: (async (_url: string, init: RequestInit) => {
      sent.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify(status === 200 ? { results: [] } : { error: "bad token" }), { status });
    }) as typeof fetch,
  });
  await client.lookup({ language: "Python", hashes: [] } as never);
  assert.equal(sent[0].authorization, `Bearer ${TOKEN}`);

  status = 401;
  await assert.rejects(client.lookup({ language: "Python", hashes: [] } as never), CloudError);
  assert.equal(unauthorized, 1);

  token = undefined;
  await assert.rejects(client.lookup({ language: "Python", hashes: [] } as never), CloudError);
  assert.equal(sent[2].authorization, undefined, "no header when signed out");
  assert.equal(unauthorized, 1, "a 401 without a token is not a sign-in problem");
});
