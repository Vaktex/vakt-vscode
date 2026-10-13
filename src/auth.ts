// Sign-in to vaktex.com ("VAKT: Sign In to Vaktex" / "VAKT: Sign Out").
// Signed-in users get the account's monthly cloud cap instead of the anonymous one.
//
// The browser does the signing in (Better Auth on vaktex.com); the token comes
// back through the editor's URI handler (<scheme>://vaktex.vakt-vscode/auth) and
// is kept in SecretStorage only: never in settings, globalState or the log. The
// callback URI is never logged either, since its query carries the token.
// Pure parts (state, URLs, callback checks) are in src/authFlow.ts.

import * as vscode from "vscode";
import { CLOUD_URL } from "./cloud";
import { callbackUri, PendingSignIns, readCallback, REDIRECT, signInUrl } from "./authFlow";

const SECRET_KEY = "vakt.cloudToken";
const REVOKE_TIMEOUT_MS = 10_000;

export class CloudAuth implements vscode.Disposable {
  private readonly pending = new PendingSignIns();
  private readonly disposables: vscode.Disposable[] = [];
  /** undefined: not read yet. null: no token. */
  private cached: string | null | undefined;
  private toldExpired = false;
  private readonly changed = new vscode.EventEmitter<boolean>();
  /** Signed in or out, here or in another window (fires with signedIn). Also once the token is first read. */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.disposables.push(
      vscode.window.registerUriHandler({ handleUri: (uri) => this.handleUri(uri) }),
      vscode.commands.registerCommand("vakt.signIn", () => this.signIn()),
      vscode.commands.registerCommand("vakt.signOut", () => this.signOut()),
      // Another window signed in or out: SecretStorage is shared, the cache is not.
      ctx.secrets.onDidChange((e) => {
        if (e.key === SECRET_KEY) void this.reload();
      }),
      this.changed,
    );
    void this.token();
  }

  /** Whether a token is stored. False until it has been read (onDidChange fires then). */
  get signedIn(): boolean {
    return !!this.cached;
  }

  /** The sign-in token for cloud calls, or undefined when signed out. */
  async token(): Promise<string | undefined> {
    if (this.cached === undefined) this.set((await this.ctx.secrets.get(SECRET_KEY)) ?? null);
    return this.cached ?? undefined;
  }

  private async reload(): Promise<void> {
    this.set((await this.ctx.secrets.get(SECRET_KEY)) ?? null);
  }

  /** The one place the cached token changes, so listeners hear of every change. */
  private set(token: string | null): void {
    if (token === this.cached) return;
    this.cached = token;
    this.changed.fire(this.signedIn);
  }

  /** The server refused our token (revoked or expired): forget it and say so once. */
  onUnauthorized(): void {
    void this.clear().then(() => {
      if (this.toldExpired) return;
      this.toldExpired = true;
      this.log.warn("vaktex.com sign-in expired or was revoked; signed out");
      void vscode.window
        .showWarningMessage("VAKT: your Vaktex sign-in has expired. Cloud review continues with the standard limit.", "Sign In")
        .then((pick) => pick && vscode.commands.executeCommand("vakt.signIn"));
    });
  }

  private async signIn(): Promise<void> {
    const local = vscode.Uri.parse(callbackUri(vscode.env.uriScheme));
    let redirect = (await vscode.env.asExternalUri(local)).toString(true);
    // In a browser-hosted editor asExternalUri can give an https URL the site will refuse.
    if (!REDIRECT.test(redirect)) redirect = local.toString(true);
    const url = signInUrl(CLOUD_URL, this.pending.start(), redirect);
    if (!url) {
      void vscode.window.showErrorMessage(`VAKT: sign-in is not supported in this editor (${vscode.env.uriScheme}).`);
      return;
    }
    const opened = await vscode.env.openExternal(vscode.Uri.parse(url, true));
    if (!opened) {
      void vscode.window.showErrorMessage("VAKT: could not open the browser to sign in.");
      return;
    }
    void vscode.window.setStatusBarMessage("VAKT: finish signing in in your browser", 10_000);
  }

  private async handleUri(uri: vscode.Uri): Promise<void> {
    const result = readCallback(uri.path, uri.query, this.pending);
    if (!result.ok) {
      // Path and reason only: the query carries the token.
      this.log.warn(`sign-in callback refused (${result.reason}) for path ${uri.path.slice(0, 40)}`);
      if (result.reason !== "path") {
        void vscode.window.showErrorMessage("VAKT: that sign-in link has expired or was not started here. Run “VAKT: Sign In to Vaktex” again.");
      }
      return;
    }
    const previous = await this.token();
    await this.ctx.secrets.store(SECRET_KEY, result.token);
    this.set(result.token);
    this.toldExpired = false;
    if (previous && previous !== result.token) void this.revoke(previous);
    this.log.info("signed in to vaktex.com");
    void vscode.window.showInformationMessage("VAKT: signed in to Vaktex. Cloud review now uses your account's limit.");
  }

  private async signOut(): Promise<void> {
    const token = await this.token();
    if (!token) return void vscode.window.showInformationMessage("VAKT: you are not signed in to Vaktex.");
    await this.clear();
    void this.revoke(token); // best effort: the token is gone from this machine either way
    this.log.info("signed out of vaktex.com");
    void vscode.window.showInformationMessage("VAKT: signed out of Vaktex.");
  }

  private async clear(): Promise<void> {
    this.set(null);
    await this.ctx.secrets.delete(SECRET_KEY);
  }

  private async revoke(token: string): Promise<void> {
    try {
      await fetch(`${CLOUD_URL}/api/vakt/auth/revoke`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "x-vakt-client": `vscode/${String(this.ctx.extension.packageJSON.version ?? "0.0.0")}`,
        },
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
    } catch (e) {
      this.log.warn(`could not revoke the old sign-in token: ${(e as Error).name}`);
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
