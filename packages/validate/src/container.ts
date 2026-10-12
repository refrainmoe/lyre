import {
  closeSync,
  constants as FS_CONSTANTS,
  createWriteStream,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  type WriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Readable } from "node:stream";
import { inflateSync } from "node:zlib";
import yauzl from "yauzl";
import {
  loadModel,
  parseLyreJson,
  premultiplyStraightRGBA8,
  type LoadOptions,
  type Model,
  type ModelFiles,
  type PremultipliedImage,
} from "@refrain-lyre/core";
import { LIMITS, RUNTIME_LIMITS } from "@refrain-lyre/core";

export interface LoadedContainer {
  model: Model;
  /** Per-file textures keyed by texture id, premultiplied at load (§3.2). */
  textures: Map<string, PremultipliedImage>;
  /** Decoded atlas image when atlas.json is present. */
  atlasImage: PremultipliedImage | null;
  /** Raw parsed JSON documents (for schema validation and lints). */
  raw: ModelFiles;
  /** Container-relative paths of the raw JSON documents, keyed like `raw`. */
  rawPaths: { manifest: string; rig: string; physics?: string; variants?: string; atlas?: string };
  source: FileSource;
}

/** Uniform read access to an unpacked directory or a `.lyre` ZIP (§3). */
export interface FileSource {
  /** All container-relative file paths (files only, `/`-separated). */
  files(): string[];
  has(rel: string): boolean;
  read(rel: string): Uint8Array;
  /** Uncompressed size without reading (for stats). */
  size(rel: string): number;
  /** Release backing resources. Idempotent; the source is unusable afterward. */
  close(): void;
}

/**
 * §16 container safety for ZIP entries and manifest-listed paths: relative,
 * no `..` segments, no absolute/drive prefixes.
 */
export function checkContainerPath(path: string): void {
  if (path.length === 0 || path.includes("\0")) {
    throw new Error(`container path must be a non-empty, NUL-free relative path (§16)`);
  }
  const pathBytes = Buffer.byteLength(path, "utf8");
  if (pathBytes > RUNTIME_LIMITS.containerPathBytes) {
    throw new Error(
      `container path exceeds ${RUNTIME_LIMITS.containerPathBytes} UTF-8 bytes (§16)`,
    );
  }
  // A Windows drive-relative path such as C:foo is still drive-prefixed even
  // though it lacks a slash. Reject every leading drive designator.
  if (/^([a-zA-Z]:|[\\/])/.test(path)) {
    throw new Error(`container path "${path}" must be relative (§16)`);
  }
  const segments = path.split(/[\\/]/);
  if (segments.some((s) => s === "..")) {
    throw new Error(`container path "${path}" must not contain ".." segments (§16)`);
  }
}

// ---------------------------------------------------------------------------
// Directory source

