import type * as ts from "typescript";
import type { Unit } from "../report";

export type PathClass = "request-handler" | "auth" | "payments" | "admin" | "data" | "files" | "security" | "ui" | "test" | "tooling" | "other";
export type Resolution = "resolved" | "candidate-set" | "unresolved";
export interface Coverage { files: number; functions: number; calls: number; resolved: number; extractor: string }
export interface GraphFile { id: string; path: string; pathClass: PathClass; language: string; framework: string[]; extractor: string; functions: number }
export interface GraphNode {
  id: string; file: string; name: string; kind: string; language: string; lines: number; tokens: number;
  dom?: { severity: number; top_family: string; families: Record<string, number> };
  importance: number; reasons: string[];
}
export interface GraphEdge {
  kind: "call" | "import" | "route" | "data" | "guard";
  from: string; to: string | null; target?: string; method?: string; resolution: Resolution; line?: number;
}
export interface Ingest {
  schema: "vakt-graph/1"; anon: number; repo: string; snapshot: string;
  chunk: { index: number; total: number }; coverage: Record<string, Coverage>;
  files: GraphFile[]; nodes: GraphNode[]; edges: GraphEdge[];
}
/** These inputs and extracted ASTs are local-only. Never serialize them as a request. */
export interface SourceInput { path: string; code: string; language?: string }
export interface Definition { node: ts.FunctionLikeDeclaration; name: string; kind: string; start: number; end: number; startLine: number; endLine: number; code: string }
export interface ExtractedCall { node: ts.CallExpression | ts.NewExpression; owner?: Definition; target: string; line: number }
export interface ExtractedImport { node: ts.Node; target: string; line: number }
export interface ExtractedFile {
  path: string; language: string; extractor: string; sourceFile: ts.SourceFile;
  definitions: Definition[]; calls: ExtractedCall[]; imports: ExtractedImport[];
}
export interface BuildOptions {
  installSalt: string; repoSalt?: string; workspacePath: string; remoteUrl?: string; snapshot?: string;
  units?: readonly Unit[];
  /** Lower limits are useful for tests; hard wire limits cannot be increased. */
  maxNodes?: number; maxEdges?: number; maxBytes?: number;
}
export interface LocalCode { md5: string; language: string; code: string }
export interface BuiltGraph { repo: string; snapshot: string; chunks: Ingest[]; code: Map<string, LocalCode> }
