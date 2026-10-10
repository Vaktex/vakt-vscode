// Types and validation for the vakt JSON report (schema_version "1",
// internal/report in the vakt repo). No vscode import, so it is unit-testable.
//
// A report describes an untrusted repository: file paths and function names
// come straight from the scanned code. parseReport rejects anything that does
// not look like a vakt v1 report, and the helpers below keep repo-controlled
// strings from escaping the scan root or smuggling control characters into UI.

import { isFamily } from "./families";

export const SCHEMA_VERSION = "1";

export interface Part {
  split_part: number;
  start_line: number;
  end_line: number;
  severity: number;
  top_family: string;
  top_family_prob: number;
}

export interface Unit {
  file: string;
  language: string;
  kind: string;
  name?: string;
  start_line: number;
  end_line: number;
  tokens: number;
  severity: number;
  families: Record<string, number>;
  top_family: string;
  top_family_prob: number;
  flagged: boolean;
  explanation?: string;
  cached?: boolean;
  truncated?: boolean;
  split_of?: number;
  parts?: Part[];
}

export interface Skip {
  file: string;
  reason: string;
}

export interface Report {
  schema_version: string;
  tool: { name: string; binary: string; version: string; commit: string };
  model: { repo: string; revision: string; sha256: string; backend: string; device: string; precision: string };
  scan: {
    root: string;
    started_at: string;
    duration_ms: number;
    files: number;
    units: number;
    tokens: number;
    tokens_per_sec: number;
    cache_hits: number;
    skipped: Skip[] | null;
  };
  units: Unit[];
  summary: { threshold: number; min_confidence?: number; flagged_units: number; flagged_files: number };
}

export class ReportError extends Error {}

function isProb(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

function isLine(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

/**
 * A report path must be a relative, slash-separated path that stays inside
 * the scan root. vakt guarantees this; the check means a forged or corrupted
 * report cannot make the extension open or annotate files elsewhere.
 */
export function isSafeRelPath(p: unknown): p is string {
  if (typeof p !== "string" || p === "" || p.length > 4096) return false;
  if (p.startsWith("/") || p.includes("\\") || /^[A-Za-z]:/.test(p) || p.includes("\0")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

// C0/C1 controls plus bidi and other invisible format characters (the same
// classes vakt strips from terminal output).
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** Strip control and bidi characters from a repo-supplied string for display. */
export function sanitize(s: string | undefined, max = 200): string {
  if (!s) return "";
  const clean = s.replace(UNSAFE_CHARS, "");
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

/** Parse and validate a report. Throws ReportError on anything unexpected. */
export function parseReport(text: string): Report {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ReportError(`VAKT did not return JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) throw new ReportError("not a vakt report");
  const r = raw as Partial<Report>;
  if (r.schema_version === undefined) throw new ReportError("not a vakt report: schema_version missing");
  if (r.schema_version !== SCHEMA_VERSION) {
    throw new ReportError(
      `unsupported report schema_version ${JSON.stringify(sanitize(String(r.schema_version), 20))} ` +
        `(this extension reads "${SCHEMA_VERSION}"); update the extension or vakt`,
    );
  }
  if (!Array.isArray(r.units)) throw new ReportError("report has no units array");
  r.units.forEach((u, i) => checkUnit(u, i));
  if (!r.scan || typeof r.scan !== "object") throw new ReportError("report has no scan section");
  return r as Report;
}

/** Validate one unit (a streamed `unit` event or a `vakt serve` result). Throws ReportError. */
export function parseUnit(raw: unknown): Unit {
  checkUnit(raw as Unit, 0);
  return raw as Unit;
}

function checkUnit(u: Unit, i: number): void {
  const where = `unit ${i}`;
  if (!u || typeof u !== "object") throw new ReportError(`${where}: not an object`);
  if (!isSafeRelPath(u.file)) throw new ReportError(`${where}: unsafe file path`);
  if (!isLine(u.start_line) || !isLine(u.end_line) || u.end_line < u.start_line) {
    throw new ReportError(`${where}: invalid line span`);
  }
  if (!isProb(u.severity) || !isProb(u.top_family_prob)) throw new ReportError(`${where}: score outside [0,1]`);
  if (u.top_family !== "" && !isFamily(u.top_family)) throw new ReportError(`${where}: unknown top_family`);
  if (!u.families || typeof u.families !== "object") throw new ReportError(`${where}: families missing`);
  for (const [k, v] of Object.entries(u.families)) {
    if (!isFamily(k)) throw new ReportError(`${where}: unknown family`);
    if (!isProb(v)) throw new ReportError(`${where}: family score outside [0,1]`);
  }
}

export interface Gates {
  threshold: number;
  minConfidence: number;
}

/**
 * Same rule as vakt's report.ApplyConfidence. The extension re-applies it
 * locally, rather than trusting `flagged`, so changing the thresholds in
 * settings re-renders immediately without a re-scan.
 */
export function isFinding(u: Unit, g: Gates): boolean {
  return u.severity >= g.threshold && u.top_family_prob >= g.minConfidence;
}