export function dirFileSource(root: string): FileSource {
  interface StableEntry {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  }
  const snapshot = (entry: StableEntry): StableEntry => ({
    dev: entry.dev,
    ino: entry.ino,
    size: entry.size,
    mtimeNs: entry.mtimeNs,
    ctimeNs: entry.ctimeNs,
  });
  const sameIdentity = (actual: StableEntry, expected: StableEntry): boolean =>
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs &&
    actual.ctimeNs === expected.ctimeNs;

  const files: string[] = [];
  const entries = new Map<string, StableEntry>();
  let totalBytes = 0;
  let entryCount = 0;
  let pathMetadataBytes = 0;
  const realRoot = realpathSync(root);
  const pending: Array<{ rel: string; expected: StableEntry }> = [
    { rel: "", expected: snapshot(lstatSync(realRoot, { bigint: true })) },
  ];
  while (pending.length > 0) {
    const { rel, expected } = pending.pop()!;
    const queuedPath = rel === "" ? realRoot : join(root, rel);
    const canonical = realpathSync(queuedPath);
    if (canonical !== realRoot && !canonical.startsWith(`${realRoot}${sep}`)) {
      throw new Error(`container directory "${rel}" resolves outside its root (§16)`);
    }
    const before = lstatSync(canonical, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || !sameIdentity(before, expected)) {
      throw new Error(`container directory "${rel}" changed after being queued (§16)`);
    }

    const dir = opendirSync(canonical);
    try {
      for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
        if (++entryCount > RUNTIME_LIMITS.containerTraversalEntries) {
          throw new Error(
            `container exceeds ${RUNTIME_LIMITS.containerTraversalEntries} filesystem traversal entries (§16)`,
          );
        }
        const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
        checkContainerPath(relPath);
        pathMetadataBytes += Buffer.byteLength(relPath, "utf8");
        if (pathMetadataBytes > RUNTIME_LIMITS.containerPathMetadataBytes) {
          throw new Error(
            `container paths exceed ${RUNTIME_LIMITS.containerPathMetadataBytes} UTF-8 metadata bytes (§16)`,
          );
        }
        const st = lstatSync(join(root, relPath), { bigint: true });
        if (st.isSymbolicLink()) {
          throw new Error(`container entry "${relPath}" is a symlink (§16: ignored or rejected)`);
        }
        if (st.isDirectory()) pending.push({ rel: relPath, expected: snapshot(st) });
        else if (st.isFile()) {
          files.push(relPath);
          if (files.length > LIMITS.containerFiles) {
            throw new Error(`container exceeds ${LIMITS.containerFiles} regular files (§16)`);
          }
          entries.set(relPath, {
            dev: st.dev,
            ino: st.ino,
            size: st.size,
            mtimeNs: st.mtimeNs,
            ctimeNs: st.ctimeNs,
          });
          totalBytes += Number(st.size);
          if (totalBytes > LIMITS.containerUncompressedBytes) {
            throw new Error(
              `container exceeds ${LIMITS.containerUncompressedBytes} uncompressed bytes (§16)`,
            );
          }
        } else {
          throw new Error(`container entry "${relPath}" is not a regular file (§16)`);
        }
      }
    } finally {
      dir.closeSync();
    }
    const after = lstatSync(canonical, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameIdentity(after, expected)) {
      throw new Error(`container directory "${rel}" changed while being scanned (§16)`);
    }
  }
  files.sort();
  let closed = false;
  const requireOpen = (): void => {
    if (closed) throw new Error(`directory file source is closed`);
  };
  type StableFile = StableEntry;
  const matches = (
    actual: {
      isFile(): boolean;
      isSymbolicLink(): boolean;
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
      ctimeNs: bigint;
    },
    expected: StableFile,
  ): boolean => actual.isFile() && !actual.isSymbolicLink() && sameIdentity(actual, expected);
  const openStable = (rel: string): { fd: number; expected: StableFile } => {
    requireOpen();
    checkContainerPath(rel);
    const expected = entries.get(rel);
    if (!expected) throw new Error(`container is missing "${rel}"`);
    const canonical = realpathSync(join(root, rel));
    if (canonical !== realRoot && !canonical.startsWith(`${realRoot}${sep}`)) {
      throw new Error(`container entry "${rel}" resolves outside its root (§16)`);
    }
    const before = lstatSync(canonical, { bigint: true });
    if (!matches(before, expected)) {
      throw new Error(`container entry "${rel}" changed after safety inspection (§16)`);
    }
    const fd = openSync(canonical, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
    const actual = fstatSync(fd, { bigint: true });
    if (!matches(actual, expected)) {
      closeSync(fd);
      throw new Error(`container entry "${rel}" changed while opening (§16)`);
    }
    return { fd, expected };
  };
  return {
    files: () => {
      requireOpen();
      return [...files];
    },
    has: (rel) => {
      requireOpen();
      return entries.has(rel);
    },
    read: (rel) => {
      const { fd, expected } = openStable(rel);
      try {
        const bytes = readFileSync(fd);
        const after = fstatSync(fd, { bigint: true });
        if (BigInt(bytes.byteLength) !== expected.size || !matches(after, expected)) {
          throw new Error(`container entry "${rel}" changed while reading (§16)`);
        }
        return bytes;
      } finally {
        closeSync(fd);
      }
    },
    size: (rel) => {
      const { fd, expected } = openStable(rel);
      closeSync(fd);
      return Number(expected.size);
    },
    close: () => {
      closed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// ZIP source (yauzl): §16 — path safety, symlink rejection, bounded inflation.
// Entries stream to an opaque temporary directory so opening a valid archive
// never retains its whole uncompressed payload in the JS heap.

const S_IFLNK = 0xa000;

export function zipFileSource(zipPath: string): Promise<FileSource> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err) return reject(err);
      if (zip.entryCount > RUNTIME_LIMITS.containerTraversalEntries) {
        zip.close();
        return reject(
          new Error(
            `container declares ${zip.entryCount} traversal entries (> ${RUNTIME_LIMITS.containerTraversalEntries}, §16)`,
          ),
        );
      }
      let spoolRoot: string;
      try {
        spoolRoot = mkdtempSync(join(tmpdir(), "lyre-zip-"));
      } catch (e) {
        zip.close();
        return reject(e as Error);
      }
      const contents = new Map<string, { path: string; size: number }>();
      const seenPaths = new Set<string>();
      let declaredTotal = 0;
      let actualTotal = 0;
      let pathMetadataBytes = 0;
      let fileIndex = 0;
      let settled = false;
      let activeInput: Readable | null = null;
      let activeOutput: WriteStream | null = null;

      const cleanupSpool = (): void => {
        try {
          rmSync(spoolRoot, { recursive: true, force: true });
        } catch {
          // A failing output stream can close just after rejection (notably
          // on Windows). Its close handler retries this best-effort cleanup.
        }
      };

      const fail = (e: Error): void => {
        if (settled) return;
        settled = true;
        const closingOutput = activeOutput;
        closingOutput?.once("close", cleanupSpool);
        activeInput?.destroy();
        closingOutput?.destroy();
        zip.close();
        cleanupSpool();
        reject(e);
      };

      zip.on("error", fail);
      zip.on("entry", (entry: yauzl.Entry) => {
        if (settled) return;
        try {
          const pathForSafety = entry.fileName.endsWith("/")
            ? entry.fileName.slice(0, -1)
            : entry.fileName;
          checkContainerPath(pathForSafety);
          pathMetadataBytes += Buffer.byteLength(entry.fileName, "utf8");
          if (pathMetadataBytes > RUNTIME_LIMITS.containerPathMetadataBytes) {
            throw new Error(
              `container paths exceed ${RUNTIME_LIMITS.containerPathMetadataBytes} UTF-8 metadata bytes (§16)`,
            );
          }
          if (entry.fileName.endsWith("/")) {
            zip.readEntry();
            return;
          }
          if (seenPaths.has(entry.fileName)) {
            throw new Error(`ZIP contains duplicate file path "${entry.fileName}" (§16)`);
          }
          seenPaths.add(entry.fileName);
          if (seenPaths.size > LIMITS.containerFiles) {
            throw new Error(`container exceeds ${LIMITS.containerFiles} regular files (§16)`);
          }
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode === S_IFLNK) {
            throw new Error(
              `ZIP entry "${entry.fileName}" is a symlink (§16: ignored or rejected)`,
            );
          }
          declaredTotal += entry.uncompressedSize;
          if (declaredTotal > LIMITS.containerUncompressedBytes) {
            throw new Error(
              `container exceeds ${LIMITS.containerUncompressedBytes} uncompressed bytes (§16)`,
            );
          }
        } catch (e) {
          return fail(e as Error);
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (settled) {
            stream?.destroy();
            return;
          }
          if (streamErr) return fail(streamErr);
          const spoolPath = join(spoolRoot, `${fileIndex++}.bin`);
          const output = createWriteStream(spoolPath, { flags: "wx", mode: 0o600 });
          activeInput = stream;
          activeOutput = output;
          let actual = 0;
          stream.on("data", (chunk: Buffer) => {
            actual += chunk.length;
            actualTotal += chunk.length;
            // Never trust ZIP headers (§16): abort inflation past the ceiling.
            if (
              actual > entry.uncompressedSize ||
              actualTotal > LIMITS.containerUncompressedBytes
            ) {
              const message =
                actual > entry.uncompressedSize
                  ? `ZIP entry "${entry.fileName}" inflates past its declared size (§16)`
                  : `container inflates past ${LIMITS.containerUncompressedBytes} uncompressed bytes (§16)`;
              fail(new Error(message));
            }
          });
          stream.on("error", fail);
          output.on("error", fail);
          // Wait for close, not only finish: on platforms that forbid removing
          // open files, the returned source must never retain a live spool fd.
          output.on("close", () => {
            if (settled) return;
            if (actual !== entry.uncompressedSize) {
              fail(
                new Error(
                  `ZIP entry "${entry.fileName}" inflated to ${actual} bytes; declared ${entry.uncompressedSize} (§16)`,
                ),
              );
              return;
            }
            activeInput = null;
            activeOutput = null;
            contents.set(entry.fileName, { path: spoolPath, size: actual });
            zip.readEntry();
          });
          stream.pipe(output);
        });
      });
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        zip.close();
        const files = [...contents.keys()].sort();
        let closed = false;
        const requireOpen = (): void => {
          if (closed) throw new Error(`ZIP file source is closed`);
        };
        resolvePromise({
          files: () => {
            requireOpen();
            return [...files];
          },
          has: (rel) => {
            requireOpen();
            return contents.has(rel);
          },
          read: (rel) => {
            requireOpen();
            checkContainerPath(rel);
            const stored = contents.get(rel);
            if (!stored) throw new Error(`container is missing "${rel}"`);
            return readFileSync(stored.path);
          },
          size: (rel) => {
            requireOpen();
            checkContainerPath(rel);
            const stored = contents.get(rel);
            if (!stored) throw new Error(`container is missing "${rel}"`);
            return stored.size;
          },
          close: () => {
            if (closed) return;
            closed = true;
            contents.clear();
            rmSync(spoolRoot, { recursive: true, force: true });
          },
        });
      });
      zip.readEntry();
    });
  });
}

