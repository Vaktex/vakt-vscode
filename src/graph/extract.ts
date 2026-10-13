import * as ts from "typescript";
import type { Definition, ExtractedFile } from "./types";

export function languageFor(path: string): string {
  if (/\.svelte$/i.test(path)) return "svelte";
  if (/\.[cm]?tsx?$/i.test(path)) return "typescript";
  if (/\.[cm]?jsx?$/i.test(path)) return "javascript";
  const ext = path.split(".").pop()?.toLowerCase() ?? "unknown";
  return ({ py: "python", pyw: "python", go: "go", rs: "rust", rb: "ruby", java: "java", php: "php", phtml: "php", kt: "kotlin", kts: "kotlin", swift: "swift", cs: "csharp", dart: "dart", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", m: "objc", mm: "objc", scala: "scala", sc: "scala", ex: "elixir", exs: "elixir", sol: "solidity", sh: "shellscript", bash: "shellscript" } as Record<string, string>)[ext] ?? ext;
}

/** Mask markup, not slice scripts: all AST positions remain original-file offsets. */
export function scriptSource(code: string): string {
  let result = "";
  let cursor = 0;
  const scripts = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of code.matchAll(scripts)) {
    const start = match.index! + match[0].indexOf(">") + 1;
    result += code.slice(cursor, start).replace(/[^\r\n]/g, " ") + match[1];
    cursor = start + match[1].length;
  }
  return result + code.slice(cursor).replace(/[^\r\n]/g, " ");
}

/** Async grammar loading preserves the synchronous TS/JS API. */
export async function extractFileAsync(path: string, code: string, language = languageFor(path)): Promise<ExtractedFile> {
  language = ({ "c#": "csharp", "objective-c": "objc", "objective-cpp": "objc", bash: "shellscript", shell: "shellscript", "c++": "cpp" } as Record<string, string>)[language] ?? language;
  const out = extractFile(path, code, language);
  if (out.extractor !== "none") return out;
  const { extractModern } = await import("./modern");
  return extractModern(out, code);
}

function definitionName(node: ts.FunctionLikeDeclaration): string {
  if (node.name) return node.name.getText();
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const p = node.parent;
  if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) return p.name.getText();
  return "anonymous";
}

/** Deliberately TS/JS (and Svelte script) only. Unsupported languages expose zero coverage. */
export function extractFile(path: string, code: string, language = languageFor(path)): ExtractedFile {
  const supported = ["typescript", "javascript", "svelte", "typescriptreact", "javascriptreact"].includes(language);
  const text = !supported ? "" : language === "svelte" ? scriptSource(code) : code;
  const kind = /\.[jt]sx$/i.test(path) ? ts.ScriptKind.TSX : /javascript/.test(language) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const out: ExtractedFile = { path, language, extractor: supported ? "typescript-compiler" : "none", sourceFile, definitions: [], calls: [], imports: [] };
  const line = (pos: number) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  function visit(node: ts.Node, owner?: Definition): void {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node)) && node.body) {
      const start = node.getStart(sourceFile);
      owner = { node, name: definitionName(node), kind: ts.isArrowFunction(node) ? "arrow" : ts.isMethodDeclaration(node) ? "method" : "function", start, end: node.end, startLine: line(start), endLine: line(node.end - 1), code: code.slice(start, node.end) };
      out.definitions.push(owner);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      out.calls.push({ node, owner, target: node.expression.getText(sourceFile), line: line(node.getStart(sourceFile)) });
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.imports.push({ node, target: node.moduleSpecifier.text, line: line(node.getStart(sourceFile)) });
    }
    ts.forEachChild(node, child => visit(child, owner));
  }
  if (supported) visit(sourceFile);
  return out;
}
