// Cloud review: a second opinion from a large model on what DOM-0.8B found,
// and fixes for editors with no coding agent. No vscode import, so it is
// unit-testable.
//
// Everything here is optional. "Improved cloud responses" (on by default) and
// "Fully local" (off by default) decide whether anything is sent at all, and
// any failure (offline, refused, slow, rate-limited) falls back to DOM-0.8B's
// own result: the cloud can only remove, relabel or add findings, never block
// the local scan.
//
// What is sent: one function's source at a time, redacted (src/redact.ts),
// with its language and DOM-0.8B's scores. Never a path, file or repository name.

import { createHash } from "node:crypto";
import { Family, isFamily } from "./families";
import { importance, Importance, IMPORTANT } from "./heuristics";
import { redact, restore } from "./redact";
import { anonymizeCode, restoreNames, VOCAB_VERSION } from "./anonymize";
import { Gates, isFinding, Unit } from "./report";
import type { Ingest, LocalCode } from "./graph/types";
import type { GraphControl, GraphStatus } from "./graph/upload";

/** VAKT_CLOUD_URL points the extension at a local server (`bun run dev` in marketing_site). */
export const CLOUD_URL = (process.env.VAKT_CLOUD_URL || "https://vaktex.com").replace(/\/+$/, "");

/** Same limits as the server (marketing_site src/lib/server/vakt-cloud/input.ts). */
export const MAX_FUNCTION_CHARS = 8_000;
export const MIN_FUNCTION_CHARS = 16;
export const BATCH = 8;
/** A rescan reviews at most this many functions of a file, highest scores first. */
export const RESCAN_MAX = 40;
const REQUEST_TIMEOUT_MS = 60_000;
const ACCOUNT_TIMEOUT_MS = 10_000;
/** A 402 pauses until the cap resets (the 1st of next month UTC), never longer than this. */
export const MAX_CAP_PAUSE_MS = 31 * 86_400_000;

/** Paused at today's request limit (429), which signing in to a verified account raises. */
export interface Limited {
  resetsAt: string;
}

/** The signed-in account's plan and usage (GET /api/vakt/account). */
export interface Account {
  plan: "free" | "paid";
  emailVerified: boolean;
  month: { month: string; spentUsd: number; resetsAt: string };
  /** Null until the account's email is verified. */
  today: { requests: number; limit: number; resetsAt: string } | null;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const str = (v: unknown): v is string => typeof v === "string" && v.length <= 64;

/** The account endpoint's body, or undefined when it is not one. */
export function parseAccount(j: unknown): Account | undefined {
  const a = j as { plan?: unknown; emailVerified?: unknown; month?: Record<string, unknown> | null; today?: Record<string, unknown> | null } | null;
  if (!a || (a.plan !== "free" && a.plan !== "paid") || typeof a.emailVerified !== "boolean") return undefined;
  const m = a.month;
  if (!m || !str(m.month) || !num(m.spentUsd) || !str(m.resetsAt)) return undefined;
  const t = a.today;
  if (t !== null && (!t || !num(t.requests) || !num(t.limit) || !str(t.resetsAt))) return undefined;
  return {
    plan: a.plan,
    emailVerified: a.emailVerified,
    month: { month: m.month, spentUsd: m.spentUsd, resetsAt: m.resetsAt },
    today: t && { requests: t.requests as number, limit: t.limit as number, resetsAt: t.resetsAt as string },
  };
}

/** Paused at this month's cloud spend cap. */
export interface Capped {
  resetsAt: string;
  /** Signing in to vaktex.com raises the cap. */
  signIn: boolean;
}

export type Operation = "confirm" | "reject" | "reclassify" | "add" | "agree";

export interface CloudVerdict {
  operation: Operation;
  /** Most likely first; empty when the cloud model says it is not vulnerable. */
  families: Family[];
  explanation: string;
  /** Opaque cloud engine version (e.g. `vakt-cloud/3`). The server never names its models. */
  engine: string;
}

export interface CloudFix {
  fixed: boolean;
  code: string;
  summary: string;
}

export class CloudError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** How long to stop calling after a refusal, by status. 0: only this request failed. */
/** A pause longer than this is a limit, not an outage: local results show meanwhile. */
export const LONG_PAUSE_MS = 3_600_000;

function backoffMs(status: number, retryAfter: string | null): number {
  const after = Number(retryAfter);
  const told = Number.isFinite(after) && after > 0 ? Math.min(after, 86_400) * 1000 : 0;
  if (status === 0) return 5 * 60_000; // offline or timed out
  if (status === 403) return 24 * 3_600_000; // blocked
  if (status === 429 || status === 503) return told || 60_000;
  if (status >= 500 && status !== 502) return 60_000;
  return 0;
}

/**
 * Talks to /api/vakt/review and /api/vakt/fix. Every refusal pauses all calls
 * for as long as the server asks (or a sensible default), so a rate-limited or
 * blocked client stops at once instead of collecting strikes.
 */
export class CloudClient {
  private blockedUntil = 0;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly opts: {
      version: string;
      base?: string;
      fetch?: typeof fetch;
      now?: () => number;
      log?: (m: string) => void;
      /** The vaktex.com sign-in token (src/auth.ts), sent as `Authorization: Bearer`. Never logged. */
      token?: () => Promise<string | undefined>;
      /** Called when the server refused a token we sent (401): it is revoked or expired. */
      onUnauthorized?: () => void;
      /** Random UUID created once per install (globalState `vakt.installId`), sent as `x-vakt-install`. */
      installId?: string;
      /** This month's spend cap was reached (402). Called once per pause, not per request. */
      onCapped?: (capped: Capped) => void;
      /** Today's limit was reached (429) and signing in raises it. Called once per pause, not per request. */
      onLimited?: (limited: Limited) => void;
      /** The server answered a review, lookup, fix or graph call (any status). */
      onResponse?: () => void;
    },
  ) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** False while backing off after a refusal or an outage. */
  get available(): boolean {
    return this.now() >= this.blockedUntil;
  }

