// Queues scans. No vscode import, so it is unit-testable.
//
// Each vakt process loads DOM-0.8B (~1.5 GB) onto the GPU, so scans run one
// at a time. Saves arriving while a scan runs are coalesced per root into the
// next run, and a pending whole-root scan absorbs any file scans for that root.

export interface Job {
  root: string;
  /** Relative paths to scan, or undefined for the whole root. */
  files?: string[];
}

export type Runner = (job: Job, signal: AbortSignal) => Promise<void>;

interface Pending {
  all: boolean;
  files: Set<string>;
}

export class Scheduler {
  private readonly pending = new Map<string, Pending>();
  private running: { job: Job; ctrl: AbortController } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(busy: boolean) => void>();

  constructor(
    private readonly run: Runner,
    private readonly debounceMs = 400,
  ) {}

  get busy(): boolean {
    return this.running !== undefined || this.pending.size > 0;
  }

  get current(): Job | undefined {
    return this.running?.job;
  }

  onDidChangeBusy(fn: (busy: boolean) => void): { dispose(): void } {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.busy);
  }

  /** Queue a scan of some files under root, or of the whole root when files is undefined. */
  enqueue(job: Job, immediate = false): void {
    let p = this.pending.get(job.root);
    if (!p) {
      p = { all: false, files: new Set() };
      this.pending.set(job.root, p);
    }
    if (job.files === undefined) {
      p.all = true;
      p.files.clear();
    } else if (!p.all) {
      for (const f of job.files) p.files.add(f);
    }
    this.emit();
    this.schedule(immediate ? 0 : this.debounceMs);
  }

  /** Abort the running scan and drop everything queued. */
  cancel(): void {
    this.pending.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.running?.ctrl.abort();
    this.emit();
  }

  private schedule(ms: number): void {
    if (this.running) return; // drained when the current run finishes
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, ms);
  }

  private async drain(): Promise<void> {
    while (!this.running && this.pending.size > 0) {
      const [root, p] = this.pending.entries().next().value as [string, Pending];
      this.pending.delete(root);
      const job: Job = p.all ? { root } : { root, files: [...p.files].sort() };
      const ctrl = new AbortController();
      this.running = { job, ctrl };
      this.emit();
      try {
        await this.run(job, ctrl.signal);
      } catch {
        // The runner reports its own errors; one failed root must not stall the queue.
      } finally {
        this.running = undefined;
      }
    }
    this.emit();
  }
}
