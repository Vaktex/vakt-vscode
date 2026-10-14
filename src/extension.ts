import * as vscode from "vscode";
import { AccountTracker, AccountView } from "./account";
import { CloudAuth } from "./auth";
import { GraphHost } from "./graph/vscodeHost";
import { LiveScorer, modelCached, resolveBinary, runPatrol, runResults, ScanError, ScanSettings, serveArgs } from "./cli";
import { randomUUID } from "node:crypto";
import { Capped, CloudClient, cloudLanguage, CloudReview, CloudVerdict, MAX_FUNCTION_CHARS, RETRY_MS, VerdictCache } from "./cloud";
import { agentTarget, hasGrammar, reviewPrompt } from "./present";
import { sanitize, Unit } from "./report";
import { Job, Scheduler } from "./scheduler";
import { Ignores, IgnoreState } from "./ignores";
import { FindingsView } from "./listView";
import { DetailPanel } from "./panel";
import { ResultStore } from "./store";
import { Diagnostics, fileUri, Gutter, Lenses, locate, readConfig, Reviews } from "./ui";

const INSTALL_CMD = "curl -fsSL https://get.vaktex.com/oss-vakt | sh";
const IGNORES_KEY = "vakt.ignores";
const VERDICTS_KEY = "vakt.cloudVerdicts";
const INSTALL_ID_KEY = "vakt.installId";

