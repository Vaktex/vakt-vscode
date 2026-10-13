import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCOUNT_REFRESH_MS, accountLine, AccountTracker, usd } from "../src/account";
import { Account, CloudClient, CloudError, parseAccount } from "../src/cloud";
import { listBody, listShape, ListModel } from "../src/listHtml";

const TOKEN = "vkx_" + "A".repeat(43);

const BODY = {
  plan: "free",
  emailVerified: true,
  month: { month: "2026-10", spentUsd: 4.12, resetsAt: "2026-11-01T00:00:00.000Z" },
  today: { requests: 212, limit: 1500, resetsAt: "2026-10-14T00:00:00.000Z" },
};
const ACCOUNT = parseAccount(BODY)!;

test("usd: whole dollars bare, cents to two places", () => {
  assert.equal(usd(30), "$30");
  assert.equal(usd(4.12), "$4.12");
  assert.equal(usd(4.1), "$4.10");
  assert.equal(usd(0), "$0");
  assert.equal(usd(1200), "$1,200");
});

test("accountLine: signed out, signed in before and after the usage arrives", () => {
  assert.deepEqual(accountLine({ signedIn: false }), { status: "Not signed in", link: { cmd: "signIn", label: "Sign in" } });
  assert.deepEqual(accountLine({ signedIn: true }), { status: "Signed in", link: { cmd: "signOut", label: "Sign out" } });
  const free = accountLine({ signedIn: true, account: ACCOUNT });
  assert.equal(`${free.status} · ${free.usage}`, "Signed in · Free · $4.12 used this month · 212 of 1,500 today");
  assert.equal(free.link.cmd, "signOut");
  const paid = accountLine({ signedIn: true, account: { ...ACCOUNT, plan: "paid", month: { ...ACCOUNT.month, spentUsd: 61.5 } } });
  assert.equal(`${paid.status} · ${paid.usage}`, "Signed in · Paid · $61.50 used this month · 212 of 1,500 today");
  const unverified = accountLine({ signedIn: true, account: { ...ACCOUNT, emailVerified: false, today: null } });
  assert.equal(unverified.usage, "$4.12 used this month · Verify your email to get the full free account");
});

test("parseAccount: accepts the server's body, refuses anything else", () => {
  assert.deepEqual(ACCOUNT, BODY);
  assert.equal(parseAccount({ ...BODY, today: null })?.today, null);
  assert.equal(parseAccount({ ...BODY, plan: "gold" }), undefined);
  assert.equal(parseAccount({ ...BODY, month: { ...BODY.month, spentUsd: "4" } }), undefined);
  assert.equal(parseAccount({ ...BODY, today: { requests: 1 } }), undefined);
  assert.equal(parseAccount(null), undefined);
  assert.equal(parseAccount({ error: "nope" }), undefined);
});

function client(answer: () => { status: number; body: unknown } | Error, token: string | null = TOKEN) {
  const sent: { url: string; method?: string; headers: Record<string, string> }[] = [];
  let unauthorized = 0;
  const c = new CloudClient({
    version: "0.1.0",
    base: "http://x",
    installId: "install-1",
    token: async () => token ?? undefined,
    onUnauthorized: () => unauthorized++,
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, method: init.method, headers: init.headers as Record<string, string> });
      const a = answer();
      if (a instanceof Error) throw a;
      return new Response(JSON.stringify(a.body), { status: a.status });
    }) as typeof fetch,
  });
  return { c, sent, unauthorized: () => unauthorized };
}

