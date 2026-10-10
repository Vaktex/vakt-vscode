import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { detailHtml } from "./detailHtml";
import { displayTitle } from "./families";
import { Ignores } from "./ignores";
import { Unit } from "./report";
import { Finding } from "./store";
import { fileUri } from "./ui";

export interface PanelDeps {
  findings: () => Finding[];
  gates: () => { threshold: number; minConfidence: number };
  ignores: Ignores;
  model: (root: string) => { repo: string; revision: string; backend: string; device: string; precision: string } | undefined;
  /** MITRE's full CWE entry from vaktex.com, when lookups are enabled. */
}

const sameUnit = (a: Finding, root: string, u: Unit) =>
  a.root === root && a.unit.file === u.file && a.unit.start_line === u.start_line && a.unit.name === u.name;

/** Width the panel opens at when it makes its own column (the design's 520 px, plus a scrollbar). */
const PANEL_WIDTH = 540;

/** The single "VAKT finding" editor tab beside the code, reused as the selection changes. */
export class DetailPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private current: { root: string; unit: Unit } | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the finding shown changes or the panel closes. */
  readonly onDidChangeSelection = this.changed.event;

  /** The finding on screen, if the panel is open. */
  get selection(): { root: string; unit: Unit } | undefined {
    return this.panel ? this.current : undefined;
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: PanelDeps,
  ) {}

  async show(root: string, unit: Unit, reveal = true): Promise<void> {
    this.current = { root, unit };
    this.changed.fire();
    if (reveal) await this.openSource(root, unit);
    if (!this.panel) {
      const groupsBefore = vscode.window.tabGroups.all.length;
      this.panel = vscode.window.createWebviewPanel(
        "vakt.finding",
        "VAKT finding",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, localResourceRoots: [this.fonts()], retainContextWhenHidden: false },
      );
      this.panel.iconPath = {
        light: vscode.Uri.joinPath(this.extensionUri, "media", "vakt.svg"),
        dark: vscode.Uri.joinPath(this.extensionUri, "media", "vakt-dark.svg"),
      };
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.changed.fire();
      });
      this.panel.webview.onDidReceiveMessage((m: { cmd?: string; width?: number }) =>
        m.cmd === "width" ? this.fitWidth(m.width) : void this.onMessage(m.cmd),
      );
      // "Beside" splits the editor 50/50, far wider than the panel needs. When
      // the panel made that split itself, it is resized once the page reports
      // its width (fitWidth). A layout the user split already is left alone.
      this.fitPending = groupsBefore === 1 && vscode.window.tabGroups.all.length === 2;
    } else if (!this.panel.visible) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
    }
    await this.render();
  }

  /** Re-render after results, settings or ignores change; close if the finding is gone. */
  async refresh(): Promise<void> {
    if (!this.panel || !this.current) return;
    const { root, unit } = this.current;
    const fresh = this.deps.findings().find((f) => sameUnit(f, root, unit));
    if (fresh) this.current = { root, unit: fresh.unit };
    await this.render();
  }

  private async render(): Promise<void> {
    if (!this.panel || !this.current) return;
    const { root, unit } = this.current;
    const list = this.deps.findings();
    const idx = list.findIndex((f) => sameUnit(f, root, unit));
    let source: string[] = [];
    let languageId: string | undefined;
    try {
      const doc = await vscode.workspace.openTextDocument(fileUri(root, unit.file));
      languageId = doc.languageId;
      const end = Math.min(unit.end_line, doc.lineCount);
      for (let l = unit.start_line - 1; l < end && l - unit.start_line < 400; l++) source.push(doc.lineAt(l).text);
    } catch {
      source = ["(file is no longer available)"];
    }
    const g = this.deps.gates();
    this.panel.title = displayTitle(unit.top_family);
    this.panel.webview.html = detailHtml(
      {
        unit,
        source,
        languageId,
        findingIndex: idx >= 0 ? idx : undefined,
        findingCount: idx >= 0 ? list.length : undefined,
        threshold: g.threshold,
        minConfidence: g.minConfidence,
        ignored: this.deps.ignores.has(root, unit),
        model: this.deps.model(root),
      },
      {
        nonce: randomBytes(16).toString("base64"),
        cspSource: this.panel.webview.cspSource,
        fontUri: this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.fonts(), "Vaktex-Sans-Variable-2-latin.woff2")).toString(),
      },
    );
  }

  private fonts(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, "media", "fonts");
  }

  private async openSource(root: string, u: Unit): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(fileUri(root, u.file));
    const line = Math.min(Math.max(0, u.start_line - 1), doc.lineCount - 1);
    const r = new vscode.Range(line, 0, line, 0);
    await vscode.window.showTextDocument(doc, { selection: r, viewColumn: vscode.ViewColumn.One, preserveFocus: false });
  }

  private async step(delta: number): Promise<void> {
    if (!this.current) return;
    const list = this.deps.findings();
    if (!list.length) return;
    const i = list.findIndex((f) => sameUnit(f, this.current!.root, this.current!.unit));
    const next = list[(Math.max(i, 0) + delta + list.length) % list.length];
    await this.show(next.root, next.unit);
  }

  private fitPending = false;

  /**
   * Resize the panel's column to about PANEL_WIDTH. Split sizes are fractions
   * and the API has no window size, so the editor area's width is worked out
   * from the panel's own width in the fresh 50/50 split.
   */
  private fitWidth(width: number | undefined): void {
    if (!this.fitPending || !width || width < 50) return;
    this.fitPending = false;
    const total = width * 2;
    const panel = Math.min(0.5, Math.max(0.2, PANEL_WIDTH / total));
    void vscode.commands.executeCommand("vscode.setEditorLayout", {
      orientation: 0,
      groups: [{ size: 1 - panel }, { size: panel }],
    });
  }

  private async onMessage(cmd: string | undefined): Promise<void> {
    if (!this.current) return;
    const { root, unit } = this.current;
    switch (cmd) {
      case "open":
        return this.openSource(root, unit);
      case "next":
        return this.step(1);
      case "prev":
        return this.step(-1);
      case "review":
        return void vscode.commands.executeCommand("vakt.reviewWithAgent", root, unit);
      case "rescan":
        return void vscode.commands.executeCommand("vakt.scanFile", fileUri(root, unit.file));
      case "ignoreUnit":
        this.deps.ignores.ignoreUnit(root, unit);
        return this.render();
      case "ignoreFile":
        this.deps.ignores.ignoreFile(root, unit.file);
        return this.render();
    }
  }

  dispose(): void {
    this.changed.dispose();
    this.panel?.dispose();
  }
}
