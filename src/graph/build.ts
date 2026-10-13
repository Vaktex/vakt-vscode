import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as ts from "typescript";
import { anonymizeCode, anonymizeName, anonymizePath, VOCAB_VERSION } from "../anonymize";
import { importance } from "../heuristics";
import { isSafeRelPath } from "../report";
import { extractFile, extractFileAsync } from "./extract";
import type { BuildOptions, BuiltGraph, Coverage, Definition, ExtractedFile, GraphEdge, GraphFile, GraphNode, Ingest, PathClass, SourceInput } from "./types";

const md5 = (text: string) => createHash("md5").update(text).digest("hex");
export function repoId(installSalt: string, identity: string): string { return md5(installSalt + identity); }
export function fileId(repoSalt: string, relativePath: string): string { return "f" + md5(repoSalt + relativePath).slice(0, 15); }
export function pathClass(p: string): PathClass {
  if (/(?:^|\/)(?:__tests__|tests?|fixtures)(?:\/|$)|\.(?:test|spec)\./i.test(p)) return "test";
  if (/(?:auth|login|session|oauth)/i.test(p)) return "auth";
  if (/(?:payment|billing|checkout)/i.test(p)) return "payments";
  if (/admin/i.test(p)) return "admin";
  if (/(?:routes\/|\+server\.|\+page\.server\.|hooks\.server\.|api\/)/i.test(p)) return "request-handler";
  if (/(?:security|crypto|permission)/i.test(p)) return "security";
  if (/(?:db|models?|queries)(?:\/|\.)/i.test(p)) return "data";
  if (/(?:files?|storage|upload)(?:\/|\.)/i.test(p)) return "files";
  if (/(?:components|styles)(?:\/)|\.svelte$/i.test(p)) return "ui";
  if (/(?:scripts|tools)(?:\/)|config\./i.test(p)) return "tooling";
  return "other";
}
const DATA: [RegExp, string][] = [
  [/\b(?:query|execute|prepare|sql)\b/i, "sql"], [/\b(?:prisma|sequelize|findMany|findUnique|insertInto)\b/i, "orm-model"],
  [/\b(?:readFile|writeFile|unlink|createReadStream|createWriteStream)\b/, "fs"], [/\b(?:fetch|axios|request)\b/, "http-out"],
  [/\b(?:exec|execSync|spawn|execFile)\b/, "exec"], [/\b(?:createHash|createCipheriv|randomBytes|bcrypt|scrypt)\b/, "crypto"],
  [/\b(?:render|compileTemplate)\b/, "template"],
];

/** Pure, bounded wire builder. The caller supplies already-selected workspace files; no disk/network reads. */
export function buildGraph(inputs: readonly SourceInput[], options: BuildOptions): BuiltGraph {
  return buildExtracted(inputs, options);
}

/** Load local WASM grammars sequentially, keeping peak parser memory bounded. */
export async function buildSnapshotAsync(inputs: readonly SourceInput[], options: BuildOptions): Promise<BuiltGraph> {
  const extracted: ExtractedFile[] = [];
  for (const input of [...inputs].sort((a, b) => a.path.localeCompare(b.path))) extracted.push(await extractFileAsync(input.path, input.code, input.language));
  return buildExtracted(inputs, options, extracted);
}
export const buildGraphAsync = buildSnapshotAsync;

