import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { FileObject } from "@prisma/client";
import { appConfig } from "../config";

// Besides path separators, the only thing we strip from a filename is control
// characters (0x00-0x1F and 0x7F). Everything else -- spaces, unicode,
// parentheses, &, +, etc. -- is kept so the name is preserved exactly.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;

export function sanitizeFilename(filename: string): string {
  let name = (filename ?? "")
    .replace(/[/\\]+/g, "_")
    .replace(CONTROL_CHARS, "")
    .trim();
  if (name === "" || name === "." || name === "..") {
    name = "file";
  }
  return name;
}

/** Rename a .heic/.heif file to .jpg (used when converting HEIC on upload). */
export function swapHeicToJpg(filename: string): string {
  if (/\.(heic|heif)$/i.test(filename)) {
    return filename.replace(/\.(heic|heif)$/i, ".jpg");
  }
  return `${filename}.jpg`;
}

// The object key keeps the ORIGINAL filename as its final segment, untouched.
// Uniqueness comes from a random-uuid PARENT folder, so two files with the same
// name never collide yet the filename itself is never renamed.
export function generateStorageKey(userId: string, filename: string): string {
  const clean = sanitizeFilename(filename || "file");
  return `${userId}/${randomUUID()}/${clean}`;
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
