import { ZipArchive } from "archiver";
import type { FastifyReply } from "fastify";
import type { Readable } from "node:stream";
import { getObject } from "./r2";

export type ZipEntry = {
  /** R2 object key to read from. */
  key: string;
  /** Path (and filename) the entry should have inside the archive. */
  name: string;
};

function sanitizePathSegment(segment: string): string {
  return (
    segment
      .replace(/[\\/]+/g, "_") // strip path separators
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f]/g, "") // strip control chars
      .replace(/^\.+$/, "_") // avoid "." / ".."
      .trim() || "_"
  );
}

/** Normalises an in-archive path: sanitise each segment, drop empties. */
export function buildArchivePath(parts: string[]): string {
  return parts.map(sanitizePathSegment).filter(Boolean).join("/");
}

/** Ensures every entry has a unique name inside the archive. */
function dedupeEntries(entries: ZipEntry[]): ZipEntry[] {
  const used = new Set<string>();
  return entries.map((entry) => {
    let name = entry.name;
    if (used.has(name)) {
      const slash = name.lastIndexOf("/");
      const dir = slash >= 0 ? name.slice(0, slash + 1) : "";
      const file = slash >= 0 ? name.slice(slash + 1) : name;
      const dot = file.lastIndexOf(".");
      const base = dot > 0 ? file.slice(0, dot) : file;
      const ext = dot > 0 ? file.slice(dot) : "";
      let i = 1;
      while (used.has(`${dir}${base} (${i})${ext}`)) i += 1;
      name = `${dir}${base} (${i})${ext}`;
    }
    used.add(name);
    return { key: entry.key, name };
  });
}

function contentDisposition(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(
    filename
  )}`;
}

/**
 * Streams a zip archive of the given R2 objects to the client.
 * Objects are fetched and appended one at a time so memory stays flat
 * regardless of how many (or how large) the files are.
 */
export function streamZip(
  reply: FastifyReply,
  filename: string,
  entries: ZipEntry[]
) {
  const archive = new ZipArchive({ zlib: { level: 1 } });
  const unique = dedupeEntries(entries);

  archive.on("warning", () => {
    /* ignore ENOENT-style warnings */
  });
  archive.on("error", (err) => {
    reply.log.error({ err }, "zip archive error");
    archive.destroy(err);
  });

  reply.header("Content-Type", "application/zip");
  reply.header("Content-Disposition", contentDisposition(filename));
  reply.header("Cache-Control", "no-store");

  void (async () => {
    try {
      for (const entry of unique) {
        const object = await getObject(entry.key);
        if (!object.Body) continue;
        archive.append(object.Body as unknown as Readable, {
          name: entry.name
        });
      }
      await archive.finalize();
    } catch (err) {
      archive.destroy(err as Error);
    }
  })();

  return reply.send(archive);
}