function buildExtracted(inputs: readonly SourceInput[], options: BuildOptions, parsed?: ExtractedFile[]): BuiltGraph {
  if (!options.installSalt) throw new Error("installSalt is required");
  const repo = repoId(options.installSalt, options.remoteUrl || options.workspacePath);
  const snapshot = options.snapshot ?? randomUUID();
  const salt = options.repoSalt ?? options.installSalt;
  const sorted = [...inputs].sort((a, b) => a.path.localeCompare(b.path));
  const seen = new Set<string>();
  for (const input of sorted) {
    if (!isSafeRelPath(input.path) || seen.has(input.path)) throw new Error("Unsafe or duplicate graph path");
    seen.add(input.path);
  }
  const extracted = parsed ?? sorted.map(f => extractFile(f.path, f.code, f.language));
  // An in-memory compiler host prevents imports from reading outside the supplied workspace.
  const root = "/vakt-graph";
  const asts = new Map(extracted.map(f => {
    const absolute = path.posix.join(root, f.path);
    f.sourceFile.fileName = absolute;
    return [absolute, f.sourceFile] as const;
  }));
  const directories = new Set([...asts.keys()].flatMap(p => {
    const parents: string[] = [];
    for (let dir = path.posix.dirname(p); dir !== "/"; dir = path.posix.dirname(dir)) parents.push(dir);
    return parents;
  }));
  const compilerOptions: ts.CompilerOptions = { allowJs: true, noLib: true, noResolve: false, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowNonTsExtensions: true };
  const host: ts.CompilerHost = {
    getSourceFile: name => asts.get(name), getDefaultLibFileName: () => "", writeFile: () => {}, getCurrentDirectory: () => root,
    getDirectories: () => [], directoryExists: name => directories.has(name), fileExists: name => asts.has(name), readFile: name => asts.get(name)?.text,
    getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => "\n",
  };
  const program = ts.createProgram([...asts.keys()], compilerOptions, host);
  const checker = program.getTypeChecker();
  const nodes: GraphNode[] = [], files: GraphFile[] = [], edges: GraphEdge[] = [];
  const code: BuiltGraph["code"] = new Map();
  const ids = new Map<ts.Node, string>();
  const coverage: Record<string, Coverage> = {};
  const fileIds = new Map(extracted.map(f => [f.path, fileId(salt, f.path)]));
  const definitions = new Map<string, Definition[]>();
  for (const f of extracted) {
    const stats = coverage[f.language] ??= { files: 0, functions: 0, calls: 0, resolved: 0, extractor: f.extractor };
    stats.files++; stats.functions += f.definitions.length; stats.calls += f.calls.length;
    const fid = fileIds.get(f.path)!;
    files.push({ id: fid, path: anonymizePath(f.path), pathClass: pathClass(f.path), language: f.language, framework: /(?:^|\/)src\/routes\/|(?:^|\/)hooks\.server\.|\.svelte$/.test(f.path) ? ["sveltekit"] : [], extractor: f.extractor, functions: f.definitions.length });
    for (const d of f.definitions) {
      const canonical = anonymizeCode(d.code, f.language).code;
      const id = md5(canonical);
      ids.set(d.node, id);
      // Compiler symbols for arrows live on their variable/property declaration.
      if (ts.isArrowFunction(d.node) || ts.isFunctionExpression(d.node)) ids.set(d.node.parent, id);
      definitions.set(d.name, [...(definitions.get(d.name) ?? []), d]);
      const score = importance(f.path, d.code);
      const unit = options.units?.find(u => u.file === f.path && u.start_line === d.startLine && u.end_line === d.endLine);
      nodes.push({ id, file: fid, name: anonymizeName(d.name), kind: d.kind, language: f.language, lines: d.endLine - d.startLine + 1, tokens: unit?.tokens ?? Math.ceil(canonical.length / 4), importance: score.score, reasons: score.reasons,
        ...(unit ? { dom: { severity: unit.severity, top_family: unit.top_family, families: unit.families } } : {}) });
      code.set(id, { md5: id, language: f.language, code: canonical });
      const route = /(?:^|\/)src\/routes\/(?:(.*)\/)?\+(?:server|page\.server)\.[cm]?[jt]s$/.exec(f.path);
      if (route && /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|load|actions)$/.test(d.name)) {
        edges.push({ kind: "route", from: fid, to: id, target: anonymizePath("/" + (route[1] ?? "")), ...( /^[A-Z]+$/.test(d.name) ? { method: d.name } : {}), resolution: "resolved", line: d.startLine });
      }
      if (/(?:^|\/)hooks\.server\.[cm]?[jt]s$/.test(f.path) && /^(?:handle|handleFetch|handleError)$/.test(d.name)) {
        edges.push({ kind: "guard", from: fid, to: id, target: "sveltekit-hook", resolution: "resolved", line: d.startLine });
      }
    }
  }
  for (const f of extracted) {
    const fid = fileIds.get(f.path)!;
    for (const imp of f.imports) {
      const symbol = f.extractor === "typescript-compiler" && (imp.node as ts.ImportDeclaration).moduleSpecifier ? checker.getSymbolAtLocation((imp.node as ts.ImportDeclaration).moduleSpecifier!) : undefined;
      const targetFile = symbol?.declarations?.find(ts.isSourceFile);
      const target = targetFile ? fileIds.get(targetFile.fileName.replace(/^\/vakt-graph\//, "")) : undefined;
      edges.push({ kind: "import", from: fid, to: target ?? null, target: anonymizePath(imp.target), resolution: target ? "resolved" : "unresolved", line: imp.line });
    }
    for (const call of f.calls) {
      const from = call.owner ? ids.get(call.owner.node)! : fid;
      if (f.extractor !== "typescript-compiler") {
        const candidates = f.definitions.filter(d => d.name === call.target);
        edges.push({ kind: "call", from, to: null, target: anonymizeName(call.target), resolution: candidates.length ? "candidate-set" : "unresolved", line: call.line });
        for (const [pattern, target] of DATA) if (pattern.test(call.target)) edges.push({ kind: "data", from, to: null, target, resolution: "unresolved", line: call.line });
        continue;
      }
      let symbol = checker.getSymbolAtLocation(call.node.expression);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const targets = new Set((symbol?.declarations ?? []).map(d => ids.get(d)).filter((id): id is string => !!id));
      const type = checker.getTypeAtLocation(call.node.expression);
      const variants = type.isUnion() ? type.types : [type];
      for (const variant of variants) {
        for (const sig of variant.getCallSignatures()) {
          const id = sig.declaration && ids.get(sig.declaration);
          if (id) targets.add(id);
        }
      }
      // A union may contain unknown/external branches: even one known target is not proof.
      const ambiguous = type.isUnion() || targets.size > 1;
      const resolution = ambiguous ? "candidate-set" : targets.size === 1 ? "resolved" : (definitions.get(call.target)?.length ?? 0) > 1 ? "candidate-set" : "unresolved";
      edges.push({ kind: "call", from, to: resolution === "resolved" ? [...targets][0] : null, target: anonymizeName(call.target), resolution, line: call.line });
      if (resolution === "resolved") coverage[f.language].resolved++;
      for (const [pattern, target] of DATA) if (pattern.test(call.target)) edges.push({ kind: "data", from, to: null, target, resolution: "unresolved", line: call.line });
      if (/\b(?:requireAuth|checkAuth|verifyToken|authorize|hasAccess)\b/i.test(call.target)) edges.push({ kind: "guard", from, to: resolution === "resolved" ? [...targets][0] : null, resolution, line: call.line });
    }
  }
  const base = { schema: "vakt-graph/1" as const, anon: VOCAB_VERSION, repo, snapshot, coverage };
  const maxNodes = Math.max(1, Math.min(2000, options.maxNodes ?? 2000));
  const maxEdges = Math.max(1, Math.min(8000, options.maxEdges ?? 8000));
  const maxBytes = Math.min(1024 * 1024, options.maxBytes ?? 1024 * 1024);
  const chunks: Ingest[] = [];
  let chunk: Ingest = { ...base, chunk: { index: 0, total: 1 }, files: [], nodes: [], edges: [] };
  // Reserve space for final chunk indices/counts before applying the hard byte ceiling.
  const bytes = (c: Ingest) => Buffer.byteLength(JSON.stringify({ ...c, chunk: { index: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER } }));
  function add<K extends "files" | "nodes" | "edges">(key: K, item: Ingest[K][number]): void {
    const next = { ...chunk, [key]: [...chunk[key], item] };
    if (next.nodes.length > maxNodes || next.edges.length > maxEdges || bytes(next) > maxBytes) {
      if (!chunk.files.length && !chunk.nodes.length && !chunk.edges.length) throw new Error("Graph item exceeds chunk byte limit");
      chunks.push(chunk);
      chunk = { ...base, chunk: { index: 0, total: 1 }, files: [], nodes: [], edges: [] };
    }
    (chunk[key] as Array<typeof item>).push(item);
    if (bytes(chunk) > maxBytes) throw new Error("Graph item exceeds chunk byte limit");
  }
  for (const f of files) add("files", f);
  for (const n of nodes) add("nodes", n);
  for (const e of edges) add("edges", e);
  chunks.push(chunk);
  chunks.forEach((c, index) => { c.chunk = { index, total: chunks.length }; });
  return { repo, snapshot, chunks, code };
}