export function activate(ctx: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("VAKT", { log: true });
  const store = new ResultStore();
  // Per-workspace, kept in VS Code's storage rather than a file in the repo.
  const ignores = new Ignores(ctx.workspaceState.get<IgnoreState>(IGNORES_KEY), (s) => ctx.workspaceState.update(IGNORES_KEY, s));
  store.hide = (root, u) => ignores.has(root, u);
  ctx.subscriptions.push(ignores.onDidChange(() => store.touch()));

  // ---- cloud review (src/cloud.ts): off entirely with vakt.fullyLocal
  const cloudAllowed = () => {
    const c = vscode.workspace.getConfiguration("vakt");
    const local = c.get("fullyLocal", false);
    return { review: !local && c.get("improvedResponses", true), fix: !local };
  };
  // Sign-in to vaktex.com (src/auth.ts): the token lives in SecretStorage and only raises the spend cap.
  const auth = new CloudAuth(ctx, log);
  ctx.subscriptions.push(auth);
  const cloud = new CloudClient({
    version: String(ctx.extension.packageJSON.version ?? "0.0.0"),
    log: (m) => log.info(m),
    token: () => auth.token(),
    onUnauthorized: () => auth.onUnauthorized(),
    installId: installId(ctx),
    onCapped: (c) => void showCapped(c),
    // Already signed in (email not verified yet): the account line says what to do instead.
    onLimited: () => void (auth.signedIn || showLimited()),
    onResponse: () => account.refresh(),
  });
  // The account line in the sidebar: read on activation, on sign-in, and after cloud calls (throttled).
  const account = new AccountTracker({
    fetch: () => cloud.account(),
    active: () => auth.signedIn && !vscode.workspace.getConfiguration("vakt").get("fullyLocal", false),
    changed: () => list?.refresh(),
  });
  // Shown when something would use the account: cloud review, or (signed in) cloud fixes.
  const accountView = (): AccountView | undefined => {
    const allowed = cloudAllowed();
    if (!allowed.review && !(allowed.fix && auth.signedIn)) return undefined;
    return { signedIn: auth.signedIn, account: auth.signedIn ? account.account : undefined };
  };
  ctx.subscriptions.push(
    auth.onDidChange((signedIn) => {
      account.clear();
      if (signedIn) account.refresh(true);
      list?.refresh();
    }),
  );
  const verdicts = new VerdictCache(ctx.globalState.get<Record<string, CloudVerdict>>(VERDICTS_KEY), (s) => ctx.globalState.update(VERDICTS_KEY, s));
  ctx.subscriptions.push({ dispose: () => verdicts.flush() });
  const review = new CloudReview({
    client: cloud,
    enabled: () => cloudAllowed().review,
    read: async (root, u) => {
      const uri = fileUri(root, u.file);
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      // An unopened file is read from disk rather than opened, which would fire open-document handlers.
      const text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      const lines = text.split(/\r?\n/);
      if (u.end_line > lines.length) return undefined;
      return { code: lines.slice(u.start_line - 1, u.end_line).join("\n"), language: cloudLanguage(u.language, open?.languageId) };
    },
    changed: () => render(),
    cache: verdicts,
    localModel: (root) => store.model(root)?.revision,
    log: (m) => log.info(m),
  });
  const graph = new GraphHost({ context: ctx, store, client: cloud,
    enabled: () => cloudAllowed().review,
    refresh: () => review.refresh(store.candidates(readConfig())),
    log: (message) => log.info(message),
  });
  ctx.subscriptions.push(graph);
  store.view = (root, u, g) => review.view(root, u, g);
  // An ignored finding is the user saying it is wrong or not worth fixing: worth knowing, with its code.
  ctx.subscriptions.push(
    ignores.onWillIgnore(({ root, file, unit }) => {
      const shown = unit ? [unit] : store.fileFindings(root, file, readConfig());
      void review.reportFeedback("ignore", root, unit ? "unit" : "file", shown);
    }),
  );

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
  // Functions DOM-0.8B passed are scored for importance (path and code) once results settle.
  let sweepTimer: NodeJS.Timeout | undefined;
  const sweepSoon = () => {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(() => review.sweep(store.all(), readConfig()), 2_000);
  };
  // Verdicts already shown are re-checked by hash now and then: a better model or the crowd may know more.
  const REFRESH_MS = 6 * 3_600_000;
  const refreshTimers = [
    setTimeout(() => review.refresh(store.candidates(readConfig())), 60_000),
    setInterval(() => review.refresh(store.candidates(readConfig())), REFRESH_MS),
    // Findings the cloud could not answer for stay held back: ask again once it is reachable.
    setInterval(() => review.validate(store.candidates(readConfig())), RETRY_MS),
  ];
  ctx.subscriptions.push(
    store.onDidChange(render),
    // After render: anything new it held back is queued for review here.
    store.onDidChange(() => {
      review.validate(store.candidates(readConfig()));
      sweepSoon();
    }),
    { dispose: () => [sweepTimer, ...refreshTimers].forEach((t) => clearTimeout(t)) },
  );

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
      cloudRescan(job);
      if (!job.files && !signal.aborted) graph.schedule(job.root);
      log.info(
        `${rep.scan.units} units in ${rep.scan.files} files, ${rep.scan.cache_hits} cached, ` +
          `${Date.now() - started} ms (${rep.model.backend}, ${rep.model.device}, ${rep.model.precision})`,
      );
      for (const s of rep.scan.skipped ?? []) log.debug(`skipped ${s.file}: ${s.reason}`);
    } catch (e) {
      for (const k of rescans) if (k.root === job.root) rescans.delete(k);
      await reportError(e);
    }
  };

  // Files the user asked to rescan: once vakt has scored them, cloud review re-reviews every function.
  const rescans = new Set<{ root: string; rel: string }>();
  const cloudRescan = (job: Job) => {
    for (const k of [...rescans]) {
      if (k.root !== job.root || (job.files && !job.files.includes(k.rel))) continue;
      rescans.delete(k);
      if (!cloudAllowed().review) continue;
      void vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `VAKT: cloud review of ${k.rel.split("/").pop()}` }, () =>
        review.rescan(k.root, store.units(k.root, k.rel), readConfig()),
      );
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
    setup: () => ({
      binary: binary() !== undefined,
      model: !modelMissing && (store.roots().length > 0 || modelCached()),
      // No step when nothing would use the account.
      signedIn: cloudAllowed().review ? auth.signedIn : undefined,
    }),
    account: accountView,
    selected: () => panel.selection,
  });
  const updateStatus = () => {
    const cfg = readConfig();
    const n = store.findings(cfg).length;
    const held = review.held(store.candidates(cfg));
    // A scan shows its own progress item ("VAKT: scanning …"); this one spins only for cloud review.
    status.text = !scheduler.busy && review.pending > 0 ? "$(vakt-logo) $(sync~spin)" : `$(vakt-logo) ${n}`;
    if (lastError) status.text += " $(warning)";
    const waiting = held
      ? ` ${held} more waiting for cloud review${cloud.available ? "" : " (cloud unreachable, retrying)"}.`
      : "";
    status.tooltip = lastError
      ? `VAKT: ${lastError}`
      : `${n} finding${n === 1 ? "" : "s"} at the current thresholds.${waiting} Click to open.`;
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
    if (immediate) {
      if (![...rescans].some((k) => k.root === loc.root && k.rel === loc.rel)) rescans.add(loc);
      // Asking for a rescan says something about what was showing: report it as it was.
      void review.reportFeedback("rescan", loc.root, "file", store.fileFindings(loc.root, loc.rel, readConfig()));
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

  // ---- cloud fixes: shown as a diff, applied only when the user accepts
  const proposals = new Map<string, string>();
  let proposalSeq = 0;
  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("vakt-fix", { provideTextDocumentContent: (uri) => proposals.get(uri.toString()) ?? "" }),
  );
  const copyPrompt = async (u: Unit, src: string, languageId: string, why: string) => {
    await vscode.env.clipboard.writeText(reviewPrompt(u, src, languageId));
    void vscode.window.showWarningMessage(`VAKT: ${why} The review prompt was copied instead; paste it into a coding agent.`);
  };
  const fixWithCloud = async (root: string, u: Unit) => {
    const doc = await vscode.workspace.openTextDocument(fileUri(root, u.file));
    const end = Math.min(u.end_line, doc.lineCount);
    const range = new vscode.Range(u.start_line - 1, 0, end - 1, doc.lineAt(end - 1).text.length);
    const original = doc.getText(range);
    if (!cloudAllowed().fix) return copyPrompt(u, original, doc.languageId, "cloud fixes are off (VAKT: Fully Local).");
    if (original.length > MAX_FUNCTION_CHARS) return copyPrompt(u, original, doc.languageId, "this function is too long for a cloud fix.");

    let fix;
    try {
      fix = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `VAKT: writing a fix for ${sanitize(u.name, 80) || `line ${u.start_line}`}…` },
        () => cloud.fix({ language: cloudLanguage(u.language, doc.languageId), code: original, family: u.top_family, explanation: u.cloud ? u.explanation : undefined }),
      );
    } catch (e) {
      log.warn(`cloud fix: ${(e as Error).message}`);
      return copyPrompt(u, original, doc.languageId, "the cloud could not write a fix right now.");
    }
    if (!fix.fixed) return void vscode.window.showInformationMessage(`VAKT: no change needed. ${sanitize(fix.summary, 300)}`);

    const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const code = fix.code.replace(/\r?\n/g, eol);
    const whole = doc.getText();
    const proposed = whole.slice(0, doc.offsetAt(range.start)) + code + whole.slice(doc.offsetAt(range.end));
    const right = vscode.Uri.from({ scheme: "vakt-fix", path: doc.uri.path, query: String(++proposalSeq) });
    proposals.set(right.toString(), proposed);
    try {
      await vscode.commands.executeCommand("vscode.diff", doc.uri, right, `${u.file.split("/").pop()} ↔ VAKT fix`, { preview: true });
      const pick = await vscode.window.showInformationMessage(`VAKT fix: ${sanitize(fix.summary, 300)}`, "Accept", "Reject");
      if (pick === "Accept") {
        if (doc.getText(range) !== original) {
          void vscode.window.showWarningMessage("VAKT: the function changed while the fix was open, so it was not applied.");
        } else {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(doc.uri, range, code);
          if (await vscode.workspace.applyEdit(edit)) void vscode.window.setStatusBarMessage("VAKT: fix applied. Review and save the file.", 5000);
        }
      }
    } finally {
      const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === right.toString());
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      proposals.delete(right.toString());
    }
  };

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
    vscode.commands.registerCommand("vakt.uploadGraph", async () => {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        if (folder.uri.scheme === "file") await graph.upload(folder.uri.fsPath, true);
      }
    }),
    vscode.commands.registerCommand("vakt.cancel", () => { scheduler.cancel(); graph.cancel(); }),
    vscode.commands.registerCommand("vakt.clear", () => {
      review.clear();
      store.clear();
    }),
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
      // No agent in this editor: VAKT Cloud writes the fix, unless the user keeps everything local.
      if (cloudAllowed().fix) return void vscode.commands.executeCommand("vakt.fixWithCloud", root, u);
      await vscode.env.clipboard.writeText(prompt);
      void vscode.window.showInformationMessage("VAKT: no chat agent found here, so the review prompt was copied. Paste it into your coding agent.");
    }),
    vscode.commands.registerCommand("vakt.fixWithCloud", (root: string, u: Unit) => fixWithCloud(root, u)),
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
      if (e.affectsConfiguration("vakt.fullyLocal") || e.affectsConfiguration("vakt.improvedResponses")) graph.cancel();
      if (["vakt.threshold", "vakt.minConfidence", "vakt.diagnosticSeverity", "vakt.improvedResponses", "vakt.fullyLocal"].some((k) => e.affectsConfiguration(k))) {
        render(); // gates and cloud verdicts are re-applied locally: no re-scan needed
        review.validate(store.candidates(readConfig()));
        account.refresh();
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
      graph.cancel();
      for (const f of e.removed) {
        review.clear(f.uri.fsPath);
        store.clear(f.uri.fsPath);
      }
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

/** A random id for this install, created once (sent as `x-vakt-install`; the cloud's spend cap counts by it). */
function installId(ctx: vscode.ExtensionContext): string {
  let id = ctx.globalState.get<string>(INSTALL_ID_KEY);
  if (!id) {
    id = randomUUID();
    void ctx.globalState.update(INSTALL_ID_KEY, id);
  }
  return id;
}

/** Once per pause (CloudClient calls it once): today's limit is reached, and signing in raises it. */
// The pause may be shorter than the day (Retry-After), so no time is promised.
async function showLimited(): Promise<void> {
  const pick = await vscode.window.showInformationMessage("VAKT cloud review has reached today's limit. Local results continue. Signing in raises it.", "Sign in");
  if (pick === "Sign in") await vscode.commands.executeCommand("vakt.signIn").then(undefined, () => undefined);
}

/** Once per pause (CloudClient calls it once): the month's free cloud budget is spent. */
async function showCapped(c: Capped): Promise<void> {
  const date = new Date(c.resetsAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  const message = `VAKT cloud review has reached this month's free limit. Local results continue. Resets ${date}.`;
  const pick = c.signIn ? await vscode.window.showInformationMessage(message, "Sign In") : await vscode.window.showInformationMessage(message);
  // vakt.signIn is registered by the sign-in code (src/auth.ts); missing is harmless.
  if (pick === "Sign In") await vscode.commands.executeCommand("vakt.signIn").then(undefined, () => undefined);
}
