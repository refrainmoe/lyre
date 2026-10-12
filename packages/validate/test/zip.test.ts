// §16 container safety for packed `.lyre` ZIPs: path traversal, symlinks,
// entry-count and inflation bounds — attack fixtures hand-crafted byte by byte.

import {
  createWriteStream,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { ZipFile } from "yazl";
import { LIMITS, RUNTIME_LIMITS } from "@refrain-lyre/core";
import {
  addTexturePixels,
  checkContainerPath,
  decodePngBuffer,
  decodePngFile,
  dirFileSource,
  inspectPngBuffer,
  zipFileSource,
  loadContainer,
  loadContainerFromSource,
  readRawDocs,
  type FileSource,
} from "../src/container.js";
import { validateModelPath } from "../src/validate.js";
import {
  baseDocs,
  fixtureZipEntries,
  pngBuffer,
  rawZip,
  tempDir,
  writeFixture,
  type RawZipEntry,
} from "./helpers.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc(bytes: Buffer): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = PNG_CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string | Uint8Array, data = Buffer.alloc(0), validCrc = true): Buffer {
  const typeBytes = typeof type === "string" ? Buffer.from(type, "ascii") : Buffer.from(type);
  if (typeBytes.byteLength !== 4) throw new Error("test PNG chunk type must contain four bytes");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(validCrc ? pngCrc(Buffer.concat([typeBytes, data])) : 0, 8 + data.byteLength);
  return chunk;
}

function insertAfterIhdr(png: Buffer, chunks: readonly Buffer[]): Buffer {
  return Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)]);
}

function legalPng(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  interlace: number,
  raw: Buffer,
  beforeIdat: readonly Buffer[] = [],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    ...beforeIdat,
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND"),
  ]);
}

function indexedTransparencyPng(): Buffer {
  return legalPng(2, 1, 1, 3, 0, Buffer.from([0, 0b0100_0000]), [
    pngChunk("PLTE", Buffer.from([255, 0, 0, 0, 255, 0])),
    pngChunk("tRNS", Buffer.from([255, 0])),
  ]);
}

function zipPath(entries: RawZipEntry[]): string {
  const p = join(tempDir(), "model.lyre");
  writeFileSync(p, rawZip(entries));
  return p;
}

async function compressedZipPath(entries: RawZipEntry[]): Promise<string> {
  const p = join(tempDir(), "model.lyre");
  const zip = new ZipFile();
  for (const entry of entries) zip.addBuffer(entry.data, entry.name);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(p));
  return p;
}

function zipSpoolDirs(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("lyre-zip-")));
}

