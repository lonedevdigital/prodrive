import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { copyObject, deleteObject, signedDownloadUrl, uploadObject } from "../lib/r2";
import { prisma } from "../lib/prisma";
import {
  UploadSizeLimitError,
  uploadMultipartToR2
} from "../lib/upload-stream";
import {
  generateStorageKey,
  sanitizeFilename,
  toFileResponse
} from "../lib/file-utils";
import { generatePreviewBuffer, isThumbnailableImage } from "../lib/thumbnail";
import { streamZip } from "../lib/zip";

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 200;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

const moveFileSchema = z.object({
  targetFolderId: z.string().nullable().optional()
});

const createFileSchema = z.object({
  name: z.string().min(1).max(255),
  folderId: z.string().nullable().optional(),
  content: z.string().optional(),
  mimeType: z.string().max(255).optional()
});

const copyFileSchema = z.object({
  targetFolderId: z.string().nullable().optional(),
  newName: z.string().min(1).max(255).optional()
});

const renameFileSchema = z.object({
  name: z.string().min(1).max(255)
});

const sharePublicSchema = z.object({
  enabled: z.boolean()
});

async function assertFolderOwnership(
  userId: string,
  folderId: string | null | undefined
) {
  if (!folderId) {
    return null;
  }

  const folder = await prisma.folder.findFirst({
    where: {
      id: folderId,
      ownerId: userId
    }
  });

  if (!folder) {
    throw new Error("Folder not found");
  }

  return folder;
}

const fileRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/",
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const query = request.query as {
        folderId?: string | null;
        limit?: string;
        offset?: string;
      };
      const folderId = query.folderId === "" ? null : (query.folderId ?? null);
      const limit = clampInt(query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
      const offset = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

      const where = {
        ownerId: request.user.userId,
        folderId
      };

      const [files, total] = await Promise.all([
        prisma.fileObject.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: offset,
          take: limit
        }),
        prisma.fileObject.count({ where })
      ]);

      return {
        files: files.map((file) => toFileResponse(file, request)),
        total,
        limit,
        offset
      };
    }
  );

  fastify.get(
    "/storage/summary",
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const aggregated = await prisma.fileObject.aggregate({
        where: {
          ownerId: request.user.userId
        },
        _sum: { size: true },
        _count: { _all: true }
      });

      const totalBytes = aggregated._sum.size ?? 0;
      return {
        totalBytes,
        totalGb: Number((totalBytes / (1024 ** 3)).toFixed(3)),
        fileCount: aggregated._count._all
      };
    }
  );

  // Downscaled preview for grid display. Generated on the fly in the file's
  // ORIGINAL format and never stored — the original object is untouched.
  fastify.get(
    "/:id/thumbnail",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = request.params as { id: string };
      const file = await prisma.fileObject.findFirst({
        where: { id: params.id, ownerId: request.user.userId }
      });

      if (!file) {
        return reply.code(404).send({ message: "File not found" });
      }
      if (!isThumbnailableImage(file.mimeType, file.name)) {
        return reply.code(400).send({ message: "File is not a previewable image" });
      }

      try {
        const { buffer, contentType } = await generatePreviewBuffer(file);
        reply.header("Content-Type", contentType);
        reply.header("Cache-Control", "private, max-age=86400");
        return reply.send(buffer);
      } catch (error) {
        request.log.error({ err: error, fileId: file.id }, "thumbnail failed");
        return reply.code(500).send({ message: "Gagal membuat preview" });
      }
    }
  );

  // Batch download: zip up the selected files (used by multi-select).
  fastify.get(
    "/download-zip",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const query = request.query as { ids?: string };
      const ids = (query.ids ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);

      if (ids.length === 0) {
        return reply.code(400).send({ message: "No file ids provided" });
      }

      const files = await prisma.fileObject.findMany({
        where: { id: { in: ids }, ownerId: request.user.userId },
        select: { key: true, name: true }
      });

      if (files.length === 0) {
        return reply.code(404).send({ message: "No files found" });
      }

      return streamZip(
        reply,
        `protekdrive-${files.length}-file.zip`,
        files.map((file) => ({ key: file.key, name: file.name }))
      );
    }
  );

  fastify.post(
    "/create",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = createFileSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          message: "Invalid payload",
          errors: parsed.error.flatten()
        });
      }

      try {
        await assertFolderOwnership(request.user.userId, parsed.data.folderId);
      } catch {
        return reply.code(404).send({ message: "Target folder not found" });
      }

      const fileName = sanitizeFilename(parsed.data.name.trim() || "Untitled.txt");
      const key = generateStorageKey(request.user.userId, fileName);
      const bodyBuffer = Buffer.from(parsed.data.content ?? "", "utf8");
      const mimeType =
        parsed.data.mimeType ?? (parsed.data.content ? "text/plain" : "application/octet-stream");

      await uploadObject({
        key,
        body: bodyBuffer,
        contentType: mimeType
      });

      const created = await prisma.fileObject.create({
        data: {
          name: fileName,
          key,
          size: bodyBuffer.length,
          mimeType,
          ownerId: request.user.userId,
          folderId: parsed.data.folderId ?? null
        }
      });

      return reply.code(201).send({
        file: toFileResponse(created, request)
      });
    }
  );

  fastify.post(
    "/upload",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const part = await request.file();
      if (!part) {
        return reply.code(400).send({ message: "Missing file multipart field" });
      }

      const folderField = part.fields.folderId as
        | { value?: string }
        | undefined;
      const folderId = folderField?.value ? String(folderField.value) : null;

      try {
        await assertFolderOwnership(request.user.userId, folderId);
      } catch {
        return reply.code(404).send({ message: "Target folder not found" });
      }

      const fileName = sanitizeFilename(part.filename || "file");
      const key = generateStorageKey(request.user.userId, fileName);

      let uploadedSize = 0;
      try {
        const result = await uploadMultipartToR2({
          part,
          key,
          contentType: part.mimetype
        });
        uploadedSize = result.bytesUploaded;
      } catch (error) {
        if (error instanceof UploadSizeLimitError) {
          return reply.code(413).send({
            message: "Ukuran file melebihi limit upload server"
          });
        }
        request.log.error({ err: error, key }, "R2 upload failed");
        return reply.code(500).send({ message: "Upload ke storage gagal" });
      }

      const created = await prisma.fileObject.create({
        data: {
          name: fileName,
          key,
          size: uploadedSize,
          mimeType: part.mimetype,
          ownerId: request.user.userId,
          folderId
        }
      });

      return reply.code(201).send({
        file: toFileResponse(created, request)
      });
    }
  );

  fastify.patch(
    "/:id/move",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = request.params as { id: string };
      const parsed = moveFileSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          message: "Invalid payload",
          errors: parsed.error.flatten()
        });
      }

      const file = await prisma.fileObject.findFirst({
        where: {
          id: params.id,
          ownerId: request.user.userId
        }
      });

      if (!file) {
        return reply.code(404).send({ message: "File not found" });
      }

      try {
        await assertFolderOwnership(request.user.userId, parsed.data.targetFolderId);
      } catch {
        return reply.code(404).send({ message: "Target folder not found" });
      }

      const updated = await prisma.fileObject.update({
        where: { id: file.id },
        data: {
          folderId: parsed.data.targetFolderId ?? null
        }
      });

      return { file: toFileResponse(updated, request) };
    }
  );

  fastify.post(
    "/:id/copy",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = request.params as { id: string };
      const parsed = copyFileSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          message: "Invalid payload",
          errors: parsed.error.flatten()
        });
      }

      const source = await prisma.fileObject.findFirst({
        where: {
          id: params.id,
          ownerId: request.user.userId
        }
      });

      if (!source) {
        return reply.code(404).send({ message: "File not found" });
      }

      try {
        await assertFolderOwnership(request.user.userId, parsed.data.targetFolderId);
      } catch {
        return reply.code(404).send({ message: "Target folder not found" });
      }

      const newName = sanitizeFilename(parsed.data.newName ?? source.name);
      const newKey = generateStorageKey(request.user.userId, newName);

      await copyObject({
        sourceKey: source.key,
        destinationKey: newKey,
        contentType: source.mimeType
      });

      const copied = await prisma.fileObject.create({
        data: {
          name: newName,
          key: newKey,
          size: source.size,
          mimeType: source.mimeType,
          ownerId: request.user.userId,
          folderId: parsed.data.targetFolderId ?? null
        }
      });

      return reply.code(201).send({
        file: toFileResponse(copied, request)
      });
    }
  );

  fastify.patch(
    "/:id/rename",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = request.params as { id: string };
      const parsed = renameFileSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          message: "Invalid payload",
          errors: parsed.error.flatten()
        });
      }

      const file = await prisma.fileObject.findFirst({
        where: {
          id: params.id,
          ownerId: request.user.userId
        }
      });

      if (!file) {
        return reply.code(404).send({ message: "File not found" });
      }

      const updated = await prisma.fileObject.update({
        where: { id: file.id },
        data: {
          name: sanitizeFilename(parsed.data.name.trim())
        }
      });

      return { file: toFileResponse(updated, request) };
    }
  );

  fastify.post(
    "/:id/share/public",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = request.params as { id: string };
      const parsed = sharePublicSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          message: "Invalid payload",
          errors: parsed.error.flatten()
        });
      }

      const file = await prisma.fileObject.findFirst({
        where: {
          id: params.id,
          ownerId: request.user.userId
        }
      });

      if (!file) {
        return reply.code(404).send({ message: "File not found" });
      }

      const updated = await prisma.fileObject.update({
        where: { id: file.id },
        data: {
          isPublic: parsed.data.enabled,
          publicToken: parsed.data.enabled
            ? file.publicToken ?? randomUUID().replace(/-/g, "")
            : null
        }
      });

      return {
        file: toFileResponse(updated, request)
      };
    }
  );

  fastify.get(
    "/:id/download-url",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = request.params as { id: string };

      const file = await prisma.fileObject.findFirst({
        where: {
          id: params.id,
          ownerId: request.user.userId
        }
      });

      if (!file) {
        return reply.code(404).send({ message: "File not found" });
      }

      const url = await signedDownloadUrl(file.key);
      return {
        url,
        expiresInSeconds: 900
      };
    }
  );

  fastify.delete(
    "/:id",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = request.params as { id: string };
      const file = await prisma.fileObject.findFirst({
        where: {
          id: params.id,
          ownerId: request.user.userId
        }
      });

      if (!file) {
        return reply.code(404).send({ message: "File not found" });
      }

      await deleteObject(file.key);
      await prisma.fileObject.delete({ where: { id: file.id } });

      return { message: "File deleted" };
    }
  );
};

export default fileRoutes;
