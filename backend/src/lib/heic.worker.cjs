"use strict";

// HEIC preview worker. Runs the CPU-heavy HEVC decode (WASM) off the main
// event loop so the server stays responsive, and lets several previews decode
// in parallel across cores. Plain CommonJS so it runs as-is under both tsx
// (dev) and compiled node (prod) without any TS loader.
const { parentPort } = require("node:worker_threads");
const heicConvert = require("heic-convert");
const sharp = require("sharp");

const PREVIEW_WIDTH = Number(process.env.PREVIEW_WIDTH) || 480;

if (!parentPort) {
  throw new Error("heic.worker must run as a worker thread");
}

parentPort.on("message", async (msg) => {
  const { jobId, buffer } = msg;
  try {
    // sharp's prebuilt libheif only decodes AVIF, so HEVC goes through the
    // WASM decoder; then downscale and emit JPEG for browser display.
    const decodedJpeg = await heicConvert({
      buffer,
      format: "JPEG",
      quality: 0.82
    });
    const out = await sharp(Buffer.from(decodedJpeg))
      .rotate()
      .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    parentPort.postMessage({ jobId, ok: true, data: out });
  } catch (error) {
    parentPort.postMessage({
      jobId,
      ok: false,
      error: error && error.message ? error.message : String(error)
    });
  }
});