// ---------------------------------------------------------------------------
// Container loading over a source

function readJson(source: FileSource, rel: string): unknown {
  checkContainerPath(rel);
  if (source.size(rel) > LIMITS.jsonFileBytes) {
    throw new Error(`"${rel}" exceeds the ${LIMITS.jsonFileBytes}-byte JSON ceiling (§16)`);
  }
  const buf = source.read(rel);
  if (buf.byteLength > LIMITS.jsonFileBytes) {
    throw new Error(`"${rel}" exceeds the ${LIMITS.jsonFileBytes}-byte JSON ceiling (§16)`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    throw new Error(`"${rel}" is not valid UTF-8 JSON (§2)`);
  }
  return parseLyreJson(text, `"${rel}"`);
}

export interface PngInfo {
  width: number;
  height: number;
}

export interface AtlasConsistencyProblem {
  id: string;
  message: string;
}

function atlasCropMatches(
  atlas: PremultipliedImage,
  rect: readonly [number, number, number, number],
  texture: PremultipliedImage,
): boolean {
  const [x, y, width, height] = rect;
  if (width !== texture.width || height !== texture.height) return false;
  for (let row = 0; row < height; row++) {
    let atlasOffset = ((y + row) * atlas.width + x) * 4;
    let textureOffset = row * texture.width * 4;
    const end = textureOffset + width * 4;
    while (textureOffset < end) {
      if (atlas.data[atlasOffset++] !== texture.data[textureOffset++]) return false;
    }
  }
  return true;
}

/**
 * Enumerate normative atlas errors without allocating a second image-sized
 * buffer. Bounds are checked for every rect; dimensions and premultiplied
 * pixels are checked for every texture actually referenced by the model.
 */
export function* atlasConsistencyProblems(
  atlas: NonNullable<Model["atlas"]>,
  textures: ReadonlyMap<string, PremultipliedImage>,
  atlasImage: PremultipliedImage,
): Generator<AtlasConsistencyProblem> {
  for (const [id, [x, y, width, height]] of atlas.rects) {
    if (x < 0 || y < 0 || x + width > atlasImage.width || y + height > atlasImage.height) {
      yield {
        id,
        message: `atlas rect for "${id}" falls outside ${atlas.image}`,
      };
    }
  }

  for (const [id, texture] of textures) {
    const rect = atlas.rects.get(id);
    if (!rect) continue; // A missing rect deliberately falls back to the file.
    const [x, y, width, height] = rect;
    // An out-of-bounds rect was already reported above and cannot be sampled
    // safely for the pixel-equivalence check.
    if (x < 0 || y < 0 || x + width > atlasImage.width || y + height > atlasImage.height) {
      continue;
    }
    if (width !== texture.width || height !== texture.height) {
      yield {
        id,
        message: `atlas rect for "${id}" is ${width}×${height}, but textures/${id}.png is ${texture.width}×${texture.height}`,
      };
      continue;
    }
    if (!atlasCropMatches(atlasImage, rect, texture)) {
      yield {
        id,
        message: `atlas rect for "${id}" does not match the premultiplied pixels of textures/${id}.png`,
      };
    }
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPngChunkTypeByte(value: number): boolean {
  return (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a);
}

/**
 * Read the fixed PNG signature/IHDR prefix before inflating anything.
 * Dimension and pixel-count checks after decode are too late: the decoder has
 * already allocated the attacker-controlled image buffer.
 */
export function inspectPngBuffer(bytes: Uint8Array, label: string): PngInfo {
  if (bytes.byteLength > LIMITS.textureFileBytes) {
    throw new Error(
      `texture "${label}" exceeds the ${LIMITS.textureFileBytes}-byte PNG ceiling (§16)`,
    );
  }
  if (bytes.byteLength < 33) throw new Error(`texture "${label}" has a truncated PNG header`);
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`texture "${label}" is not a PNG file`);
  }
  if (
    buf.readUInt32BE(8) !== 13 ||
    buf[12] !== 0x49 ||
    buf[13] !== 0x48 ||
    buf[14] !== 0x44 ||
    buf[15] !== 0x52
  ) {
    throw new Error(`texture "${label}" does not begin with a valid IHDR chunk`);
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width < 1 || height < 1) {
    throw new Error(`texture "${label}" must have positive dimensions`);
  }
  if (width > LIMITS.textureDimension || height > LIMITS.textureDimension) {
    throw new Error(`texture "${label}" exceeds the ${LIMITS.textureDimension}px ceiling (§16)`);
  }
  const pixels = width * height;
  if (pixels > LIMITS.texturePixels) {
    throw new Error(
      `texture "${label}" exceeds the ${LIMITS.texturePixels}-pixel decoded-image ceiling (§16)`,
    );
  }
  return { width, height };
}

const PNG_CHANNELS = new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4],
]);
const PNG_DEPTHS = new Map<number, ReadonlySet<number>>([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);
const ADAM7_PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

interface DecodedPngSource extends PngInfo {
  bitDepth: number;
  colorType: number;
  channels: number;
  interlace: number;
  palette: Uint8Array | null;
  paletteAlpha: Uint8Array | null;
  transparent: readonly number[] | null;
  inflated: Buffer;
}

let pngCrcTable: Uint32Array | null = null;

function pngChunkCrc(bytes: Uint8Array, start: number, end: number): number {
  if (!pngCrcTable) {
    pngCrcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let value = n;
      for (let bit = 0; bit < 8; bit++) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      pngCrcTable[n] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = pngCrcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function passSize(size: number, start: number, step: number): number {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

/** PNG keyword/profile-name grammar (printable Latin-1, normalized spaces). */
function isLegalPngKeyword(bytes: Uint8Array): boolean {
  if (bytes.length < 1 || bytes.length > 79 || bytes[0] === 0x20 || bytes.at(-1) === 0x20) {
    return false;
  }
  let previousSpace = false;
  for (const byte of bytes) {
    const printable = (byte >= 32 && byte <= 126) || byte >= 161;
    if (!printable || (byte === 0x20 && previousSpace)) return false;
    previousSpace = byte === 0x20;
  }
  return true;
}

/**
 * Parse the bounded PNG structure, validate every chunk CRC, and inflate the
 * exact IDAT stream once with a dimension-derived cap. Decoding from this
 * retained inflation avoids the former double-inflate memory peak for Adam7.
 */
function parseAndInflatePng(bytes: Buffer, label: string): DecodedPngSource {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24]!;
  const colorType = bytes[25]!;
  const compression = bytes[26]!;
  const filter = bytes[27]!;
  const interlace = bytes[28]!;
  const channels = PNG_CHANNELS.get(colorType);
  if (!channels || !PNG_DEPTHS.get(colorType)?.has(bitDepth)) {
    throw new Error(
      `texture "${label}" has unsupported PNG bit depth ${bitDepth}/color type ${colorType}`,
    );
  }
  if (compression !== 0 || filter !== 0) {
    throw new Error(
      `texture "${label}" has unsupported PNG compression/filter methods ${compression}/${filter}`,
    );
  }
  if (interlace !== 0 && interlace !== 1) {
    throw new Error(`texture "${label}" has unsupported PNG interlace method ${interlace}`);
  }

  const passes =
    interlace === 0 ? ([[0, 0, 1, 1]] as const) : (ADAM7_PASSES as readonly (readonly number[])[]);
  const bitsPerPixel = channels * bitDepth;
  let expectedBytes = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = passSize(width, startX!, stepX!);
    const passHeight = passSize(height, startY!, stepY!);
    if (passWidth === 0 || passHeight === 0) continue;
    expectedBytes += passHeight * (1 + Math.ceil((passWidth * bitsPerPixel) / 8));
  }
  if (!Number.isSafeInteger(expectedBytes)) {
    throw new Error(`texture "${label}" has an unsafe inflated PNG size`);
  }

  const idat: Buffer[] = [];
  let offset = PNG_SIGNATURE.length;
  let chunks = 0;
  let idatChunks = 0;
  let seenIhdr = false;
  let seenPlte = false;
  let paletteEntries = 0;
  let seenTrns = false;
  let seenIdat = false;
  let idatEnded = false;
  let seenIend = false;
  const seenColorMetadata = new Set<string>();
  let palette: Uint8Array | null = null;
  let paletteAlpha: Uint8Array | null = null;
  let transparent: readonly number[] | null = null;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new Error(`texture "${label}" ends inside a PNG chunk header`);
    }
    chunks++;
    if (chunks > RUNTIME_LIMITS.pngChunks) {
      throw new Error(
        `texture "${label}" exceeds the ${RUNTIME_LIMITS.pngChunks}-chunk PNG ceiling (§16)`,
      );
    }
    const length = bytes.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) {
      throw new Error(`texture "${label}" ends inside a PNG chunk`);
    }
    const typeOffset = offset + 4;
    if (
      !isPngChunkTypeByte(bytes[typeOffset]!) ||
      !isPngChunkTypeByte(bytes[typeOffset + 1]!) ||
      !isPngChunkTypeByte(bytes[typeOffset + 2]!) ||
      !isPngChunkTypeByte(bytes[typeOffset + 3]!)
    ) {
      throw new Error(`texture "${label}" contains an invalid PNG chunk type`);
    }
    const type = String.fromCharCode(
      bytes[typeOffset]!,
      bytes[typeOffset + 1]!,
      bytes[typeOffset + 2]!,
      bytes[typeOffset + 3]!,
    );
    // The third chunk-type byte is reserved by PNG and must be uppercase.
    if ((bytes[offset + 6]! & 0x20) !== 0) {
      throw new Error(`texture "${label}" has PNG chunk ${type} with an invalid reserved bit`);
    }
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    const actualCrc = pngChunkCrc(bytes, offset + 4, dataEnd);
    if (actualCrc !== expectedCrc) {
      throw new Error(`texture "${label}" has an invalid CRC in its PNG ${type} chunk`);
    }
    if (seenIend) {
      throw new Error(`texture "${label}" contains data after its PNG IEND chunk`);
    }

    switch (type) {
      case "IHDR":
        if (seenIhdr || offset !== PNG_SIGNATURE.length || length !== 13) {
          throw new Error(`texture "${label}" has a misplaced or duplicate PNG IHDR chunk`);
        }
        seenIhdr = true;
        break;

      case "PLTE": {
        if (seenPlte) {
          throw new Error(`texture "${label}" has duplicate PNG PLTE chunks`);
        }
        if (seenIdat || seenTrns) {
          throw new Error(`texture "${label}" has a PNG PLTE chunk in an invalid order`);
        }
        if (colorType === 0 || colorType === 4) {
          throw new Error(
            `texture "${label}" has a PNG PLTE chunk forbidden for color type ${colorType}`,
          );
        }
        if (length === 0 || length > 768 || length % 3 !== 0) {
          throw new Error(`texture "${label}" has an invalid PNG PLTE size ${length}`);
        }
        paletteEntries = length / 3;
        if (colorType === 3 && paletteEntries > 2 ** bitDepth) {
          throw new Error(
            `texture "${label}" has ${paletteEntries} palette entries for indexed bit depth ${bitDepth}`,
          );
        }
        palette = bytes.subarray(dataStart, dataEnd);
        seenPlte = true;
        break;
      }

      case "tRNS": {
        if (seenTrns) {
          throw new Error(`texture "${label}" has duplicate PNG tRNS chunks`);
        }
        if (seenIdat) {
          throw new Error(`texture "${label}" has a PNG tRNS chunk after IDAT`);
        }
        if (colorType === 4 || colorType === 6) {
          throw new Error(
            `texture "${label}" has a PNG tRNS chunk forbidden for color type ${colorType}`,
          );
        }
        if (colorType === 0) {
          if (length !== 2) {
            throw new Error(`texture "${label}" has an invalid grayscale PNG tRNS size ${length}`);
          }
          const maxSample = 2 ** bitDepth - 1;
          // PNG requires decoders to ignore the unused high bits when the
          // image bit depth is below 16. Encoders SHOULD clear them, but their
          // presence does not make the datastream undecodable.
          transparent = [bytes.readUInt16BE(dataStart) & maxSample];
        } else if (colorType === 2) {
          if (length !== 6) {
            throw new Error(`texture "${label}" has an invalid truecolor PNG tRNS size ${length}`);
          }
          const maxSample = 2 ** bitDepth - 1;
          transparent = [
            bytes.readUInt16BE(dataStart) & maxSample,
            bytes.readUInt16BE(dataStart + 2) & maxSample,
            bytes.readUInt16BE(dataStart + 4) & maxSample,
          ];
        } else {
          if (!seenPlte) {
            throw new Error(`texture "${label}" has an indexed PNG tRNS chunk before PLTE`);
          }
          if (length > paletteEntries) {
            throw new Error(
              `texture "${label}" has too many PNG tRNS entries (${length}) for a ${paletteEntries}-entry palette`,
            );
          }
          paletteAlpha = bytes.subarray(dataStart, dataEnd);
        }
        seenTrns = true;
        break;
      }

      case "gAMA":
      case "cHRM":
      case "sRGB":
      case "iCCP": {
        if (seenColorMetadata.has(type)) {
          throw new Error(`texture "${label}" has duplicate PNG ${type} chunks`);
        }
        if (seenPlte || seenIdat) {
          throw new Error(`texture "${label}" has a PNG ${type} chunk in an invalid order`);
        }
        if (type === "gAMA") {
          if (length !== 4 || bytes.readUInt32BE(dataStart) === 0) {
            throw new Error(`texture "${label}" has an invalid PNG gAMA chunk`);
          }
        } else if (type === "cHRM") {
          if (length !== 32) {
            throw new Error(`texture "${label}" has an invalid PNG cHRM size ${length}`);
          }
        } else if (type === "sRGB") {
          if (length !== 1 || bytes[dataStart]! > 3) {
            throw new Error(`texture "${label}" has an invalid PNG sRGB chunk`);
          }
        } else {
          let separator = dataStart;
          while (separator < dataEnd && bytes[separator] !== 0) separator++;
          const profileName = bytes.subarray(dataStart, separator);
          const compressionMethod = separator + 1;
          if (
            separator === dataEnd ||
            !isLegalPngKeyword(profileName) ||
            compressionMethod >= dataEnd ||
            bytes[compressionMethod] !== 0 ||
            compressionMethod + 1 >= dataEnd
          ) {
            throw new Error(`texture "${label}" has an invalid PNG iCCP chunk`);
          }
        }
        seenColorMetadata.add(type);
        break;
      }

      case "IDAT":
        if (idatEnded) {
          throw new Error(`texture "${label}" has non-consecutive PNG IDAT chunks`);
        }
        if (colorType === 3 && !seenPlte) {
          throw new Error(`texture "${label}" has indexed PNG IDAT data before PLTE`);
        }
        seenIdat = true;
        idatChunks++;
        if (idatChunks > RUNTIME_LIMITS.pngIdatChunks) {
          throw new Error(
            `texture "${label}" exceeds the ${RUNTIME_LIMITS.pngIdatChunks}-IDAT PNG ceiling (§16)`,
          );
        }
        idat.push(bytes.subarray(dataStart, dataEnd));
        break;

      case "IEND":
        if (length !== 0 || !seenIdat) {
          throw new Error(`texture "${label}" has an invalid PNG IEND chunk`);
        }
        seenIend = true;
        break;

      default:
        // PNG defines only IHDR, PLTE, IDAT, and IEND as critical. Unknown
        // critical chunks cannot be ignored safely.
        if ((bytes[offset + 4]! & 0x20) === 0) {
          throw new Error(`texture "${label}" has unsupported critical PNG chunk ${type}`);
        }
        if (seenIdat) idatEnded = true;
        break;
    }

    offset = chunkEnd;
    if (type === "IEND" && offset !== bytes.length) {
      throw new Error(`texture "${label}" contains data after its PNG IEND chunk`);
    }
  }
  if (!seenIend) throw new Error(`texture "${label}" has no PNG IEND chunk`);
  if (!seenIdat) throw new Error(`texture "${label}" has no PNG IDAT data`);

  let inflated: Buffer;
  try {
    const compressed = idat.length === 1 ? idat[0]! : Buffer.concat(idat);
    inflated = inflateSync(compressed, { maxOutputLength: expectedBytes + 1 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`texture "${label}" failed bounded PNG inflation: ${detail}`);
  }
  if (inflated.byteLength !== expectedBytes) {
    throw new Error(
      `texture "${label}" inflates to ${inflated.byteLength} bytes; expected ${expectedBytes}`,
    );
  }
  return {
    width,
    height,
    bitDepth,
    colorType,
    channels,
    interlace,
    palette,
    paletteAlpha,
    transparent,
    inflated,
  };
}