describe("packed .lyre loading", () => {
  it("validates a well-formed ZIP identically and cleans its disk spool", async () => {
    const path = await compressedZipPath(fixtureZipEntries(baseDocs()));
    const beforeValidation = zipSpoolDirs();
    const report = await validateModelPath(path);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
    expect(zipSpoolDirs()).toEqual(beforeValidation);

    const beforeOpen = zipSpoolDirs();
    const source = await zipFileSource(path);
    const created = [...zipSpoolDirs()].filter((name) => !beforeOpen.has(name));
    expect(created).toHaveLength(1);
    try {
      const { model } = loadContainerFromSource(source);
      expect(model.id).toBe("fixture");
      expect(model.sprites).toHaveLength(1);
    } finally {
      source.close();
    }
    expect(existsSync(join(tmpdir(), created[0]!))).toBe(false);
    expect(() => source.read("manifest.json")).toThrow(/closed/);
    source.close(); // idempotent
  });

  it("rejects oversized JSON from metadata before reading it", () => {
    const read = vi.fn(() => Buffer.from("{}"));
    const source: FileSource = {
      files: () => ["manifest.json"],
      has: () => true,
      read,
      size: () => LIMITS.jsonFileBytes + 1,
      close: () => {},
    };
    expect(() => readRawDocs(source)).toThrow(/JSON ceiling/);
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects excessive aggregate listed JSON before reading dependent documents", () => {
    const manifest = Buffer.from(
      JSON.stringify({
        lyre: "0.1",
        id: "json_budget",
        canvas: { width: 1, height: 1, origin: [0, 0] },
        files: { rig: "rig.json", physics: "physics.json" },
      }),
    );
    const read = vi.fn((path: string) => {
      if (path === "manifest.json") return manifest;
      return Buffer.from("{}");
    });
    const source: FileSource = {
      files: () => ["manifest.json", "rig.json", "physics.json"],
      has: () => true,
      read,
      size: (path) =>
        path === "manifest.json" ? manifest.byteLength : LIMITS.jsonDocumentsBytes / 2,
      close: () => {},
    };
    expect(() => readRawDocs(source)).toThrow(/aggregate bytes/);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("manifest.json");
  });

  it("rejects invalid UTF-8 instead of accepting replacement characters", () => {
    const read = vi.fn(() => Buffer.from([0xff]));
    const source: FileSource = {
      files: () => ["manifest.json"],
      has: () => true,
      read,
      size: () => 1,
      close: () => {},
    };
    expect(() => readRawDocs(source)).toThrow(/valid UTF-8/);
  });

  it("preserves manifest paths that collide with object prototype names", () => {
    const contents = new Map<string, Buffer>([
      [
        "manifest.json",
        Buffer.from(
          JSON.stringify({
            lyre: "0.1",
            id: "prototype_path",
            canvas: { width: 1, height: 1, origin: [0, 0] },
            files: { rig: "rig.json", motions: ["__proto__"] },
          }),
        ),
      ],
      ["rig.json", Buffer.from(JSON.stringify({ params: [], nodes: [], bindings: [] }))],
      ["__proto__", Buffer.from(JSON.stringify({ id: "m", duration: 1, tracks: [] }))],
    ]);
    const source: FileSource = {
      files: () => [...contents.keys()],
      has: (path) => contents.has(path),
      read: (path) => contents.get(path)!,
      size: (path) => contents.get(path)!.byteLength,
      close: () => {},
    };
    const { raw } = readRawDocs(source);
    expect(Object.hasOwn(raw.motions!, "__proto__")).toBe(true);
  });

  it("bounds aggregate manifest path metadata before reading listed files", () => {
    const motions = Array.from({ length: 2_051 }, (_, i) => {
      const prefix = `m${i}_`;
      return prefix + "a".repeat(RUNTIME_LIMITS.containerPathBytes - 6 - prefix.length);
    });
    const manifest = Buffer.from(
      JSON.stringify({
        lyre: "0.1",
        id: "path_metadata",
        canvas: { width: 1, height: 1, origin: [0, 0] },
        files: { rig: "rig.json", motions },
      }),
    );
    const rig = Buffer.from(JSON.stringify({ params: [], nodes: [], bindings: [] }));
    const source: FileSource = {
      files: () => ["manifest.json", "rig.json"],
      has: (path) => path === "manifest.json" || path === "rig.json",
      read: (path) => (path === "manifest.json" ? manifest : rig),
      size: (path) => (path === "manifest.json" ? manifest.byteLength : rig.byteLength),
      close: () => {},
    };
    expect(() => readRawDocs(source)).toThrow(/metadata bytes/);
  });

  it("loadContainer cleans its spool when model loading fails", async () => {
    const path = await compressedZipPath([
      { name: "manifest.json", data: Buffer.from("{not json") },
    ]);
    const before = zipSpoolDirs();
    await expect(loadContainer(path)).rejects.toThrow();
    expect(zipSpoolDirs()).toEqual(before);
  });

  it("enforces the total uncompressed-size ceiling for directories", () => {
    const dir = tempDir();
    const huge = join(dir, "huge.bin");
    writeFileSync(huge, "");
    truncateSync(huge, LIMITS.containerUncompressedBytes + 1);
    try {
      expect(() => dirFileSource(dir)).toThrow(/uncompressed bytes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a directory file replaced after the initial safety scan", () => {
    const dir = writeFixture(baseDocs());
    const source = dirFileSource(dir);
    const replacement = join(dir, "replacement.tmp");
    writeFileSync(replacement, readFileSync(join(dir, "rig.json")));
    renameSync(replacement, join(dir, "rig.json"));
    try {
      expect(() => source.read("rig.json")).toThrow(/changed after safety inspection/);
      expect(() => source.size("rig.json")).toThrow(/changed after safety inspection/);
    } finally {
      source.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects symlinks while incrementally scanning a directory", () => {
    const dir = tempDir();
    const targetDir = tempDir();
    const target = join(targetDir, "target.json");
    writeFileSync(target, "{}");
    symlinkSync(target, join(dir, "link.json"));
    try {
      expect(() => dirFileSource(dir)).toThrow(/symlink/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });
});

describe("decoded-image ceilings (§16)", () => {
  it("rejects oversized IHDR dimensions before PNG inflation", () => {
    const png = pngBuffer(1, 1);
    png.writeUInt32BE(LIMITS.textureDimension, 16);
    png.writeUInt32BE(LIMITS.textureDimension, 20);
    expect(() => inspectPngBuffer(png, "oversized.png")).toThrow(/decoded-image ceiling/);
  });

  it("bounds aggregate decoded texture pixels", () => {
    const almostFull = LIMITS.totalTexturePixels - 1;
    expect(() => addTexturePixels(almostFull, { width: 1, height: 2 }, "last.png")).toThrow(
      /aggregate ceiling/,
    );
  });

  it("bounds total PNG chunks and fragmented IDAT streams before decode", () => {
    const png = pngBuffer(1, 1);
    const ancillary = pngChunk("vpAg");
    const tooManyChunks = insertAfterIhdr(png, Array(RUNTIME_LIMITS.pngChunks + 1).fill(ancillary));
    expect(() => decodePngBuffer(tooManyChunks, "chunks.png")).toThrow(/chunk PNG ceiling/);

    const emptyIdat = pngChunk("IDAT");
    const tooManyIdats = insertAfterIhdr(
      png,
      Array(RUNTIME_LIMITS.pngIdatChunks + 1).fill(emptyIdat),
    );
    expect(() => decodePngBuffer(tooManyIdats, "idats.png")).toThrow(/IDAT PNG ceiling/);
  });

  it("rejects illegal PLTE and tRNS multiplicity, order, and sizes", () => {
    const rgba = pngBuffer(1, 1);
    const secondIhdr = pngChunk("IHDR", rgba.subarray(16, 29));
    expect(() =>
      decodePngBuffer(insertAfterIhdr(rgba, [secondIhdr]), "duplicate-ihdr.png"),
    ).toThrow(/duplicate PNG IHDR/);

    const palette = pngChunk("PLTE", Buffer.from([1, 2, 3]));
    expect(() =>
      decodePngBuffer(insertAfterIhdr(rgba, [palette, palette]), "duplicate-plte.png"),
    ).toThrow(/duplicate PNG PLTE/);
    expect(() =>
      decodePngBuffer(
        insertAfterIhdr(rgba, [pngChunk("PLTE", Buffer.alloc(771))]),
        "large-plte.png",
      ),
    ).toThrow(/invalid PNG PLTE size/);
    expect(() =>
      decodePngBuffer(
        insertAfterIhdr(rgba, [pngChunk("tRNS", Buffer.from([0, 0]))]),
        "rgba-trns.png",
      ),
    ).toThrow(/tRNS chunk forbidden/);

    const indexed = indexedTransparencyPng();
    const plteStart = 33;
    const plteEnd = plteStart + 18;
    const trnsEnd = plteEnd + 14;
    const wrongOrder = Buffer.concat([
      indexed.subarray(0, plteStart),
      indexed.subarray(plteEnd, trnsEnd),
      indexed.subarray(plteStart, plteEnd),
      indexed.subarray(trnsEnd),
    ]);
    expect(() => decodePngBuffer(wrongOrder, "trns-before-plte.png")).toThrow(
      /tRNS chunk before PLTE/,
    );
  });

  it("rejects PNG chunk types whose reserved bit is set", () => {
    const png = insertAfterIhdr(pngBuffer(1, 1), [pngChunk("vpag")]);
    expect(() => decodePngBuffer(png, "reserved-bit.png")).toThrow(/invalid reserved bit/);
  });

  it("rejects high-bit chunk type bytes instead of ASCII-masking them", () => {
    const highBitType = Buffer.from([0xe1, 0x42, 0x43, 0x44]);
    const png = insertAfterIhdr(pngBuffer(1, 1), [pngChunk(highBitType)]);
    expect(() => decodePngBuffer(png, "high-bit-type.png")).toThrow(/invalid PNG chunk type/);

    const highBitIhdr = Buffer.from(pngBuffer(1, 1));
    highBitIhdr[12] = 0xc9;
    highBitIhdr.writeUInt32BE(pngCrc(highBitIhdr.subarray(12, 29)), 29);
    expect(() => inspectPngBuffer(highBitIhdr, "high-bit-ihdr.png")).toThrow(/valid IHDR/);
  });

  it("validates ignored color-metadata cardinality, order, and shape", () => {
    const rgba = pngBuffer(1, 1);
    const gamma = pngChunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f]));
    const chromaticities = pngChunk("cHRM", Buffer.alloc(32));
    const srgb = pngChunk("sRGB", Buffer.from([0]));

    expect(() =>
      decodePngBuffer(
        insertAfterIhdr(rgba, [chromaticities, gamma, srgb]),
        "legal-color-metadata.png",
      ),
    ).not.toThrow();
    expect(() =>
      decodePngBuffer(insertAfterIhdr(rgba, [gamma, gamma]), "duplicate-gamma.png"),
    ).toThrow(/duplicate PNG gAMA/);
    expect(() =>
      decodePngBuffer(insertAfterIhdr(rgba, [pngChunk("gAMA")]), "empty-gamma.png"),
    ).toThrow(/invalid PNG gAMA/);
    expect(() =>
      decodePngBuffer(
        insertAfterIhdr(rgba, [pngChunk("cHRM", Buffer.alloc(31))]),
        "short-chromaticities.png",
      ),
    ).toThrow(/invalid PNG cHRM size/);
    expect(() =>
      decodePngBuffer(
        insertAfterIhdr(rgba, [pngChunk("sRGB", Buffer.from([4]))]),
        "bad-rendering-intent.png",
      ),
    ).toThrow(/invalid PNG sRGB/);

    const palette = pngChunk("PLTE", Buffer.from([0, 0, 0]));
    expect(() =>
      decodePngBuffer(insertAfterIhdr(rgba, [palette, gamma]), "late-gamma.png"),
    ).toThrow(/gAMA chunk in an invalid order/);
  });

  it("validates iCCP framing, keeps its payload opaque, and accepts legal color metadata", () => {
    const rgba = pngBuffer(1, 1);
    const iccp = pngChunk(
      "iCCP",
      Buffer.concat([
        Buffer.from("fixture profile\0\0", "latin1"),
        deflateSync(Buffer.from("icc")),
      ]),
    );
    expect(() => decodePngBuffer(insertAfterIhdr(rgba, [iccp]), "legal-iccp.png")).not.toThrow();
    const opaqueIccp = pngChunk(
      "iCCP",
      Buffer.from("opaque profile\0\0not-a-zlib-stream", "latin1"),
    );
    expect(() =>
      decodePngBuffer(insertAfterIhdr(rgba, [opaqueIccp]), "opaque-iccp.png"),
    ).not.toThrow();
    expect(() =>
      decodePngBuffer(
        insertAfterIhdr(rgba, [pngChunk("iCCP", Buffer.from("missing separators"))]),
        "bad-iccp.png",
      ),
    ).toThrow(/invalid PNG iCCP/);
    expect(() =>
      decodePngBuffer(
        insertAfterIhdr(rgba, [pngChunk("sRGB", Buffer.from([0])), iccp]),
        "srgb-and-iccp.png",
      ),
    ).not.toThrow();
  });

  it("rejects illegal ignored metadata through full model validation", async () => {
    const docs = baseDocs();
    docs.textures = {
      s: insertAfterIhdr(pngBuffer(1, 1), [pngChunk("gAMA")]),
    };
    const report = await validateModelPath(writeFixture(docs));
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === "bad_texture")).toBe(true);
  });

  it("continues to accept a legal indexed PNG with palette transparency", () => {
    const decoded = decodePngBuffer(indexedTransparencyPng(), "indexed-trns.png");
    expect([decoded.width, decoded.height]).toEqual([2, 1]);
    expect([...decoded.data]).toEqual([255, 0, 0, 255, 0, 0, 0, 0]);
  });

  it("accepts an empty indexed tRNS prefix and masks unused high sample bits", () => {
    const opaqueIndexed = decodePngBuffer(
      legalPng(1, 1, 1, 3, 0, Buffer.from([0, 0]), [
        pngChunk("PLTE", Buffer.from([10, 20, 30])),
        pngChunk("tRNS"),
      ]),
      "indexed-empty-trns.png",
    );
    expect([...opaqueIndexed.data]).toEqual([10, 20, 30, 255]);

    const grayscale = decodePngBuffer(
      legalPng(1, 1, 8, 0, 0, Buffer.from([0, 10]), [pngChunk("tRNS", Buffer.from([0x12, 10]))]),
      "grayscale-masked-trns.png",
    );
    expect([...grayscale.data]).toEqual([0, 0, 0, 0]);

    const truecolor = decodePngBuffer(
      legalPng(1, 1, 8, 2, 0, Buffer.from([0, 10, 20, 30]), [
        pngChunk("tRNS", Buffer.from([0x12, 10, 0x34, 20, 0x56, 30])),
      ]),
      "truecolor-masked-trns.png",
    );
    expect([...truecolor.data]).toEqual([0, 0, 0, 0]);
  });

  it("decodes legal grayscale, alpha, 16-bit, and Adam7 PNG layouts", () => {
    const grayscale = decodePngBuffer(
      legalPng(2, 1, 1, 0, 0, Buffer.from([0, 0b0100_0000])),
      "grayscale-1.png",
    );
    expect([...grayscale.data]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);

    const grayscaleTransparency = decodePngBuffer(
      legalPng(2, 1, 8, 0, 0, Buffer.from([0, 10, 20]), [pngChunk("tRNS", Buffer.from([0, 10]))]),
      "grayscale-trns.png",
    );
    expect([...grayscaleTransparency.data]).toEqual([0, 0, 0, 0, 20, 20, 20, 255]);

    const truecolorTransparency = decodePngBuffer(
      legalPng(1, 1, 8, 2, 0, Buffer.from([0, 10, 20, 30]), [
        pngChunk("tRNS", Buffer.from([0, 10, 0, 20, 0, 30])),
      ]),
      "truecolor-trns.png",
    );
    expect([...truecolorTransparency.data]).toEqual([0, 0, 0, 0]);

    const grayscaleAlpha = decodePngBuffer(
      legalPng(1, 1, 8, 4, 0, Buffer.from([0, 128, 128])),
      "grayscale-alpha.png",
    );
    expect([...grayscaleAlpha.data]).toEqual([64, 64, 64, 128]);

    const rgba16 = decodePngBuffer(
      legalPng(1, 1, 16, 6, 0, Buffer.from([0, 0xff, 0xff, 0x80, 0x00, 0x00, 0x00, 0x80, 0x00])),
      "rgba-16.png",
    );
    expect([...rgba16.data]).toEqual([128, 64, 0, 128]);

    const width = 3;
    const height = 3;
    const straight = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      straight.set([i * 20, 255 - i * 20, i, 255], i * 4);
    }
    const adam7: number[] = [];
    for (const [startX, startY, stepX, stepY] of [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2],
    ] as const) {
      for (let y = startY; y < height; y += stepY) {
        if (startX >= width) continue;
        adam7.push(0);
        for (let x = startX; x < width; x += stepX) {
          adam7.push(...straight.subarray((y * width + x) * 4, (y * width + x + 1) * 4));
        }
      }
    }
    const interlaced = decodePngBuffer(
      legalPng(width, height, 8, 6, 1, Buffer.from(adam7)),
      "adam7.png",
    );
    expect([...interlaced.data]).toEqual([...straight]);
  });

  it("rejects bad PNG chunk CRCs before inflation", () => {
    const badCrc = insertAfterIhdr(pngBuffer(1, 1), [pngChunk("vpAg", Buffer.alloc(0), false)]);
    expect(() => decodePngBuffer(badCrc, "crc.png")).toThrow(/invalid CRC/);
  });

  it("decodes a PNG file through one stable, bounded descriptor read", () => {
    const path = join(tempDir(), "image.png");
    writeFileSync(path, pngBuffer(2, 1));
    const decoded = decodePngFile(path);
    expect([decoded.width, decoded.height, decoded.data.byteLength]).toEqual([2, 1, 8]);
  });
});

