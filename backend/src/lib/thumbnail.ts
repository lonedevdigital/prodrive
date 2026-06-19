import sharp from "sharp";
import heicConvert from "heic-convert";
import { getObject } from "./r2";

// Preview width for the grid. Images are downscaled only for display; the
// original file in storage is never modified, converted, or copied.
const PREVIEW_WIDTH = 480;

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|heic|heif)$/i;

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

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  const bytes = await (
    body as { transformToByteArray(): Promise<Uint8Array> }
  ).transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * Generates a downscaled preview of an image ON THE FLY. Nothing is written
 * back to storage and the original object is never modified.
 *
 * - Common web formats keep their ORIGINAL format (jpeg→jpeg, png→png, ...).
 * - HEIC/HEIF can't be rendered by most browsers, so the *preview only* is
 *   transcoded to JPEG for display. The stored .heic original stays as-is.
 *
 * Returns the preview bytes plus the Content-Type the route should send.
 */
export async function generatePreviewBuffer(file: {
  key: string;
  mimeType?: string | null;
  name?: string | null;
}): Promise<{ buffer: Buffer; contentType: string }> {
  const object = await getObject(file.key);
  if (!object.Body) {
    throw new Error("Source object has no body");
  }
  const input = await bodyToBuffer(object.Body);

  if (isHeic(file)) {
    // Decode HEVC via WASM (sharp's prebuilt libheif only handles AVIF), then
    // downscale and emit JPEG so every browser can display the preview.
    const decodedJpeg = await heicConvert({
      buffer: input,
      format: "JPEG",
      quality: 0.82
    });
    const buffer = await sharp(Buffer.from(decodedJpeg))
      .rotate()
      .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { buffer, contentType: "image/jpeg" };
  }

  // No explicit output format → sharp re-encodes in the SAME format as input.
  const { data, info } = await sharp(input, { failOn: "none" })
    .rotate() // respect EXIF orientation
    .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });

  return { buffer: data, contentType: `image/${info.format}` };
}
