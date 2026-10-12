import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Connect, type Plugin } from "vite";
import { TESTBED_SERVER_LIMITS } from "./src/server-limits.js";
import { parseTimelineText } from "./src/timeline.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const canonicalRepoRoot = realpathSync(repoRoot);

/** Repo-relative paths the dev API may serve from. */
const SERVE_PREFIXES = ["examples", "conformance"];

interface ResolvedRepoEntry {
  path: string;
  relativePath: string;
  identity: EntryIdentity;
}

interface EntryIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  kind: "file" | "directory";
}

interface OpenEntry {
  fd: number;
  anchor: string;
  descriptorAnchored: boolean;
  stats: BigIntStats;
}

function entryIdentity(stats: BigIntStats): EntryIdentity | null {
  const kind = stats.isFile() ? "file" : stats.isDirectory() ? "directory" : null;
  return kind
    ? {
        dev: stats.dev,
        ino: stats.ino,
        size: stats.size,
        mtimeNs: stats.mtimeNs,
        ctimeNs: stats.ctimeNs,
        kind,
      }
    : null;
}

function sameEntryIdentity(stats: BigIntStats, expected: EntryIdentity): boolean {
  const actual = entryIdentity(stats);
  return (
    actual !== null &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs &&
    actual.ctimeNs === expected.ctimeNs &&
    actual.kind === expected.kind
  );
}

function descriptorAnchor(fd: number, expected: EntryIdentity): string | null {
  for (const root of ["/proc/self/fd", "/dev/fd"]) {
    const candidate = join(root, String(fd));
    try {
      if (sameEntryIdentity(statSync(candidate, { bigint: true }), expected)) return candidate;
    } catch {
      // Try the next descriptor filesystem.
    }
  }
  return null;
}

function assertPathIdentity(entry: ResolvedRepoEntry): void {
  const stats = lstatSync(entry.path, { bigint: true });
  if (stats.isSymbolicLink() || !sameEntryIdentity(stats, entry.identity)) {
    throw new Error(`repository entry changed while being accessed: ${entry.relativePath}`);
  }
}

