// Spawning the vakt binary. No vscode import, so it is unit-testable.
//
// The extension never reimplements the engine: it drives `vakt patrol` (and
// `vakt serve` for code as it is typed) and reads their JSON, so the scores in
// the editor are the same scores the CLI, CI and the MCP server produce (same
// pinned weights, same score cache).

import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { parseReport, parseUnit, Report, ReportError, Unit } from "./report";

export interface ScanSettings {
  threshold: number;
  minConfidence: number;
  precision: string;
  device: string;
  topLevel: boolean;
  /** --no-repo-ignores: forced on for untrusted workspaces. */
  noRepoIgnores: boolean;
}

/**
 * Escape a literal path for vakt's doublestar --include globs. Without this a
 * file such as `app/[id]/page.tsx` (common in Next.js/SvelteKit) is read as a
 * character class and silently matches nothing.
 */
export function escapeGlob(rel: string): string {
  return rel.replace(/[\\*?[\]{}!]/g, (c) => "\\" + c);
}

/** Arguments for `vakt patrol`. `files` are slash-separated paths relative to root; empty scans everything. */
export function patrolArgs(root: string, files: readonly string[], s: ScanSettings, format: "jsonl" | "json" = "jsonl"): string[] {
  const args = [
    "patrol",
    root,
    "--format", format,
    "--out", "-",
    // Keep each file's results, by content hash, in <root>/.vakt so they show
    // again on the next start without a scan (`vakt results`).
    ...(format === "jsonl" ? ["--save-results"] : []),
    "--quiet",
    "--no-color",
    "--threshold", String(s.threshold),
    "--min-confidence", String(s.minConfidence),
    "--precision", s.precision,
    "--device", s.device,
  ];
  if (s.topLevel) args.push("--top-level");
  if (s.noRepoIgnores) args.push("--no-repo-ignores");
  for (const f of files) args.push("--include", escapeGlob(f));
  return args;
}

/** First candidate that exists: explicit setting, the installer's default location, then PATH. */
export function resolveBinary(configured: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (configured.trim()) {
    const p = configured.trim().replace(/^~(?=$|[\\/])/, homedir());
    return isFile(p) ? p : undefined;
  }
  const exe = process.platform === "win32" ? "vakt.exe" : "vakt";
  const candidates = [path.join(homedir(), ".local", "bin", exe)];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }
  return candidates.find((c) => existsSync(c) && isFile(c));
}

export type ScanErrorKind = "auth" | "gated" | "not-found" | "no-engine" | "offline" | "rate-limit" | "usage" | "cancelled" | "unknown";

export class ScanError extends Error {
  constructor(
    readonly kind: ScanErrorKind,
    message: string,
    readonly stderr = "",
  ) {
    super(message);
  }
}

/** Map vakt's stderr (internal/hub and internal/engine error strings) to something the UI can act on. */
export function classifyError(stderr: string, code: number | null): ScanError {
  const text = stderr.trim();
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  const msg = first.replace(/^vakt:\s*/, "") || `vakt exited with status ${code}`;
  if (/not signed in to Hugging Face/i.test(text)) return new ScanError("auth", msg, text);
  if (/gated or private/i.test(text)) return new ScanError("gated", msg, text);
  if (/model not found/i.test(text)) {
    return new ScanError(
      "not-found",
      `${msg}. If vakt was just updated, the installed binary may pin an older model revision: run "VAKT: Run Doctor".`,
      text,
    );
  }
  if (/native backend unavailable|no scanning engine/i.test(text)) return new ScanError("no-engine", msg, text);
  if (/not in the local cache/i.test(text)) return new ScanError("offline", msg, text);
  if (/HTTP 429|rate limiting/i.test(text)) return new ScanError("rate-limit", msg, text);
  if (/must be in|must be pretty|unknown flag|unknown command|invalid argument|cannot scan/i.test(text)) return new ScanError("usage", msg, text);
  return new ScanError("unknown", msg, text);
}

// vakt caps reports it reads at 512 MiB; hold stdout to the same bound.
const MAX_STDOUT = 512 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

export interface RunOptions {
  signal?: AbortSignal;
  onSpawn?: (cmdline: string) => void;
  /** Each unit as soon as vakt has scored it (vakt with --format jsonl). */
  onUnit?: (u: Unit) => void;
}

/** Whether a vakt run failed because the binary predates a flag or command (so: fall back). */
function unsupported(e: unknown): boolean {
  return e instanceof ScanError && e.kind === "usage" && /--format must be|unknown flag|unknown command/i.test(e.stderr || e.message);
}

/** Binaries seen without JSONL streaming, so it is not tried on them again. */
const noJsonl = new Set<string>();

/**
 * Run `vakt patrol` and return the parsed report, streaming units through
 * o.onUnit as they are scored. A vakt that predates --format jsonl is run
 * again with --format json (no streaming, no saved results).
 */
