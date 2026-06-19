import sharp from "sharp";
import { getObject } from "./r2";
import { decodeHeicPreview } from "./heic-pool";

// Preview width for the grid. Images are downscaled only for display; the
// original file in storage is never modified, converted, or copied.
const PREVIEW_WIDTH = 480;

// HEIC decode (HEVC via WASM) is expensive AND can't be skipped — browsers
// other than Safari can't render HEIC at all. To avoid paying that cost on
// every view we keep generated HEIC previews in a small, BYTE-CAPPED in-memory
// cache: no disk, no R2 bucket, RAM bounded by PREVIEW_CACHE_MAX_BYTES. Each
// HEIC is decoded once per server lifetime, then served instantly. The decode
// itself runs in a worker pool (see ./heic-pool) so it never blocks the server.
const PREVIEW_CACHE_MAX_BYTES =
  (Number(process.env.PREVIEW_CACHE_MAX_MB) || 64) * 1024 * 1024;

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|heic|heif)$/i;

type Preview = { buffer: Buffer; contentType: string };

// ── Bounded LRU (insertion-order Map) ────────────────────────────────────────
const previewCache = new Map<string, Preview>();
let previewCacheBytes = 0;

function cacheGet(key: string): Preview | undefined {
  const hit = previewCache.get(key);
  if (!hit) return undefined;
  previewCache.delete(key); // refresh recency
  previewCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: Preview): void {
  if (value.buffer.length > PREVIEW_CACHE_MAX_BYTES) return;
  const existing = previewCache.get(key);
  if (existing) {
    previewCacheBytes -= existing.buffer.length;
    previewCache.delete(key);
  }
  previewCache.set(key, value);
  previewCacheBytes += value.buffer.length;
  while (previewCacheBytes > PREVIEW_CACHE_MAX_BYTES) {
    const oldest = previewCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = previewCache.get(oldest);
    previewCache.delete(oldest);
    if (evicted) previewCacheBytes -= evicted.buffer.length;
  }
}

// De-dupe concurrent requests for the same not-yet-cached HEIC preview.
const inFlight = new Map<string, Promise<Preview>>();

function isHeic(file: { mimeType?: string | null; name?: string | null }): boolean {
  const mime = (file.mimeType ?? "").toLowerCase();
  if (
    mime === "image/heic" ||
    mime === "image/heif" ||
    mime === "image/heic-sequence" ||
    mime === "image/heif-sequence"
  ) {
    return true;
  }
  const name = (file.name ?? "").toLowerCase();
  return name.endsWith(".heic") || name.endsWith(".heif");
}

/**
 * Whether we can produce a (web-displayable) preview for this file. Detected by
 * mime type, falling back to the filename extension when the upload mime is
 * generic (e.g. application/octet-stream for .heic on some browsers).
 */
export function isThumbnailableImage(
  mimeType?: string | null,
  name?: string | null
): boolean {
  const mime = (mimeType ?? "").toLowerCase();
  // sharp needs librsvg for SVG; treat vectors as non-previewable.
  if (mime === "image/svg+xml") return false;
  if (mime.startsWith("image/")) return true;
  return IMAGE_EXT.test(name ?? "");
}

async function readObjectBuffer(key: string): Promise<Buffer> {
  const object = await getObject(key);
  if (!object.Body) {
    throw new Error("Source object has no body");
  }
  const bytes = await (
    object.Body as { transformToByteArray(): Promise<Uint8Array> }
  ).transformToByteArray();
  return Buffer.from(bytes);
}

async function buildHeicPreview(key: string): Promise<Preview> {
  const input = await readObjectBuffer(key);
  // Decode + downscale happens in a worker thread (off the event loop).
  const buffer = await decodeHeicPreview(input);
  return { buffer, contentType: "image/jpeg" };
}

/**
 * Generates a downscaled preview of an image ON THE FLY. Nothing is written
 * back to storage and the original object is never modified.
 *
 * - Common web formats keep their ORIGINAL format (jpeg→jpeg, png→png, ...) and
 *   are re-resized per request (cheap, native libvips, async).
 * - HEIC/HEIF can't be rendered by most browsers, so the *preview only* is
 *   transcoded to JPEG for display, decoded at most once and cached in RAM.
 *   The stored .heic original stays as-is.
 */
export async function generatePreviewBuffer(file: {
  id: string;
  key: string;
  mimeType?: string | null;
  name?: string | null;
}): Promise<Preview> {
  if (isHeic(file)) {
    const cached = cacheGet(file.id);
    if (cached) return cached;

    const existing = inFlight.get(file.id);
    if (existing) return existing;

    const pending = (async () => {
      try {
        const preview = await buildHeicPreview(file.key);
        cacheSet(file.id, preview);
        return preview;
      } finally {
        inFlight.delete(file.id);
      }
    })();
    inFlight.set(file.id, pending);
    return pending;
  }

  const input = await readObjectBuffer(file.key);
  // No explicit output format → sharp re-encodes in the SAME format as input.
  const { data, info } = await sharp(input, { failOn: "none" })
    .rotate() // respect EXIF orientation
    .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });

  return { buffer: data, contentType: `image/${info.format}` };
}