function scalePngSample(sample: number, bitDepth: number): number {
  if (bitDepth === 8) return sample;
  const max = 2 ** bitDepth - 1;
  return Math.floor((sample * 255) / max + 0.5);
}

function readPngSample(row: Uint8Array, index: number, bitDepth: number): number {
  if (bitDepth === 8) return row[index]!;
  if (bitDepth === 16) return (row[index * 2]! << 8) | row[index * 2 + 1]!;
  const bitOffset = index * bitDepth;
  const shift = 8 - bitDepth - (bitOffset & 7);
  return (row[bitOffset >> 3]! >> shift) & (2 ** bitDepth - 1);
}

function writePngPixel(
  out: Uint8Array,
  offset: number,
  samples: readonly number[],
  png: DecodedPngSource,
): void {
  const { bitDepth, colorType, palette, paletteAlpha, transparent } = png;
  if (colorType === 0) {
    if (transparent?.[0] === samples[0]) {
      out.fill(0, offset, offset + 4);
      return;
    }
    const gray = scalePngSample(samples[0]!, bitDepth);
    out[offset] = gray;
    out[offset + 1] = gray;
    out[offset + 2] = gray;
    out[offset + 3] = 255;
    return;
  }
  if (colorType === 2) {
    if (
      transparent &&
      transparent[0] === samples[0] &&
      transparent[1] === samples[1] &&
      transparent[2] === samples[2]
    ) {
      out.fill(0, offset, offset + 4);
      return;
    }
    out[offset] = scalePngSample(samples[0]!, bitDepth);
    out[offset + 1] = scalePngSample(samples[1]!, bitDepth);
    out[offset + 2] = scalePngSample(samples[2]!, bitDepth);
    out[offset + 3] = 255;
    return;
  }
  if (colorType === 3) {
    const index = samples[0]!;
    if (!palette || index * 3 + 2 >= palette.length) {
      throw new Error(`PNG palette index ${index} has no PLTE entry`);
    }
    out[offset] = palette[index * 3]!;
    out[offset + 1] = palette[index * 3 + 1]!;
    out[offset + 2] = palette[index * 3 + 2]!;
    out[offset + 3] = paletteAlpha?.[index] ?? 255;
    return;
  }
  if (colorType === 4) {
    const gray = scalePngSample(samples[0]!, bitDepth);
    out[offset] = gray;
    out[offset + 1] = gray;
    out[offset + 2] = gray;
    out[offset + 3] = scalePngSample(samples[1]!, bitDepth);
    return;
  }
  out[offset] = scalePngSample(samples[0]!, bitDepth);
  out[offset + 1] = scalePngSample(samples[1]!, bitDepth);
  out[offset + 2] = scalePngSample(samples[2]!, bitDepth);
  out[offset + 3] = scalePngSample(samples[3]!, bitDepth);
}