export async function runPatrol(bin: string, root: string, files: readonly string[], s: ScanSettings, o: RunOptions = {}): Promise<Report> {
  if (!noJsonl.has(bin)) {
    try {
      return await runPatrolFormat(bin, root, files, s, o, "jsonl");
    } catch (e) {
      if (!unsupported(e)) throw e;
      noJsonl.add(bin);
    }
  }
  return runPatrolFormat(bin, root, files, s, o, "json");
}

/**
 * Parse `vakt patrol --format jsonl` output as it arrives: unit events go to
 * onUnit, and the closing report event is returned. Exported for tests.
 */
export class JsonlReader {
  private buf = "";
  report: Report | undefined;

  constructor(private readonly onUnit?: (u: Unit) => void) {}

  push(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this.line(line);
    }
  }

  private line(line: string): void {
    let ev: { type?: string; unit?: unknown; report?: unknown };
    try {
      ev = JSON.parse(line);
    } catch (e) {
      throw new ReportError(`VAKT sent a line that is not JSON: ${(e as Error).message}`);
    }
    if (ev.type === "unit") {
      // Validate even with no listener: a bad unit means a bad stream.
      const u = parseUnit(ev.unit);
      this.onUnit?.(u);
    }
    else if (ev.type === "report") this.report = parseReport(JSON.stringify(ev.report));
  }

  end(): Report {
    if (this.buf.trim()) this.line(this.buf);
    if (!this.report) throw new ReportError("VAKT ended without a report");
    return this.report;
  }
}

/**
 * Run `vakt patrol` once in the given format.
 * Exit 0 (no findings) and 1 (findings) both carry a report; 2 is an error;
 * 130 is an interrupt.
 */
function runPatrolFormat(bin: string, root: string, files: readonly string[], s: ScanSettings, o: RunOptions, format: "jsonl" | "json"): Promise<Report> {
  const args = patrolArgs(root, files, s, format);
  o.onSpawn?.([bin, ...args].map((a) => (/[\s"'\\[\]*?{}]/.test(a) ? JSON.stringify(a) : a)).join(" "));
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(new ScanError("cancelled", "cancelled"));
    const group = process.platform !== "win32";
    const child = spawn(bin, args, {
      cwd: root,
      // stdin closed: vakt's sign-in flow must never wait on a prompt nobody can see.
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
      windowsHide: true,
      // Own process group, so cancelling also stops vakt's sandboxed parser workers.
      detached: group,
    });
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (group && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // already gone
      }
    };
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      o.signal?.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      fn();
    };
    const out: Buffer[] = [];
    let outLen = 0;
    let err = "";
    let overflow = false;
    let bad: Error | undefined;
    const reader = format === "jsonl" ? new JsonlReader(o.onUnit) : undefined;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (b: string) => {
      outLen += b.length;
      if (outLen > MAX_STDOUT) {
        overflow = true;
        kill("SIGKILL");
        return;
      }
      if (!reader) return void out.push(Buffer.from(b, "utf8"));
      try {
        reader.push(b);
      } catch (e) {
        // A malformed or unsafe event: stop the scan rather than trust the rest.
        bad = e as Error;
        kill("SIGKILL");
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      if (err.length < MAX_STDERR) err += b.toString("utf8");
    });

    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      // SIGINT lets vakt close the score cache cleanly; force it if it lingers.
      kill("SIGINT");
      killTimer = setTimeout(() => kill("SIGKILL"), 3000);
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e) => settle(() => reject(new ScanError("unknown", `could not start ${bin}: ${e.message}`))));
    // On cancel, settle as soon as vakt itself exits: a straggling grandchild
    // holding the pipes open must not keep the queue blocked.
    child.on("exit", (code) => {
      if (o.signal?.aborted || code === 130) {
        kill("SIGKILL");
        settle(() => reject(new ScanError("cancelled", "cancelled")));
      }
    });
    child.on("close", (code) =>
      settle(() => {
        if (overflow) return reject(new ScanError("unknown", "VAKT report exceeded the 512 MiB limit"));
        if (bad) return reject(new ScanError("unknown", bad.message, err));
        if (code !== 0 && code !== 1) return reject(classifyError(err, code));
        try {
          resolve(reader ? reader.end() : parseReport(Buffer.concat(out).toString("utf8")));
        } catch (e) {
          reject(new ScanError("unknown", (e as Error).message, err));
        }
      }),
    );
  });
}

/**
 * Whether DOM-0.8B is in vakt's model cache: <$VAKT_CACHE or the OS cache
 * dir>/vakt/hub/models--vaktex--dom-oss-0.8b/snapshots/<commit>/model.safetensors
 * (internal/hub in vakt).
 */
