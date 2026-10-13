// Sign-in to vaktex.com, the pure part (src/auth.ts does the vscode side).
// No vscode import, so it is unit-testable.
//
// The flow: the extension makes a random `state`, opens
//   <CLOUD_URL>/extension/sign-in?state=<state>&redirect=<scheme>://vaktex.vakt-vscode/auth
// the user clicks Allow, and the browser opens
//   <scheme>://vaktex.vakt-vscode/auth?token=vkx_…&state=<state>
// which the editor hands to our URI handler. A callback is accepted only with a
// state we issued in the last 10 minutes, once.

import { randomBytes } from "node:crypto";

/** Same rules as the server (marketing_site src/lib/server/vakt-cloud/extension-auth.ts). */
export const STATE = /^[A-Za-z0-9_-]{16,128}$/;
export const TOKEN = /^vkx_[A-Za-z0-9_-]{43}$/;
export const REDIRECT = /^(vscode|cursor|vscode-insiders|windsurf|vscodium):\/\/vaktex\.vakt-vscode\/auth$/;
export const PENDING_TTL_MS = 10 * 60_000;
export const AUTH_PATH = "/auth";

/** A fresh client nonce: 32 random bytes, base64url (43 characters). */
export function newState(): string {
  return randomBytes(32).toString("base64url");
}

export function isState(s: unknown): s is string {
  return typeof s === "string" && STATE.test(s);
}

export function isToken(s: unknown): s is string {
  return typeof s === "string" && TOKEN.test(s);
}

/** `<scheme>://vaktex.vakt-vscode/auth`, the URI the editor routes to our handler. */
export function callbackUri(uriScheme: string): string {
  return `${uriScheme}://vaktex.vakt-vscode${AUTH_PATH}`;
}

/** The page on vaktex.com that asks the user to Allow. Null when the redirect is not one the server accepts. */
export function signInUrl(base: string, state: string, redirect: string): string | null {
  if (!isState(state) || !REDIRECT.test(redirect)) return null;
  const q = new URLSearchParams({ state, redirect });
  return `${base.replace(/\/+$/, "")}/extension/sign-in?${q.toString()}`;
}

/** Outstanding sign-in attempts, by state. Each state is accepted once, within PENDING_TTL_MS. */
export class PendingSignIns {
  private readonly pending = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Starts an attempt; returns its state. */
  start(): string {
    this.prune();
    const state = newState();
    this.pending.set(state, this.now() + PENDING_TTL_MS);
    return state;
  }

  /** Consumes the state: true only when it was issued here, not yet used and not expired. */
  take(state: string): boolean {
    this.prune();
    if (!this.pending.has(state)) return false;
    this.pending.delete(state);
    return true;
  }

  get size(): number {
    this.prune();
    return this.pending.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [s, until] of this.pending) if (until <= t) this.pending.delete(s);
  }
}

export type Callback = { ok: true; token: string } | { ok: false; reason: "path" | "state" | "token" };

/**
 * Checks a callback (path and query of the URI the editor handed us) and, when it
 * is ours, consumes its state. The query is never logged: it carries the token.
 */
export function readCallback(path: string, query: string, pending: PendingSignIns): Callback {
  if (path !== AUTH_PATH) return { ok: false, reason: "path" };
  const q = new URLSearchParams(query);
  const state = q.get("state");
  const token = q.get("token");
  if (!isState(state) || !pending.take(state)) return { ok: false, reason: "state" };
  if (!isToken(token)) return { ok: false, reason: "token" };
  return { ok: true, token };
}
