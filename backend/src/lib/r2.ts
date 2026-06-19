import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { appConfig } from "../config";

export const r2Client = new S3Client({
  region: "auto",
  endpoint: appConfig.r2.endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: appConfig.r2.accessKeyId,
    secretAccessKey: appConfig.r2.secretAccessKey
  }
});

function encodeCopySource(sourceKey: string): string {
  return `${appConfig.r2.bucket}/${encodeURIComponent(sourceKey).replace(/%2F/g, "/")}`;
}

export async function uploadObject(params: {
  key: string;
  body: Buffer | Uint8Array | string | Readable;
  contentType?: string;
  contentLength?: number;
}): Promise<void> {
  const upload = new Upload({
    client: r2Client,
    queueSize: appConfig.r2Upload.multipartQueueSize,
    partSize: appConfig.r2Upload.multipartPartSizeBytes,
    leavePartsOnError: false,
    params: {
      Bucket: appConfig.r2.bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      ContentLength: params.contentLength
    }
  });

  await upload.done();
}

export async function copyObject(params: {
  sourceKey: string;
  destinationKey: string;
  contentType?: string | null;
}): Promise<void> {
  await r2Client.send(
    new CopyObjectCommand({
      Bucket: appConfig.r2.bucket,
      Key: params.destinationKey,
      CopySource: encodeCopySource(params.sourceKey),
      ContentType: params.contentType ?? undefined,
      MetadataDirective: params.contentType ? "REPLACE" : "COPY"
    })
  );
}

export async function deleteObject(key: string): Promise<void> {
  await r2Client.send(
    new DeleteObjectCommand({
      Bucket: appConfig.r2.bucket,
      Key: key
    })
  );
}

export async function deleteObjectsStrict(
  keys: string[],
  batchSize = 20
): Promise<void> {
  if (keys.length === 0) {
    return;
  }

  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map((key) => deleteObject(key)));
    const failedCount = settled.filter((result) => result.status === "rejected").length;

    if (failedCount > 0) {
      throw new Error(`Failed deleting ${failedCount} object(s) from R2`);
    }
  }
}

export function signedDownloadUrl(key: string): Promise<string> {
  return getSignedUrl(
    r2Client,
    new GetObjectCommand({
      Bucket: appConfig.r2.bucket,
      Key: key
    }),
    { expiresIn: 900 }
  );
}

export async function getObject(key: string) {
  return r2Client.send(
    new GetObjectCommand({
      Bucket: appConfig.r2.bucket,
      Key: key
    })
  );
}

/**
 * Returns true if an object exists under `key`, false on 404.
 * Re-throws unexpected errors.
 */
export async function headObject(key: string): Promise<boolean> {
  try {
    await r2Client.send(
      new HeadObjectCommand({
        Bucket: appConfig.r2.bucket,
        Key: key
      })
    );
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    const name = (error as { name?: string })?.name;
    if (status === 404 || name === "NotFound" || name === "NoSuchKey") {
      return false;
    }
    throw error;
  }
}

/** Best-effort delete that never throws (for cleanup of derived objects). */
export async function deleteObjectQuietly(key: string): Promise<void> {
  try {
    await deleteObject(key);
  } catch {
    /* ignore */
  }
}
