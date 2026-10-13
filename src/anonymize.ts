import { VOCAB } from './vocab';
export { VOCAB_VERSION } from './vocab';

export interface Anonymized {
  code: string;
  /** Placeholder -> original word. In memory only, never sent. */
  names: Map<string, string>;
}

const PLACEHOLDER = /^(?:Nm\d+|nm\d+|NM\d+|seg\d+|REDACTED_[A-Z0-9_]+)$/;
const TOKENS = /REDACTED_[A-Z0-9_]+|\b(?:Nm|nm|NM|seg)\d+\b|[\p{L}\p{M}_$][\p{L}\p{M}\p{N}_$]*|\d{6,}/gu;
const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^\s:/@'"`]+:[^\s@'"`]+(?=@)/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  /\b((?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*)(["'])([^"'\r\n]+)\2/gi,
];

/** Split camel/snake words without losing punctuation or acronym casing. */
function words(text: string, replace: (word: string) => string): string {
  return text.replace(/REDACTED_[A-Z0-9_]+|(?:Nm|nm|NM|seg)\d+|[\p{Lu}]+(?=[\p{Lu}][\p{Ll}]|[^\p{L}]|$)|[\p{Lu}]?[\p{Ll}\p{M}]+|[\p{L}\p{M}]+/gu, replace);
}

/** A small lexer: comment markers inside quoted strings never start comments. */
function withoutComments(code: string, language: string): string {
  const hash = /^(python|py|ruby|rb|shellscript|shell|bash|sh|powershell|perl|yaml|yml|r|elixir)$/i.test(language);
  const lua = /^lua$/i.test(language);
  const cstyle = !hash && !lua;
  let out = '';
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const delimiter = code.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      out += delimiter;
      i += delimiter.length;
      while (i < code.length) {
        if (code[i] === '\\') { out += code.slice(i, i + 2); i += 2; }
        else if (code.startsWith(delimiter, i)) { out += delimiter; i += delimiter.length; break; }
        else { out += code[i++]; }
      }
      continue;
    }
    // Lua long strings and long comments support arbitrary equals delimiters.
    const long = lua ? /^(--)?\[(=*)\[/.exec(code.slice(i)) : null;
    if (long) {
      const end = code.indexOf(`]${long[2]}]`, i + long[0].length);
      const stop = end < 0 ? code.length : end + long[2].length + 2;
      out += long[1] ? code.slice(i, stop).replace(/[^\r\n]/g, ' ') : code.slice(i, stop);
      i = stop;
      continue;
    }
    if ((hash && ch === '#') || (lua && code.startsWith('--', i)) || (cstyle && code.startsWith('//', i))) {
      const end = code.indexOf('\n', i);
      out += ' ';
      i = end < 0 ? code.length : end;
      continue;
    }
    if (cstyle && code.startsWith('/*', i)) {
      const end = code.indexOf('*/', i + 2);
      const stop = end < 0 ? code.length : end + 2;
      out += code.slice(i, stop).replace(/[^\r\n]/g, ' ');
      i = stop;
      continue;
    }
    out += code[i++];
  }
  return out;
}

export function anonymizeCode(code: string, language = ''): Anonymized {
  const names = new Map<string, string>();
  const replacements = new Map<string, string>();
  const used = new Set(code.match(/(?:Nm|nm|NM|seg)\d+|REDACTED_[A-Z0-9_]+|\b\d{6,}\b/g) ?? []);
  let next = 1;
  let secret = 1;
  let numeric = 100001;
  const hideSecret = (value: string): string => {
    if (PLACEHOLDER.test(value)) return value;
    const existing = replacements.get(value);
    if (existing) return existing;
    let placeholder: string;
    do { placeholder = `REDACTED_SECRET_${secret++}`; } while (used.has(placeholder));
    used.add(placeholder);
    replacements.set(value, placeholder);
    names.set(placeholder, value);
    return placeholder;
  };
  let redacted = code;
  for (const pattern of SECRETS) {
    redacted = redacted.replace(pattern, (match, prefix?: string, quote?: string) =>
      typeof prefix === 'string' && typeof quote === 'string'
        ? `${prefix}${quote}${hideSecret(match.slice(prefix.length + quote.length, -quote.length))}${quote}`
        : hideSecret(match));
  }
  const replaceWord = (word: string): string => {
    if (PLACEHOLDER.test(word) || VOCAB.has(word.toLowerCase())) return word;
    const existing = replacements.get(word);
    if (existing) return existing;
    const casing = word === word.toUpperCase() ? 'NM' : /^\p{Lu}/u.test(word) ? 'Nm' : 'nm';
    while (used.has(`Nm${next}`) || used.has(`nm${next}`) || used.has(`NM${next}`)) next++;
    const placeholder = `${casing}${next++}`;
    used.add(placeholder);
    replacements.set(word, placeholder);
    names.set(placeholder, word);
    return placeholder;
  };
  const result = withoutComments(redacted, language).replace(TOKENS, (token) => {
    if (PLACEHOLDER.test(token)) return token;
    if (/^\d{6,}$/.test(token)) {
      // This reserved range is canonical, so a server's second pass is stable.
      if (/^1\d{5}$/.test(token) && Number(token) > 100000) return token;
      const existing = replacements.get(token);
      if (existing) return existing;
      while (used.has(String(numeric))) numeric++;
      const placeholder = String(numeric++);
      used.add(placeholder);
      replacements.set(token, placeholder);
      names.set(placeholder, token);
      return placeholder;
    }
    return words(token, replaceWord);
  });
  return { code: result, names };
}

export function anonymizeName(name: string): string {
  return anonymizeCode(name).code;
}

export function anonymizePath(path: string): string {
  let next = 1;
  const used = new Set(path.match(/seg\d+/g) ?? []);
  const replacements = new Map<string, string>();
  return path.replace(/\\/g, '/').split('/').map((segment) => {
    if (segment === '.' || segment === '..' || !segment) return segment;
    return segment.replace(/[\p{L}\p{M}\p{N}_$-]+/gu, (part) => {
      if (PLACEHOLDER.test(part) || VOCAB.has(part.toLowerCase())) return part;
      // Keep known camel/snake combinations, e.g. request-handler and user_id.
      let known = true;
      words(part, (word) => { if (!VOCAB.has(word.toLowerCase()) && !PLACEHOLDER.test(word)) known = false; return word; });
      if (known && !/\d{6,}/.test(part)) return part;
      const existing = replacements.get(part);
      if (existing) return existing;
      while (used.has(`seg${next}`)) next++;
      const placeholder = `seg${next++}`;
      used.add(placeholder);
      replacements.set(part, placeholder);
      return placeholder;
    });
  }).join('/');
}

export function restoreNames(code: string, names: ReadonlyMap<string, string>): string {
  // Single pass: restored originals must never be interpreted as placeholders.
  return code.replace(/REDACTED_[A-Z0-9_]+|(?:Nm|nm|NM|seg)\d+|\b\d{6,}\b/g, (placeholder) => names.get(placeholder) ?? placeholder);
}