function openResolvedEntry(entry: ResolvedRepoEntry): OpenEntry {
  const directoryFlag = entry.identity.kind === "directory" ? constants.O_DIRECTORY : 0;
  const fd = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW | directoryFlag);
  try {
    const stats = fstatSync(fd, { bigint: true });
    if (!sameEntryIdentity(stats, entry.identity)) {
      throw new Error(`repository entry changed while being opened: ${entry.relativePath}`);
    }
    const descriptorPath =
      entry.identity.kind === "directory" ? descriptorAnchor(fd, entry.identity) : null;
    return {
      fd,
      anchor: descriptorPath ?? entry.path,
      descriptorAnchored: descriptorPath !== null,
      stats,
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function posixPath(path: string): string {
  return path.split(sep).join("/");
}

function hasAllowedPrefix(path: string): boolean {
  return SERVE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Resolve an existing allowed entry without following any symlink component. */
function resolveRepoEntry(requested: string): ResolvedRepoEntry | null {
  if (
    requested.length === 0 ||
    requested.includes("\0") ||
    /^([a-zA-Z]:|[\\/])/.test(requested) ||
    requested.split(/[\\/]/).some((segment) => segment === "..")
  ) {
    return null;
  }
  const lexical = resolve(repoRoot, requested);
  const lexicalRelative = relative(repoRoot, lexical);
  if (
    lexicalRelative === "" ||
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${sep}`)
  ) {
    return null;
  }
  const normalized = posixPath(lexicalRelative);
  if (!hasAllowedPrefix(normalized)) return null;

  try {
    let current = repoRoot;
    for (const segment of lexicalRelative.split(sep)) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink()) return null;
    }
    const canonical = realpathSync(lexical);
    const canonicalRelative = relative(canonicalRepoRoot, canonical);
    if (
      canonicalRelative === "" ||
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${sep}`) ||
      !hasAllowedPrefix(posixPath(canonicalRelative))
    ) {
      return null;
    }
    const stats = lstatSync(canonical, { bigint: true });
    if (stats.isSymbolicLink()) return null;
    const identity = entryIdentity(stats);
    if (!identity) return null;
    return { path: canonical, relativePath: normalized, identity };
  } catch {
    return null;
  }
}

function listModelDirs(parent: string): string[] {
  const root = resolveRepoEntry(parent);
  if (!root || root.identity.kind !== "directory") return [];
  const opened = openResolvedEntry(root);
  const models: string[] = [];
  try {
    if (!opened.descriptorAnchored) assertPathIdentity(root);
    const directory = opendirSync(opened.anchor);
    try {
      let entries = 0;
      for (let dirent = directory.readSync(); dirent !== null; dirent = directory.readSync()) {
        if (++entries > TESTBED_SERVER_LIMITS.containerTraversalEntries) {
          throw new Error(
            `model root exceeds ${TESTBED_SERVER_LIMITS.containerTraversalEntries} traversal entries`,
          );
        }
        if (!dirent.name.endsWith(".lyre")) continue;
        const entry = resolveRepoEntry(`${parent}/${dirent.name}`);
        if (entry?.identity.kind === "directory") models.push(entry.relativePath);
      }
    } finally {
      directory.closeSync();
    }
    if (!opened.descriptorAnchored) assertPathIdentity(root);
  } finally {
    closeSync(opened.fd);
  }
  return models.sort();
}

interface InventoryFile {
  path: string;
  size: number;
}

function readStableRepoFile(entry: ResolvedRepoEntry, maxBytes: number): Buffer {
  if (entry.identity.kind !== "file") throw new Error("repository entry is not a regular file");
  const opened = openResolvedEntry(entry);
  try {
    if (opened.stats.size > BigInt(maxBytes)) {
      throw new Error(`file exceeds the ${maxBytes}-byte read limit`);
    }
    const expectedSize = Number(opened.stats.size);
    const bytes = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const count = readSync(opened.fd, bytes, offset, expectedSize - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (
      offset !== expectedSize ||
      !sameEntryIdentity(fstatSync(opened.fd, { bigint: true }), entry.identity)
    ) {
      throw new Error(`repository file changed while being read: ${entry.relativePath}`);
    }
    return bytes;
  } finally {
    closeSync(opened.fd);
  }
}

/** Scan a container without reading file bodies, enforcing every traversal ceiling. */
function inventoryContainer(root: ResolvedRepoEntry): InventoryFile[] {
  if (root.identity.kind !== "directory") throw new Error("container root is not a directory");
  const files: InventoryFile[] = [];
  const pending: Array<{
    entry: ResolvedRepoEntry;
    containerRelativePath: string;
  }> = [{ entry: root, containerRelativePath: "" }];
  let entries = 0;
  let pathBytes = 0;
  let totalBytes = 0;

  while (pending.length > 0) {
    const directory = pending.pop()!;
    const opened = openResolvedEntry(directory.entry);
    try {
      if (!opened.descriptorAnchored) assertPathIdentity(directory.entry);
      const handle = opendirSync(opened.anchor);
      try {
        for (let dirent = handle.readSync(); dirent !== null; dirent = handle.readSync()) {
          if (++entries > TESTBED_SERVER_LIMITS.containerTraversalEntries) {
            throw new Error(
              `container exceeds ${TESTBED_SERVER_LIMITS.containerTraversalEntries} filesystem traversal entries`,
            );
          }
          const relativePath =
            directory.containerRelativePath === ""
              ? dirent.name
              : `${directory.containerRelativePath}/${dirent.name}`;
          const encodedPathBytes = Buffer.byteLength(relativePath, "utf8");
          if (encodedPathBytes > TESTBED_SERVER_LIMITS.containerPathBytes) {
            throw new Error(
              `container path exceeds ${TESTBED_SERVER_LIMITS.containerPathBytes} UTF-8 bytes`,
            );
          }
          if (encodedPathBytes > TESTBED_SERVER_LIMITS.containerPathMetadataBytes - pathBytes) {
            throw new Error(
              `container paths exceed ${TESTBED_SERVER_LIMITS.containerPathMetadataBytes} UTF-8 metadata bytes`,
            );
          }
          pathBytes += encodedPathBytes;

          const anchoredPath = join(opened.anchor, dirent.name);
          const stats = lstatSync(anchoredPath, { bigint: true });
          if (stats.isSymbolicLink()) {
            throw new Error(`container entry "${relativePath}" is a symlink`);
          }
          const identity = entryIdentity(stats);
          if (!identity) {
            throw new Error(`container entry "${relativePath}" is not a regular file`);
          }
          if (identity.kind === "directory") {
            pending.push({
              entry: {
                path: join(directory.entry.path, dirent.name),
                relativePath: `${directory.entry.relativePath}/${dirent.name}`,
                identity,
              },
              containerRelativePath: relativePath,
            });
          } else {
            if (files.length >= TESTBED_SERVER_LIMITS.containerFiles) {
              throw new Error(
                `container exceeds ${TESTBED_SERVER_LIMITS.containerFiles} regular files`,
              );
            }
            const size = Number(identity.size);
            if (
              !Number.isSafeInteger(size) ||
              size > TESTBED_SERVER_LIMITS.containerUncompressedBytes - totalBytes
            ) {
              throw new Error(
                `container exceeds ${TESTBED_SERVER_LIMITS.containerUncompressedBytes} uncompressed bytes`,
              );
            }
            totalBytes += size;
            files.push({ path: relativePath, size });
          }
        }
      } finally {
        handle.closeSync();
      }
      if (!opened.descriptorAnchored) assertPathIdentity(directory.entry);
      if (!sameEntryIdentity(fstatSync(opened.fd, { bigint: true }), directory.entry.identity)) {
        throw new Error(`container directory changed while being scanned`);
      }
    } finally {
      closeSync(opened.fd);
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function sendJson(res: ServerResponse, value: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}

function timelineIndexEntry(
  timelinesRoot: ResolvedRepoEntry,
  file: string,
): { id: string; path: string; model: string; captures: number[] } | null {
  const entry = resolveRepoEntry(`conformance/timelines/${file}`);
  if (!entry || entry.identity.kind !== "file") return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      readStableRepoFile(entry, TESTBED_SERVER_LIMITS.jsonFileBytes),
    );
  } catch {
    return null;
  }
  let timeline: ReturnType<typeof parseTimelineText>;
  try {
    timeline = parseTimelineText(text, entry.relativePath);
  } catch {
    return null;
  }
  const modelAbs = resolve(timelinesRoot.path, timeline.model);
  const modelRelative = posixPath(relative(canonicalRepoRoot, modelAbs));
  const model = resolveRepoEntry(modelRelative);
  if (!model || model.identity.kind !== "directory") return null;
  return {
    id: file.replace(/\.timeline\.json$/, ""),
    path: entry.relativePath,
    model: model.relativePath,
    captures: timeline.captures ?? [],
  };
}

function attachLyreApi(middlewares: Connect.Server): void {
  middlewares.use("/__lyre/index", (_req, res) => {
    try {
      const models = [...listModelDirs("examples"), ...listModelDirs("conformance/models")];
      const timelinesEntry = resolveRepoEntry("conformance/timelines");
      const timelines: ReturnType<typeof timelineIndexEntry>[] = [];
      if (timelinesEntry?.identity.kind === "directory") {
        const opened = openResolvedEntry(timelinesEntry);
        try {
          if (!opened.descriptorAnchored) assertPathIdentity(timelinesEntry);
          const directory = opendirSync(opened.anchor);
          try {
            let entries = 0;
            for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
              if (++entries > TESTBED_SERVER_LIMITS.containerTraversalEntries) {
                throw new Error(
                  `timeline root exceeds ${TESTBED_SERVER_LIMITS.containerTraversalEntries} traversal entries`,
                );
              }
              if (!entry.name.endsWith(".timeline.json")) continue;
              timelines.push(timelineIndexEntry(timelinesEntry, entry.name));
            }
          } finally {
            directory.closeSync();
          }
          if (!opened.descriptorAnchored) assertPathIdentity(timelinesEntry);
        } finally {
          closeSync(opened.fd);
        }
      }
      sendJson(res, {
        models,
        timelines: timelines
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .sort((left, right) => left.id.localeCompare(right.id)),
      });
    } catch (error) {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    }
  });

  middlewares.use("/__lyre/inventory", (req, res) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const root = resolveRepoEntry(url.searchParams.get("path") ?? "");
    if (!root) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    try {
      sendJson(res, { files: inventoryContainer(root) });
    } catch (error) {
      res.statusCode = 400;
      res.end(error instanceof Error ? error.message : String(error));
    }
  });

  middlewares.use("/__lyre/file", (req, res) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const entry = resolveRepoEntry(url.searchParams.get("path") ?? "");
    if (!entry || entry.identity.kind !== "file") {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    let opened: OpenEntry;
    try {
      opened = openResolvedEntry(entry);
    } catch {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    const size = Number(opened.stats.size);
    if (!Number.isSafeInteger(size) || size > TESTBED_SERVER_LIMITS.containerUncompressedBytes) {
      closeSync(opened.fd);
      res.statusCode = 413;
      res.end("file too large");
      return;
    }
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-length", String(size));
    if (size === 0) {
      closeSync(opened.fd);
      res.end();
      return;
    }
    const stream = createReadStream(entry.path, {
      fd: opened.fd,
      autoClose: true,
      start: 0,
      end: size - 1,
    });
    res.on("close", () => stream.destroy());
    stream.on("error", (error) => res.destroy(error));
    stream.pipe(res);
  });
}

/**
 * Repository API for the dev and preview servers:
 *   GET /__lyre/index                → { models, timelines }
 *   GET /__lyre/inventory?path=<dir> → regular-file paths and sizes
 *   GET /__lyre/file?path=<rel>      → raw bytes (examples/ and conformance/ only)
 */
function lyreDevApi(): Plugin {
  return {
    name: "lyre-dev-api",
    configureServer(server) {
      attachLyreApi(server.middlewares);
    },
    configurePreviewServer(server) {
      attachLyreApi(server.middlewares);
    },
  };
}

export default defineConfig({
  plugins: [lyreDevApi()],
  server: {
    fs: {
      // Allow serving files from the monorepo root (workspace sources).
      allow: ["../.."],
    },
  },
});
