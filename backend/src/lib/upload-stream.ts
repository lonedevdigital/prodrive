import type { MultipartFile } from "@fastify/multipart";
import { Transform, type TransformCallback } from "node:stream";
import { uploadObject } from "./r2";
import { convertHeicToJpeg } from "./heic-pool";
import { isHeicFile } from "./thumbnail";
import {
  generateStorageKey,
  sanitizeFilename,
  swapHeicToJpg
} from "./file-utils";

class ByteCounterTransform extends Transform {
  public bytes = 0;

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    this.bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    callback(null, chunk);
  }
}

export class UploadSizeLimitError extends Error {
  constructor() {
    super("File size exceeds upload limit");
    this.name = "UploadSizeLimitError";
  }
}

export async function uploadMultipartToR2(params: {
  part: MultipartFile;
  key: string;
  contentType?: string;
}): Promise<{ bytesUploaded: number }> {
  const stream = params.part.file as NodeJS.ReadableStream & {
    truncated?: boolean;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
  };

  const counter = new ByteCounterTransform();
  let limitReached = false;

  stream.on("limit", () => {
    limitReached = true;
    counter.destroy(new UploadSizeLimitError());
  });

  stream.pipe(counter);

  try {
    await uploadObject({
      key: params.key,
      body: counter,
      contentType: params.contentType
    });
  } catch (error) {
    if (limitReached || stream.truncated) {
      throw new UploadSizeLimitError();
    }
    throw error;
  }

  if (limitReached || stream.truncated) {
    throw new UploadSizeLimitError();
  }

  if (counter.bytes <= 0) {
    throw new Error("Cannot upload empty file");
  }

  return { bytesUploaded: counter.bytes };
}

export type StoredUpload = {
  name: string;
  key: string;
  size: number;
  mimeType: string | null;
};

// HEIC must be buffered in memory to decode; cap it so a huge file named .heic
// can't exhaust server memory. Real HEIC photos are a few MB.
const HEIC_MAX_INPUT_BYTES =
  (Number(process.env.HEIC_MAX_INPUT_MB) || 80) * 1024 * 1024;

async function readPartToBuffer(
  part: MultipartFile,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of part.file) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > maxBytes || part.file.truncated) {
      throw new UploadSizeLimitError();
    }
    chunks.push(buf);
  }
  if (part.file.truncated) {
    throw new UploadSizeLimitError();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Persists one uploaded multipart file to R2 and returns the stored metadata.
 *
 * - HEIC/HEIF is converted to JPG at upload (browsers other than Safari can't
 *   render HEIC). Only the JPG is stored — the original HEIC is not kept — so
 *   previews/downloads are fast and work everywhere afterwards.
 * - Everything else streams straight through unchanged (original format kept).
 */
export async function storeUploadedPart(params: {
  part: MultipartFile;
  ownerId: string;
}): Promise<StoredUpload> {
  const { part, ownerId } = params;

  if (isHeicFile({ mimeType: part.mimetype, name: part.filename })) {
    const heicBuffer = await readPartToBuffer(part, HEIC_MAX_INPUT_BYTES);
    if (heicBuffer.length === 0) {
      throw new Error("Cannot upload empty file");
    }
    const jpegBuffer = await convertHeicToJpeg(heicBuffer);
    const name = sanitizeFilename(swapHeicToJpg(part.filename || "file"));
    const key = generateStorageKey(ownerId, name);
    await uploadObject({ key, body: jpegBuffer, contentType: "image/jpeg" });
    return { name, key, size: jpegBuffer.length, mimeType: "image/jpeg" };
  }

  const name = sanitizeFilename(part.filename || "file");
  const key = generateStorageKey(ownerId, name);
  const result = await uploadMultipartToR2({
    part,
    key,
    contentType: part.mimetype
  });
  return { name, key, size: result.bytesUploaded, mimeType: part.mimetype ?? null };
}
