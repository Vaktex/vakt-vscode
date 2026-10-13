import type { Node as SyntaxNode, Language as GrammarLanguage } from "web-tree-sitter";
import * as ts from "typescript";
import { setFlagsFromString } from "node:v8";
// Set before requiring Emscripten: it starts compiling its runtime during module evaluation.
setFlagsFromString("--liftoff-only --no-wasm-tier-up --no-wasm-dynamic-tiering --no-wasm-opt");
const { Parser, Language }: typeof import("web-tree-sitter") = require("web-tree-sitter");
import type { Definition, ExtractedFile } from "./types";

// Grammar bundle version is pinned; grammars are local runtime dependencies, never fetched.
const VERSION = "0.1.13";
type Rules = { grammar: string; definitions: string[]; calls: string[]; imports: string[] };
const rule = (grammar: string, definitions: string, calls: string, imports: string): Rules => ({ grammar, definitions: definitions.split(" "), calls: calls.split(" "), imports: imports.split(" ") });
const RULES: Record<string, Rules> = {
  python: rule("python", "function_definition", "call", "import_statement import_from_statement"),
  go: rule("go", "function_declaration method_declaration func_literal", "call_expression", "import_spec"),
  rust: rule("rust", "function_item closure_expression", "call_expression", "use_declaration"),
  java: rule("java", "method_declaration constructor_declaration lambda_expression", "method_invocation object_creation_expression", "import_declaration"),
  kotlin: rule("kotlin", "function_declaration secondary_constructor lambda_literal", "call_expression", "import_header"),
  swift: rule("swift", "function_declaration init_declaration lambda_literal", "call_expression", "import_declaration"),
  csharp: rule("c_sharp", "method_declaration constructor_declaration local_function_statement lambda_expression", "invocation_expression object_creation_expression", "using_directive"),
  php: rule("php", "function_definition method_declaration anonymous_function arrow_function", "function_call_expression member_call_expression scoped_call_expression object_creation_expression", "namespace_use_declaration include_expression require_expression"),
  dart: rule("dart", "function_signature method_signature constructor_signature", "selector", "import_or_export"),
  ruby: rule("ruby", "method singleton_method lambda", "call", ""),
  c: rule("c", "function_definition", "call_expression", "preproc_include"),
  cpp: rule("cpp", "function_definition lambda_expression", "call_expression", "preproc_include"),
  objc: rule("objc", "function_definition method_definition", "call_expression message_expression", "preproc_include preproc_import"),
  scala: rule("scala", "function_definition lambda_expression", "call_expression", "import_declaration"),
  elixir: rule("elixir", "", "call", ""),
  solidity: rule("solidity", "function_definition constructor_definition", "call_expression", "import_directive"),
  shellscript: rule("bash", "function_definition", "command", ""),
};
let initialized: Promise<void> | undefined;
const languages = new Map<string, Promise<GrammarLanguage | undefined>>();
async function grammar(name: string): Promise<GrammarLanguage | undefined> {
  let pending = languages.get(name);
  if (!pending) {
    pending = (async () => {
      try {
        // V8 13.x's optimizing WASM tier exhausts compiler Zone memory on these large
        // generated grammars. Baseline WASM is sufficient for bounded syntax walks.
        if (!initialized) {
          initialized = Parser.init();
        }
        await initialized;
        return await Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`));
      } catch { return undefined; }
    })();
    languages.set(name, pending);
  }
  return pending;
}
function field(n: SyntaxNode, ...names: string[]): SyntaxNode | undefined {
  for (const name of names) { const child = n.childForFieldName(name); if (child) return child; }
  return undefined;
}
function identifier(n: SyntaxNode): SyntaxNode | undefined {
  if (["identifier", "simple_identifier", "name", "field_identifier", "type_identifier", "command_name"].includes(n.type)) return n;
  for (const child of n.namedChildren) { const found = child && identifier(child); if (found) return found; }
  return undefined;
}

/** Real syntax extraction, deliberately not a compiler/name resolver. ASTs are freed after copying. */
export async function extractModern(out: ExtractedFile, code: string): Promise<ExtractedFile> {
  const rules = RULES[out.language];
  if (!rules) return out;
  const lang = await grammar(rules.grammar);
  if (!lang) return out;
  const parser = new Parser();
  try { parser.setLanguage(lang); }
  catch { parser.delete(); return out; } // Absent/incompatible bundled grammar is truthful zero coverage.
  const tree = parser.parse(code);
  if (!tree) { parser.delete(); return out; }
  try {
    out.extractor = `tree-sitter:${rules.grammar}@${VERSION}/tags-1`;
    function visit(n: SyntaxNode, owner?: Definition): void {
      // Do not interpret code-looking comments, string contents or error recovery as definitions.
      if (n.type === "ERROR" || /comment|string|heredoc/.test(n.type)) return;
      const elixirDefinition = out.language === "elixir" && n.type === "call" && ["def", "defp", "defmacro", "defmacrop"].includes(field(n, "target")?.text ?? "");
      if (rules.definitions.includes(n.type) || elixirDefinition) {
        const region = n;
        // Dart signatures and bodies are siblings, even at top level.
        const dartBody = out.language === "dart" && n.nextNamedSibling?.type === "function_body" ? n.nextNamedSibling : undefined;
        const nameNode = elixirDefinition ? identifier(n.namedChildren.find(c => c?.type === "arguments") ?? n) : field(n, "name") ?? identifier(field(n, "declarator") ?? n);
        const name = nameNode?.text ?? "anonymous";
        // web-tree-sitter's string API uses UTF-16 code-unit indices (not UTF-8 byte offsets).
        const start = region.startIndex, end = dartBody?.endIndex ?? region.endIndex;
        const node = ts.factory.createFunctionDeclaration(undefined, undefined, name, undefined, [], undefined, undefined);
        owner = { node, name, kind: n.type.includes("method") ? "method" : "function", start, end, startLine: region.startPosition.row + 1, endLine: (dartBody ?? region).endPosition.row + 1, code: code.slice(start, end) };
        out.definitions.push(owner);
        if (dartBody) visit(dartBody, owner);
      }
      if (out.language === "dart" && n.type === "function_body" && !owner) return;
      if (rules.calls.includes(n.type) && !elixirDefinition) {
        const targetNode = (out.language === "dart" ? n.previousNamedSibling : undefined) ?? field(n, "function", "name", "target", "method") ?? n.namedChildren[0];
        const target = targetNode?.text;
        if (target) {
          out.calls.push({ node: ts.factory.createCallExpression(ts.factory.createIdentifier(target), undefined, []), owner, target, line: n.startPosition.row + 1 });
          if ((out.language === "ruby" && ["require", "require_relative", "load"].includes(target)) || (out.language === "elixir" && ["alias", "import", "require", "use"].includes(target)) || (out.language === "shellscript" && ["source", "."].includes(target))) out.imports.push({ node: ts.factory.createIdentifier(target), target: n.text, line: n.startPosition.row + 1 });
        }
      }
      if (rules.imports.includes(n.type)) out.imports.push({ node: ts.factory.createIdentifier("import"), target: n.text, line: n.startPosition.row + 1 });
      for (const child of n.namedChildren) child && visit(child, owner);
    }
    visit(tree.rootNode);
    return out;
  } finally { tree.delete(); parser.delete(); }
}
