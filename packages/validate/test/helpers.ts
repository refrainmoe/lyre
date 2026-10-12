// Shared fixture builders: minimal valid containers written to a temp dir,
// mutated per test case, plus hand-crafted ZIPs for §16 attack fixtures.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import { afterEach } from "vitest";

const temporaryDirectories = new Set<string>();

afterEach(() => {
  // Some fixtures are renamed or nested below another tracked fixture during
  // a test. Removing deepest paths first makes cleanup deterministic in both
  // cases; force handles sources that were already moved.
  for (const directory of [...temporaryDirectories].sort((a, b) => b.length - a.length)) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

export function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "lyre-validate-"));
  temporaryDirectories.add(directory);
  return directory;
}

export function pngBuffer(width: number, height: number, rgba = [200, 60, 60, 255]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgba[0]!;
    png.data[i * 4 + 1] = rgba[1]!;
    png.data[i * 4 + 2] = rgba[2]!;
    png.data[i * 4 + 3] = rgba[3]!;
  }
  return PNG.sync.write(png, { deflateLevel: 9, filterType: 0 });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface FixtureDocs {
  manifest: any;
  rig: any;
  physics?: any;
  variants?: any;
  atlas?: any;
  expressions?: Record<string, any>;
  motions?: Record<string, any>;
  /** path (relative to container root) → bytes */
  extraFiles?: Record<string, Buffer>;
  textures?: Record<string, Buffer>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Minimal valid model: one 16×16 sprite on a 32×32 canvas. */
export function baseDocs(): FixtureDocs {
  return {
    manifest: {
      lyre: "0.1",
      id: "fixture",
      canvas: { width: 32, height: 32, origin: [0, 0] },
      capabilities: ["core"],
      files: { rig: "rig.json" },
    },
    rig: {
      params: [],
      nodes: [
        {
          id: "root",
          type: "group",
          children: [{ id: "s", type: "sprite", rect: [0, 0, 16, 16], z: 10 }],
        },
      ],
      bindings: [],
    },
    textures: { s: pngBuffer(16, 16) },
  };
}

/** Write a fixture container into a fresh temp dir; returns its path. */
export function writeFixture(docs: FixtureDocs): string {
  const dir = tempDir();
  const files = docs.manifest?.files ?? {};

  const put = (rel: string, content: Buffer | string): void => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };

  put("manifest.json", JSON.stringify(docs.manifest, null, 2));
  put(typeof files.rig === "string" ? files.rig : "rig.json", JSON.stringify(docs.rig, null, 2));
  if (docs.physics !== undefined) {
    files.physics ??= "physics.json";
    put(files.physics, JSON.stringify(docs.physics, null, 2));
  }
  if (docs.variants !== undefined) {
    files.variants ??= "variants.json";
    put(files.variants, JSON.stringify(docs.variants, null, 2));
  }
  if (docs.atlas !== undefined) {
    files.atlas ??= "atlas.json";
    put(files.atlas, JSON.stringify(docs.atlas, null, 2));
  }
  if (docs.expressions) {
    files.expressions = Object.keys(docs.expressions).map((id) => `expressions/${id}.exp.json`);
    for (const [id, doc] of Object.entries(docs.expressions)) {
      put(`expressions/${id}.exp.json`, JSON.stringify(doc, null, 2));
    }
  }
  if (docs.motions) {
    files.motions = Object.keys(docs.motions).map((id) => `motions/${id}.motion.json`);
    for (const [id, doc] of Object.entries(docs.motions)) {
      put(`motions/${id}.motion.json`, JSON.stringify(doc, null, 2));
    }
  }
  // Rewrite the manifest in case files.* were filled in above.
  put("manifest.json", JSON.stringify(docs.manifest, null, 2));

  for (const [id, bytes] of Object.entries(docs.textures ?? {})) {
    put(`textures/${id}.png`, bytes);
  }
  for (const [rel, bytes] of Object.entries(docs.extraFiles ?? {})) {
    put(rel, bytes);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Hand-crafted ZIP writer (stored entries only) — full control over entry
// names, unix modes, and declared sizes for §16 attack fixtures.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface RawZipEntry {
  name: string;
  data: Buffer;
  /** Unix mode for external attrs (e.g. 0o120777 marks a symlink). */
  mode?: number;
  /** Override the declared uncompressed size (lying-header fixtures). */
  declaredSize?: number;
}

/** Build a ZIP (method 0, no compression) byte-for-byte by hand. */
export function rawZip(entries: RawZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const declared = e.declaredSize ?? e.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // mtime
    local.writeUInt16LE(0x21, 12); // mdate (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18); // compressed size
    local.writeUInt32LE(declared, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, e.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4); // made by unix
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(e.data.length, 20);
    cd.writeUInt32LE(declared, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + e.data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

/** All files of a fixture dir as raw ZIP entries (packed `.lyre` shape). */
export function fixtureZipEntries(docs: FixtureDocs): RawZipEntry[] {
  const dir = writeFixture(docs);
  // Re-read what writeFixture produced so ZIP and dir fixtures stay identical.
  const entries: RawZipEntry[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(relPath);
      else entries.push({ name: relPath, data: readFileSync(join(dir, relPath)) });
    }
  };
  walk("");
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}
