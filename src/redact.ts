// Anonymising code before it leaves the machine. No vscode import, so it is unit-testable.
//
// Only the function's own source is ever sent (no path, file or repository
// name), and keys, tokens, URL credentials and email addresses in it are
// replaced by numbered placeholders first. A placeholder is still a literal, so
// "this function hard-codes a secret" survives; the value does not. restore()
// puts the originals back into a fix the cloud returns.

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^\s:/@'"]+:[^\s@'"]+(?=@)/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
];

export interface Redacted {
  code: string;
  /** Placeholder -> original text. */
  secrets: Map<string, string>;
}

export function redact(code: string): Redacted {
  const secrets = new Map<string, string>();
  const byValue = new Map<string, string>();
  let out = code;
  for (const re of PATTERNS) {
    out = out.replace(re, (m) => {
      let ph = byValue.get(m);
      if (!ph) {
        ph = `REDACTED_SECRET_${secrets.size + 1}`;
        byValue.set(m, ph);
        secrets.set(ph, m);
      }
      return ph;
    });
  }
  return { code: out, secrets };
}

/** Put the originals back into code that came back from the cloud. */
export function restore(code: string, secrets: ReadonlyMap<string, string>): string {
  return secrets.size ? code.replace(/REDACTED_SECRET_\d+/g, (ph) => secrets.get(ph) ?? ph) : code;
}
