import sharp from "sharp";
import {
  deleteObjectQuietly,
  getObject,
  headObject,
  signedDownloadUrl,
  uploadObject
} from "./r2";

const THUMB_PREFIX = "thumb";
// Thumbnails are served in the grid preview at ~160-220px wide; 480px keeps
// them crisp on retina screens while staying tiny compared to the original.
const THUMB_WIDTH = 480;
const THUMB_QUALITY = 72;

export function thumbnailKeyForFile(fileId: string): string {
  return `${THUMB_PREFIX}/${fileId}.webp`;
}

/** Images we can rasterise into a webp thumbnail with sharp. */
export function isThumbnailableImage(mimeType?: string | null): boolean {
  if (!mimeType) return false;
  if (!mimeType.startsWith("image/")) return false;
  // sharp needs librsvg for SVG; treat vectors as non-thumbnailable.
  if (mimeType === "image/svg+xml") return false;
  return true;
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  const bytes = await (
    body as { transformToByteArray(): Promise<Uint8Array> }
  ).transformToByteArray();
  return Buffer.from(bytes);
}

async function generateThumbnail(
  sourceKey: string,
  thumbKey: string
): Promise<void> {
  const object = await getObject(sourceKey);
  if (!object.Body) {
    throw new Error("Source object has no body");
  }
  const input = await bodyToBuffer(object.Body);
  const output = await sharp(input, { failOn: "none" })
    .rotate() // respect EXIF orientation
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();

  await uploadObject({
    key: thumbKey,
    body: output,
    contentType: "image/webp"
  });
}

/**
 * Ensures a cached webp thumbnail exists in R2 and returns its key.
 * Generates it on the first request, then reuses the cached object.
 */
export async function ensureThumbnailKey(file: {
  id: string;
  key: string;
}): Promise<string> {
  const thumbKey = thumbnailKeyForFile(file.id);
  const exists = await headObject(thumbKey);
  if (!exists) {
    await generateThumbnail(file.key, thumbKey);
  }
  return thumbKey;
}

/** Signed URL to the cached thumbnail (used by the authenticated app). */
export async function thumbnailSignedUrl(file: {
  id: string;
  key: string;
}): Promise<string> {
  const thumbKey = await ensureThumbnailKey(file);
  return signedDownloadUrl(thumbKey);
}

/** Raw webp bytes of the cached thumbnail (used by public share streaming). */
export async function getThumbnailBuffer(file: {
  id: string;
  key: string;
}): Promise<Buffer> {
  const thumbKey = await ensureThumbnailKey(file);
  const object = await getObject(thumbKey);
  if (!object.Body) {
    throw new Error("Thumbnail object has no body");
  }
  return bodyToBuffer(object.Body);
}

/** Best-effort cleanup of cached thumbnails when their files are removed. */
export async function deleteThumbnailsQuietly(fileIds: string[]): Promise<void> {
  await Promise.all(
    fileIds.map((id) => deleteObjectQuietly(thumbnailKeyForFile(id)))
  );
}
