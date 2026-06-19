"use strict";

// HEIC worker. Runs the CPU-heavy HEVC decode (WASM) off the main event loop so
// the server stays responsive, and lets several jobs run in parallel across
// cores. Plain CommonJS so it runs as-is under both tsx (dev) and compiled node
// (prod) without any TS loader.
//
// Two modes, by message payload:
//   { width > 0 }  -> small JPEG preview (decode + downscale)  [grid preview]
//   { width = 0 }  -> full-size JPEG     (decode only)         [upload convert]
const { parentPort } = require("node:worker_threads");
const heicConvert = require("heic-convert");
const sharp = require("sharp");

if (!parentPort) {
  throw new Error("heic.worker must run as a worker thread");
}

parentPort.on("message", async (msg) => {
  const { jobId, buffer, width, heicQuality } = msg;
  try {
    // sharp's prebuilt libheif only decodes AVIF, so HEVC goes through the
    // WASM decoder. libheif already applies the orientation transforms, so the
    // decoded JPEG is upright.
    const decodedJpeg = await heicConvert({
      buffer,
      format: "JPEG",
      quality: heicQuality || 0.82
    });

    let out;
    if (width && width > 0) {
      out = await sharp(Buffer.from(decodedJpeg))
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    } else {
      out = Buffer.isBuffer(decodedJpeg)
        ? decodedJpeg
        : Buffer.from(decodedJpeg);
    }

    parentPort.postMessage({ jobId, ok: true, data: out });
  } catch (error) {
    parentPort.postMessage({
      jobId,
      ok: false,
      error: error && error.message ? error.message : String(error)
    });
  }
});