export function modelCached(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  const userCache =
    platform === "darwin"
      ? path.join(homedir(), "Library", "Caches")
      : platform === "win32"
        ? env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local")
        : env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  const root = env.VAKT_CACHE || path.join(userCache, "vakt");
  const snaps = path.join(root, "hub", "models--vaktex--dom-oss-0.8b", "snapshots");
  try {
    return readdirSync(snaps).some((c) => existsSync(path.join(snaps, c, "model.safetensors")));
  } catch {
    return false;
  }
}

/**
 * Results stored in <root>/.vakt for files unchanged since they were scanned
 * (`vakt results`). It needs no model, so it runs at startup. Undefined when
 * vakt predates the command or has nothing usable.
 */
export function runResults(bin: string, root: string, s: Pick<ScanSettings, "threshold" | "minConfidence">): Promise<Report | undefined> {
  const args = ["results", root, "--threshold", String(s.threshold), "--min-confidence", String(s.minConfidence)];
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" }, windowsHide: true });
    const out: Buffer[] = [];
    let len = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.on("data", (b: Buffer) => {
      len += b.length;
      if (len > MAX_STDOUT) child.kill("SIGKILL");
      else out.push(b);
    });
    child.stderr.resume();
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(undefined);
      try {
        resolve(parseReport(Buffer.concat(out).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
  });
}

/** `vakt serve` arguments for the current settings. */
export function serveArgs(s: ScanSettings): string[] {
  const args = [
    "serve",
    "--save-results",
    "--threshold", String(s.threshold),
    "--min-confidence", String(s.minConfidence),
    "--precision", s.precision,
    "--device", s.device,
  ];
  if (s.topLevel) args.push("--top-level");
  return args;
}

/** How long `vakt serve` may sit idle (holding the model in memory) before it is stopped. */
const SERVE_IDLE_MS = 10 * 60 * 1000;

/**
 * Scores files as they are edited through one long-running `vakt serve`, so
 * the model is loaded once rather than per keystroke pause. Started on first
 * use, stopped after SERVE_IDLE_MS idle; restarted on demand.
 */
export class LiveScorer {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buf = "";
  private stderr = "";
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (u: Unit[] | undefined) => void; reject: (e: Error) => void }>();
  private idle: NodeJS.Timeout | undefined;
  /** False once vakt is known to have no `serve` command. */
  supported = true;

  constructor(
    private readonly bin: string,
    private readonly args: string[],
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /**
   * Score one file (content: an unsaved buffer; omitted: the file on disk).
   * Resolves to the file's units, or undefined if a newer request for the
   * same file replaced this one.
   */
  score(root: string, file: string, content?: string): Promise<Unit[] | undefined> {
    if (!this.supported) return Promise.reject(new ScanError("usage", "this vakt has no `serve` command"));
    const child = this.start();
    const id = this.nextId++;
    this.touch();
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, root, file, content }) + "\n");
    });
  }

  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    const child = this.child;
    this.child = undefined;
    if (child) {
      child.stdin.end();
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }
    this.fail(new ScanError("cancelled", "cancelled"));
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      if (this.waiting.size === 0) this.stop();
      else this.touch();
    }, SERVE_IDLE_MS);
    this.idle.unref?.();
  }

  private fail(e: Error): void {
    for (const w of this.waiting.values()) w.reject(e);
    this.waiting.clear();
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    this.log(`$ ${this.bin} ${this.args.join(" ")}`);
    const child = spawn(this.bin, this.args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" }, windowsHide: true });
    this.child = child;
    this.buf = "";
    this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (b: string) => {
      this.buf += b;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line.trim()) this.reply(line);
      }
    });
    child.stderr.on("data", (b: Buffer) => {
      if (this.stderr.length < MAX_STDERR) this.stderr += b.toString("utf8");
    });
    child.stdin.on("error", () => {}); // reported through "close"
    child.on("error", (e) => this.fail(new ScanError("unknown", `could not start ${this.bin}: ${e.message}`)));
    child.on("close", (code) => {
      if (this.child === child) this.child = undefined;
      const err = classifyError(this.stderr, code);
      if (err.kind === "usage" && /unknown command/i.test(this.stderr)) this.supported = false;
      this.fail(err);
    });
    return child;
  }

  private reply(line: string): void {
    let m: { id?: number; type?: string; units?: unknown[]; message?: string };
    try {
      m = JSON.parse(line);
    } catch {
      return this.log(`vakt serve sent a line that is not JSON`);
    }
    const w = typeof m.id === "number" ? this.waiting.get(m.id) : undefined;
    if (!w) return;
    this.waiting.delete(m.id!);
    if (m.type === "superseded") return w.resolve(undefined);
    if (m.type === "error") return w.reject(classifyError(String(m.message ?? "vakt serve error"), 2));
    try {
      w.resolve((m.units ?? []).map(parseUnit));
    } catch (e) {
      w.reject(new ScanError("unknown", (e as Error).message));
    }
  }
}
