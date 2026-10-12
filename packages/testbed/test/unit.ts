import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { LIMITS, RUNTIME_LIMITS, type EvalFrame } from "@refrain-lyre/core";
import { devApiSource, loadContainerFrom, mapSource } from "../src/container.js";
import { collectDroppedDirectory, readAllDirectoryEntries } from "../src/directory.js";
import { decodePng } from "../src/png.js";
import { TESTBED_SERVER_LIMITS } from "../src/server-limits.js";
import { compareSurfaces, compositeSurface } from "../src/surfaces.js";
import { parseTimelineText, parseTimelineValue, TESTBED_TIMELINE_LIMITS } from "../src/timeline.js";
import { stripFrame } from "../src/worker-protocol.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ADAM7 = [
  { x: 0, y: 0, dx: 8, dy: 8 },
  { x: 4, y: 0, dx: 8, dy: 8 },
  { x: 0, y: 4, dx: 4, dy: 8 },
  { x: 2, y: 0, dx: 4, dy: 4 },
  { x: 0, y: 2, dx: 2, dy: 4 },
  { x: 1, y: 0, dx: 2, dy: 2 },
  { x: 0, y: 1, dx: 1, dy: 2 },
] as const;

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string | Uint8Array, data: Uint8Array): Buffer {
  const typeBytes = typeof type === "string" ? Buffer.from(type, "ascii") : Buffer.from(type);
  if (typeBytes.byteLength !== 4) throw new Error("test PNG chunk type must contain four bytes");
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, output.length - 4)), output.length - 4);
  return output;
}

function makePng(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  interlace: number,
  raw: Uint8Array,
  beforeIdat: readonly Buffer[] = [],
): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    ...beforeIdat,
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

function fakeReader(batches: readonly FileSystemEntry[][]): FileSystemDirectoryReader {
  let offset = 0;
  return {
    readEntries(success) {
      const batch = batches[offset++] ?? [];
      queueMicrotask(() => success(batch));
    },
  };
}

let fakeFileReads = 0;

function fakeFile(name: string, bytes: readonly number[]): FileSystemFileEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file(success) {
      const data = Uint8Array.from(bytes);
      success({
        size: data.byteLength,
        arrayBuffer: async () => {
          fakeFileReads++;
          return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        },
      } as File);
    },
  } as FileSystemFileEntry;
}

function fakeDirectory(
  name: string,
  batches: readonly FileSystemEntry[][],
): FileSystemDirectoryEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => fakeReader(batches),
  } as FileSystemDirectoryEntry;
}

async function testSurfaces(): Promise<void> {
  const onePixel = { data: Uint8Array.of(10, 20, 30, 40), width: 1, height: 1 };
  assert.deepEqual(compareSurfaces(onePixel, onePixel), {
    pass: true,
    maxDiff: 0,
    badPixels: 0,
    catastrophicPixels: 0,
    largestCatastrophicRegion: 0,
    totalPixels: 1,
  });
  assert.throws(
    () =>
      compareSurfaces(onePixel, {
        data: new Uint8Array(8),
        width: 2,
        height: 1,
      }),
    /surface dimensions differ/,
  );
  assert.throws(
    () => compareSurfaces(onePixel, { data: new Uint8Array(3), width: 1, height: 1 }),
    /expected 4/,
  );

  // Sparse raster-edge outliers may fit the 99.9% population rule, while a
  // connected 3×3 catastrophic region must fail the §12 secondary guard.
  const reference = { data: new Uint8Array(100 * 100 * 4), width: 100, height: 100 };
  const atMax = { ...reference, data: new Uint8Array(reference.data) };
  atMax.data[0] = 16;
  assert.deepEqual(compareSurfaces(reference, atMax), {
    pass: true,
    maxDiff: 16,
    badPixels: 1,
    catastrophicPixels: 0,
    largestCatastrophicRegion: 0,
    totalPixels: 10_000,
  });
  const beyondMax = { ...reference, data: new Uint8Array(reference.data) };
  beyondMax.data[0] = 17;
  assert.deepEqual(compareSurfaces(reference, beyondMax), {
    pass: true,
    maxDiff: 17,
    badPixels: 1,
    catastrophicPixels: 1,
    largestCatastrophicRegion: 1,
    totalPixels: 10_000,
  });
  const region = { ...reference, data: new Uint8Array(reference.data) };
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 3; x++) region.data[(y * region.width + x) * 4] = 17;
  }
  assert.deepEqual(compareSurfaces(reference, region), {
    pass: false,
    maxDiff: 17,
    badPixels: 9,
    catastrophicPixels: 9,
    largestCatastrophicRegion: 9,
    totalPixels: 10_000,
  });

  const emission = compositeSurface(
    { data: Uint8Array.of(80, 0, 0, 0), width: 1, height: 1 },
    "dark",
  );
  assert.deepEqual([...emission], [110, 31, 38, 255]);
}