/** Unfilter and map non-interlaced or Adam7 samples directly to straight RGBA8. */
function decodePngPixels(png: DecodedPngSource, label: string): Uint8Array {
  const outputLength = png.width * png.height * 4;
  if (!Number.isSafeInteger(outputLength)) {
    throw new Error(`texture "${label}" has unsafe decoded PNG dimensions`);
  }
  const out = new Uint8Array(outputLength);
  const passes =
    png.interlace === 0
      ? ([[0, 0, 1, 1]] as const)
      : (ADAM7_PASSES as readonly (readonly number[])[]);
  const bitsPerPixel = png.channels * png.bitDepth;
  const filterBytesPerPixel = Math.max(1, Math.ceil(bitsPerPixel / 8));
  let rawOffset = 0;

  for (const [startX, startY, stepX, stepY] of passes) {
    const passWidth = passSize(png.width, startX!, stepX!);
    const passHeight = passSize(png.height, startY!, stepY!);
    if (passWidth === 0 || passHeight === 0) continue;
    const stride = Math.ceil((passWidth * bitsPerPixel) / 8);
    let previous = new Uint8Array(stride);
    const samples = new Array<number>(png.channels).fill(0);

    for (let py = 0; py < passHeight; py++) {
      if (rawOffset + stride + 1 > png.inflated.byteLength) {
        throw new Error(`texture "${label}" ends inside an inflated PNG scanline`);
      }
      const filter = png.inflated[rawOffset++]!;
      if (filter > 4) throw new Error(`texture "${label}" has unknown PNG filter ${filter}`);
      const row = new Uint8Array(stride);
      for (let i = 0; i < stride; i++) {
        const value = png.inflated[rawOffset++]!;
        const left = i >= filterBytesPerPixel ? row[i - filterBytesPerPixel]! : 0;
        const up = previous[i]!;
        const upLeft = i >= filterBytesPerPixel ? previous[i - filterBytesPerPixel]! : 0;
        let predictor = 0;
        if (filter === 1) predictor = left;
        else if (filter === 2) predictor = up;
        else if (filter === 3) predictor = (left + up) >> 1;
        else if (filter === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        }
        row[i] = (value + predictor) & 0xff;
      }

      for (let px = 0; px < passWidth; px++) {
        for (let channel = 0; channel < png.channels; channel++) {
          samples[channel] = readPngSample(row, px * png.channels + channel, png.bitDepth);
        }
        const x = startX! + px * stepX!;
        const y = startY! + py * stepY!;
        writePngPixel(out, (y * png.width + x) * 4, samples, png);
      }
      previous = row;
    }
  }

  if (rawOffset !== png.inflated.byteLength) {
    throw new Error(
      `texture "${label}" has ${png.inflated.byteLength - rawOffset} trailing inflated PNG bytes`,
    );
  }
  return out;
}

