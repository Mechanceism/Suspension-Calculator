/**
 * A pool of web workers (one per spare CPU core) for work that splits into independent evaluations:
 * the vehicle optimizer's Jacobian columns and damping trials, DOE samples, Bayesian batches of rates,
 * several tests at once (docs/MATH.md § Parallel evaluation).
 *
 * Every worker gets the same context once (`init`: e.g. the vehicle problem); then `run(task)` sends a
 * task to the next free worker and resolves with its answer. `terminate()` stops them all (pending tasks
 * reject), which is how a Stop button cancels.
 */

/** Workers to use: the cores the browser reports, one left for the page, at most 8; at least 1. */
export const POOL_SIZE = Math.max(1, Math.min(8, ((typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2) - 1));

/** What a pool worker holds while it evaluates tasks. */
export type PoolContext =
  | { type: 'vehicle'; problem: unknown }
  | { type: 'rates'; problem: unknown; tests: unknown; vars: unknown; mode: 'pass' | 'improve' };

export type PoolTask =
  | { kind: 'residuals'; x: number[] }
  | { kind: 'report'; x: number[] }
  | { kind: 'sensitivity'; x: number[] }
  | { kind: 'score'; x: number[] };

export interface Pool {
  readonly size: number;
  run<T>(task: PoolTask): Promise<T>;
  /** Run tasks over the free workers; answers in the tasks' order. */
  map<T>(tasks: PoolTask[]): Promise<T[]>;
  terminate(): void;
}

export function createPool(ctx: PoolContext, size = POOL_SIZE): Pool {
  interface Pending { task: PoolTask; resolve: (v: unknown) => void; reject: (e: unknown) => void }
  const queue: Pending[] = [];
  const workers = Array.from({ length: Math.max(1, size) }, () => {
    const w = new Worker(new URL('./optimizer.worker.ts', import.meta.url), { type: 'module' });
    w.postMessage({ kind: 'pool-init', ctx });
    return { w, busy: null as Pending | null };
  });
  let dead = false;
  const pump = () => {
    for (const slot of workers) {
      if (slot.busy || !queue.length) continue;
      const job = queue.shift()!;
      slot.busy = job;
      slot.w.onmessage = (e: MessageEvent) => {
        const m = e.data as { type: 'pool-result'; result: unknown } | { type: 'error'; message: string };
        const j = slot.busy!;
        slot.busy = null;
        if (m.type === 'error') j.reject(new Error(m.message)); else j.resolve(m.result);
        pump();
      };
      slot.w.onerror = (e) => { const j = slot.busy; slot.busy = null; j?.reject(new Error(e.message || 'Worker failed')); pump(); };
      slot.w.postMessage({ kind: 'pool-task', task: job.task });
    }
  };
  const run = <T>(task: PoolTask) => new Promise<T>((resolve, reject) => {
    if (dead) { reject(new Error('stopped')); return; }
    queue.push({ task, resolve: resolve as (v: unknown) => void, reject });
    pump();
  });
  return {
    size: workers.length,
    run,
    map: <T>(tasks: PoolTask[]) => Promise.all(tasks.map((t) => run<T>(t))),
    terminate: () => {
      dead = true;
      for (const slot of workers) { slot.w.terminate(); slot.busy?.reject(new Error('stopped')); slot.busy = null; }
      for (const j of queue.splice(0)) j.reject(new Error('stopped'));
    },
  };
}

/**
 * Run up to `limit` async jobs at once (e.g. tests, each in its own worker); results in the inputs' order.
 * `stopped()` ends it early (jobs not started yet are skipped and left undefined).
 */
export async function runLimited<T, R>(items: T[], limit: number, job: (item: T, index: number) => Promise<R>, stopped: () => boolean = () => false): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length && !stopped()) {
      const i = next++;
      out[i] = await job(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
  return out;
}
