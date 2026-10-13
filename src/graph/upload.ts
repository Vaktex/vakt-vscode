import { createHash } from "node:crypto";
import { anonymizeCode } from "../anonymize";
import type { BuiltGraph, Ingest, LocalCode } from "./types";

export interface GraphControl { signal?: AbortSignal; beforeRequest?: () => boolean }
export interface GraphStatus { state: "receiving" | "queued" | "labelling" | "reviewing" | "done" | "failed"; progress: { done: number; total: number } }
export interface GraphClient {
  readonly available: boolean;
  graphIngest(body: Ingest, control?: GraphControl): Promise<{ snapshot: string; needCode: string[] }>;
  graphCode(body: { snapshot: string; items: LocalCode[] }, control?: GraphControl): Promise<unknown>;
  graphCommit(body: { snapshot: string }, control?: GraphControl): Promise<unknown>;
  graphStatus(body: { snapshot: string }, control?: GraphControl): Promise<GraphStatus>;
}
export const GRAPH_MAX_BYTES = 1024 * 1024;
export const GRAPH_MAX_CHUNKS = 32;
export const GRAPH_MAX_CODE_BATCHES = 8;

/** No filesystem/editor dependency; only the built, anonymised wire objects leave here. */
export class GraphUploader {
  private busy = false;
  constructor(private readonly opts: {
    client: GraphClient; enabled: () => boolean;
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    done?: () => void | Promise<void>;
    polls?: number;
  }) {}

  async upload(graph: BuiltGraph, signal?: AbortSignal): Promise<"done" | "pending" | "stopped" | "failed"> {
    const allowed = () => !signal?.aborted && this.opts.enabled() && this.opts.client.available;
    if (this.busy || !allowed()) return "stopped";
    this.busy = true;
    const control: GraphControl = { signal, beforeRequest: allowed };
    try {
      if (!graph.chunks.length || graph.chunks.length > GRAPH_MAX_CHUNKS) throw new Error("Graph chunk limit exceeded");
      // Validate the whole upload before sending any part of it.
      for (const [index, chunk] of graph.chunks.entries()) {
        if (chunk.repo !== graph.repo || chunk.snapshot !== graph.snapshot || chunk.chunk.index !== index || chunk.chunk.total !== graph.chunks.length || chunk.nodes.length > 2000 || chunk.edges.length > 8000 || Buffer.byteLength(JSON.stringify(chunk)) > GRAPH_MAX_BYTES) throw new Error("Invalid graph chunk");
      }
      const requested = new Set<string>();
      for (const chunk of graph.chunks) {
        if (!allowed()) return "stopped";
        const reply = await this.opts.client.graphIngest(chunk, control);
        if (reply.snapshot !== graph.snapshot || !Array.isArray(reply.needCode)) throw new Error("Invalid graph ingest response");
        const ids = new Set(chunk.nodes.map(n => n.id));
        for (const id of reply.needCode) if (typeof id === "string" && ids.has(id)) requested.add(id);
      }
      const items: LocalCode[] = [];
      for (const id of requested) {
        const item = graph.code.get(id);
        if (!item || item.md5 !== id || item.code.length > 8000 || anonymizeCode(item.code, item.language).code !== item.code || createHash("md5").update(item.code).digest("hex") !== id) continue;
        items.push({ md5: id, language: item.language, code: item.code });
        if (items.length === GRAPH_MAX_CODE_BATCHES * 8) break;
      }
      for (let offset = 0; offset < items.length; offset += 8) {
        if (!allowed()) return "stopped";
        await this.opts.client.graphCode({ snapshot: graph.snapshot, items: items.slice(offset, offset + 8) }, control);
      }
      if (!allowed()) return "stopped";
      await this.opts.client.graphCommit({ snapshot: graph.snapshot }, control);
      const polls = Math.max(0, Math.min(12, this.opts.polls ?? 12));
      for (let index = 0; index < polls; index++) {
        if (!allowed()) return "stopped";
        if (index) await (this.opts.wait ?? wait)(5000, signal);
        if (!allowed()) return "stopped";
        const status = await this.opts.client.graphStatus({ snapshot: graph.snapshot }, control);
        if (status.state === "failed") return "failed";
        if (status.state === "done") {
          if (!allowed()) return "stopped";
          await this.opts.done?.();
          return "done";
        }
      }
      return "pending";
    } finally { this.busy = false; }
  }
}
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Graph upload cancelled")); return; }
    const abort = () => { clearTimeout(timer); reject(new Error("Graph upload cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