  /** Paused for longer than a blip (this month's or today's limit, blocked): the cloud will not answer soon. */
  get stopped(): boolean {
    return this.blockedUntil - this.now() > LONG_PAUSE_MS;
  }

  private cappedAt: Capped | undefined;
  /** Set while paused at this month's spend cap (402): when it resets, and whether signing in raises it. */
  get capped(): Capped | undefined {
    if (this.cappedAt && this.available) this.cappedAt = undefined;
    return this.cappedAt;
  }

  /** A 402: stop until the cap resets (at most MAX_CAP_PAUSE_MS), and say so once. */
  private cap(body: { resetsAt?: unknown; signIn?: unknown }): void {
    const resets = typeof body.resetsAt === "string" ? Date.parse(body.resetsAt) : NaN;
    const until = Math.min(Number.isFinite(resets) ? resets : this.now() + 86_400_000, this.now() + MAX_CAP_PAUSE_MS);
    const first = !this.capped;
    this.blockedUntil = Math.max(this.blockedUntil, until);
    this.cappedAt = { resetsAt: new Date(this.blockedUntil).toISOString(), signIn: body.signIn === true };
    if (!first) return;
    this.opts.log?.(`cloud review reached this month's limit; paused until ${this.cappedAt.resetsAt}`);
    this.opts.onCapped?.(this.cappedAt);
  }

  /** Until when the last 429 that asked to sign in was reported: one prompt per pause. */
  private limitedUntil = 0;

  /** A 429 that says signing in raises the limit: say so once per pause. */
  private limit(): void {
    if (this.now() < this.limitedUntil) return;
    this.limitedUntil = Math.max(this.blockedUntil, this.now() + 60_000);
    this.opts.onLimited?.({ resetsAt: new Date(this.blockedUntil).toISOString() });
  }

