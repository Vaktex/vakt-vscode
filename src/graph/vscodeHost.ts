import * as vscode from "vscode";
import * as path from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildGraphAsync, repoId } from "./build";
import { GraphUploader } from "./upload";
import type { GraphClient } from "./upload";
import type { SourceInput } from "./types";
import type { ResultStore } from "../store";
import { isSafeRelPath } from "../report";

const COOLDOWN = 6 * 3_600_000;
const EXCLUDE = "**/{.git,node_modules,vendor,dist,build,out,coverage,.next,.svelte-kit,generated,__generated__,.cache}/**";
export function safeGraphPath(rel: string): boolean {
  return isSafeRelPath(rel) && !/(?:^|\/)(?:\.[^/]+|node_modules|vendor|dist|build|out|coverage|generated|__generated__)(?:\/|$)/i.test(rel)
    && !/(?:^|\/)(?:.*\.(?:pem|key|p12|pfx|crt|cer)|.*(?:secret|credential).*|id_rsa|id_ed25519)$/i.test(rel)
    && /\.(?:[cm]?[jt]sx?|svelte)$/i.test(rel) && !/\.(?:min|generated|g)\.[^.]+$/i.test(rel);
}
/** Fail closed if Git cannot establish that the file is not ignored. */
function notIgnored(root: string, rel: string, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => execFile("git", ["-C", root, "check-ignore", "--no-index", "--quiet", "--", rel], { timeout: 3000, signal }, error => {
    resolve(!!error && (error as NodeJS.ErrnoException & { code?: number }).code === 1);
  }));
}

/** Deliberately limited to already-scanned Unit files; never broadly reads a workspace. */
export class GraphHost implements vscode.Disposable {
  private timer?: NodeJS.Timeout;
  private controller?: AbortController;
  private disposed = false;
  private readonly last = new Map<string, number>();
  private readonly salt: string;
  private readonly saltReady: Thenable<void>;
  constructor(private readonly opts: {
    context: vscode.ExtensionContext; store: ResultStore; client: GraphClient;
    enabled: () => boolean; refresh: () => void | Promise<void>; log: (message: string) => void;
  }) {
    this.salt = opts.context.globalState.get<string>("vakt.repoSalt") || randomUUID();
    this.saltReady = opts.context.globalState.update("vakt.repoSalt", this.salt);
  }
  private allowed = () => !this.disposed && vscode.workspace.isTrusted && this.opts.enabled() && this.opts.client.available;
  cancel(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.controller?.abort(); }
  dispose(): void { this.disposed = true; this.cancel(); }
  schedule(root: string): void {
    if (!this.allowed() || this.controller) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.upload(root); }, 2000);
  }
  async upload(root: string, explicit = false): Promise<void> {
    const cooldownKey = `vakt.graphUploaded.${repoId(this.salt, root)}`;
    const last = this.last.get(root) ?? this.opts.context.globalState.get<number>(cooldownKey, 0);
    if (!this.allowed() || this.controller || (!explicit && Date.now() - last < COOLDOWN)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const controller = this.controller = new AbortController();
    const active = () => this.allowed() && !controller.signal.aborted;
    try {
      await this.saltReady;
      if (!active()) return;
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
      if (!folder || folder.uri.scheme !== "file" || folder.uri.fsPath !== root) return;
      const canonicalRoot = await realpath(root);
      const units = this.opts.store.all().filter(f => f.root === root).map(f => f.unit);
      const scanned = new Set(units.map(u => u.file).filter(safeGraphPath));
      // Discovery only; only paths already represented in the completed scan may be read.
      const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,svelte}"), EXCLUDE, 2001);
      if (found.length > 2000 || !active()) return;
      const inputs: SourceInput[] = [];
      let bytes = 0;
      for (const uri of found) {
        const rel = path.relative(root, uri.fsPath).split(path.sep).join("/");
        if (!scanned.has(rel) || !safeGraphPath(rel) || !active()) continue;
        if (!await notIgnored(root, rel, controller.signal) || !active()) continue;
        // Reject symlinked ancestors as well as symlink files, before any source read.
        let current = root;
        let safe = true;
        for (const segment of rel.split("/")) {
          current = path.join(current, segment);
          if ((await lstat(current)).isSymbolicLink()) { safe = false; break; }
        }
        if (!safe) continue;
        const canonical = await realpath(uri.fsPath);
        if (!canonical.startsWith(canonicalRoot + path.sep)) continue;
        const stat = await lstat(canonical);
        if (!stat.isFile() || stat.size > 256 * 1024 || !active()) continue;
        if (bytes + stat.size > 4 * 1024 * 1024 || inputs.length >= 200) break;
        const code = await readFile(canonical, { encoding: "utf8", signal: controller.signal });
        bytes += Buffer.byteLength(code);
        if (bytes > 4 * 1024 * 1024) break;
        inputs.push({ path: rel, code });
      }
      if (!inputs.length || !active()) return;
      const graph = await buildGraphAsync(inputs, { installSalt: this.salt, repoSalt: this.salt, workspacePath: root, units });
      if (!active()) return;
      this.last.set(root, Date.now());
      await this.opts.context.globalState.update(cooldownKey, this.last.get(root));
      const result = await new GraphUploader({ client: this.opts.client, enabled: active, done: this.opts.refresh }).upload(graph, controller.signal);
      this.opts.log(`graph upload: ${result} (bounded scanned-file coverage)`);
    } catch {
      // Never log paths, code, server responses, or identity material.
      this.opts.log("graph upload skipped or cancelled");
    } finally { if (this.controller === controller) this.controller = undefined; }
  }
}
