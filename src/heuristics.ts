// How security-relevant a function looks, from its path and its code. No
// vscode import, so it is unit-testable.
//
// DOM-0.8B misses some vulnerable functions. Rather than send everything to
// the cloud, functions it passed are scored here, on this machine, and only
// the ones that score IMPORTANT or more are checked by cloud review "just in
// case" (src/cloud.ts, mode "important"). The path never leaves the machine.
//
// A rough score, not a verdict: signals add up, test and UI code count against.

export const IMPORTANT = 5;

type Signal = [RegExp, number, string];

const PATH: Signal[] = [
  [/(^|[/_.-])(auth|login|logout|signin|signup|session|oauth|sso|jwt|token|password|credential)s?([/_.-]|$)/i, 3, "auth path"],
  [/(^|[/_.-])(admin|payment|billing|checkout|stripe|invoice|wallet)s?([/_.-]|$)/i, 3, "sensitive area"],
  [/(^|\/)(api|routes?|controllers?|handlers?|endpoints?|server|middleware|webhooks?|graphql|rpc)(\/|\.|$)|\+server\.|\+page\.server\.|hooks\.server\./i, 2, "request handler path"],
  [/(^|[/_.-])(crypto|security|secrets?|keys?|permissions?|acl|rbac|policy|policies)([/_.-]|$)/i, 2, "security path"],
  [/(^|[/_.-])(db|sql|queries|query|repository|repositories|dao|models?)([/_.-]|$)/i, 1, "data path"],
  [/(^|[/_.-])(upload|uploads|files?|storage|download)([/_.-]|$)/i, 1, "file path"],
];

const NOT_IMPORTANT: Signal[] = [
  [/(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures?|mocks?|__mocks__|stories|storybook|examples?|docs?)(\/|$)|\.(test|spec|e2e|stories)\.[a-z]+$|\.d\.ts$/i, -6, "test or docs"],
  [/(^|\/)(components\/ui|styles?|assets|icons?|locales?|i18n)(\/|$)/i, -3, "UI or assets"],
];

const CODE: Signal[] = [
  [/\b(exec|execSync|spawn|spawnSync|execFile|popen|system|shell_exec|passthru|proc_open|Runtime\.getRuntime)\s*\(|\bsubprocess\.|child_process|os\.system|ProcessBuilder/, 4, "runs commands"],
  [/\beval\s*\(|new\s+Function\s*\(|\bexecScript\b|vm\.runIn/, 4, "evaluates code"],
  [/\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^;\n]*(["'`]\s*\+|\+\s*\w|\$\{|%s|\{\w*\}|\.format\(|f["'])/i, 4, "builds SQL from strings"],
  [/\b(pickle\.loads?|yaml\.load\b|yaml\.unsafe_load|unserialize|ObjectInputStream|Marshal\.load|BinaryFormatter|readObject\s*\()/, 4, "deserialises input"],
  [/innerHTML\s*=|outerHTML\s*=|dangerouslySetInnerHTML|\{@html\b|v-html|document\.write\(|\|\s*safe\b|mark_safe\(|html_safe/, 3, "writes raw HTML"],
  [/\b(req|request)\.(body|query|params|args|form|files|GET|POST|cookies|headers)\b|\$_(GET|POST|REQUEST|COOKIE|FILES)|searchParams|formData\(\)|url\.searchParams/, 2, "reads request input"],
  [/\b(readFile|writeFile|createReadStream|createWriteStream|sendFile|unlink|rmSync|open\s*\(|fopen|send_file|FileInputStream)\b/, 2, "touches files"],
  [/\b(password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key|jwt|bearer)\b/i, 2, "handles secrets"],
  [/\b(isAdmin|is_admin|role|permission|authori[sz]e|can\(|hasAccess|requireAuth|verifyToken|checkAuth)\b/, 2, "access checks"],
  [/\b(createHash|createCipher(iv)?|md5|sha1|crypto\.|Cipher\.|hashlib\.|bcrypt|scrypt|randomBytes|Math\.random)\b/, 2, "cryptography"],
  [/\b(fetch|axios|requests\.(get|post)|http\.(get|request)|urlopen|HttpClient)\s*\(/, 1, "makes requests"],
  [/\b(redirect|res\.location|Location:)\b/, 1, "redirects"],
  [/\b(session|cookie|set-cookie|setCookie)\b/i, 1, "sessions or cookies"],
];

export interface Importance {
  score: number;
  /** Why, most significant first, for the log. */
  reasons: string[];
}

/** Score a function from its path (relative, slash-separated) and its code. */
export function importance(path: string, code: string): Importance {
  const hits: [number, string][] = [];
  for (const [re, w, why] of PATH) if (re.test(path)) hits.push([w, why]);
  for (const [re, w, why] of NOT_IMPORTANT) if (re.test(path)) hits.push([w, why]);
  for (const [re, w, why] of CODE) if (re.test(code)) hits.push([w, why]);
  hits.sort((a, b) => b[0] - a[0]);
  return { score: hits.reduce((n, [w]) => n + w, 0), reasons: hits.map(([w, why]) => `${why} (${w > 0 ? "+" : ""}${w})`) };
}
