// The Vaktex account line in the sidebar ("Signed in · Free" and this month's
// usage) and when to ask the server for it. No vscode import, so it is
// unit-testable. The HTTP call itself is CloudClient.account() in src/cloud.ts.

import type { Account } from "./cloud";

/** What the sidebar knows about the account. Undefined in ListModel when nothing uses it. */
export interface AccountView {
  signedIn: boolean;
  /** The last usage read from the server, once there is one. */
  account?: Account;
}

export interface AccountLine {
  /** "Signed in · Free" or "Not signed in". */
  status: string;
  /** This month's spend and today's requests, when known. */
  usage?: string;
  link: { cmd: "signIn" | "signOut"; label: string };
}

/** Whole dollars without cents, otherwise two decimals: $5, $4.12, $4.10. */
export function usd(n: number): string {
  return Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function accountLine(v: AccountView): AccountLine {
  if (!v.signedIn) return { status: "Not signed in", link: { cmd: "signIn", label: "Sign in" } };
  const a = v.account;
  const link = { cmd: "signOut", label: "Sign out" } as const;
  if (!a) return { status: "Signed in", link };
  // What was spent, never the allowance: the cap stays on the server.
  const month = `${usd(a.month.spentUsd)} used this month`;
  const today = a.today
    ? `${a.today.requests.toLocaleString("en-US")} of ${a.today.limit.toLocaleString("en-US")} today`
    : "Verify your email to get the full free account";
  return { status: `Signed in · ${a.plan === "paid" ? "Paid" : "Free"}`, usage: `${month} · ${today}`, link };
}

/** Background refreshes (after cloud calls) are at most this often. */
export const ACCOUNT_REFRESH_MS = 5 * 60_000;

/**
 * Keeps the last account usage read from the server. refresh(true) reads it
 * now (activation, sign-in); refresh() at most every ACCOUNT_REFRESH_MS
 * (after cloud calls). A failed read keeps what was shown.
 */
export class AccountTracker {
  account: Account | undefined;
  private last = -Infinity;
  private inflight = false;
  /** Bumped by clear(), so a read started before a sign-out is dropped. */
  private gen = 0;

  constructor(
    private readonly deps: {
      fetch: () => Promise<Account | undefined>;
      /** Signed in and not fully local. */
      active: () => boolean;
      changed: () => void;
      now?: () => number;
    },
  ) {}

  refresh(force = false): void {
    if (!this.deps.active() || this.inflight) return;
    const now = (this.deps.now ?? Date.now)();
    if (!force && now - this.last < ACCOUNT_REFRESH_MS) return;
    this.last = now;
    this.inflight = true;
    const gen = this.gen;
    void this.deps
      .fetch()
      .catch(() => undefined)
      .then((a) => {
        if (gen !== this.gen) return;
        this.inflight = false;
        if (a) {
          this.account = a;
          this.deps.changed();
        }
      });
  }

  /** Signed out or in as someone else: forget the old usage. */
  clear(): void {
    this.gen++;
    this.inflight = false;
    this.last = -Infinity;
    if (!this.account) return;
    this.account = undefined;
    this.deps.changed();
  }
}