export function addTexturePixels(total: number, info: PngInfo, label: string): number {
  const next = total + info.width * info.height;
  if (next > LIMITS.totalTexturePixels) {
    throw new Error(
      `decoded textures exceed the ${LIMITS.totalTexturePixels}-pixel aggregate ceiling at "${label}" (§16)`,
    );
  }
  return next;
}

export function decodePngBuffer(bytes: Uint8Array, label: string): PremultipliedImage {
  const decoded = decodePngBufferStraight(bytes, label);
  return {
    width: decoded.width,
    height: decoded.height,
    data: premultiplyStraightRGBA8(decoded.data),
  };
}

/**
 * Decode stored PNG samples without alpha conversion. Conformance captures
 * deliberately store the already-premultiplied model surface as raw RGBA8,
 * so applying texture premultiplication to those bytes would be destructive.
 */
export function decodePngBufferStraight(bytes: Uint8Array, label: string): PremultipliedImage {
  const info = inspectPngBuffer(bytes, label);
  const png = parseAndInflatePng(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    label,
  );
  if (png.width !== info.width || png.height !== info.height) {
    throw new Error(`texture "${label}" decoded dimensions disagree with its IHDR`);
  }
  return {
    width: png.width,
    height: png.height,
    data: decodePngPixels(png, label),
  };
}