async function testDirectories(): Promise<void> {
  const entries = [fakeFile("a", [1]), fakeFile("b", [2]), fakeFile("c", [3])];
  assert.equal(
    (await readAllDirectoryEntries(fakeReader([[entries[0]!], [entries[1]!], []]))).length,
    2,
  );

  const nested = fakeDirectory("textures", [[entries[2]!], []]);
  const root = fakeDirectory("model.lyre", [[entries[0]!], [entries[1]!, nested], []]);
  fakeFileReads = 0;
  const source = await collectDroppedDirectory(root);
  const inventory = (await source.inventory()) as { files: { path: string; size: number }[] };
  assert.deepEqual(
    inventory.files.map((entry) => entry.path),
    ["a", "b", "textures/c"],
  );
  assert.equal(fakeFileReads, 0, "directory collection must not read opaque file bodies");
  assert.deepEqual([...(await source.read("textures/c", 1))], [3]);
  assert.equal(fakeFileReads, 1);

  const unsafe = fakeDirectory("model.lyre", [[fakeFile("..", [1])], []]);
  await assert.rejects(() => collectDroppedDirectory(unsafe), /unsafe dropped entry/);
  await assert.rejects(
    () =>
      readAllDirectoryEntries(
        fakeReader([
          Array.from({ length: RUNTIME_LIMITS.containerTraversalEntries + 1 }, () => entries[0]!),
        ]),
      ),
    /exceeds/,
  );
}

async function testTimelineAdmission(): Promise<void> {
  assert.equal(TESTBED_TIMELINE_LIMITS.jsonBytes, LIMITS.jsonFileBytes);
  assert.equal(TESTBED_TIMELINE_LIMITS.idLength, LIMITS.idLength);
  assert.equal(TESTBED_TIMELINE_LIMITS.params, LIMITS.params);
  assert.equal(TESTBED_TIMELINE_LIMITS.pathBytes, RUNTIME_LIMITS.containerPathBytes);

  const valid = parseTimelineValue({
    model: "../models/fixture.lyre",
    fps: 60,
    steps: 2,
    captures: [0, 1],
    events: [{ step: 0, set: { x: 1 } }],
  });
  assert.deepEqual(valid.captures, [0, 1]);
  assert.throws(
    () =>
      parseTimelineValue({
        model: "../models/fixture.lyre",
        fps: 60,
        steps: 1,
        captures: [Number.MAX_SAFE_INTEGER],
      }),
    /captures\[0\].*\[0, 1\)/,
  );
  assert.throws(
    () =>
      parseTimelineValue({
        model: "../models/fixture.lyre",
        fps: 60,
        steps: TESTBED_TIMELINE_LIMITS.steps + 1,
      }),
    /steps must be an integer/,
  );
  assert.throws(
    () =>
      parseTimelineValue({
        model: "../models/fixture.lyre",
        fps: 1e-307,
        steps: TESTBED_TIMELINE_LIMITS.steps,
      }),
    /finite timeline duration/,
  );
  assert.throws(
    () =>
      parseTimelineValue({
        model: "../models/fixture.lyre",
        fps: 60,
        steps: 1,
        events: [{ step: 0, set: { x: 1 }, clear: ["x"] }],
      }),
    /exactly one/,
  );
  assert.throws(
    () => parseTimelineText('{"model":"a","fps":60,"fps":1,"steps":1}', "duplicate.timeline.json"),
    /duplicate JSON object member "fps"/,
  );

  const timelinesDir = join(repoRoot, "conformance", "timelines");
  for (const file of readdirSync(timelinesDir).filter((name) => name.endsWith(".timeline.json"))) {
    parseTimelineText(readFileSync(join(timelinesDir, file), "utf8"), file);
  }
}

