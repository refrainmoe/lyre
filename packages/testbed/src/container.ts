// Browser-side container loading: fetches the raw JSON documents and PNG
// textures of an unpacked .lyre directory (dev API or dropped folder) and
// produces the same shapes the Node loaders use.

import {
  LIMITS,
  RUNTIME_LIMITS,
  loadModel,
  parseLyreJson,
  premultiplyStraightRGBA8,
  type Model,
  type ModelFiles,
  type PremultipliedImage,
} from "@refrain-lyre/core";
import { decodePng } from "./png.js";

interface SourceInventoryEntry {
  path: string;
  size: number;
}

interface SourceInventory {
  files: SourceInventoryEntry[];
}

/** Async byte access plus a complete regular-file inventory for a container root. */
export interface ByteSource {
  /** Read exactly the inventoried byte count without buffering past it. */
  read(rel: string, expectedBytes?: number): Promise<Uint8Array>;
  inventory(): Promise<unknown>;
}

interface InventoryReader {
  read(rel: string): Promise<Uint8Array>;
  size(rel: string): number;
}

export interface BrowserContainer {
  model: Model;
  textures: Map<string, PremultipliedImage>;
  atlasImage: PremultipliedImage | null;
  raw: ModelFiles;
}

/** Stream an HTTP response into a bounded buffer, optionally requiring an exact size. */
export async function readBoundedResponse(
  res: Response,
  label: string,
  maxBytes: number,
  expectedBytes?: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`invalid byte limit for ${label}`);
  }
  if (
    expectedBytes !== undefined &&
    (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes)
  ) {
    throw new Error(`invalid expected byte count for ${label}`);
  }
  const declaredHeader = res.headers.get("content-length");
  const declared = declaredHeader === null ? undefined : Number(declaredHeader);
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 0)) {
    throw new Error(`invalid content-length for ${label}`);
  }
  if (declared !== undefined && declared > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} encoded bytes`);
  }
  if (expectedBytes !== undefined && declared !== undefined && declared !== expectedBytes) {
    throw new Error(
      `${label} changed size after inventory (${expectedBytes} to ${declaredHeader} bytes)`,
    );
  }
  const exactBytes = expectedBytes ?? declared;
  if (!res.body) {
    if (exactBytes === 0) return new Uint8Array();
    throw new Error(`${label} response has no body`);
  }

  const output = exactBytes === undefined ? null : new Uint8Array(exactBytes);
  const chunks: Uint8Array[] = [];
  const reader = res.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = (exactBytes ?? maxBytes) - offset;
      if (value.byteLength > remaining) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the deterministic size error.
        }
        throw new Error(`${label} grew past its ${exactBytes ?? maxBytes}-byte limit`);
      }
      if (output) output.set(value, offset);
      else chunks.push(value);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (exactBytes !== undefined && offset !== exactBytes) {
    throw new Error(`${label} changed size (${exactBytes} to ${offset} bytes)`);
  }
  if (output) return output;
  const combined = new Uint8Array(offset);
  let chunkOffset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, chunkOffset);
    chunkOffset += chunk.byteLength;
  }
  return combined;
}

export function devApiSource(modelPath: string): ByteSource {
  return {
    async read(rel, expectedBytes) {
      const res = await fetch(`/__lyre/file?path=${encodeURIComponent(`${modelPath}/${rel}`)}`);
      if (!res.ok) throw new Error(`container is missing "${rel}"`);
      if (expectedBytes === undefined) {
        throw new Error(`an expected byte count is required for "${rel}"`);
      }
      return readBoundedResponse(
        res,
        `container file "${rel}"`,
        LIMITS.containerUncompressedBytes,
        expectedBytes,
      );
    },
    async inventory() {
      const res = await fetch(`/__lyre/inventory?path=${encodeURIComponent(modelPath)}`);
      if (!res.ok) {
        const detailBytes = await readBoundedResponse(res, "container inventory error", 64 * 1024);
        const detail = decoder.decode(detailBytes).trim();
        throw new Error(
          detail.length > 0
            ? `could not inspect container: ${detail}`
            : `could not inspect container (${res.status})`,
        );
      }
      const bytes = await readBoundedResponse(res, "container inventory", LIMITS.jsonFileBytes);
      return parseLyreJson(decoder.decode(bytes), "container inventory");
    },
  };
}

/** Source over an in-memory file map (directory drag & drop). */
export function mapSource(files: Map<string, Uint8Array>): ByteSource {
  return {
    async read(rel, expectedBytes) {
      const bytes = files.get(rel);
      if (!bytes) throw new Error(`container is missing "${rel}"`);
      expectedBytes ??= bytes.byteLength;
      if (bytes.byteLength !== expectedBytes) {
        throw new Error(
          `container file "${rel}" changed size after inventory (${expectedBytes} to ${bytes.byteLength} bytes)`,
        );
      }
      return bytes;
    },
    async inventory(): Promise<SourceInventory> {
      return {
        files: [...files].map(([path, bytes]) => ({ path, size: bytes.byteLength })),
      };
    },
  };
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function checkContainerPath(path: string): void {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    /^([a-zA-Z]:|[\\/])/.test(path) ||
    path.split(/[\\/]/).some((segment) => segment === "..")
  ) {
    throw new Error(`unsafe container path "${path}"`);
  }
  if (encoder.encode(path).byteLength > RUNTIME_LIMITS.containerPathBytes) {
    throw new Error(`container path exceeds ${RUNTIME_LIMITS.containerPathBytes} bytes`);
  }
}

async function readJson(source: InventoryReader, rel: string): Promise<unknown> {
  if (source.size(rel) > LIMITS.jsonFileBytes) {
    throw new Error(`"${rel}" exceeds ${LIMITS.jsonFileBytes} JSON bytes`);
  }
  const bytes = await source.read(rel);
  return parseLyreJson(decoder.decode(bytes), `"${rel}"`);
}

async function readImage(
  source: InventoryReader,
  rel: string,
  pixelBudget: number,
): Promise<PremultipliedImage> {
  if (source.size(rel) > LIMITS.textureFileBytes) {
    throw new Error(`"${rel}" exceeds ${LIMITS.textureFileBytes} PNG bytes`);
  }
  const png = await decodePng(await source.read(rel), pixelBudget);
  return { width: png.width, height: png.height, data: premultiplyStraightRGBA8(png.data) };
}

export async function loadContainerFrom(source: ByteSource): Promise<BrowserContainer> {
  const inventoryValue = await source.inventory();
  if (
    typeof inventoryValue !== "object" ||
    inventoryValue === null ||
    Array.isArray(inventoryValue) ||
    !Array.isArray((inventoryValue as { files?: unknown }).files)
  ) {
    throw new Error("container inventory must contain a files array");
  }
  const inventoryEntries = (inventoryValue as { files: unknown[] }).files;
  if (inventoryEntries.length > LIMITS.containerFiles) {
    throw new Error(`container exceeds ${LIMITS.containerFiles} regular files`);
  }
  const inventory = new Map<string, number>();
  let totalBytes = 0;
  let totalPathBytes = 0;
  for (const value of inventoryEntries) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("container inventory entries must be objects");
    }
    const { path, size } = value as { path?: unknown; size?: unknown };
    if (typeof path !== "string") throw new Error("container inventory path must be a string");
    checkContainerPath(path);
    if (!Number.isSafeInteger(size) || (size as number) < 0) {
      throw new Error(`container inventory size for "${path}" must be a non-negative safe integer`);
    }
    if (inventory.has(path))
      throw new Error(`container inventory contains duplicate path "${path}"`);
    const pathBytes = encoder.encode(path).byteLength;
    if (pathBytes > RUNTIME_LIMITS.containerPathMetadataBytes - totalPathBytes) {
      throw new Error(
        `container paths exceed ${RUNTIME_LIMITS.containerPathMetadataBytes} metadata bytes`,
      );
    }
    totalPathBytes += pathBytes;
    if ((size as number) > LIMITS.containerUncompressedBytes - totalBytes) {
      throw new Error(`container exceeds ${LIMITS.containerUncompressedBytes} uncompressed bytes`);
    }
    totalBytes += size as number;
    inventory.set(path, size as number);
  }

  const size = (rel: string): number => {
    checkContainerPath(rel);
    const expectedSize = inventory.get(rel);
    if (expectedSize === undefined) throw new Error(`container is missing "${rel}"`);
    return expectedSize;
  };
  const inventoryReader: InventoryReader = {
    size,
    async read(rel) {
      const expectedSize = size(rel);
      const bytes = await source.read(rel, expectedSize);
      if (bytes.byteLength !== expectedSize) {
        throw new Error(
          `container file "${rel}" changed size after inventory (${expectedSize} to ${bytes.byteLength} bytes)`,
        );
      }
      return bytes;
    },
  };

  const manifestValue = await readJson(inventoryReader, "manifest.json");
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
  let manifestPathMetadataBytes = encoder.encode("manifest.json").byteLength;
  const accountManifestPath = (path: string): void => {
    checkContainerPath(path);
    const pathBytes = encoder.encode(path).byteLength;
    if (pathBytes > RUNTIME_LIMITS.containerPathMetadataBytes - manifestPathMetadataBytes) {
      throw new Error(
        `manifest file paths exceed ${RUNTIME_LIMITS.containerPathMetadataBytes} metadata bytes`,
      );
    }
    manifestPathMetadataBytes += pathBytes;
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
    if (Array.isArray(value) && value.length > LIMITS.containerFiles) {
      throw new Error(`manifest.files.${key} exceeds ${LIMITS.containerFiles} paths`);
    }
    if (
      !Array.isArray(value) ||
      value.some((path) => typeof path !== "string" || path.length === 0)
    ) {
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
    throw new Error(`manifest lists more than ${LIMITS.containerFiles} distinct JSON documents`);
  }
  let listedJsonBytes = 0;
  for (const path of jsonPaths) {
    const declaredSize = size(path);
    if (declaredSize > LIMITS.jsonFileBytes) {
      throw new Error(`"${path}" exceeds ${LIMITS.jsonFileBytes} JSON bytes`);
    }
    if (declaredSize > LIMITS.jsonDocumentsBytes - listedJsonBytes) {
      throw new Error(`manifest-listed JSON exceeds ${LIMITS.jsonDocumentsBytes} aggregate bytes`);
    }
    listedJsonBytes += declaredSize;
  }
  const jsonCache = new Map<string, unknown>([["manifest.json", manifest]]);
  const cachedJson = async (path: string): Promise<unknown> => {
    if (jsonCache.has(path)) return jsonCache.get(path);
    const value = await readJson(inventoryReader, path);
    jsonCache.set(path, value);
    return value;
  };

  const raw: ModelFiles = {
    manifest,
    rig: await cachedJson(rigPath),
  };
  if (physicsPath) raw.physics = await cachedJson(physicsPath);
  if (variantsPath) raw.variants = await cachedJson(variantsPath);
  if (atlasPath) raw.atlas = await cachedJson(atlasPath);
  if (expressionPaths) {
    const expressions = Object.create(null) as Record<string, unknown>;
    for (const path of expressionPaths) expressions[path] = await cachedJson(path);
    raw.expressions = expressions;
  }
  if (motionPaths) {
    const motions = Object.create(null) as Record<string, unknown>;
    for (const path of motionPaths) motions[path] = await cachedJson(path);
    raw.motions = motions;
  }

  const model = loadModel(raw);

  const textures = new Map<string, PremultipliedImage>();
  let decodedPixels = 0;
  for (const sprite of model.sprites) {
    if (!textures.has(sprite.texture)) {
      const image = await readImage(
        inventoryReader,
        `textures/${sprite.texture}.png`,
        LIMITS.totalTexturePixels - decodedPixels,
      );
      decodedPixels += image.width * image.height;
      if (decodedPixels > LIMITS.totalTexturePixels) {
        throw new Error(`textures exceed ${LIMITS.totalTexturePixels} aggregate decoded pixels`);
      }
      textures.set(sprite.texture, image);
    }
  }
  const atlasImage = model.atlas
    ? await readImage(inventoryReader, model.atlas.image, LIMITS.totalTexturePixels - decodedPixels)
    : null;
  if (atlasImage) {
    decodedPixels += atlasImage.width * atlasImage.height;
    if (decodedPixels > LIMITS.totalTexturePixels) {
      throw new Error(`textures exceed ${LIMITS.totalTexturePixels} aggregate decoded pixels`);
    }
    for (const [id, [x, y, width, height]] of model.atlas!.rects) {
      if (x + width > atlasImage.width || y + height > atlasImage.height) {
        throw new Error(`atlas rect for "${id}" falls outside ${model.atlas!.image}`);
      }
      const texture = textures.get(id);
      if (!texture) continue;
      if (width !== texture.width || height !== texture.height) {
        throw new Error(
          `atlas rect for "${id}" is ${width}×${height}, but its per-file texture is ${texture.width}×${texture.height}`,
        );
      }
      for (let row = 0; row < height; row++) {
        let atlasOffset = ((y + row) * atlasImage.width + x) * 4;
        let textureOffset = row * texture.width * 4;
        const end = textureOffset + width * 4;
        while (textureOffset < end) {
          if (atlasImage.data[atlasOffset++] !== texture.data[textureOffset++]) {
            throw new Error(`atlas rect for "${id}" does not match its per-file texture pixels`);
          }
        }
      }
    }
  }
  return { model, textures, atlasImage, raw };
}