export function decodePngFile(path: string): PremultipliedImage {
  const fd = openSync(path, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new Error(`texture "${path}" is not a regular file`);
    if (before.size > BigInt(LIMITS.textureFileBytes)) {
      throw new Error(
        `texture "${path}" exceeds the ${LIMITS.textureFileBytes}-byte PNG ceiling (§16)`,
      );
    }

    const expectedSize = Number(before.size);
    const bounded = Buffer.allocUnsafe(expectedSize + 1);
    let offset = 0;
    while (offset < bounded.byteLength) {
      const count = readSync(fd, bounded, offset, bounded.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      offset !== expectedSize ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw new Error(`texture "${path}" changed while being read (§16)`);
    }
    bytes = bounded.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
  return decodePngBuffer(bytes, path);
}

/** Reject an oversized PNG from source metadata before materializing it. */
export function readPngBytes(source: FileSource, rel: string): Uint8Array {
  checkContainerPath(rel);
  if (source.size(rel) > LIMITS.textureFileBytes) {
    throw new Error(
      `texture "${rel}" exceeds the ${LIMITS.textureFileBytes}-byte PNG ceiling (§16)`,
    );
  }
  const bytes = source.read(rel);
  if (bytes.byteLength > LIMITS.textureFileBytes) {
    throw new Error(
      `texture "${rel}" exceeds the ${LIMITS.textureFileBytes}-byte PNG ceiling (§16)`,
    );
  }
  return bytes;
}

/** Read and parse every manifest-listed JSON document (no model loading). */
export function readRawDocs(source: FileSource): {
  raw: ModelFiles;
  rawPaths: LoadedContainer["rawPaths"];
} {
  const manifestValue = readJson(source, "manifest.json");
  if (typeof manifestValue !== "object" || manifestValue === null || Array.isArray(manifestValue)) {
    throw new Error(`"manifest.json" must contain a JSON object`);
  }
  const manifest = manifestValue as Record<string, unknown>;
  const filesValue = manifest.files;
  if (
    filesValue !== undefined &&
    (typeof filesValue !== "object" || filesValue === null || Array.isArray(filesValue))
  ) {
    throw new Error(`manifest.files must be a JSON object`);
  }
  const files = (filesValue ?? {}) as Record<string, unknown>;
  let manifestPathMetadataBytes = Buffer.byteLength("manifest.json", "utf8");
  const accountManifestPath = (path: string): void => {
    checkContainerPath(path);
    manifestPathMetadataBytes += Buffer.byteLength(path, "utf8");
    if (manifestPathMetadataBytes > RUNTIME_LIMITS.containerPathMetadataBytes) {
      throw new Error(
        `manifest file paths exceed ${RUNTIME_LIMITS.containerPathMetadataBytes} UTF-8 metadata bytes (§16)`,
      );
    }
  };
  const onePath = (key: string, dflt?: string): string | undefined => {
    const value = files[key];
    if (value === undefined) {
      if (dflt !== undefined) accountManifestPath(dflt);
      return dflt;
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`manifest.files.${key} must be a non-empty string path`);
    }
    accountManifestPath(value);
    return value;
  };
  const pathList = (key: string): string[] | undefined => {
    const value = files[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      throw new Error(`manifest.files.${key} must be an array of non-empty string paths`);
    }
    // Reject before `.some`, `Set`, or file reads allocate/work over the
    // complete attacker-controlled array.
    if (value.length > LIMITS.containerFiles) {
      throw new Error(
        `manifest.files.${key} exceeds the ${LIMITS.containerFiles}-path ceiling (§16)`,
      );
    }
    if (value.some((path) => typeof path !== "string" || path.length === 0)) {
      throw new Error(`manifest.files.${key} must be an array of non-empty string paths`);
    }
    const paths = value as string[];
    if (new Set(paths).size !== paths.length) {
      throw new Error(`manifest.files.${key} must not contain duplicate paths`);
    }
    for (const path of paths) accountManifestPath(path);
    return paths;
  };

  const rigPath = onePath("rig", "rig.json")!;
  const physicsPath = onePath("physics");
  const variantsPath = onePath("variants");
  const atlasPath = onePath("atlas");
  const expressionPaths = pathList("expressions");
  const motionPaths = pathList("motions");

  // Resolve and account for every manifest path before any listed file read.
  // Raw documents remain retained for schemas and lints, so bound their
  // aggregate encoded footprint independently of opaque container payload.
  const jsonPaths = new Set([
    "manifest.json",
    rigPath,
    ...(physicsPath ? [physicsPath] : []),
    ...(variantsPath ? [variantsPath] : []),
    ...(atlasPath ? [atlasPath] : []),
    ...(expressionPaths ?? []),
    ...(motionPaths ?? []),
  ]);
  if (jsonPaths.size > LIMITS.containerFiles) {
    throw new Error(
      `manifest lists more than ${LIMITS.containerFiles} distinct JSON documents (§16)`,
    );
  }
  let listedJsonBytes = 0;
  for (const path of jsonPaths) {
    const size = source.size(path);
    if (size > LIMITS.jsonFileBytes) {
      throw new Error(`"${path}" exceeds the ${LIMITS.jsonFileBytes}-byte JSON ceiling (§16)`);
    }
    if (size > LIMITS.jsonDocumentsBytes - listedJsonBytes) {
      throw new Error(
        `manifest-listed JSON exceeds ${LIMITS.jsonDocumentsBytes} aggregate bytes (§16)`,
      );
    }
    listedJsonBytes += size;
  }

  // Cache cross-category aliases so even a malformed manifest cannot force the
  // same maximum-size JSON file to be parsed repeatedly.
  const jsonCache = new Map<string, unknown>([["manifest.json", manifest]]);
  const cachedJson = (path: string): unknown => {
    if (jsonCache.has(path)) return jsonCache.get(path);
    const value = readJson(source, path);
    jsonCache.set(path, value);
    return value;
  };

  const raw: ModelFiles = { manifest, rig: cachedJson(rigPath) };
  const rawPaths: LoadedContainer["rawPaths"] = { manifest: "manifest.json", rig: rigPath };
  if (physicsPath) {
    raw.physics = cachedJson(physicsPath);
    rawPaths.physics = physicsPath;
  }
  if (variantsPath) {
    raw.variants = cachedJson(variantsPath);
    rawPaths.variants = variantsPath;
  }
  if (atlasPath) {
    raw.atlas = cachedJson(atlasPath);
    rawPaths.atlas = atlasPath;
  }
  if (expressionPaths) {
    const expressions = Object.create(null) as Record<string, unknown>;
    for (const path of expressionPaths) expressions[path] = cachedJson(path);
    raw.expressions = expressions;
  }
  if (motionPaths) {
    const motions = Object.create(null) as Record<string, unknown>;
    for (const path of motionPaths) motions[path] = cachedJson(path);
    raw.motions = motions;
  }
  return { raw, rawPaths };
}

/**
 * Load from a caller-owned source. This function never closes `source`: on
 * success it is returned in `LoadedContainer`; on failure the caller must
 * close it.
 */
export function loadContainerFromSource(source: FileSource, opts?: LoadOptions): LoadedContainer {
  const { raw, rawPaths } = readRawDocs(source);
  const model = loadModel(raw, opts);

  const textures = new Map<string, PremultipliedImage>();
  let decodedTexturePixels = 0;
  for (const sprite of model.sprites) {
    if (!textures.has(sprite.texture)) {
      const rel = `textures/${sprite.texture}.png`;
      const bytes = readPngBytes(source, rel);
      decodedTexturePixels = addTexturePixels(
        decodedTexturePixels,
        inspectPngBuffer(bytes, rel),
        rel,
      );
      textures.set(sprite.texture, decodePngBuffer(bytes, rel));
    }
  }
  let atlasImage: PremultipliedImage | null = null;
  if (model.atlas) {
    checkContainerPath(model.atlas.image);
    const bytes = readPngBytes(source, model.atlas.image);
    decodedTexturePixels = addTexturePixels(
      decodedTexturePixels,
      inspectPngBuffer(bytes, model.atlas.image),
      model.atlas.image,
    );
    atlasImage = decodePngBuffer(bytes, model.atlas.image);
    for (const problem of atlasConsistencyProblems(model.atlas, textures, atlasImage)) {
      throw new Error(problem.message);
    }
  }
  return { model, textures, atlasImage, raw, rawPaths, source };
}

/** Load an unpacked container directory (§3). */
export function loadContainerDir(dir: string, opts?: LoadOptions): LoadedContainer {
  const source = dirFileSource(dir);
  try {
    return loadContainerFromSource(source, opts);
  } catch (error) {
    source.close();
    throw error;
  }
}

/** Load a container from a directory or a packed `.lyre` ZIP file. */
export async function loadContainer(path: string, opts?: LoadOptions): Promise<LoadedContainer> {
  const st = statSync(path);
  const source = st.isDirectory() ? dirFileSource(path) : await zipFileSource(path);
  try {
    return loadContainerFromSource(source, opts);
  } catch (e) {
    source.close();
    throw e;
  }
}
