// Ignored findings. No vscode import, so it is unit-testable.
//
// A finding is keyed by file, kind and function name rather than line, so an
// ignore survives edits above the function. Units without a name (whole-file
// or top-level fragments) fall back to their start line.

import { Unit } from "./report";

export interface IgnoreState {
  units: string[];
  files: string[];
}

export function unitKey(root: string, u: Pick<Unit, "file" | "kind" | "name" | "start_line">): string {
  return JSON.stringify([root, u.file, u.kind, u.name || `@${u.start_line}`]);
}

export function fileKey(root: string, file: string): string {
  return JSON.stringify([root, file]);
}

export class Ignores {
  private units: Set<string>;
  private files: Set<string>;
  private readonly listeners = new Set<() => void>();

  constructor(
    initial: IgnoreState | undefined,
    private readonly save: (s: IgnoreState) => unknown,
  ) {
    this.units = new Set(initial?.units ?? []);
    this.files = new Set(initial?.files ?? []);
  }

  onDidChange(fn: () => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private commit(): void {
    this.save({ units: [...this.units], files: [...this.files] });
    for (const fn of this.listeners) fn();
  }

  has(root: string, u: Unit): boolean {
    return this.files.has(fileKey(root, u.file)) || this.units.has(unitKey(root, u));
  }

  ignoreUnit(root: string, u: Unit): void {
    this.units.add(unitKey(root, u));
    this.commit();
  }

  ignoreFile(root: string, file: string): void {
    this.files.add(fileKey(root, file));
    this.commit();
  }

  get size(): number {
    return this.units.size + this.files.size;
  }

  clear(): void {
    this.units.clear();
    this.files.clear();
    this.commit();
  }
}
