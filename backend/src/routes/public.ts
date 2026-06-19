import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  deleteObject,
  deleteObjectsStrict,
  getObject,
  uploadObject
} from "../lib/r2";
import { prisma } from "../lib/prisma";
import {
  UploadSizeLimitError,
  uploadMultipartToR2
} from "../lib/upload-stream";
import {
  generateStorageKey,
  sanitizeFilename
} from "../lib/file-utils";
import {
  generatePreviewBuffer,
  isThumbnailableImage
} from "../lib/thumbnail";
import { buildArchivePath, streamZip } from "../lib/zip";

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 200;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

const folderCreateSchema = z.object({
  name: z.string().min(1).max(120),
  parentId: z.string().nullable().optional()
});

const folderRenameSchema = z.object({
  name: z.string().min(1).max(120)
});

const fileCreateSchema = z.object({
  name: z.string().min(1).max(255),
  folderId: z.string().nullable().optional(),
  content: z.string().optional(),
  mimeType: z.string().max(255).optional()
});

const fileRenameSchema = z.object({
  name: z.string().min(1).max(255)
});

function inferBaseUrl(request: {
  protocol: string;
  headers: { host?: string };
}): string {
  return `${request.protocol}://${request.headers.host}`;
}

function mapChildren(allFolders: Array<{ id: string; parentId: string | null }>) {
  const childrenMap = new Map<string | null, string[]>();
  for (const folder of allFolders) {
    const list = childrenMap.get(folder.parentId ?? null) ?? [];
    list.push(folder.id);
    childrenMap.set(folder.parentId ?? null, list);
  }
  return childrenMap;
}

function collectDescendantIds(
  rootFolderId: string,
  childrenMap: Map<string | null, string[]>
): string[] {
  const result: string[] = [];
  const stack: string[] = [rootFolderId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    result.push(current);
    const children = childrenMap.get(current) ?? [];
    for (const child of children) {
      stack.push(child);
    }
  }
  return result;
}

async function resolvePublicFolderShare(token: string) {
  const rootFolder = await prisma.folder.findFirst({
    where: {
      publicToken: token,
      isPublic: true
    }
  });

  if (!rootFolder) {
    return null;
  }

  const allFolders = await prisma.folder.findMany({
    where: {
      ownerId: rootFolder.ownerId
    },
    select: {
      id: true,
      parentId: true
    }
  });

  const descendants = collectDescendantIds(rootFolder.id, mapChildren(allFolders));
  const descendantSet = new Set(descendants);

  return {
    rootFolder,
    descendantIds: descendants,
    descendantSet
  };
}

function ensureFolderInShare(
  folderId: string,
  shareContext: { descendantSet: Set<string> }
) {
  return shareContext.descendantSet.has(folderId);
}

function assertEditPermission(
  shareContext: {
    rootFolder: {
      publicPermission: "VIEW" | "EDIT";
    };
  }
) {
  return shareContext.rootFolder.publicPermission === "EDIT";
}

const publicRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/folders/:token/content", async (request, reply) => {
    const params = request.params as { token: string };
    const query = request.query as {
      folderId?: string | null;
      limit?: string;
      offset?: string;
    };
    const shareContext = await resolvePublicFolderShare(params.token);
    if (!shareContext) {
      return reply.code(404).send({ message: "Public folder not found" });
    }

    const currentFolderId = query.folderId ?? shareContext.rootFolder.id;
    if (!ensureFolderInShare(currentFolderId, shareContext)) {
      return reply.code(403).send({ message: "Folder access denied" });
    }

    const limit = clampInt(query.limit, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
    const offset = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    const fileWhere = {
      ownerId: shareContext.rootFolder.ownerId,
      folderId: currentFolderId
    };

    const [folders, files, total] = await Promise.all([
      prisma.folder.findMany({
        where: {
          ownerId: shareContext.rootFolder.ownerId,
          parentId: currentFolderId
        },
        orderBy: { name: "asc" }
      }),
      prisma.fileObject.findMany({
        where: fileWhere,
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit
      }),
      prisma.fileObject.count({ where: fileWhere })
    ]);

    const baseUrl = inferBaseUrl(request);
    const fileBase = `${baseUrl}/api/public/folders/${params.token}/files`;

    return {
      share: {
        token: params.token,
        permission: shareContext.rootFolder.publicPermission,
        rootFolderId: shareContext.rootFolder.id,
        currentFolderId
      },
      folders,
      total,
      limit,
      offset,
      files: files.map((file) => ({
        id: file.id,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        folderId: file.folderId,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        downloadUrl: `${fileBase}/${file.id}/download`,
        thumbnailUrl: isThumbnailableImage(file.mimeType, file.name)
          ? `${fileBase}/${file.id}/thumbnail`
          : null
      }))
    };
  });

  fastify.get("/folders/:token/files/:fileId/download", async (request, reply) => {
    const params = request.params as { token: string; fileId: string };
    const shareContext = await resolvePublicFolderShare(params.token);
    if (!shareContext) {
      return reply.code(404).send({ message: "Public folder not found" });
    }

    const file = await prisma.fileObject.findFirst({
      where: {
        id: params.fileId,
        ownerId: shareContext.rootFolder.ownerId,
        folderId: {
          in: shareContext.descendantIds
        }
      }
    });

    if (!file) {
      return reply.code(404).send({ message: "File not found in shared folder" });
    }

    const object = await getObject(file.key);
    if (!object.Body) {
      return reply.code(404).send({ message: "File data not found" });
    }

    reply.header(
      "Content-Type",
      file.mimeType || object.ContentType || "application/octet-stream"
    );
    reply.header("Content-Length", String(file.size));
    reply.header(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(file.name)}"`
    );

    return reply.send(object.Body as unknown as NodeJS.ReadableStream);
  });

  // Lightweight cached thumbnail for grid previews in a public share.
  fastify.get(
    "/folders/:token/files/:fileId/thumbnail",
    async (request, reply) => {
      const params = request.params as { token: string; fileId: string };
      const shareContext = await resolvePublicFolderShare(params.token);
      if (!shareContext) {
        return reply.code(404).send({ message: "Public folder not found" });
      }

      const file = await prisma.fileObject.findFirst({
        where: {
          id: params.fileId,
          ownerId: shareContext.rootFolder.ownerId,
          folderId: { in: shareContext.descendantIds }
        }
      });

      if (!file) {
        return reply.code(404).send({ message: "File not found in shared folder" });
      }
      if (!isThumbnailableImage(file.mimeType, file.name)) {
        return reply.code(400).send({ message: "File is not a previewable image" });
      }

      try {
        const { buffer, contentType } = await generatePreviewBuffer(file);
        reply.header("Content-Type", contentType);
        reply.header("Cache-Control", "public, max-age=86400");
        return reply.send(buffer);
      } catch (error) {
        request.log.error({ err: error, fileId: file.id }, "public thumbnail failed");
        return reply.code(500).send({ message: "Gagal membuat preview" });
      }
    }
  );

  // Download an entire shared (sub)folder as a zip, preserving structure.
  fastify.get("/folders/:token/download", async (request, reply) => {
    const params = request.params as { token: string };
    const query = request.query as { folderId?: string | null };
    const shareContext = await resolvePublicFolderShare(params.token);
    if (!shareContext) {
      return reply.code(404).send({ message: "Public folder not found" });
    }

    const targetFolderId = query.folderId ?? shareContext.rootFolder.id;
    if (!ensureFolderInShare(targetFolderId, shareContext)) {
      return reply.code(403).send({ message: "Folder access denied" });
    }

    const allFolders = await prisma.folder.findMany({
      where: { ownerId: shareContext.rootFolder.ownerId },
      select: { id: true, name: true, parentId: true }
    });
    const folderMap = new Map(allFolders.map((f) => [f.id, f]));
    const childrenMap = mapChildren(allFolders);

    const descendantIds = collectDescendantIds(targetFolderId, childrenMap).filter(
      (id) => shareContext.descendantSet.has(id)
    );

    const pathCache = new Map<string, string[]>();
    const folderPathParts = (fid: string): string[] => {
      const cached = pathCache.get(fid);
      if (cached) return cached;
      const parts: string[] = [];
      let current: string | null = fid;
      while (current) {
        const node = folderMap.get(current);
        if (!node) break;
        parts.unshift(node.name);
        if (current === targetFolderId) break;
        current = node.parentId ?? null;
      }
      pathCache.set(fid, parts);
      return parts;
    };

    const files = await prisma.fileObject.findMany({
      where: {
        ownerId: shareContext.rootFolder.ownerId,
        folderId: { in: descendantIds }
      },
      select: { key: true, name: true, folderId: true }
    });

    if (files.length === 0) {
      return reply
        .code(400)
        .send({ message: "Folder ini tidak punya file untuk diunduh" });
    }

    const folderName = folderMap.get(targetFolderId)?.name ?? "folder";
    const entries = files.map((file) => ({
      key: file.key,
      name: buildArchivePath([
        ...folderPathParts(file.folderId ?? targetFolderId),
        file.name
      ])
    }));

    return streamZip(reply, `${folderName}.zip`, entries);
  });

  // Batch download selected files inside a public share as a zip.
  fastify.get("/folders/:token/download-zip", async (request, reply) => {
    const params = request.params as { token: string };
    const query = request.query as { ids?: string };
    const shareContext = await resolvePublicFolderShare(params.token);
    if (!shareContext) {
      return reply.code(404).send({ message: "Public folder not found" });
    }

    const ids = (query.ids ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      return reply.code(400).send({ message: "No file ids provided" });
    }

    const files = await prisma.fileObject.findMany({
      where: {
        id: { in: ids },
        ownerId: shareContext.rootFolder.ownerId,
        folderId: { in: shareContext.descendantIds }
      },
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
  });

  fastify.post("/folders/:token/folders", async (request, reply) => {
    const params = request.params as { token: string };
    const parsed = folderCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid payload",
        errors: parsed.error.flatten()
      });
    }

    const shareContext = await resolvePublicFolderShare(params.token);
    if (!shareContext) {
      return reply.code(404).send({ message: "Public folder not found" });
    }

    if (!assertEditPermission(shareContext)) {
      return reply.code(403).send({ message: "This shared folder is read-only" });
    }

    const parentId = parsed.data.parentId ?? shareContext.rootFolder.id;
    if (!ensureFolderInShare(parentId, shareContext)) {
      return reply.code(403).send({ message: "Parent folder access denied" });
    }

    const folder = await prisma.folder.create({
      data: {
        name: parsed.data.name.trim(),
        ownerId: shareContext.rootFolder.ownerId,
        parentId
      }
    });

    return reply.code(201).send({ folder });
  });

  fastify.patch("/folders/:token/folders/:folderId/rename", async (request, reply) => {
    const params = request.params as { token: string; folderId: string };
    const parsed = folderRenameSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid payload",
        errors: parsed.error.flatten()
      });
    }

    const shareContext = await resolvePublicFolderShare(params.token);
    if (!shareContext) {
      return reply.code(404).send({ message: "Public folder not found" });
    }

    if (!assertEditPermission(shareContext)) {
      return reply.code(403).send({ message: "This shared folder is read-only" });
    }

    if (!ensureFolderInShare(params.folderId, shareContext)) {
      return reply.code(403).send({ message: "Folder access denied" });
    }

    const folder = await prisma.folder.findFirst({
      where: {
        id: params.folderId,
        ownerId: shareContext.rootFolder.ownerId
      }
    });

    if (!folder) {
      return reply.code(404).send({ message: "Folder not found" });
    }

    const updated = await prisma.folder.update({
      where: { id: folder.id },
      data: {
        name: parsed.data.name.trim()
      }
    });

    return { folder: updated };
  });

  fastify.delete("/folders/:token/folders/:folderId", async (request, reply) => {
    const params = request.params as { token: string; folderId: string };
    const shareContext = await resolvePublicFolderShare(params.token);
    if (!shareContext) {
      return reply.code(404).send({ message: "Public folder not found" });
    }

    if (!assertEditPermission(shareContext)) {
      return reply.code(403).send({ message: "This shared folder is read-only" });
    }

    if (!ensureFolderInShare(params.folderId, shareContext)) {
      return reply.code(403).send({ message: "Folder access denied" });
    }

    if (params.folderId === shareContext.rootFolder.id) {
      return reply.code(400).send({ message: "Shared root folder cannot be deleted" });
    }

    const allOwnerFolders = await prisma.folder.findMany({
      where: {
        ownerId: shareContext.rootFolder.ownerId
      },
      select: {
        id: true,
        parentId: true
      }
    });

    const idsToDelete = collectDescendantIds(
      params.folderId,
      mapChildren(allOwnerFolders)
    ).filter((id) => shareContext.descendantSet.has(id));

    const files = await prisma.fileObject.findMany({
      where: {
        ownerId: shareContext.rootFolder.ownerId,
        folderId: {
          in: idsToDelete
        }
      },
      select: {
        id: true,
        key: true
      }
    });

    try {
      await deleteObjectsStrict(files.map((file) => file.key));
    } catch {
      return reply.code(502).send({
        message:
          "Gagal menghapus sebagian file di R2. Penghapusan dibatalkan agar data konsisten."
      });
    }

    await prisma.$transaction(async (tx) => {
      if (files.length > 0) {
        await tx.fileObject.deleteMany({
          where: {
            id: {
              in: files.map((file) => file.id)
            }
          }
        });
      }

      await tx.folder.deleteMany({
        where: {
          id: {
            in: idsToDelete
          }
        }
      });
    });

    return {
      message: "Folder deleted",
      deletedFolders: idsToDelete.length,
      deletedFiles: files.length
    };
  });

  fastify.post("/folders/:token/files/create", async (request, reply) => {
    const params = request.params as { token: string };
    const parsed = fileCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid payload",
        errors: parsed.error.flatten()
      });
    }

    const shareContext = await resolvePublicFolderShare(params.token);
    if (!shareContext) {
      return reply.code(404).send({ message: "Public folder not found" });
    }

    if (!assertEditPermission(shareContext)) {
      return reply.code(403).send({ message: "This shared folder is read-only" });
    }

    const folderId = parsed.data.folderId ?? shareContext.rootFolder.id;
    if (!ensureFolderInShare(folderId, shareContext)) {
      return reply.code(403).send({ message: "Folder access denied" });
    }

    const fileName = sanitizeFilename(parsed.data.name.trim() || "Untitled.txt");
    const key = generateStorageKey(shareContext.rootFolder.ownerId, fileName);
    const bodyBuffer = Buffer.from(parsed.data.content ?? "", "utf8");
    const mimeType =
      parsed.data.mimeType ??
      (parsed.data.content ? "text/plain" : "application/octet-stream");

    await uploadObject({
      key,
      body: bodyBuffer,
      contentType: mimeType
    });

    const file = await prisma.fileObject.create({
      data: {
        name: fileName,
        key,
        size: bodyBuffer.length,
        mimeType,
        ownerId: shareContext.rootFolder.ownerId,
        folderId
      }
    });

    return reply.code(201).send({ file });
  });

  fastify.post("/folders/:token/files/upload", async (request, reply) => {
    const params = request.params as { token: string };
    const shareContext = await resolvePublicFolderShare(params.token);
    if (!shareContext) {
      return reply.code(404).send({ message: "Public folder not found" });
    }

    if (!assertEditPermission(shareContext)) {
      return reply.code(403).send({ message: "This shared folder is read-only" });
    }

    const part = await request.file();
    if (!part) {
      return reply.code(400).send({ message: "Missing file multipart field" });
    }

    const folderField = part.fields.folderId as { value?: string } | undefined;
    const folderId = folderField?.value ?? shareContext.rootFolder.id;

    if (!ensureFolderInShare(folderId, shareContext)) {
      return reply.code(403).send({ message: "Folder access denied" });
    }

    const fileName = sanitizeFilename(part.filename || "file");
    const key = generateStorageKey(shareContext.rootFolder.ownerId, fileName);

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
      throw error;
    }

    const file = await prisma.fileObject.create({
      data: {
        name: fileName,
        key,
        size: uploadedSize,
        mimeType: part.mimetype,
        ownerId: shareContext.rootFolder.ownerId,
        folderId
      }
    });

    return reply.code(201).send({ file });
  });

  fastify.patch("/folders/:token/files/:fileId/rename", async (request, reply) => {
    const params = request.params as { token: string; fileId: string };
    const parsed = fileRenameSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid payload",
        errors: parsed.error.flatten()
      });
    }

    const shareContext = await resolvePublicFolderShare(params.token);
    if (!shareContext) {
      return reply.code(404).send({ message: "Public folder not found" });
    }

    if (!assertEditPermission(shareContext)) {
      return reply.code(403).send({ message: "This shared folder is read-only" });
    }

    const file = await prisma.fileObject.findFirst({
      where: {
        id: params.fileId,
        ownerId: shareContext.rootFolder.ownerId,
        folderId: {
          in: shareContext.descendantIds
        }
      }
    });

    if (!file) {
      return reply.code(404).send({ message: "File not found in shared folder" });
    }

    const updated = await prisma.fileObject.update({
      where: { id: file.id },
      data: {
        name: sanitizeFilename(parsed.data.name.trim())
      }
    });

    return { file: updated };
  });

  fastify.delete("/folders/:token/files/:fileId", async (request, reply) => {
    const params = request.params as { token: string; fileId: string };
    const shareContext = await resolvePublicFolderShare(params.token);
    if (!shareContext) {
      return reply.code(404).send({ message: "Public folder not found" });
    }

    if (!assertEditPermission(shareContext)) {
      return reply.code(403).send({ message: "This shared folder is read-only" });
    }

    const file = await prisma.fileObject.findFirst({
      where: {
        id: params.fileId,
        ownerId: shareContext.rootFolder.ownerId,
        folderId: {
          in: shareContext.descendantIds
        }
      }
    });

    if (!file) {
      return reply.code(404).send({ message: "File not found in shared folder" });
    }

    await deleteObject(file.key);
    await prisma.fileObject.delete({
      where: { id: file.id }
    });

    return { message: "File deleted" };
  });

  fastify.get("/:token", async (request, reply) => {
    const params = request.params as { token: string };
    const file = await prisma.fileObject.findFirst({
      where: {
        publicToken: params.token,
        isPublic: true
      },
      select: {
        id: true,
        name: true,
        size: true,
        mimeType: true,
        createdAt: true
      }
    });

    if (!file) {
      return reply.code(404).send({ message: "Public file not found" });
    }

    return { file };
  });

  fastify.get("/:token/download", async (request, reply) => {
    const params = request.params as { token: string };
    const file = await prisma.fileObject.findFirst({
      where: {
        publicToken: params.token,
        isPublic: true
      }
    });

    if (!file) {
      return reply.code(404).send({ message: "Public file not found" });
    }

    const object = await getObject(file.key);
    if (!object.Body) {
      return reply.code(404).send({ message: "File data not found" });
    }

    reply.header(
      "Content-Type",
      file.mimeType || object.ContentType || "application/octet-stream"
    );
    reply.header("Content-Length", String(file.size));
    reply.header(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(file.name)}"`
    );

    return reply.send(object.Body as unknown as NodeJS.ReadableStream);
  });
};

export default publicRoutes;
