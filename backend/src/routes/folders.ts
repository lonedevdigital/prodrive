import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { deleteObjectsStrict } from "../lib/r2";
import { prisma } from "../lib/prisma";
import { deleteThumbnailsQuietly } from "../lib/thumbnail";
import { buildArchivePath, streamZip } from "../lib/zip";

const createFolderSchema = z.object({
  name: z.string().min(1).max(120),
  parentId: z.string().nullable().optional()
});

const moveFolderSchema = z.object({
  targetParentId: z.string().nullable().optional()
});

const renameFolderSchema = z.object({
  name: z.string().min(1).max(120)
});

const shareFolderSchema = z.object({
  enabled: z.boolean(),
  permission: z.enum(["VIEW", "EDIT"]).optional()
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

async function getDescendantFolderIds(
  userId: string,
  rootFolderId: string
): Promise<string[]> {
  const allFolders = await prisma.folder.findMany({
    where: { ownerId: userId },
    select: { id: true, parentId: true }
  });

  const childrenMap = new Map<string | null, string[]>();
  for (const folder of allFolders) {
    const current = childrenMap.get(folder.parentId ?? null) ?? [];
    current.push(folder.id);
    childrenMap.set(folder.parentId ?? null, current);
  }

  const result: string[] = [];
  const stack: string[] = [rootFolderId];
  while (stack.length) {
    const current = stack.pop() as string;
    result.push(current);
    const children = childrenMap.get(current) ?? [];
    for (const child of children) {
      stack.push(child);
    }
  }

  return result;
}

const folderRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const query = request.query as { parentId?: string | null };
      const parentId = query.parentId === "" ? null : (query.parentId ?? null);

      const folders = await prisma.folder.findMany({
        where: {
          ownerId: request.user.userId,
          parentId
        },
        orderBy: { name: "asc" }
      });

      return { folders };
    }
  );

  fastify.post(
    "/",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const parsed = createFolderSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          message: "Invalid payload",
          errors: parsed.error.flatten()
        });
      }

      const { name, parentId } = parsed.data;
      try {
        await assertFolderOwnership(request.user.userId, parentId);
      } catch {
        return reply.code(404).send({ message: "Parent folder not found" });
      }

      const folder = await prisma.folder.create({
        data: {
          name,
          ownerId: request.user.userId,
          parentId: parentId ?? null
        }
      });

      return reply.code(201).send({ folder });
    }
  );

  fastify.patch(
    "/:id/move",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = request.params as { id: string };
      const parsed = moveFolderSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          message: "Invalid payload",
          errors: parsed.error.flatten()
        });
      }

      const folder = await prisma.folder.findFirst({
        where: {
          id: params.id,
          ownerId: request.user.userId
        }
      });

      if (!folder) {
        return reply.code(404).send({ message: "Folder not found" });
      }

      if (parsed.data.targetParentId === params.id) {
        return reply.code(400).send({
          message: "Folder cannot be moved into itself"
        });
      }

      if (parsed.data.targetParentId) {
        const descendantIds = await getDescendantFolderIds(
          request.user.userId,
          params.id
        );
        if (descendantIds.includes(parsed.data.targetParentId)) {
          return reply.code(400).send({
            message: "Folder cannot be moved into its own child"
          });
        }
      }

      try {
        await assertFolderOwnership(request.user.userId, parsed.data.targetParentId);
      } catch {
        return reply.code(404).send({ message: "Target folder not found" });
      }

      const updated = await prisma.folder.update({
        where: { id: params.id },
        data: {
          parentId: parsed.data.targetParentId ?? null
        }
      });

      return { folder: updated };
    }
  );

  fastify.patch(
    "/:id/rename",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = request.params as { id: string };
      const parsed = renameFolderSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          message: "Invalid payload",
          errors: parsed.error.flatten()
        });
      }

      const folder = await prisma.folder.findFirst({
        where: {
          id: params.id,
          ownerId: request.user.userId
        }
      });

      if (!folder) {
        return reply.code(404).send({ message: "Folder not found" });
      }

      const updated = await prisma.folder.update({
        where: { id: params.id },
        data: {
          name: parsed.data.name.trim()
        }
      });

      return { folder: updated };
    }
  );

  fastify.post(
    "/:id/share/public",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = request.params as { id: string };
      const parsed = shareFolderSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          message: "Invalid payload",
          errors: parsed.error.flatten()
        });
      }

      const folder = await prisma.folder.findFirst({
        where: {
          id: params.id,
          ownerId: request.user.userId
        }
      });

      if (!folder) {
        return reply.code(404).send({ message: "Folder not found" });
      }

      const updated = await prisma.folder.update({
        where: { id: folder.id },
        data: {
          isPublic: parsed.data.enabled,
          publicToken: parsed.data.enabled
            ? folder.publicToken ?? randomUUID().replace(/-/g, "")
            : null,
          publicPermission: parsed.data.enabled
            ? parsed.data.permission ?? folder.publicPermission
            : "VIEW"
        }
      });

      return {
        folder: updated
      };
    }
  );

  // Download the whole folder (incl. nested subfolders) as a zip archive,
  // preserving the directory structure inside the zip.
  fastify.get(
    "/:id/download",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = request.params as { id: string };
      const folder = await prisma.folder.findFirst({
        where: { id: params.id, ownerId: request.user.userId }
      });
      if (!folder) {
        return reply.code(404).send({ message: "Folder not found" });
      }

      const allFolders = await prisma.folder.findMany({
        where: { ownerId: request.user.userId },
        select: { id: true, name: true, parentId: true }
      });
      const folderMap = new Map(allFolders.map((f) => [f.id, f]));

      const childrenMap = new Map<string | null, string[]>();
      for (const f of allFolders) {
        const list = childrenMap.get(f.parentId ?? null) ?? [];
        list.push(f.id);
        childrenMap.set(f.parentId ?? null, list);
      }

      const descendantIds: string[] = [];
      const stack: string[] = [folder.id];
      while (stack.length) {
        const current = stack.pop() as string;
        descendantIds.push(current);
        for (const child of childrenMap.get(current) ?? []) {
          stack.push(child);
        }
      }

      // Path of a folder relative to (and including) the downloaded folder.
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
          if (current === folder.id) break;
          current = node.parentId ?? null;
        }
        pathCache.set(fid, parts);
        return parts;
      };

      const files = await prisma.fileObject.findMany({
        where: {
          ownerId: request.user.userId,
          folderId: { in: descendantIds }
        },
        select: { key: true, name: true, folderId: true }
      });

      if (files.length === 0) {
        return reply
          .code(400)
          .send({ message: "Folder ini tidak punya file untuk diunduh" });
      }

      const entries = files.map((file) => ({
        key: file.key,
        name: buildArchivePath([
          ...folderPathParts(file.folderId ?? folder.id),
          file.name
        ])
      }));

      return streamZip(reply, `${folder.name}.zip`, entries);
    }
  );

  fastify.delete(
    "/:id",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const params = request.params as { id: string };

      const folder = await prisma.folder.findFirst({
        where: {
          id: params.id,
          ownerId: request.user.userId
        }
      });

      if (!folder) {
        return reply.code(404).send({ message: "Folder not found" });
      }

      const descendantFolderIds = await getDescendantFolderIds(
        request.user.userId,
        folder.id
      );

      const files = await prisma.fileObject.findMany({
        where: {
          ownerId: request.user.userId,
          folderId: {
            in: descendantFolderIds
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

        await tx.folder.delete({
          where: { id: folder.id }
        });
      });

      await deleteThumbnailsQuietly(files.map((file) => file.id));

      return {
        message: "Folder deleted",
        deletedFolders: descendantFolderIds.length,
        deletedFiles: files.length
      };
    }
  );
};

export default folderRoutes;
