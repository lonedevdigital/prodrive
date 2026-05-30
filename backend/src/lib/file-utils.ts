import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { FileObject } from "@prisma/client";
import { appConfig } from "../config";

export function sanitizeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function generateStorageKey(userId: string, filename: string): string {
  const clean = sanitizeFilename(filename || "file");
  return `${userId}/${randomUUID()}-${clean}`;
}

export function toFileResponse(
  file: FileObject,
  request: FastifyRequest
): Record<string, unknown> {
  const host = request.headers.host;
  const inferredBase = `${request.protocol}://${host}`;
  const base = appConfig.publicShareBaseUrl ?? inferredBase;

  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mimeType: file.mimeType,
    folderId: file.folderId,
    isPublic: file.isPublic,
    publicToken: file.publicToken,
    publicUrl:
      file.isPublic && file.publicToken
        ? `${base}/api/public/${file.publicToken}/download`
        : null,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt
  };
}