function testServerLimitParity(): void {
  assert.equal(TESTBED_SERVER_LIMITS.containerFiles, LIMITS.containerFiles);
  assert.equal(TESTBED_SERVER_LIMITS.containerUncompressedBytes, LIMITS.containerUncompressedBytes);
  assert.equal(TESTBED_SERVER_LIMITS.jsonFileBytes, LIMITS.jsonFileBytes);
  assert.equal(
    TESTBED_SERVER_LIMITS.containerTraversalEntries,
    RUNTIME_LIMITS.containerTraversalEntries,
  );
  assert.equal(TESTBED_SERVER_LIMITS.containerPathBytes, RUNTIME_LIMITS.containerPathBytes);
  assert.equal(
    TESTBED_SERVER_LIMITS.containerPathMetadataBytes,
    RUNTIME_LIMITS.containerPathMetadataBytes,
  );
}

function testWorkerFrameIdentity(): void {
  const geometry = (id: string) => ({
    sprite: { id },
    texture: "texture",
    positions: Float64Array.of(0, 0, 1, 0, 0, 1),
    uvs: Float64Array.of(0, 0, 1, 0, 0, 1),
    indices: Uint32Array.of(0, 1, 2),
  });
  const draw = {
    ...geometry("draw_sprite"),
    opacity: 1,
    blend: "normal" as const,
    effectiveZ: 0,
    mask: { mode: "alpha" as const, group: 0 },
  };
  const mask = geometry("mask_sprite");
  const stripped = stripFrame({
    canvas: { width: 1, height: 1 },
    drawList: [draw],
    maskGroups: [{ sources: [mask] }],
  } as unknown as EvalFrame);

  assert.equal(stripped.drawList[0]?.sprite.id, "draw_sprite");
  assert.equal(stripped.maskGroups[0]?.sources[0]?.sprite.id, "mask_sprite");
  assert.notEqual(stripped.drawList[0]?.sprite, draw.sprite);
  assert.notEqual(stripped.maskGroups[0]?.sources[0]?.sprite, mask.sprite);
}

