import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

// Pool of worker threads that decode HEIC previews. Keeping this small bounds
// the transient CPU/RAM cost (each in-flight decode holds a full-resolution
// bitmap), while still moving the blocking WASM work off the main thread and
// allowing a couple of decodes to run in parallel.
const POOL_SIZE =
  Number(process.env.HEIC_DECODE_CONCURRENCY) ||
  Math.max(1, Math.min(2, (os.cpus().length || 2) - 1)) ||
  1;

// Plain .cjs sits next to this module in both src (dev/tsx) and dist (prod).
const WORKER_FILE = path.join(__dirname, "heic.worker.cjs");

type Pending = { resolve: (buffer: Buffer) => void; reject: (error: Error) => void };
type PoolWorker = { worker: Worker; busy: boolean; current?: Pending };

const workers: PoolWorker[] = [];
const queue: Array<{ buffer: Buffer } & Pending> = [];
let nextJobId = 1;

function spawnWorker(): PoolWorker {
  const pw: PoolWorker = { worker: new Worker(WORKER_FILE), busy: false };

  pw.worker.on("message", (msg: { ok: boolean; data?: Buffer; error?: string }) => {
    const job = pw.current;
    pw.current = undefined;
    pw.busy = false;
    pw.worker.unref(); // idle again — don't keep the process alive
    if (job) {
      if (msg.ok && msg.data) job.resolve(Buffer.from(msg.data));
      else job.reject(new Error(msg.error || "HEIC decode failed"));
    }
    dispatch();
  });

  pw.worker.on("error", (err: unknown) => {
    const job = pw.current;
    pw.current = undefined;
    pw.busy = false;
    if (job) job.reject(err instanceof Error ? err : new Error(String(err)));
    const idx = workers.indexOf(pw);
    if (idx >= 0) workers.splice(idx, 1);
    dispatch();
  });

  // Don't keep the process alive just because idle workers exist.
  pw.worker.unref();
  return pw;
}

function ensureWorkers(): void {
  while (workers.length < POOL_SIZE) {
    workers.push(spawnWorker());
  }
}

function dispatch(): void {
  if (queue.length === 0) return;
  ensureWorkers();
  const free = workers.find((w) => !w.busy);
  if (!free) return;
  const job = queue.shift();
  if (!job) return;
  free.busy = true;
  free.current = { resolve: job.resolve, reject: job.reject };
  free.worker.ref(); // active job must keep the process alive
  const jobId = nextJobId++;
  free.worker.postMessage({ jobId, buffer: job.buffer });
}

/** Decode + downscale a HEIC/HEIF buffer to a small JPEG preview off-thread. */
export function decodeHeicPreview(buffer: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    queue.push({ buffer, resolve, reject });
    dispatch();
  });
}