test("CloudClient.account: GET with the usual headers, parsed", async () => {
  const t = client(() => ({ status: 200, body: BODY }));
  assert.deepEqual(await t.c.account(), ACCOUNT);
  assert.equal(t.sent[0].url, "http://x/api/vakt/account");
  assert.equal(t.sent[0].method, "GET");
  assert.equal(t.sent[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(t.sent[0].headers["x-vakt-client"], "vscode/0.1.0");
  assert.equal(t.sent[0].headers["x-vakt-install"], "install-1");
});

test("CloudClient.account: 401 signs out; other failures are quiet and pause nothing", async () => {
  let answer: { status: number; body: unknown } | Error = { status: 401, body: { error: "revoked" } };
  const t = client(() => answer);
  assert.equal(await t.c.account(), undefined);
  assert.equal(t.unauthorized(), 1);
  answer = { status: 500, body: { error: "x" } };
  assert.equal(await t.c.account(), undefined);
  answer = new Error("offline");
  assert.equal(await t.c.account(), undefined);
  answer = { status: 200, body: { plan: "free" } };
  assert.equal(await t.c.account(), undefined);
  assert.equal(t.unauthorized(), 1);
  assert.ok(t.c.available, "review is not paused by the account call");

  const out = client(() => ({ status: 200, body: BODY }), null);
  assert.equal(await out.c.account(), undefined);
  assert.equal(out.sent.length, 0, "signed out: no request");
});

test("CloudClient: a 429 that says sign in is reported once per pause", async () => {
  let now = 1_000_000;
  let body: unknown = { error: "daily limit", signIn: true };
  let limited = 0;
  let responses = 0;
  const c = new CloudClient({
    version: "0.1.0",
    base: "http://x",
    now: () => now,
    onLimited: () => limited++,
    onResponse: () => responses++,
    fetch: (async () => new Response(JSON.stringify(body), { status: 429, headers: { "retry-after": "3600" } })) as unknown as typeof fetch,
  });
  await assert.rejects(c.lookup({ items: [] }), CloudError);
  assert.equal(limited, 1);
  assert.equal(responses, 1);
  await assert.rejects(c.lookup({ items: [] }), CloudError, "paused: no request");
  assert.equal(limited, 1);
  now += 3_600_000;
  await assert.rejects(c.lookup({ items: [] }), CloudError);
  assert.equal(limited, 2, "a new pause asks again");
  now += 3_600_000;
  body = { error: "slow down" };
  await assert.rejects(c.lookup({ items: [] }), CloudError);
  assert.equal(limited, 2, "a plain 429 does not ask");
});

test("AccountTracker: reads now when forced, otherwise at most every 5 minutes; clear drops a late answer", async () => {
  let now = 0;
  let calls = 0;
  let changes = 0;
  let active = true;
  let resolve: ((a: Account | undefined) => void) | undefined;
  const tracker = new AccountTracker({
    fetch: () => {
      calls++;
      return new Promise((r) => (resolve = r));
    },
    active: () => active,
    changed: () => changes++,
    now: () => now,
  });
  const answer = async (a: Account | undefined) => {
    resolve!(a);
    await new Promise((r) => setImmediate(r));
  };
  tracker.refresh(true);
  tracker.refresh(true);
  assert.equal(calls, 1, "one read at a time");
  await answer(ACCOUNT);
  assert.deepEqual(tracker.account, ACCOUNT);
  assert.equal(changes, 1);

  now += ACCOUNT_REFRESH_MS - 1;
  tracker.refresh();
  assert.equal(calls, 1, "throttled");
  now += 1;
  tracker.refresh();
  assert.equal(calls, 2);
  await answer(undefined);
  assert.deepEqual(tracker.account, ACCOUNT, "a failed read keeps what was shown");

  tracker.refresh(true);
  tracker.clear();
  assert.equal(tracker.account, undefined);
  assert.equal(changes, 2);
  await answer(ACCOUNT);
  assert.equal(tracker.account, undefined, "answer for the old sign-in dropped");

  active = false;
  tracker.refresh(true);
  assert.equal(calls, 3, "signed out or fully local: no read");
});

const base = (over: Partial<ListModel> = {}): ListModel => ({
  items: [],
  hasResults: false,
  stats: { units: 0, files: 0 },
  ignored: 0,
  setup: { binary: true, model: true, signedIn: false },
  ...over,
});

test("checklist: the sign-in step sits before the scan, is current when signed out, done when signed in", () => {
  const out = listBody(base());
  assert.match(out, /Set up the model[\s\S]*Create a free account[\s\S]*Scan your workspace/);
  assert.match(out, /step current"[^>]*>[\s\S]*?Create a free account[\s\S]*?\$30 in value\.[\s\S]*?data-cmd="signIn">Create account</);
  assert.doesNotMatch(out, /class="wide primary"/, "not ready to scan yet");

  const done = listBody(base({ setup: { binary: true, model: true, signedIn: true } }));
  assert.match(done, /step done"[^>]*>[\s\S]*?Create a free account/);
  assert.match(done, /step current"[^>]*>[\s\S]*?Scan your workspace/);
  assert.doesNotMatch(done, /\$30 in value/, "the extra shows only on the current step");

  const earlier = listBody(base({ setup: { binary: false, model: false, signedIn: false } }));
  assert.match(earlier, /step todo"[^>]*>[\s\S]*?Create a free account/);
  assert.doesNotMatch(earlier, /data-cmd="signIn"/);
});

test("checklist: no sign-in step when nothing would use the account", () => {
  const off = listBody(base({ setup: { binary: true, model: true } }));
  assert.doesNotMatch(off, /Create a free account/);
  assert.match(off, /step current"[^>]*>[\s\S]*?Scan your workspace/);
  assert.match(off, /class="wide primary" data-cmd="scan"/);
});

test("listShape: signing in or out is a new checklist page", () => {
  const a = listShape(base());
  assert.notEqual(a, listShape(base({ setup: { binary: true, model: true, signedIn: true } })));
  assert.notEqual(a, listShape(base({ setup: { binary: true, model: true } })));
  // The account line alone is a patch of the footer slot.
  assert.equal(listShape(base({ account: { signedIn: true } })), listShape(base({ account: { signedIn: true, account: ACCOUNT } })));
});

test("footer: the account line on every page, with sign in or sign out", () => {
  const signedIn = { signedIn: true, account: ACCOUNT };
  const list = listBody(base({ hasResults: true, items: [], scanning: "repo", account: signedIn, ignored: 2 }));
  assert.match(list, /data-slot="footer"><footer>[\s\S]*2 ignored[\s\S]*Signed in · Free[\s\S]*\$4\.12 used this month · 212 of 1,500 today[\s\S]*data-cmd="signOut">Sign out</);

  const clear = listBody(base({ hasResults: true, stats: { units: 3, files: 1 }, account: { signedIn: false } }));
  assert.match(clear, /No findings[\s\S]*Not signed in[\s\S]*data-cmd="signIn">Sign in</);

  // The checklist already asks to sign in: no second prompt in its footer.
  const setupOut = listBody(base({ account: { signedIn: false } }));
  assert.doesNotMatch(setupOut, /Not signed in/);
  const setupIn = listBody(base({ setup: { binary: true, model: true, signedIn: true }, account: signedIn }));
  assert.match(setupIn, /data-slot="footer"><footer>[\s\S]*Signed in · Free/);

  assert.match(listBody(base({ account: undefined, setup: { binary: true, model: true } })), /data-slot="footer"><\/div>/, "nothing uses the account: no line");
});
