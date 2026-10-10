// Syntax highlighting for the detail panel's code snippet. No vscode import,
// so it is unit-testable.
//
// highlight.js marks tokens with classes (hljs-keyword, ...) rather than
// inline styles, which the panel's CSP would drop, and it escapes the source
// itself. Only the grammars for languages vakt scores are loaded.

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import typescript from "highlight.js/lib/languages/typescript";
import vbnet from "highlight.js/lib/languages/vbnet";

const GRAMMARS = { bash, c, cpp, csharp, go, java, javascript, kotlin, lua, php, python, ruby, rust, scala, typescript, vbnet };
for (const [name, grammar] of Object.entries(GRAMMARS)) hljs.registerLanguage(name, grammar);

/** VS Code language ids that differ from the grammar's name. */
const ALIASES: Record<string, keyof typeof GRAMMARS> = {
  javascriptreact: "javascript",
  typescriptreact: "typescript",
  shellscript: "bash",
  vb: "vbnet",
};

export function grammarFor(languageId: string | undefined): string | undefined {
  if (!languageId) return undefined;
  const id = ALIASES[languageId] ?? languageId;
  return id in GRAMMARS ? id : undefined;
}

/**
 * Highlighted HTML for each source line, or undefined when there is no
 * grammar. Spans that cross a newline (block comments, multi-line strings)
 * are closed at the end of the line and reopened on the next, so each line
 * stands on its own in the panel's table.
 */
export function highlightLines(lines: string[], languageId: string | undefined): string[] | undefined {
  const language = grammarFor(languageId);
  if (!language) return undefined;
  let html: string;
  try {
    html = hljs.highlight(lines.join("\n"), { language, ignoreIllegals: true }).value;
  } catch {
    return undefined;
  }
  const out: string[] = [];
  const open: string[] = [];
  let line = "";
  for (const part of html.split(/(<span class="[^"]*">|<\/span>|\n)/)) {
    if (part === "\n") {
      out.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else if (part.startsWith("<span ")) {
      open.push(part);
      line += part;
    } else if (part === "</span>") {
      open.pop();
      line += part;
    } else {
      line += part;
    }
  }
  out.push(line + "</span>".repeat(open.length));
  return out;
}
