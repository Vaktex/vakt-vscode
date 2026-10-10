import * as vscode from "vscode";
import { LiveScorer, modelCached, resolveBinary, runPatrol, runResults, ScanError, ScanSettings, serveArgs } from "./cli";
import { agentTarget, hasGrammar, reviewPrompt } from "./present";
import { Unit } from "./report";
import { Job, Scheduler } from "./scheduler";
import { Ignores, IgnoreState } from "./ignores";
import { FindingsView } from "./listView";
import { DetailPanel } from "./panel";
import { ResultStore } from "./store";
import { Diagnostics, fileUri, Gutter, Lenses, locate, readConfig, Reviews } from "./ui";

const INSTALL_CMD = "curl -fsSL https://get.vaktex.com/oss-vakt | sh";
const IGNORES_KEY = "vakt.ignores";

export function activate(ctx: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("VAKT", { log: true });
  const store = new ResultStore();
  // Per-workspace, kept in VS Code's storage rather than a file in the repo.
  const ignores = new Ignores(ctx.workspaceState.get<IgnoreState>(IGNORES_KEY), (s) => ctx.workspaceState.update(IGNORES_KEY, s));
  store.hide = (root, u) => ignores.has(root, u);
  ctx.subscriptions.push(ignores.onDidChange(() => store.touch()));

  const diagnostics = new Diagnostics(store);
  const lenses = new Lenses(store, readConfig);
  const gutter = new Gutter(store, readConfig);
  const panel = new DetailPanel(ctx.extensionUri, {
    findings: () => store.findings(readConfig()),
    gates: readConfig,
    ignores,
    model: (root) => store.model(root),
  });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "vakt.findings.focus";
  ctx.subscriptions.push(log, diagnostics, gutter, panel, status);

  // Assigned once the scheduler exists (the list shows what is being scanned).
  // eslint-disable-next-line prefer-const
  let list: FindingsView | undefined;
  const render = () => {
    const cfg = readConfig();
    diagnostics.render(cfg);
    gutter.render();
    lenses.refresh();
    list?.refresh();
    void panel.refresh();
    updateStatus();
  };
  ctx.subscriptions.push(store.onDidChange(render));

  // ---- errors: one notification per distinct problem, everything else to the log
  let lastError: string | undefined;
  // Set when a scan fails for want of model access; cleared by the next successful scan.
  let modelMissing = false;
  const reportError = async (e: unknown) => {
    const err = e instanceof ScanError ? e : new ScanError("unknown", String((e as Error)?.message ?? e));
    if (err.kind === "cancelled") return;
    if (err.kind === "auth" || err.kind === "gated") {
      modelMissing = true;
      list?.refresh();
    }
    log.error(err.message);
    if (err.stderr) log.debug(err.stderr);
    if (err.message === lastError) return;
    lastError = err.message;
    updateStatus();
    const actions: string[] = [];
    if (err.kind === "auth" || err.kind === "gated" || err.kind === "offline") actions.push("Set Up Model");
    if (err.kind === "not-found" || err.kind === "no-engine") actions.push("Run Doctor");
    actions.push("Show Log");
    const pick = await vscode.window.showErrorMessage(`VAKT: ${err.message}`, ...actions);
    if (pick === "Set Up Model") void vscode.commands.executeCommand("vakt.setup");
    if (pick === "Run Doctor") void vscode.commands.executeCommand("vakt.doctor");
    if (pick === "Show Log") log.show();
  };

  // ---- binary
  const installInTerminal = () => {
    const t = vscode.window.createTerminal({ name: "VAKT install" });
    t.show();
    // Typed but not run: the user reviews and presses Enter.
    t.sendText(INSTALL_CMD, false);
  };
  const binary = (): string | undefined => resolveBinary(vscode.workspace.getConfiguration("vakt").get("path", ""));
  let warnedMissing = false;
  const requireBinary = async (): Promise<string | undefined> => {
    const bin = binary();
    if (bin) return bin;
    if (warnedMissing) return undefined;
    warnedMissing = true;
    const pick = await vscode.window.showWarningMessage(
      "vakt is not installed (looked in vakt.path, ~/.local/bin and PATH). It runs DOM-0.8B locally on Metal, CUDA or CPU.",
      "Install in Terminal",
      "Set Path",
    );
    if (pick === "Install in Terminal") {
      installInTerminal();
    } else if (pick === "Set Path") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "vakt.path");
    }
    return undefined;
  };

  const settings = (): ScanSettings => {
    const c = vscode.workspace.getConfiguration("vakt");
    return {
      threshold: c.get("threshold", 0.95),
      minConfidence: c.get("minConfidence", 0.9),
      precision: c.get("precision", "auto"),
      device: c.get("device", "auto"),
      topLevel: c.get("topLevel", false),
      // An untrusted repo's own ignore files must not be able to hide code from the scan.
      noRepoIgnores: c.get("noRepoIgnores", false) || !vscode.workspace.isTrusted,
    };
  };

  // ---- scanning
  const runJob = async (job: Job, signal: AbortSignal) => {
    const bin = await requireBinary();
    if (!bin) return;
    const label = job.files ? job.files.join(", ") : (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(job.root))?.name ?? "codebase");
    const started = Date.now();
    try {
      const rep = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `VAKT: scanning ${label}` },
        () =>
          runPatrol(bin, job.root, job.files ?? [], settings(), {
            signal,
            onSpawn: (c) => log.info(`$ ${c}`),
            // Findings appear as vakt scores them; the final report then replaces them.
            onUnit: (u) => store.addUnit(job.root, u),
          }),
      );
      lastError = undefined;
      modelMissing = false;
      store.apply(job.root, rep, job.files);
      log.info(
        `${rep.scan.units} units in ${rep.scan.files} files, ${rep.scan.cache_hits} cached, ` +
          `${Date.now() - started} ms (${rep.model.backend}, ${rep.model.device}, ${rep.model.precision})`,
      );
      for (const s of rep.scan.skipped ?? []) log.debug(`skipped ${s.file}: ${s.reason}`);
    } catch (e) {
      await reportError(e);
    }
  };
  const scheduler = new Scheduler(runJob);
  const scanningLabel = () => {
    const job = scheduler.current;
    if (!job) return scheduler.busy ? "(queued)" : undefined;
    if (job.files) return job.files.map((f) => f.split("/").pop()).join(", ");
    // A whole folder: never its path. In a multi-root workspace, its name says which.
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.length > 1 ? (folders.find((f) => f.uri.fsPath === job.root)?.name ?? "codebase") : "codebase";
  };
  list = new FindingsView(ctx.extensionUri, {
    findings: () => store.findings(readConfig()),
    stats: () => store.stats(readConfig()),
    hasResults: () => store.roots().length > 0,
    scanning: scanningLabel,
    ignored: () => ignores.size,
    setup: () => ({ binary: binary() !== undefined, model: !modelMissing && (store.roots().length > 0 || modelCached()) }),
    selected: () => panel.selection,
  });
  const updateStatus = () => {
    const n = store.findings(readConfig()).length;
    if (scheduler.busy) {
      status.text = "$(vakt-logo) $(sync~spin)";
    } else {
      status.text = `$(vakt-logo) ${n}`;
    }
    if (lastError) status.text += " $(warning)";
    status.tooltip = lastError
      ? `VAKT: ${lastError}`
      : `${n} finding${n === 1 ? "" : "s"} at the current thresholds. Click to open.`;
    status.show();
  };
  ctx.subscriptions.push(
    scheduler.onDidChangeBusy((busy) => {
      void vscode.commands.executeCommand("setContext", "vakt.busy", busy);
      list?.refresh();
      updateStatus();
    }),
    { dispose: () => scheduler.cancel() },
  );

  const scanUri = (uri: vscode.Uri | undefined, immediate: boolean) => {
    const loc = uri && locate(uri);
    if (!loc) {
      if (immediate) void vscode.window.showInformationMessage("VAKT scans files inside an open workspace folder.");
      return;
    }
    scheduler.enqueue({ root: loc.root, files: [loc.rel] }, immediate);
  };

  // ---- live scanning: `vakt serve` keeps the model loaded and scores the
  // buffer being edited (unsaved text included) once typing pauses.
  const LIVE_DEBOUNCE_MS = 1500;
  let live: LiveScorer | undefined;
  const liveEnabled = () => vscode.workspace.getConfiguration("vakt").get("scanOnType", true);
  const liveTimers = new Map<string, NodeJS.Timeout>();
  const liveScanNow = async (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    clearTimeout(liveTimers.get(key));
    liveTimers.delete(key);
    const loc = locate(doc.uri);
    const bin = binary();
    if (!loc || !bin || !hasGrammar(loc.rel) || doc.isClosed) return;
    live ??= new LiveScorer(bin, serveArgs(settings()), (m) => log.info(m));
    if (!live.supported) {
      if (!doc.isDirty) scheduler.enqueue({ root: loc.root, files: [loc.rel] });
      return;
    }
    try {
      const units = await live.score(loc.root, loc.rel, doc.getText());
      if (units) store.setFile(loc.root, loc.rel, units);
      if (modelMissing) {
        modelMissing = false;
        list?.refresh();
      }
    } catch (e) {
      const err = e instanceof ScanError ? e : new ScanError("unknown", String(e));
      if (err.kind === "cancelled") return;
      if (!live?.supported) {
        log.info("this VAKT CLI has no `serve` command: scanning on save only (update the CLI for live scanning)");
        if (vscode.workspace.getConfiguration("vakt").get("scanOnSave", true) && !doc.isDirty) {
          scheduler.enqueue({ root: loc.root, files: [loc.rel] });
        }
        return;
      }
      if (err.kind === "auth" || err.kind === "gated" || /not cached/i.test(err.message)) {
        modelMissing = true;
        list?.refresh();
      }
      // Live scans run on every pause in typing: log, don't notify.
      log.warn(`live scan of ${loc.rel}: ${err.message}`);
    }
  };
  const liveScanSoon = (doc: vscode.TextDocument) => {
    const loc = locate(doc.uri);
    if (!loc || !hasGrammar(loc.rel)) return;
    const key = doc.uri.toString();
    clearTimeout(liveTimers.get(key));
    liveTimers.set(key, setTimeout(() => void liveScanNow(doc), LIVE_DEBOUNCE_MS));
  };

  // ---- past results: shown at startup from <root>/.vakt, without the model
  const loadSaved = async () => {
    const bin = binary();
    if (!bin) return;
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== "file") continue;
      const root = f.uri.fsPath;
      const rep = await runResults(bin, root, settings());
      // A scan that finished first has newer results; keep those.
      if (rep && rep.units.length && store.files(root).length === 0) {
        store.apply(root, rep);
        log.info(`loaded ${rep.units.length} stored results for ${f.name} from .vakt`);
      }
    }
  };
  void loadSaved();

  // ---- providers and views
  ctx.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lenses),
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new Reviews(store, readConfig), { providedCodeActionKinds: Reviews.kinds }),
    vscode.window.registerWebviewViewProvider(FindingsView.id, list),
    panel.onDidChangeSelection(() => list?.refresh()),
    vscode.window.onDidChangeVisibleTextEditors((eds) => gutter.render(eds)),
  );

  // ---- commands
  const terminalCommand = async (name: string, args: string[]) => {
    const bin = await requireBinary();
    if (!bin) return;
    const t = vscode.window.createTerminal({ name, shellPath: bin, shellArgs: args });
    t.show();
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand("vakt.scanFile", (uri?: vscode.Uri) =>
      scanUri(uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri, true),
    ),
    vscode.commands.registerCommand("vakt.scanWorkspace", () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (!folders.length) return void vscode.window.showInformationMessage("Open a folder to scan it with vakt.");
      for (const f of folders) if (f.uri.scheme === "file") scheduler.enqueue({ root: f.uri.fsPath }, true);
    }),
    vscode.commands.registerCommand("vakt.cancel", () => scheduler.cancel()),
    vscode.commands.registerCommand("vakt.clear", () => store.clear()),
    vscode.commands.registerCommand("vakt.setup", () => terminalCommand("vakt summon", ["summon"])),
    vscode.commands.registerCommand("vakt.doctor", () => terminalCommand("vakt doctor", ["doctor"])),
    vscode.commands.registerCommand("vakt.showOutput", () => log.show()),
    vscode.commands.registerCommand("vakt.showFinding", (root: string, u: Unit) => panel.show(root, u)),
    // Kept for links created by older lenses; same behaviour.
    vscode.commands.registerCommand("vakt.revealFinding", (root: string, u: Unit) => panel.show(root, u)),
    vscode.commands.registerCommand("vakt.showFindingAtCursor", () => {
      const ed = vscode.window.activeTextEditor;
      const loc = ed && locate(ed.document.uri);
      if (!ed || !loc) return;
      const line = ed.selection.active.line + 1;
      const u = store.fileFindings(loc.root, loc.rel, readConfig()).find((x) => x.start_line <= line && line <= x.end_line);
      if (u) void panel.show(loc.root, u, false);
      else void vscode.window.setStatusBarMessage("VAKT: no finding at the cursor", 2500);
    }),
    vscode.commands.registerCommand("vakt.ignoreFinding", (arg?: { root: string; unit: Unit }) => {
      if (arg?.unit) ignores.ignoreUnit(arg.root, arg.unit);
    }),
    vscode.commands.registerCommand("vakt.install", installInTerminal),
    vscode.commands.registerCommand("vakt.clearIgnores", async () => {
      if (!ignores.size) return void vscode.window.showInformationMessage("VAKT: nothing is ignored in this workspace.");
      const ok = await vscode.window.showWarningMessage(`Restore ${ignores.size} ignored finding(s) and file(s)?`, { modal: true }, "Restore");
      if (ok) ignores.clear();
    }),
    vscode.commands.registerCommand("vakt.reviewWithAgent", async (root: string, u: Unit) => {
      // Resolve: hand the finding to the editor's agent to review and fix.
      const doc = await vscode.workspace.openTextDocument(fileUri(root, u.file));
      const end = Math.min(u.end_line, doc.lineCount);
      const src = doc.getText(new vscode.Range(u.start_line - 1, 0, end - 1, doc.lineAt(end - 1).text.length));
      const prompt = reviewPrompt(u, src, doc.languageId);
      const target = agentTarget(vscode.env.appName, await vscode.commands.getCommands(true));
      try {
        if (target === "cursor") {
          await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt });
          void vscode.window.setStatusBarMessage("VAKT: review is ready in Chat. Press Enter to send it to the agent.", 6000);
          return;
        }
        if (target === "vscode-agent") {
          await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt, mode: "agent" });
          return;
        }
      } catch (e) {
        log.warn(`could not open the agent (${target}): ${(e as Error).message}`);
      }
      await vscode.env.clipboard.writeText(prompt);
      void vscode.window.showInformationMessage("VAKT: no chat agent found here, so the review prompt was copied. Paste it into your coding agent.");
    }),
    vscode.commands.registerCommand("vakt.copyReviewPrompt", async (root: string, u: Unit) => {
      const doc = await vscode.workspace.openTextDocument(fileUri(root, u.file));
      const end = Math.min(u.end_line, doc.lineCount);
      const src = doc.getText(new vscode.Range(u.start_line - 1, 0, end - 1, doc.lineAt(end - 1).text.length));
      await vscode.env.clipboard.writeText(reviewPrompt(u, src, doc.languageId));
      void vscode.window.setStatusBarMessage("VAKT: review prompt copied", 3000);
    }),
  );

  // ---- triggers
  ctx.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!vscode.workspace.getConfiguration("vakt").get("scanOnSave", true)) return;
      const loc = locate(doc.uri);
      if (!loc || !hasGrammar(loc.rel)) return;
      // With live scanning the saved text was (or is about to be) scored already.
      if (liveEnabled() && live?.supported !== false) return void liveScanNow(doc);
      scheduler.enqueue({ root: loc.root, files: [loc.rel] });
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length && liveEnabled()) liveScanSoon(e.document);
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      // A file with no stored or scanned results is scored when it is opened.
      const loc = locate(doc.uri);
      if (loc && liveEnabled() && hasGrammar(loc.rel) && store.units(loc.root, loc.rel).length === 0) liveScanSoon(doc);
    }),
    { dispose: () => live?.stop() },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vakt.threshold") || e.affectsConfiguration("vakt.minConfidence") || e.affectsConfiguration("vakt.diagnosticSeverity")) {
        render(); // gates are re-applied locally: no re-scan needed
      }
      if (["vakt.path", "vakt.threshold", "vakt.minConfidence", "vakt.precision", "vakt.device", "vakt.topLevel"].some((k) => e.affectsConfiguration(k))) {
        // Restarted with the new settings on the next edit.
        live?.stop();
        live = undefined;
      }
      if (e.affectsConfiguration("vakt.path")) {
        warnedMissing = false;
        list?.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const f of e.removed) store.clear(f.uri.fsPath);
    }),
    // Re-anchor diagnostics to the real signature line once the document text is available.
    vscode.workspace.onDidOpenTextDocument(() => diagnostics.render(readConfig())),
  );

  updateStatus();
  if (vscode.workspace.isTrusted && vscode.workspace.getConfiguration("vakt").get("scanWorkspaceOnOpen", false)) {
    void vscode.commands.executeCommand("vakt.scanWorkspace");
  }
}

export function deactivate(): void {
  // Subscriptions (including the scheduler's cancel) are disposed by VS Code.
}
