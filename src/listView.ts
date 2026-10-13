import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { AccountView } from "./account";
import { findingKey, listBody, listHtml, listItems, ListModel, listShape } from "./listHtml";
import { Unit } from "./report";
import { Finding } from "./store";

export interface ListDeps {
  findings: () => Finding[];
  stats: () => { units: number; files: number };
  /** Whether any scan has finished, so the page leaves the setup checklist. */
  hasResults: () => boolean;
  /** What is being scanned, if anything. */
  scanning: () => string | undefined;
  ignored: () => number;
  /** signedIn undefined: nothing uses the account, so the checklist has no sign-in step. */
  setup: () => { binary: boolean; model: boolean; signedIn?: boolean };
  /** The account line, or undefined when nothing uses the account. */
  account: () => AccountView | undefined;
  /** The finding open in the detail panel, highlighted in the list. */
  selected: () => { root: string; unit: Unit } | undefined;
}

/** The Findings sidebar: a webview so it can carry the vaktex.com design. */
export class FindingsView implements vscode.WebviewViewProvider {
  static readonly id = "vakt.findings";
  private view: vscode.WebviewView | undefined;
  private byKey = new Map<string, Finding>();
  /** Findings present when the current scan started; anything not in it is marked New. */
  private baseline: Set<string> | undefined;
  private fresh = new Set<string>();
  private wasScanning = false;
  private pending: NodeJS.Timeout | undefined;
  /** Shape of the page the webview has loaded and reported ready, if any. */
  private loaded: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: ListDeps,
  ) {}

  private fonts(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, "media", "fonts");
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.fonts()] };
    view.webview.onDidReceiveMessage((m: { cmd?: string; key?: string }) => {
      if (m.cmd === "ready") this.ready();
      else void this.onMessage(m);
    });
    // A hidden view's page is discarded: it needs a whole new one when shown again.
    view.onDidChangeVisibility(() => {
      this.loaded = this.loading = undefined;
      if (view.visible) this.render();
    });
    view.onDidDispose(() => (this.view = undefined));
    this.render();
  }

  /** Re-render after results, settings, ignores, scan state or the selection change. */
  refresh(): void {
    const findings = this.deps.findings();
    const keys = new Set(findings.map((f) => findingKey(f.root, f.unit)));
    const scanning = this.deps.scanning() !== undefined;
    if (scanning && !this.wasScanning) {
      // A first-ever scan finds everything; only mark New against earlier results.
      this.baseline = keys.size ? keys : undefined;
      this.fresh = new Set();
    }
    this.wasScanning = scanning;
    if (this.baseline) this.fresh = new Set([...keys].filter((k) => !this.baseline!.has(k)));
    // Streamed findings arrive many per second: re-render at most every 150 ms.
    if (!this.pending) {
      this.pending = setTimeout(() => {
        this.pending = undefined;
        this.render();
      }, 150);
    }
  }

  private render(): void {
    if (!this.view?.visible) return;
    const findings = this.deps.findings();
    this.byKey = new Map(findings.map((f) => [findingKey(f.root, f.unit), f]));
    const sel = this.deps.selected();
    const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const webview = this.view.webview;
    const model: ListModel = {
      items: listItems(findings, {
        selected: sel && findingKey(sel.root, sel.unit),
        fresh: this.fresh,
        rootName: multiRoot ? (root) => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))?.name : undefined,
      }),
      hasResults: this.deps.hasResults(),
      scanning: this.deps.scanning(),
      stats: this.deps.stats(),
      ignored: this.deps.ignored(),
      setup: this.deps.setup(),
      account: this.deps.account(),
    };
    const shape = listShape(model);
    // Same shape as the page on screen: patch it in place rather than reload it.
    if (this.loaded === shape) {
      void webview.postMessage({ type: "update", body: listBody(model) });
      return;
    }
    // That page is still loading: ready() renders again once it has.
    if (this.loaded === undefined && this.loading === shape) return;
    this.loaded = undefined;
    this.loading = shape;
    webview.html = listHtml(
      model,
      {
        nonce: randomBytes(16).toString("base64"),
        cspSource: webview.cspSource,
        fontUri: webview.asWebviewUri(vscode.Uri.joinPath(this.fonts(), "Vaktex-Sans-Variable-2-latin.woff2")).toString(),
      },
    );
  }

  /** Shape of the page being loaded, until it reports ready. */
  private loading: string | undefined;

  private ready(): void {
    this.loaded = this.loading;
    // Anything that changed while it loaded.
    this.render();
  }

  private async onMessage(m: { cmd?: string; key?: string }): Promise<void> {
    switch (m.cmd) {
      case "open": {
        const f = m.key ? this.byKey.get(m.key) : undefined;
        if (f) await vscode.commands.executeCommand("vakt.showFinding", f.root, f.unit);
        return;
      }
      case "scan":
        return void vscode.commands.executeCommand("vakt.scanWorkspace");
      case "cancel":
        return void vscode.commands.executeCommand("vakt.cancel");
      case "setup":
        return void vscode.commands.executeCommand("vakt.setup");
      case "install":
        return void vscode.commands.executeCommand("vakt.install");
      case "settings":
        return void vscode.commands.executeCommand("workbench.action.openSettings", "@ext:vaktex.vakt-vscode");
      case "restore":
        return void vscode.commands.executeCommand("vakt.clearIgnores");
      case "signIn":
        return void vscode.commands.executeCommand("vakt.signIn");
      case "signOut":
        return void vscode.commands.executeCommand("vakt.signOut");
    }
  }
}
