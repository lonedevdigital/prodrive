import type { MultipartFile } from "@fastify/multipart";
import { Transform, type TransformCallback } from "node:stream";
import { uploadObject } from "./r2";

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
