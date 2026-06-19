import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

// Pool of worker threads that handle HEIC decoding (preview + upload→JPG).
// Keeping this small bounds the transient CPU/RAM cost (each in-flight decode
// holds a full-resolution bitmap), while moving the blocking WASM work off the
// main thread and allowing a couple of jobs to run in parallel.
const POOL_SIZE =
  Number(process.env.HEIC_DECODE_CONCURRENCY) ||
  Math.max(1, Math.min(2, (os.cpus().length || 2) - 1)) ||
  1;

// Plain .cjs sits next to this module in both src (dev/tsx) and dist (prod).
const WORKER_FILE = path.join(__dirname, "heic.worker.cjs");

type Job = {
  buffer: Buffer;
  width: number;
  heicQuality: number;
  resolve: (buffer: Buffer) => void;
  reject: (error: Error) => void;
};
type PoolWorker = { worker: Worker; busy: boolean; current?: Job };

const workers: PoolWorker[] = [];
const queue: Job[] = [];
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
  free.current = job;
  free.worker.ref(); // active job must keep the process alive
  const jobId = nextJobId++;
  free.worker.postMessage({
    jobId,
    buffer: job.buffer,
    width: job.width,
    heicQuality: job.heicQuality
  });
}

function enqueue(buffer: Buffer, width: number, heicQuality: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    queue.push({ buffer, width, heicQuality, resolve, reject });
    dispatch();
  });
}

/** Decode + downscale a HEIC/HEIF buffer to a small JPEG preview off-thread. */
export function decodeHeicPreview(buffer: Buffer, width: number): Promise<Buffer> {
  return enqueue(buffer, width, 0.82);
}

/** Decode a HEIC/HEIF buffer to a full-size JPEG (used to convert on upload). */
export function convertHeicToJpeg(buffer: Buffer): Promise<Buffer> {
  return enqueue(buffer, 0, 0.9);
}