  private headers(token: string | undefined): Record<string, string> {
    return {
      "x-vakt-client": `vscode/${this.opts.version}`,
      ...(this.opts.installId ? { "x-vakt-install": this.opts.installId } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  /**
   * The signed-in account's plan and usage, or undefined when signed out or it
   * could not be read. A 401 means the token is gone (onUnauthorized); anything
   * else is ignored quietly and does not pause cloud review.
   */
  async account(): Promise<Account | undefined> {
    const token = await this.opts.token?.().catch(() => undefined);
    if (!token) return undefined;
    try {
      const res = await this.fetch(`${this.opts.base ?? CLOUD_URL}/api/vakt/account`, {
        method: "GET",
        headers: this.headers(token),
        signal: AbortSignal.timeout(ACCOUNT_TIMEOUT_MS),
      });
      if (res.status === 401) this.opts.onUnauthorized?.();
      if (!res.ok) return undefined;
      return parseAccount(await res.json());
    } catch {
      return undefined;
    }
  }

  private async post<T>(path: string, body: unknown, control?: GraphControl): Promise<T> {
    if (!this.available) throw new CloudError(429, "cloud review is paused after an earlier refusal");
    let res: Response;
    const token = await this.opts.token?.().catch(() => undefined);
    // Recheck after asynchronous token retrieval, immediately before the actual network call.
    if (control?.signal?.aborted || (control?.beforeRequest && !control.beforeRequest()) || !this.available) throw new CloudError(0, "cloud request cancelled");
    try {
      res = await this.fetch(`${this.opts.base ?? CLOUD_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.headers(token) },
        body: JSON.stringify(body),
        signal: control?.signal ? AbortSignal.any([control.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      this.pause(0, null);
      throw new CloudError(0, `cloud review unreachable: ${(e as Error).message}`);
    }
    this.opts.onResponse?.();
    if (!res.ok) {
      if (res.status === 401 && token) this.opts.onUnauthorized?.();
      this.pause(res.status, res.headers.get("retry-after"));
      let message = `HTTP ${res.status}`;
      let j: { error?: unknown; resetsAt?: unknown; signIn?: unknown } = {};
      try {
        j = (await res.json()) as typeof j;
        if (typeof j.error === "string") message = `${j.error.slice(0, 200)} (HTTP ${res.status})`;
      } catch {
        // not JSON
      }
      if (res.status === 402) this.cap(j);
      if (res.status === 429 && j.signIn === true) this.limit();
      throw new CloudError(res.status, message);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new CloudError(res.status, "cloud review sent a response that is not JSON");
    }
  }

  private pause(status: number, retryAfter: string | null): void {
    const ms = backoffMs(status, retryAfter);
    if (!ms) return;
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
    this.opts.log?.(`cloud review paused for ${Math.round(ms / 1000)} s (status ${status || "offline"})`);
  }

  graphIngest(body: Ingest, control?: GraphControl): Promise<{ snapshot: string; needCode: string[] }> {
    return this.post("/api/vakt/graph/ingest", body, control);
  }

  graphCode(body: { snapshot: string; items: LocalCode[] }, control?: GraphControl): Promise<{ stored: number }> {
    return this.post("/api/vakt/graph/code", body, control);
  }

  graphCommit(body: { snapshot: string }, control?: GraphControl): Promise<{ state: "queued" }> {
    return this.post("/api/vakt/graph/commit", body, control);
  }

  graphStatus(body: { snapshot: string }, control?: GraphControl): Promise<GraphStatus> {
    return this.post("/api/vakt/graph/status", body, control);
  }

  review(body: ReviewRequest): Promise<ReviewResponse> {
    return this.post("/api/vakt/review", { ...body, anon: VOCAB_VERSION, functions: body.functions.map(fn => ({ ...fn, code: anonymizeCode(fn.code, body.language).code })) });
  }

  /** What the cloud knows about these functions, by hash alone (no code is sent). */
  lookup(body: LookupRequest): Promise<LookupResponse> {
    return this.post("/api/vakt/lookup", { ...body, anon: VOCAB_VERSION });
  }

  feedback(body: FeedbackRequest): Promise<unknown> {
    return this.post("/api/vakt/feedback", { ...body, anon: VOCAB_VERSION, findings: body.findings.map(f => ({ ...f, code: anonymizeCode(f.code, body.language).code, shown: { ...f.shown, explanation: f.shown.explanation === undefined ? undefined : anonymizeCode(f.shown.explanation, "text").code } })) });
  }

  /** A fix for one function. The code is redacted on the way out and restored on the way back. */
  async fix(input: { language: string; code: string; family: string; explanation?: string }): Promise<CloudFix> {
    const redacted = redact(input.code);
    const { code, names } = anonymizeCode(redacted.code, input.language);
    const r = await this.post<Partial<CloudFix>>("/api/vakt/fix", { ...input, anon: VOCAB_VERSION, code, explanation: input.explanation === undefined ? undefined : anonymizeCode(input.explanation, "text").code, family: isFamily(input.family) ? input.family : "other" });
    if (typeof r.fixed !== "boolean" || typeof r.code !== "string" || typeof r.summary !== "string") {
      throw new CloudError(200, "cloud review sent an unexpected fix");
    }
    return { fixed: r.fixed, code: restore(restoreNames(r.code, names), redacted.secrets), summary: r.summary };
  }
}

export interface ReviewRequest {
  anon?: number;
  mode: "validate" | "important" | "rescan";
  language: string;
  local_model?: string;
  functions: { id: string; code: string; local: { flagged: boolean; severity: number; top_family: string; families: Record<string, number> } }[];
}

/** The user ignored findings, or rescanned their file: what they were shown, and the code (redacted). */
export interface FeedbackRequest {
  anon?: number;
  kind: "ignore" | "rescan";
  scope: "unit" | "file";
  language: string;
  local_model?: string;
  findings: {
    code: string;
    shown: { top_family: string; severity: number; explanation?: string; cloud_operation?: "confirm" | "reclassify" | "add" };
    families: Record<string, number>;
  }[];
}

export interface LookupRequest {
  anon?: number;
  items: { md5: string; local: { flagged: boolean; severity: number; top_family: string } }[];
}

interface LookupResponse {
  engine?: string;
  results?: { md5?: unknown; advice?: unknown; reason?: unknown; operation?: unknown; families?: unknown; explanation?: unknown }[];
}

interface ReviewResponse {
  engine?: string;
  results?: { id?: unknown; operation?: unknown; families?: unknown; explanation?: unknown }[];
}

const OPERATIONS: readonly string[] = ["confirm", "reject", "reclassify", "add", "agree"];

/** One result from the server, or undefined when it is an error or malformed. */
export function parseVerdict(r: { operation?: unknown; families?: unknown; explanation?: unknown }, engine: string): CloudVerdict | undefined {
  if (typeof r.operation !== "string" || !OPERATIONS.includes(r.operation)) return undefined;
  const families = Array.isArray(r.families) ? r.families.filter((f): f is Family => typeof f === "string" && isFamily(f)).slice(0, 3) : [];
  const operation = r.operation as Operation;
  // A relabel or an addition with no family to show is not usable.
  if ((operation === "reclassify" || operation === "add") && !families.length) return undefined;
  return { operation, families, explanation: typeof r.explanation === "string" ? r.explanation.slice(0, 400) : "", engine: engine.slice(0, 40) };
}

/** A unit as the cloud verdict says to show it. */
export function applyVerdict(u: Unit, v: CloudVerdict): Unit {
  const relabel = v.operation === "reclassify" || v.operation === "add";
  return {
    ...u,
    top_family: relabel ? v.families[0] : u.top_family,
    explanation: v.explanation || u.explanation,
    cloud: { operation: v.operation as "confirm" | "reclassify" | "add", engine: v.engine },
  };
}

export interface Source {
  code: string;
  language: string;
}

export interface ReviewDeps {
  client: CloudClient;
  /** Improved cloud responses on and Fully local off. */
  enabled: () => boolean;
  /** The unit's source, as it is now. */
  read: (root: string, u: Unit) => Promise<Source | undefined>;
  /** Verdicts changed: re-render. */
  changed: () => void;
  /** Verdicts by content hash, kept between sessions so unchanged code is never sent twice. */
  cache?: { get(hash: string): CloudVerdict | undefined; set(hash: string, v: CloudVerdict): void };
  localModel?: (root: string) => string | undefined;
  log?: (m: string) => void;
}

/**
 * `disputed`: a rescan rejected a finding the cloud had shown; it stays shown
 * until a second rescan rejects it too.
 */
type Done = { sig: string; state: "done"; verdict: CloudVerdict; disputed?: boolean };

/**
 * `quiet`: a background check (an important function DOM-0.8B passed); not shown as busy.
 * `prev`: the verdict a rescan is asking again about, shown until a new one arrives.
 */
type Entry =
  | { sig: string; state: "pending"; quiet?: boolean; prev?: Done }
  /** `until`: when to ask again; never, for code the cloud cannot take (too long, unreadable). */
  | { sig: string; state: "failed"; until: number; prev?: Done }
  | Done;

/** The verdict to show for an entry: its own, or the one a rescan is still asking again about. */
const shownVerdict = (e: Entry | undefined, sig: string): Done | undefined =>
  e?.sig !== sig ? undefined : e.state === "done" ? e : e.prev;

/**
 * validate   DOM-0.8B's findings, held back until checked
 * rescan     every function of a file the user rescanned; always the model
 * important  functions DOM-0.8B passed that heuristics.ts rates as security-relevant
 * refresh    findings already checked: anything new about them, by hash?
 */
type Mode = "validate" | "rescan" | "important" | "refresh";

interface Task {
  mode: Mode;
  root: string;
  units: { unit: Unit; flagged: boolean }[];
}

/** How long a finding the cloud could not answer for waits before it is asked about again. */
export const RETRY_MS = 2 * 60_000;

/** Background reviews (mode important) per hour, on top of the server's own quotas. */
export const IMPORTANT_PER_HOUR = 40;

const unitKey = (root: string, u: Unit) => JSON.stringify([root, u.file, u.start_line, u.name ?? ""]);
/** Changes whenever the unit is re-scored differently, i.e. its code changed. */
const unitSig = (u: Unit) => `${u.end_line}:${u.severity}:${u.top_family}:${u.top_family_prob}`;

export function contentHash(src: Source, flagged: boolean, topFamily: string): string {
  return createHash("sha256").update(JSON.stringify([src.language, flagged, topFamily, src.code])).digest("hex");
}

/** Same as the server (marketing_site src/lib/server/vakt-cloud/hash.ts): change both together. */
export function canonicalCode(code: string): string {
  return code.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

/** The MD5 the cloud knows a function by: of its redacted code, made canonical. Never the code itself. */
export function codeMd5(redactedCode: string): string {
  return createHash("md5").update(canonicalCode(redactedCode), "utf8").digest("hex");
}

interface Item {
  unit: Unit;
  flagged: boolean;
  src: Source;
  /** Redacted: what is sent, and what codeMd5 is over. */
  code: string;
  md5: string;
  hash: string;
  score?: number;
}

/**
 * Decides, per unit, what the editor shows once the cloud has had its say.
 *
 * A local finding is shown only once the cloud has confirmed it, so a finding
 * the cloud rejects never appears. While the cloud cannot answer (offline, an
 * error, a short pause) findings stay held back and are asked about again; code
 * it can never take (too long) stays held back too. held() counts them. With
 * cloud review off (or Fully local), or stopped for hours at a limit, the local
 * findings show as they always did.
 *
 * The cloud is asked by hash first (/api/vakt/lookup): a function anyone has
 * had reviewed comes back without sending code, and one reviewed by an older
 * model, or dismissed by several users since, is reviewed again. refresh()
 * asks again about what is already shown, so improvements arrive by themselves.
 */
export class CloudReview {
  private readonly entries = new Map<string, Entry>();
  /** Findings on screen: drained first. */
  private readonly urgent: Task[] = [];
  /** Important-function sweeps and refreshes. */
  private readonly background: Task[] = [];
  private draining = false;
  /** Units the sweep has scored, by key and sig, so it does not read them again. */
  private readonly screened = new Set<string>();
  private readonly importantSpent: number[] = [];

  constructor(private readonly deps: ReviewDeps & { importance?: (path: string, code: string) => Importance; now?: () => number }) {}

  /** Findings waiting on a verdict (background checks not counted). */
  get pending(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.state === "pending" && !e.quiet) n++;
    return n;
  }

  /** Local findings with no verdict yet: queued, waiting on the cloud, or code it cannot take. */
  held(findings: readonly { root: string; unit: Unit }[]): number {
    if (!this.deps.enabled() || this.deps.client.stopped) return 0;
    let n = 0;
    for (const { root, unit } of findings) if (!shownVerdict(this.entries.get(unitKey(root, unit)), unitSig(unit))) n++;
    return n;
  }

  /** The unit to show for `u`, or undefined to show nothing. */
  view(root: string, u: Unit, g: Gates): Unit | undefined {
    const local = isFinding(u, g);
    if (!this.deps.enabled()) return local ? u : undefined;
    // No verdict (not reviewed yet, pending, or the cloud could not answer): held back.
    // A rescan in flight, or one the cloud could not answer, keeps the verdict it asked again about.
    const e = shownVerdict(this.entries.get(unitKey(root, u)), unitSig(u));
    if (!e) return local && this.deps.client.stopped ? u : undefined;
    const v = e.verdict;
    switch (v.operation) {
      case "reject":
        return undefined;
      case "add":
        return applyVerdict(u, v);
      case "confirm":
      case "reclassify":
        return local ? applyVerdict(u, v) : undefined;
      default:
        return local ? u : undefined;
    }
  }

  /**
   * Queue DOM-0.8B's findings that have no current verdict, and those the cloud
   * could not answer for a while ago. Call whenever results change, and now and then.
   */
  validate(findings: readonly { root: string; unit: Unit }[]): void {
    if (!this.deps.enabled() || !this.deps.client.available) return;
    const tasks = this.byFile(
      "validate",
      findings.filter(({ root, unit }) => {
        const e = this.entries.get(unitKey(root, unit));
        if (e && e.sig === unitSig(unit) && !(e.state === "failed" && e.until <= this.now())) return false;
        this.entries.set(unitKey(root, unit), { sig: unitSig(unit), state: "pending", prev: shownVerdict(e, unitSig(unit)) });
        return true;
      }),
      () => true,
    );
    for (const t of tasks) this.enqueue(t, true);
  }

  /**
   * Functions DOM-0.8B passed: score each once from its path and code
   * (heuristics.ts) and have the cloud check the important ones, just in case.
   * Anything it finds appears as a finding ("Found by cloud").
   */
  sweep(units: readonly { root: string; unit: Unit }[], g: Gates): void {
    if (!this.deps.enabled() || !this.deps.client.available) return;
    const fresh = units.filter(({ root, unit }) => {
      if (isFinding(unit, g)) return false;
      const key = unitKey(root, unit) + unitSig(unit);
      if (this.screened.has(key) || this.entries.get(unitKey(root, unit))?.sig === unitSig(unit)) return false;
      this.screened.add(key);
      return true;
    });
    for (const t of this.byFile("important", fresh, () => false)) this.enqueue(t, false);
  }

  /** Ask again, by hash, about verdicts already given: picks up a better model or the crowd's ignores. */
  refresh(findings: readonly { root: string; unit: Unit }[]): void {
    if (!this.deps.enabled() || !this.deps.client.available) return;
    const done = findings.filter(({ root, unit }) => {
      const e = this.entries.get(unitKey(root, unit));
      return e?.state === "done" && e.sig === unitSig(unit);
    });
    for (const t of this.byFile("refresh", done, () => true)) this.enqueue(t, false);
  }

  /**
   * Review every function of a file the user asked to rescan, flagged or not,
   * highest scores first. Resolves when the verdicts are in.
   */
  rescan(root: string, units: readonly Unit[], g: Gates): Promise<void> {
    if (!this.deps.enabled() || !units.length) return Promise.resolve();
    const picked = [...units].sort((a, b) => b.severity - a.severity).slice(0, RESCAN_MAX);
    for (const unit of picked) {
      const k = unitKey(root, unit);
      this.entries.set(k, { sig: unitSig(unit), state: "pending", prev: shownVerdict(this.entries.get(k), unitSig(unit)) });
    }
    this.deps.changed();
    return new Promise((resolve) => this.enqueue({ mode: "rescan", root, units: picked.map((unit) => ({ unit, flagged: isFinding(unit, g) })) }, true, resolve));
  }

  /**
   * Tell the cloud the user ignored these findings, or rescanned the file they
   * were showing in, as they were shown and with their code. Best effort:
   * never retried, failures only logged.
   */
  async reportFeedback(kind: FeedbackRequest["kind"], root: string, scope: "unit" | "file", shown: readonly Unit[]): Promise<void> {
    if (!this.deps.enabled() || !this.deps.client.available || !shown.length) return;
    const byLanguage = new Map<string, FeedbackRequest["findings"]>();
    for (const u of shown.slice(0, BATCH)) {
      const src = await this.deps.read(root, u).catch(() => undefined);
      if (!src || src.code.length < MIN_FUNCTION_CHARS || src.code.length > MAX_FUNCTION_CHARS) continue;
      const list = byLanguage.get(src.language) ?? [];
      list.push({
        code: anonymizeCode(src.code, src.language).code,
        shown: {
          top_family: u.top_family,
          severity: u.severity,
          explanation: u.explanation ? u.explanation.slice(0, 600) : undefined,
          cloud_operation: u.cloud?.operation,
        },
        families: u.families,
      });
      byLanguage.set(src.language, list);
    }
    for (const [language, findings] of byLanguage) {
      try {
        await this.deps.client.feedback({ kind, scope, language, local_model: this.deps.localModel?.(root), findings });
      } catch (e) {
        this.deps.log?.(`cloud feedback: ${(e as Error).message}`);
      }
    }
  }

  /** Forget every verdict (results cleared). The persistent cache is kept. */
  clear(root?: string): void {
    if (root === undefined) this.entries.clear();
    else for (const k of [...this.entries.keys()]) if ((JSON.parse(k) as string[])[0] === root) this.entries.delete(k);
  }

  private byFile(mode: Mode, units: readonly { root: string; unit: Unit }[], flagged: (u: Unit) => boolean): Task[] {
    const tasks = new Map<string, Task>();
    for (const { root, unit } of units) {
      const k = JSON.stringify([root, unit.file]);
      let t = tasks.get(k);
      if (!t) tasks.set(k, (t = { mode, root, units: [] }));
      t.units.push({ unit, flagged: flagged(unit) });
    }
    return [...tasks.values()];
  }

  private readonly done = new Map<Task, () => void>();

  private enqueue(t: Task, urgent: boolean, onDone?: () => void): void {
    if (onDone) this.done.set(t, onDone);
    (urgent ? this.urgent : this.background).push(t);
    if (!this.draining) void this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      // One request at a time, findings on screen first: gentle on the server's rate limit.
      for (let t = this.urgent.shift() ?? this.background.shift(); t; t = this.urgent.shift() ?? this.background.shift()) {
        try {
          await this.run(t);
        } catch (e) {
          this.deps.log?.(`cloud review: ${(e as Error).message}`);
        } finally {
          this.done.get(t)?.();
          this.done.delete(t);
          this.deps.changed();
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /** Settle a unit's entry, unless it was re-scored (and re-queued) in the meantime. */
  private settle(root: string, u: Unit, entry: Entry): void {
    const key = unitKey(root, u);
    if (this.entries.get(key)?.sig === entry.sig) this.entries.set(key, entry);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Whether another background review fits in this hour's budget (and spends it). */
  private spendImportant(): boolean {
    const hourAgo = this.now() - 3_600_000;
    while (this.importantSpent.length && this.importantSpent[0] < hourAgo) this.importantSpent.shift();
    if (this.importantSpent.length >= IMPORTANT_PER_HOUR) return false;
    this.importantSpent.push(this.now());
    return true;
  }

  private async run(t: Task): Promise<void> {
    // A refresh never downgrades what is shown: if the cloud cannot answer, the old verdict stays.
    const prevOf = (u: Unit) => shownVerdict(this.entries.get(unitKey(t.root, u)), unitSig(u));
    const fail = (u: Unit, until = this.now() + RETRY_MS) =>
      t.mode !== "refresh" && this.settle(t.root, u, { sig: unitSig(u), state: "failed", until, prev: prevOf(u) });
    const doneWith = (u: Unit, verdict: CloudVerdict) => {
      const prev = prevOf(u);
      // One reject does not take away a finding the cloud showed: a rescan marks it disputed,
      // only a second rescan removes it, and nothing else (a refresh, say) removes it meanwhile.
      if (verdict.operation === "reject" && prev && prev.verdict.operation !== "reject" && (t.mode !== "rescan" ? prev.disputed : !prev.disputed)) {
        if (t.mode === "rescan") this.deps.log?.(`cloud review: rescan disputes ${u.name ?? `line ${u.start_line}`} in ${u.file}; kept until a second rescan agrees`);
        this.settle(t.root, u, { ...prev, sig: unitSig(u), disputed: true });
        return;
      }
      this.settle(t.root, u, { sig: unitSig(u), state: "done", verdict });
    };

    let items: Item[] = [];
    for (const { unit, flagged } of t.units) {
      const src = await this.deps.read(t.root, unit).catch(() => undefined);
      if (!src || src.code.length < MIN_FUNCTION_CHARS || src.code.length > MAX_FUNCTION_CHARS) {
        fail(unit, Infinity);
        continue;
      }
      if (!this.deps.enabled()) {
        fail(unit);
        continue;
      }
      let score: number | undefined;
      if (t.mode === "important") {
        const imp = (this.deps.importance ?? importance)(unit.file, src.code);
        if (imp.score < IMPORTANT) continue;
        score = imp.score;
        this.deps.log?.(`cloud review: checking ${unit.name ?? `line ${unit.start_line}`} in ${unit.file} just in case (${imp.reasons.slice(0, 3).join(", ")})`);
        this.entries.set(unitKey(t.root, unit), { sig: unitSig(unit), state: "pending", quiet: true });
      }
      const code = anonymizeCode(src.code, src.language).code;
      items.push({ unit, flagged, src, code, md5: codeMd5(code), hash: contentHash(src, flagged, unit.top_family), score });
    }
    if (t.mode === "important") items.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    // 1. By hash: what does the cloud already know? (A rescan always asks the model.)
    let toReview = items;
    if (t.mode !== "rescan" && items.length) {
      try {
        const res = await this.deps.client.lookup({
          items: items.map((it) => ({ md5: it.md5, local: { flagged: it.flagged, severity: it.unit.severity, top_family: it.unit.top_family } })),
        });
        const engine = typeof res.engine === "string" ? res.engine : "cloud";
        toReview = [];
        for (const it of items) {
          const r = res.results?.find((x) => x.md5 === it.md5);
          const v = r && parseVerdict(r, engine);
          // Known and current: done. Stale or disputed: show the old answer while it is re-reviewed.
          if (v) {
            doneWith(it.unit, v);
            this.deps.cache?.set(it.hash, v);
          }
          if (!(r?.advice === "apply" && v)) toReview.push(it);
        }
      } catch (e) {
        this.deps.log?.(`cloud lookup: ${(e as Error).message}`);
        // Lookup unavailable: what this machine remembers, then the model.
        toReview = items.filter((it) => {
          const cached = t.mode === "validate" ? this.deps.cache?.get(it.hash) : undefined;
          if (cached) doneWith(it.unit, cached);
          return !cached;
        });
      }
    }
    if (t.mode === "important") {
      toReview = toReview.filter((it) => {
        if (this.spendImportant()) return true;
        // Over this hour's budget: forget it was screened, so a later sweep tries again.
        this.screened.delete(unitKey(t.root, it.unit) + unitSig(it.unit));
        this.entries.delete(unitKey(t.root, it.unit));
        return false;
      });
    }

    // 2. The model, for what the cloud did not know or wants to look at again.
    const groups = new Map<string, Item[]>();
    for (const it of toReview) groups.set(it.src.language, [...(groups.get(it.src.language) ?? []), it]);
    for (const [language, group] of groups) {
      for (let i = 0; i < group.length; i += BATCH) {
        const chunk = group.slice(i, i + BATCH);
        if (!this.deps.client.available || !this.deps.enabled()) {
          chunk.forEach((it) => fail(it.unit));
          continue;
        }
        try {
          const res = await this.deps.client.review({
            mode: t.mode === "refresh" ? "validate" : t.mode,
            language,
            local_model: this.deps.localModel?.(t.root),
            functions: chunk.map((it, n) => ({
              id: String(n),
              code: it.code,
              local: { flagged: it.flagged, severity: it.unit.severity, top_family: it.unit.top_family, families: it.unit.families },
            })),
          });
          const engine = typeof res.engine === "string" ? res.engine : "cloud";
          chunk.forEach((it, n) => {
            const r = res.results?.find((x) => x.id === String(n));
            const verdict = r && parseVerdict(r, engine);
            if (verdict) {
              this.deps.cache?.set(it.hash, verdict);
              doneWith(it.unit, verdict);
            } else fail(it.unit);
          });
        } catch (e) {
          this.deps.log?.(`cloud review: ${(e as Error).message}`);
          chunk.forEach((it) => fail(it.unit));
        }
      }
    }
  }
}

/**
 * Verdicts by content hash, kept in VS Code's global storage. Insertion-ordered,
 * so the oldest go first past `max`; saved at most every few seconds.
 */
export class VerdictCache {
  private readonly map: Map<string, CloudVerdict>;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    initial: Record<string, CloudVerdict> | undefined,
    private readonly save: (s: Record<string, CloudVerdict>) => unknown,
    private readonly max = 2_000,
  ) {
    this.map = new Map(Object.entries(initial ?? {}));
  }

  get(hash: string): CloudVerdict | undefined {
    return this.map.get(hash);
  }

  set(hash: string, v: CloudVerdict): void {
    this.map.delete(hash);
    this.map.set(hash, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    this.timer ??= setTimeout(() => this.flush(), 5_000);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.save(Object.fromEntries(this.map));
  }
}

/** A language name the server accepts (letters, digits, `+#. -`), from vakt's name or VS Code's id. */
export function cloudLanguage(...names: (string | undefined)[]): string {
  for (const n of names) {
    const clean = (n ?? "").replace(/[^\w+#. -]/g, "").trim().slice(0, 40);
    if (clean) return clean;
  }
  return "text";
}
