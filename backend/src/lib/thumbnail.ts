import sharp from "sharp";
import { getObject } from "./r2";

// Preview width for the grid. Images are downscaled only for display; the
// original file in storage is never modified, converted, or copied.
const PREVIEW_WIDTH = 480;

/** Images we can downscale with sharp for a preview. */
export function isThumbnailableImage(mimeType?: string | null): boolean {
  if (!mimeType) return false;
  if (!mimeType.startsWith("image/")) return false;
  // sharp needs librsvg for SVG; treat vectors as non-previewable.
  if (mimeType === "image/svg+xml") return false;
  return true;
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  const bytes = await (
    body as { transformToByteArray(): Promise<Uint8Array> }
  ).transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * Generates a downscaled preview of an image ON THE FLY, keeping the original
 * file's format (jpeg stays jpeg, png stays png, ...). Nothing is written back
 * to storage — this is purely a smaller copy for the grid preview, streamed
 * with cache headers so the browser keeps it.
 */
export async function generatePreviewBuffer(file: {
  key: string;
}): Promise<Buffer> {
  const object = await getObject(file.key);
  if (!object.Body) {
    throw new Error("Source object has no body");
  }
  const input = await bodyToBuffer(object.Body);
  // No explicit output format → sharp re-encodes in the SAME format as input.
  return sharp(input, { failOn: "none" })
    .rotate() // respect EXIF orientation
    .resize({ width: PREVIEW_WIDTH, withoutEnlargement: true })
    .toBuffer();
}
