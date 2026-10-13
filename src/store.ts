// Scored units per scan root. No vscode import, so it is unit-testable.
//
// Every scored unit is kept, not just the flagged ones, so changing the
// threshold or confidence gate in settings re-renders without a re-scan.

import { Gates, isFinding, Report, Unit } from "./report";

export interface Finding {
  root: string;
  unit: Unit;
}

export class ResultStore {
  /** root -> relative file -> units sorted by start line. */
  private readonly byRoot = new Map<string, Map<string, Unit[]>>();
  private readonly models = new Map<string, Report["model"]>();
  /** Optional filter (ignored findings), applied to findings() and fileFindings(). */
  hide: (root: string, u: Unit) => boolean = () => false;
  /**
   * What to show for a unit: itself, a relabelled copy, or nothing. Cloud
   * review (src/cloud.ts) replaces it; by default the local gates decide.
   */
  view: (root: string, u: Unit, g: Gates) => Unit | undefined = (_root, u, g) => (isFinding(u, g) ? u : undefined);

  model(root: string): Report["model"] | undefined {
    return this.models.get(root);
  }

  /** Re-notify listeners after something outside the store (ignores) changed. */
  touch(): void {
    this.fire();
  }
  private readonly listeners = new Set<() => void>();

  onDidChange(fn: () => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private fire(): void {
    for (const fn of this.listeners) fn();
  }

  /**
   * Merge a report. `scope` lists the files the scan covered: their old units
   * are replaced, even when the new report has none for them (fixed, emptied
   * or now skipped). An undefined scope means the whole root was scanned.
   */
  apply(root: string, report: Report, scope?: readonly string[]): void {
    if (report.model) this.models.set(root, report.model);
    let files = this.byRoot.get(root);
    if (!files || scope === undefined) {
      files = new Map();
      this.byRoot.set(root, files);
    } else {
      for (const f of scope) files.delete(f);
    }
    for (const u of report.units) {
      const list = files.get(u.file);
      if (list) list.push(u);
      else files.set(u.file, [u]);
    }
    for (const list of files.values()) list.sort((a, b) => a.start_line - b.start_line);
    this.fire();
  }

  /**
   * Add or replace one unit while a scan is still running (a streamed JSONL
   * event). The scan's final report replaces it via apply().
   */
  addUnit(root: string, u: Unit): void {
    let files = this.byRoot.get(root);
    if (!files) {
      files = new Map();
      this.byRoot.set(root, files);
    }
    const list = (files.get(u.file) ?? []).filter((x) => !(x.start_line === u.start_line && x.name === u.name));
    list.push(u);
    list.sort((a, b) => a.start_line - b.start_line);
    files.set(u.file, list);
    this.fire();
  }

  /** Replace one file's units (a `vakt serve` result for an edited buffer). */
  setFile(root: string, file: string, units: readonly Unit[]): void {
    let files = this.byRoot.get(root);
    if (!files) {
      files = new Map();
      this.byRoot.set(root, files);
    }
    files.set(file, [...units].sort((a, b) => a.start_line - b.start_line));
    this.fire();
  }

  clear(root?: string): void {
    if (root === undefined) {
      this.byRoot.clear();
      this.models.clear();
    } else {
      this.byRoot.delete(root);
      this.models.delete(root);
    }
    this.fire();
  }

  roots(): string[] {
    return [...this.byRoot.keys()];
  }

  units(root: string, file: string): readonly Unit[] {
    return this.byRoot.get(root)?.get(file) ?? [];
  }

  /** Findings in one file, in line order. */
  fileFindings(root: string, file: string, g: Gates): Unit[] {
    const out: Unit[] = [];
    for (const u of this.units(root, file)) {
      const v = this.hide(root, u) ? undefined : this.view(root, u, g);
      if (v) out.push(v);
    }
    return out;
  }

  /** Every scored unit not ignored, flagged or not (cloud review's important-function sweep). */
  all(): Finding[] {
    const out: Finding[] = [];
    for (const [root, files] of this.byRoot) {
      for (const units of files.values()) for (const unit of units) if (!this.hide(root, unit)) out.push({ root, unit });
    }
    return out;
  }

  /** DOM-0.8B's own findings, before cloud review: what it should review. */
  candidates(g: Gates): Finding[] {
    const out: Finding[] = [];
    for (const [root, files] of this.byRoot) {
      for (const units of files.values()) {
        for (const unit of units) if (isFinding(unit, g) && !this.hide(root, unit)) out.push({ root, unit });
      }
    }
    return out;
  }

  /** Scored units, flagged files and total files, for the sidebar summary. */
  stats(g: Gates): { units: number; files: number; flaggedFiles: number } {
    let units = 0;
    let files = 0;
    let flaggedFiles = 0;
    for (const [root, byFile] of this.byRoot) {
      for (const [file, list] of byFile) {
        files++;
        units += list.length;
        if (this.fileFindings(root, file, g).length) flaggedFiles++;
      }
    }
    return { units, files, flaggedFiles };
  }

  /** All findings, worst first. */
  findings(g: Gates): Finding[] {
    const out: Finding[] = [];
    for (const [root, files] of this.byRoot) {
      for (const file of files.keys()) for (const unit of this.fileFindings(root, file, g)) out.push({ root, unit });
    }
    return out.sort(
      (a, b) =>
        b.unit.severity - a.unit.severity ||
        a.unit.file.localeCompare(b.unit.file) ||
        a.unit.start_line - b.unit.start_line,
    );
  }

  /** Files known for a root (scored at least once), for clearing diagnostics. */
  files(root: string): string[] {
    return [...(this.byRoot.get(root)?.keys() ?? [])];
  }
}
