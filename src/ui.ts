import * as path from "node:path";
import * as vscode from "vscode";
import { Gates, Unit } from "./report";
import { codeLensTitle, diagnosticMessage, reviewTooltip } from "./present";
import { severityLabel } from "./families";
import { ResultStore } from "./store";

export const SOURCE = "VAKT";

export interface Config extends Gates {
  diagnosticSeverity: vscode.DiagnosticSeverity;
}

export function readConfig(): Config {
  const c = vscode.workspace.getConfiguration("vakt");
  const sev = c.get<string>("diagnosticSeverity", "warning");
  const map: Record<string, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information,
    hint: vscode.DiagnosticSeverity.Hint,
  };
  return {
    threshold: c.get<number>("threshold", 0.95),
    minConfidence: c.get<number>("minConfidence", 0.9),
    diagnosticSeverity: map[sev] ?? vscode.DiagnosticSeverity.Warning,
  };
}

export function fileUri(root: string, rel: string): vscode.Uri {
  return vscode.Uri.file(path.join(root, ...rel.split("/")));
}

/** The workspace root and slash-separated relative path for a document, if it is inside a folder. */
export function locate(uri: vscode.Uri): { root: string; rel: string } | undefined {
  if (uri.scheme !== "file") return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return undefined;
  const root = folder.uri.fsPath;
  const rel = path.relative(root, uri.fsPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return { root, rel: rel.split(path.sep).join("/") };
}

/** The unit's first line: the signature, where diagnostics and lenses are anchored. */
function headRange(doc: vscode.TextDocument | undefined, u: Unit): vscode.Range {
  const line = Math.max(0, u.start_line - 1);
  if (doc && line < doc.lineCount) {
    const l = doc.lineAt(line);
    return new vscode.Range(line, l.firstNonWhitespaceCharacterIndex, line, l.text.length);
  }
  return new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER);
}

/** Problems panel. Re-rendered from the store whenever results or settings change. */
export class Diagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection(SOURCE);

  constructor(private readonly store: ResultStore) {}

  render(cfg: Config): void {
    this.collection.clear();
    for (const root of this.store.roots()) {
      for (const rel of this.store.files(root)) {
        const uri = fileUri(root, rel);
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
        const diags = this.store.fileFindings(root, rel, cfg).map((u) => {
          const d = new vscode.Diagnostic(headRange(doc, u), diagnosticMessage(u), cfg.diagnosticSeverity);
          // No source or code: the message names the issue and its CWE already.
          return d;
        });
        if (diags.length) this.collection.set(uri, diags);
      }
    }
  }

  dispose(): void {
    this.collection.dispose();
  }
}

/** A lens above each finding: its family (opens the details) and "Ignore". */
export class Lenses implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  constructor(
    private readonly store: ResultStore,
    private readonly cfg: () => Config,
  ) {}

  refresh(): void {
    this.changed.fire();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const loc = locate(doc.uri);
    if (!loc) return [];
    const lenses: vscode.CodeLens[] = [];
    for (const u of this.store.fileFindings(loc.root, loc.rel, this.cfg())) {
      const r = headRange(doc, u);
      lenses.push(
        new vscode.CodeLens(r, { title: codeLensTitle(), tooltip: reviewTooltip(u), command: "vakt.showFinding", arguments: [loc.root, u] }),
        new vscode.CodeLens(r, { title: "Ignore", tooltip: "Hide this finding in this workspace", command: "vakt.ignoreFinding", arguments: [{ root: loc.root, unit: u }] }),
      );
    }
    return lenses;
  }
}

/** "Review" (preferred) and "Ignore" as quick fixes on a finding, in the light bulb and the problem hover. */
export class Reviews implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  constructor(
    private readonly store: ResultStore,
    private readonly cfg: () => Config,
  ) {}

  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const loc = locate(doc.uri);
    if (!loc) return [];
    const actions: vscode.CodeAction[] = [];
    for (const u of this.store.fileFindings(loc.root, loc.rel, this.cfg())) {
      const head = headRange(doc, u);
      if (!head.intersection(range) && !(range.isEmpty && head.contains(range.start))) continue;
      const diags = ctx.diagnostics.filter((d) => d.range.isEqual(head) && d.message === diagnosticMessage(u));
      const review = new vscode.CodeAction("Review", vscode.CodeActionKind.QuickFix);
      review.isPreferred = true;
      review.diagnostics = diags;
      review.command = { title: "Review", tooltip: reviewTooltip(u), command: "vakt.showFinding", arguments: [loc.root, u] };
      const ignore = new vscode.CodeAction("Ignore this finding", vscode.CodeActionKind.QuickFix);
      ignore.diagnostics = diags;
      ignore.command = { title: "Ignore", command: "vakt.ignoreFinding", arguments: [{ root: loc.root, unit: u }] };
      actions.push(review, ignore);
    }
    return actions;
  }
}

/** Coloured gutter bar plus a faint line tint across every flagged function, like the margin markers in the reference UI. */
export class Gutter implements vscode.Disposable {
  private readonly types: Record<"c" | "h" | "m", vscode.TextEditorDecorationType>;

  constructor(
    private readonly store: ResultStore,
    private readonly cfg: () => Config,
  ) {
    const make = (color: string) =>
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderWidth: "0 0 0 3px",
        borderStyle: "solid",
        borderColor: color,
        overviewRulerColor: color,
        overviewRulerLane: vscode.OverviewRulerLane.Left,
      });
    this.types = { c: make("#e5484dcc"), h: make("#f76b15cc"), m: make("#e2a336cc") };
  }

  render(editors: readonly vscode.TextEditor[] = vscode.window.visibleTextEditors): void {
    for (const ed of editors) {
      const loc = locate(ed.document.uri);
      const buckets: Record<"c" | "h" | "m", vscode.Range[]> = { c: [], h: [], m: [] };
      if (loc) {
        for (const u of this.store.fileFindings(loc.root, loc.rel, this.cfg())) {
          const level = severityLabel(u.severity);
          const key = level === "CRITICAL" ? "c" : level === "HIGH" ? "h" : "m";
          const end = Math.min(u.end_line, ed.document.lineCount) - 1;
          buckets[key].push(new vscode.Range(u.start_line - 1, 0, Math.max(end, u.start_line - 1), 0));
        }
      }
      for (const k of ["c", "h", "m"] as const) ed.setDecorations(this.types[k], buckets[k]);
    }
  }

  dispose(): void {
    for (const t of Object.values(this.types)) t.dispose();
  }
}