describe("ZIP attack fixtures (§16)", () => {
  it("rejects Windows drive-relative paths", () => {
    expect(() => checkContainerPath("C:outside.json")).toThrow(/relative/);
    expect(() => checkContainerPath("z:outside.json")).toThrow(/relative/);
  });

  it("rejects overlong UTF-8 container paths", () => {
    expect(() => checkContainerPath("a".repeat(RUNTIME_LIMITS.containerPathBytes + 1))).toThrow(
      /UTF-8 bytes/,
    );
  });

  it("rejects entry names with .. segments", async () => {
    const entries = fixtureZipEntries(baseDocs());
    entries.push({ name: "../evil.txt", data: Buffer.from("boom") });
    await expect(zipFileSource(zipPath(entries))).rejects.toThrow(/\.\./);
  });

  it("rejects unsafe directory entry names too", async () => {
    const entries = fixtureZipEntries(baseDocs());
    entries.push({ name: "../evil/", data: Buffer.alloc(0) });
    await expect(zipFileSource(zipPath(entries))).rejects.toThrow(/\.\./);
  });

  it("rejects absolute entry names", async () => {
    const entries = fixtureZipEntries(baseDocs());
    entries.push({ name: "/etc/passwd", data: Buffer.from("boom") });
    await expect(zipFileSource(zipPath(entries))).rejects.toThrow(/absolute|relative/);
  });

  it("rejects symlink entries", async () => {
    const entries = fixtureZipEntries(baseDocs());
    entries.push({ name: "textures/link.png", data: Buffer.from("/etc/passwd"), mode: 0o120777 });
    await expect(zipFileSource(zipPath(entries))).rejects.toThrow(/symlink/);
  });

  it("rejects duplicate file paths", async () => {
    const entries = fixtureZipEntries(baseDocs());
    entries.push({ name: "manifest.json", data: Buffer.from("{}") });
    const before = zipSpoolDirs();
    await expect(zipFileSource(zipPath(entries))).rejects.toThrow(/duplicate file path/);
    expect(zipSpoolDirs()).toEqual(before);
  });

  it("rejects containers over the entry-count ceiling", async () => {
    const entries: RawZipEntry[] = [];
    for (let i = 0; i < LIMITS.containerFiles + 1; i++) {
      entries.push({ name: `f${i}.txt`, data: Buffer.alloc(1) });
    }
    await expect(zipFileSource(zipPath(entries))).rejects.toThrow(/files|entries/);
  }, 30_000);

  it("rejects declared uncompressed sizes over the ceiling without inflating (zip bomb)", async () => {
    // Two entries, each declaring ~1.5 GiB, actual bytes tiny: the declared
    // total crosses 2 GiB and must be rejected before any inflation happens.
    const big = 1.5 * 1024 * 1024 * 1024;
    const entries = fixtureZipEntries(baseDocs());
    entries.push({ name: "bomb1.bin", data: Buffer.alloc(8), declaredSize: big });
    entries.push({ name: "bomb2.bin", data: Buffer.alloc(8), declaredSize: big });
    await expect(zipFileSource(zipPath(entries))).rejects.toThrow(/uncompressed/);
  });

  it("stops reading an entry that inflates past its declared size", async () => {
    // Declared size lies low; the stored data is larger. The stream must be
    // aborted rather than trusted (either by our guard or yauzl's own check).
    const entries = fixtureZipEntries(baseDocs());
    entries.push({ name: "liar.bin", data: Buffer.alloc(4096, 7), declaredSize: 16 });
    await expect(zipFileSource(zipPath(entries))).rejects.toThrow();
  });
});