async function testContainerSafety(): Promise<void> {
  const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
  await assert.rejects(
    () => loadContainerFrom(mapSource(new Map([["manifest.json", Uint8Array.of(0xff)]]))),
    /encoded data|UTF-8/i,
  );

  const duplicateManifest = new TextEncoder().encode(
    '{"lyre":"0.1","id":"first","\\u0069d":"second"}',
  );
  await assert.rejects(
    () => loadContainerFrom(mapSource(new Map([["manifest.json", duplicateManifest]]))),
    /duplicate JSON object member "id"/,
  );

  const manifest = {
    lyre: "0.1",
    id: "unsafe",
    canvas: { width: 1, height: 1, origin: [0, 0] },
    files: { rig: "../rig.json" },
  };
  await assert.rejects(
    () =>
      loadContainerFrom(
        mapSource(
          new Map([
            ["manifest.json", encode(manifest)],
            ["../rig.json", encode({ params: [], nodes: [], bindings: [] })],
          ]),
        ),
      ),
    /unsafe container path/,
  );

  let readOversizedSource = false;
  await assert.rejects(
    () =>
      loadContainerFrom({
        inventory: async () => ({
          files: [
            {
              path: "opaque/source.bin",
              size: LIMITS.containerUncompressedBytes + 1,
            },
          ],
        }),
        read: async () => {
          readOversizedSource = true;
          return new Uint8Array();
        },
      }),
    /uncompressed bytes/,
  );
  assert.equal(readOversizedSource, false, "oversized inventory must fail before reading a file");

  let oversizedJsonReads = 0;
  await assert.rejects(
    () =>
      loadContainerFrom({
        inventory: async () => ({
          files: [{ path: "manifest.json", size: LIMITS.jsonFileBytes + 1 }],
        }),
        read: async () => {
          oversizedJsonReads++;
          return new Uint8Array();
        },
      }),
    /JSON bytes/,
  );
  assert.equal(oversizedJsonReads, 0, "declared oversized JSON must not be read");

  const aggregateManifest = encode({
    lyre: "0.1",
    id: "aggregate",
    canvas: { width: 1, height: 1, origin: [0, 0] },
    capabilities: ["core", "physics"],
    files: { rig: "rig.json", physics: "physics.json" },
  });
  const aggregateReads: string[] = [];
  await assert.rejects(
    () =>
      loadContainerFrom({
        inventory: async () => ({
          files: [
            { path: "manifest.json", size: aggregateManifest.byteLength },
            { path: "rig.json", size: LIMITS.jsonDocumentsBytes / 2 },
            { path: "physics.json", size: LIMITS.jsonDocumentsBytes / 2 },
          ],
        }),
        read: async (path) => {
          aggregateReads.push(path);
          if (path === "manifest.json") return aggregateManifest;
          throw new Error(`unexpected read of ${path}`);
        },
      }),
    /manifest-listed JSON exceeds/,
  );
  assert.deepEqual(
    aggregateReads,
    ["manifest.json"],
    "aggregate JSON sizes must be checked before dependent documents are read",
  );

  const textureManifest = encode({
    lyre: "0.1",
    id: "texture_limit",
    canvas: { width: 1, height: 1, origin: [0, 0] },
    files: { rig: "rig.json" },
  });
  const textureRig = encode({
    params: [],
    nodes: [
      {
        id: "root",
        type: "group",
        children: [{ id: "s", type: "sprite", rect: [0, 0, 1, 1] }],
      },
    ],
    bindings: [],
  });
  const textureReads: string[] = [];
  await assert.rejects(
    () =>
      loadContainerFrom({
        inventory: async () => ({
          files: [
            { path: "manifest.json", size: textureManifest.byteLength },
            { path: "rig.json", size: textureRig.byteLength },
            { path: "textures/s.png", size: LIMITS.textureFileBytes + 1 },
          ],
        }),
        read: async (path) => {
          textureReads.push(path);
          if (path === "manifest.json") return textureManifest;
          if (path === "rig.json") return textureRig;
          throw new Error(`unexpected read of ${path}`);
        },
      }),
    /PNG bytes/,
  );
  assert.deepEqual(
    textureReads,
    ["manifest.json", "rig.json"],
    "declared oversized PNG must not be read",
  );

  const longPaths = Array.from(
    { length: 1_025 },
    (_, index) => `docs/${index}_${"x".repeat(4_080)}.json`,
  );
  const pathManifest = encode({
    lyre: "0.1",
    id: "path_metadata",
    canvas: { width: 1, height: 1, origin: [0, 0] },
    files: { rig: "rig.json", expressions: longPaths, motions: longPaths },
  });
  const pathFiles = new Map<string, Uint8Array>([
    ["manifest.json", pathManifest],
    ["rig.json", encode({ params: [], nodes: [], bindings: [] })],
    ...longPaths.map((path) => [path, encode({})] as const),
  ]);
  const mappedPaths = mapSource(pathFiles);
  const pathReads: string[] = [];
  await assert.rejects(
    () =>
      loadContainerFrom({
        inventory: () => mappedPaths.inventory(),
        read: async (path) => {
          pathReads.push(path);
          return mappedPaths.read(path);
        },
      }),
    /manifest file paths exceed.*metadata bytes/,
  );
  assert.deepEqual(
    pathReads,
    ["manifest.json"],
    "manifest path occurrences must be bounded before listed documents are read",
  );

  await assert.rejects(
    () =>
      loadContainerFrom({
        inventory: async () => ({
          files: Array.from({ length: LIMITS.containerFiles + 1 }, (_, index) => ({
            path: `opaque/${index}.bin`,
            size: 0,
          })),
        }),
        read: async () => new Uint8Array(),
      }),
    /regular files/,
  );

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(Uint8Array.of(1, 2, 3, 4, 5), {
        headers: { "content-length": "5" },
      });
    await assert.rejects(
      () => devApiSource("model.lyre").read("rig.json", 4),
      /changed size after inventory/,
    );

    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.of(1, 2, 3, 4, 5));
            controller.close();
          },
        }),
      );
    await assert.rejects(
      () => devApiSource("model.lyre").read("rig.json", 4),
      /grew past its 4-byte limit/,
    );

    globalThis.fetch = async () =>
      new Response('{"files":[],"files":[]}', {
        headers: { "content-type": "application/json" },
      });
    await assert.rejects(
      () => devApiSource("model.lyre").inventory(),
      /duplicate JSON object member "files"/,
    );

    globalThis.fetch = async () =>
      new Response(null, {
        headers: { "content-length": String(LIMITS.jsonFileBytes + 1) },
      });
    await assert.rejects(
      () => devApiSource("model.lyre").inventory(),
      /container inventory exceeds/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testPngLayouts(): Promise<void> {
  const rgba = await decodePng(
    makePng(2, 1, 8, 6, 0, Uint8Array.of(0, 1, 2, 3, 4, 250, 251, 252, 253)),
  );
  assert.deepEqual([...rgba.data], [1, 2, 3, 4, 250, 251, 252, 253]);

  const rgb = await decodePng(makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 7, 8, 9)));
  assert.deepEqual([...rgb.data], [7, 8, 9, 255]);

  const palette = chunk("PLTE", Uint8Array.of(10, 20, 30, 40, 50, 60));
  const alpha = chunk("tRNS", Uint8Array.of(255, 0));
  const indexed = await decodePng(
    makePng(2, 1, 1, 3, 0, Uint8Array.of(0, 0b0100_0000), [palette, alpha]),
  );
  assert.deepEqual([...indexed.data], [10, 20, 30, 255, 40, 50, 60, 0]);

  const grayscale = await decodePng(makePng(2, 1, 1, 0, 0, Uint8Array.of(0, 0b0100_0000)));
  assert.deepEqual([...grayscale.data], [0, 0, 0, 255, 255, 255, 255, 255]);

  const gamma = Buffer.alloc(4);
  gamma.writeUInt32BE(45_455);
  const ignoredMetadata = await decodePng(
    makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 7, 8, 9), [
      chunk("cHRM", new Uint8Array(32)),
      chunk("gAMA", gamma),
      chunk("sRGB", Uint8Array.of(0)),
    ]),
  );
  assert.deepEqual([...ignoredMetadata.data], [7, 8, 9, 255]);

  const profile = Buffer.concat([
    Buffer.from("test profile\0", "latin1"),
    Buffer.from([0]),
    deflateSync(Buffer.from("ignored ICC profile")),
  ]);
  const ignoredProfile = await decodePng(
    makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 7, 8, 9), [chunk("iCCP", profile)]),
  );
  assert.deepEqual([...ignoredProfile.data], [7, 8, 9, 255]);
  const opaqueProfile = await decodePng(
    makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 7, 8, 9), [
      chunk("iCCP", Buffer.from("opaque profile\0\0not-a-zlib-stream", "latin1")),
    ]),
  );
  assert.deepEqual([...opaqueProfile.data], [7, 8, 9, 255]);

  const width = 3;
  const height = 3;
  const expected = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      expected.set([x * 50, y * 60, x + y, 255], (y * width + x) * 4);
    }
  }
  const interlacedRaw: number[] = [];
  for (const pass of ADAM7) {
    const passWidth = width <= pass.x ? 0 : Math.ceil((width - pass.x) / pass.dx);
    const passHeight = height <= pass.y ? 0 : Math.ceil((height - pass.y) / pass.dy);
    if (passWidth === 0 || passHeight === 0) continue;
    for (let py = 0; py < passHeight; py++) {
      interlacedRaw.push(0);
      for (let px = 0; px < passWidth; px++) {
        const x = pass.x + px * pass.dx;
        const y = pass.y + py * pass.dy;
        interlacedRaw.push(...expected.subarray((y * width + x) * 4, (y * width + x + 1) * 4));
      }
    }
  }
  const interlaced = await decodePng(
    makePng(width, height, 8, 6, 1, Uint8Array.from(interlacedRaw)),
  );
  assert.deepEqual(interlaced.data, expected);

  const corrupt = makePng(1, 1, 8, 6, 0, Uint8Array.of(0, 1, 2, 3, 4));
  corrupt[20] = corrupt[20]! ^ 1;
  await assert.rejects(() => decodePng(corrupt), /invalid CRC/);

  await assert.rejects(
    () =>
      decodePng(
        makePng(LIMITS.textureDimension, LIMITS.textureDimension, 8, 6, 0, new Uint8Array()),
      ),
    /decoded pixels/,
  );
  await assert.rejects(
    () => decodePng(makePng(2, 1, 8, 6, 0, Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8)), 1),
    /decoded-pixel budget/,
  );
  await assert.rejects(
    () => decodePng(makePng(1, 1, 8, 6, 0, new Uint8Array(1024))),
    /inflates past/,
  );

  await assert.rejects(
    () =>
      decodePng(
        makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 1, 2, 3), [
          chunk("tRNS", Uint8Array.of(0, 1, 0, 2, 0, 3)),
          chunk("PLTE", Uint8Array.of(10, 20, 30)),
        ]),
      ),
    /PLTE appears after tRNS/,
  );
  const emptyIndexedTransparency = await decodePng(
    makePng(1, 1, 1, 3, 0, Uint8Array.of(0, 0), [
      chunk("PLTE", Uint8Array.of(10, 20, 30)),
      chunk("tRNS", new Uint8Array()),
    ]),
  );
  assert.deepEqual(emptyIndexedTransparency.data, Uint8Array.of(10, 20, 30, 255));

  const maskedGrayscaleTransparency = await decodePng(
    makePng(1, 1, 8, 0, 0, Uint8Array.of(0, 10), [chunk("tRNS", Uint8Array.of(0x12, 10))]),
  );
  assert.deepEqual(maskedGrayscaleTransparency.data, Uint8Array.of(0, 0, 0, 0));

  const maskedRgbTransparency = await decodePng(
    makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 10, 20, 30), [
      chunk("tRNS", Uint8Array.of(0x12, 10, 0x34, 20, 0x56, 30)),
    ]),
  );
  assert.deepEqual(maskedRgbTransparency.data, Uint8Array.of(0, 0, 0, 0));
  await assert.rejects(
    () =>
      decodePng(
        makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 1, 2, 3), [chunk("ab1D", new Uint8Array())]),
      ),
    /invalid chunk type/,
  );
  await assert.rejects(
    () =>
      decodePng(
        makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 1, 2, 3), [chunk("abcD", new Uint8Array())]),
      ),
    /invalid reserved bit/,
  );
  await assert.rejects(
    () =>
      decodePng(
        makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 1, 2, 3), [
          chunk(Uint8Array.of(0xe1, 0x42, 0x43, 0x44), new Uint8Array()),
        ]),
      ),
    /invalid chunk type/,
  );
  await assert.rejects(
    () =>
      decodePng(
        makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 1, 2, 3), [chunk("gAMA", new Uint8Array())]),
      ),
    /gAMA must contain/,
  );
  await assert.rejects(
    () =>
      decodePng(
        makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 1, 2, 3), [
          chunk("gAMA", gamma),
          chunk("gAMA", gamma),
        ]),
      ),
    /multiple gAMA/,
  );
  await assert.rejects(
    () =>
      decodePng(
        makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 1, 2, 3), [
          chunk("PLTE", Uint8Array.of(10, 20, 30)),
          chunk("gAMA", gamma),
        ]),
      ),
    /gAMA appears after PLTE/,
  );
  await assert.rejects(
    () =>
      decodePng(
        makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 1, 2, 3), [chunk("cHRM", new Uint8Array(31))]),
      ),
    /cHRM must contain 32/,
  );
  await assert.rejects(
    () =>
      decodePng(
        makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 1, 2, 3), [chunk("sRGB", Uint8Array.of(4))]),
      ),
    /rendering-intent/,
  );
  await assert.rejects(
    () =>
      decodePng(
        makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 1, 2, 3), [
          chunk("iCCP", Buffer.from("missing separators")),
        ]),
      ),
    /profile name|compression method/,
  );
  await decodePng(
    makePng(1, 1, 8, 2, 0, Uint8Array.of(0, 1, 2, 3), [
      chunk("sRGB", Uint8Array.of(0)),
      chunk("iCCP", profile),
    ]),
  );
}

function findPngs(directory: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...findPngs(path));
    else if (entry.name.endsWith(".png")) paths.push(path);
  }
  return paths;
}

async function testCorpusPngs(): Promise<void> {
  const paths = [
    ...findPngs(join(repoRoot, "examples")),
    ...findPngs(join(repoRoot, "conformance")),
  ];
  assert(paths.length > 0, "expected PNG fixtures in the repository");
  for (const path of paths) {
    const bytes = readFileSync(path);
    const expected = PNG.sync.read(bytes);
    const actual = await decodePng(bytes);
    assert.equal(actual.width, expected.width, path);
    assert.equal(actual.height, expected.height, path);
    assert(Buffer.from(actual.data).equals(expected.data), `${path}: decoded pixels differ`);
  }
}

await testSurfaces();
await testDirectories();
await testTimelineAdmission();
testServerLimitParity();
testWorkerFrameIdentity();
await testContainerSafety();
await testPngLayouts();
await testCorpusPngs();
console.log("testbed unit: all checks passed");
