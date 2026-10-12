// Exact, browser-safe PNG decoder. Native <img>/canvas decoding can apply
// color conversion and premultiplication with implementation-defined
// rounding, so the testbed decodes stored samples directly.

import { LIMITS, RUNTIME_LIMITS } from "@refrain-lyre/core";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS = new Map([
  [0, 1], // grayscale
  [2, 3], // RGB
  [3, 1], // palette index
  [4, 2], // grayscale + alpha
  [6, 4], // RGBA
]);
const VALID_DEPTHS = new Map<number, readonly number[]>([
  [0, [1, 2, 4, 8, 16]],
  [2, [8, 16]],
  [3, [1, 2, 4, 8]],
  [4, [8, 16]],
  [6, [8, 16]],
]);
const ADAM7 = [
  { x: 0, y: 0, dx: 8, dy: 8 },
  { x: 4, y: 0, dx: 8, dy: 8 },
  { x: 0, y: 4, dx: 4, dy: 8 },
  { x: 2, y: 0, dx: 4, dy: 4 },
  { x: 0, y: 2, dx: 2, dy: 4 },
  { x: 1, y: 0, dx: 2, dy: 2 },
  { x: 0, y: 1, dx: 1, dy: 2 },
] as const;

export interface DecodedPng {
  width: number;
  height: number;
  /** Straight (non-premultiplied) RGBA8. */
  data: Uint8Array;
}

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  channels: number;
  interlace: number;
}

let crcTable: Uint32Array | undefined;

function chunkCrc(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let value = n;
      for (let k = 0; k < 8; k++) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[n] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validateIccProfileChunk(bytes: Uint8Array, start: number, end: number): void {
  let separator = -1;
  for (let i = start; i < end; i++) {
    if (bytes[i] === 0) {
      separator = i;
      break;
    }
  }
  const keywordLength = separator - start;
  if (keywordLength < 1 || keywordLength > 79) {
    throw new Error("PNG iCCP profile name must contain 1..79 bytes");
  }
  let previousSpace = true;
  for (let i = start; i < separator; i++) {
    const byte = bytes[i]!;
    const printableLatin1 = (byte >= 32 && byte <= 126) || byte >= 161;
    if (!printableLatin1 || (byte === 32 && previousSpace)) {
      throw new Error("PNG iCCP profile name is invalid");
    }
    previousSpace = byte === 32;
  }
  if (previousSpace) throw new Error("PNG iCCP profile name is invalid");
  if (separator + 2 >= end || bytes[separator + 1] !== 0) {
    throw new Error("PNG iCCP must use compression method 0 and contain profile data");
  }
}

async function inflate(zlibData: Uint8Array, expectedOutputBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("this browser does not provide DecompressionStream for exact PNG decoding");
  }
  try {
    const stream = new Blob([zlibData as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"));
    const reader = stream.getReader();
    const output = new Uint8Array(expectedOutputBytes);
    let offset = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > expectedOutputBytes - offset) {
        await reader.cancel();
        throw new Error(`PNG inflates past its expected ${expectedOutputBytes}-byte image data`);
      }
      output.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== expectedOutputBytes) {
      throw new Error(`PNG inflated to ${offset} bytes, expected ${expectedOutputBytes} bytes`);
    }
    return output;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to inflate PNG IDAT: ${detail}`);
  }
}

function scaleSample(sample: number, bitDepth: number): number {
  if (bitDepth === 8) return sample;
  const max = 2 ** bitDepth - 1;
  return Math.floor((sample * 255) / max + 0.5);
}

function readSample(row: Uint8Array, index: number, bitDepth: number): number {
  if (bitDepth === 8) return row[index]!;
  if (bitDepth === 16) return (row[index * 2]! << 8) | row[index * 2 + 1]!;
  const bitOffset = index * bitDepth;
  const shift = 8 - bitDepth - (bitOffset & 7);
  return (row[bitOffset >> 3]! >> shift) & (2 ** bitDepth - 1);
}

function passSize(size: number, start: number, step: number): number {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

function expectedInflatedBytes(header: Header): number {
  const passes = header.interlace === 0 ? [{ x: 0, y: 0, dx: 1, dy: 1 } as const] : ADAM7;
  const bitsPerPixel = header.channels * header.bitDepth;
  let total = 0;
  for (const pass of passes) {
    const width = passSize(header.width, pass.x, pass.dx);
    const height = passSize(header.height, pass.y, pass.dy);
    if (width === 0 || height === 0) continue;
    total += height * (1 + Math.ceil((width * bitsPerPixel) / 8));
  }
  if (!Number.isSafeInteger(total)) throw new Error("PNG inflated size is too large");
  return total;
}

function writePixel(
  out: Uint8Array,
  offset: number,
  samples: ArrayLike<number>,
  header: Header,
  palette: Uint8Array | null,
  paletteAlpha: Uint8Array | null,
  transparent: readonly number[] | null,
): void {
  const { bitDepth, colorType } = header;
  if (colorType === 0) {
    if (transparent?.[0] === samples[0]) {
      out.fill(0, offset, offset + 4);
      return;
    }
    const gray = scaleSample(samples[0]!, bitDepth);
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
    out[offset] = scaleSample(samples[0]!, bitDepth);
    out[offset + 1] = scaleSample(samples[1]!, bitDepth);
    out[offset + 2] = scaleSample(samples[2]!, bitDepth);
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
    const gray = scaleSample(samples[0]!, bitDepth);
    out[offset] = gray;
    out[offset + 1] = gray;
    out[offset + 2] = gray;
    out[offset + 3] = scaleSample(samples[1]!, bitDepth);
    return;
  }
  out[offset] = scaleSample(samples[0]!, bitDepth);
  out[offset + 1] = scaleSample(samples[1]!, bitDepth);
  out[offset + 2] = scaleSample(samples[2]!, bitDepth);
  out[offset + 3] = scaleSample(samples[3]!, bitDepth);
}

function decodePixels(
  raw: Uint8Array,
  header: Header,
  palette: Uint8Array | null,
  paletteAlpha: Uint8Array | null,
  transparent: readonly number[] | null,
): Uint8Array {
  const outputLength = header.width * header.height * 4;
  if (!Number.isSafeInteger(outputLength)) throw new Error("PNG dimensions are too large");
  const out = new Uint8Array(outputLength);
  const passes = header.interlace === 0 ? [{ x: 0, y: 0, dx: 1, dy: 1 } as const] : ADAM7;
  const bitsPerPixel = header.channels * header.bitDepth;
  const filterBpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const samples = new Uint16Array(4);
  let rawOffset = 0;

  for (const pass of passes) {
    const width = passSize(header.width, pass.x, pass.dx);
    const height = passSize(header.height, pass.y, pass.dy);
    if (width === 0 || height === 0) continue;
    const stride = Math.ceil((width * bitsPerPixel) / 8);
    let previous = new Uint8Array(stride);

    for (let py = 0; py < height; py++) {
      if (rawOffset + stride + 1 > raw.length) {
        throw new Error("PNG decompressed data ends inside a scanline");
      }
      const filter = raw[rawOffset++]!;
      if (filter > 4) throw new Error(`unknown PNG filter ${filter}`);
      const row = new Uint8Array(stride);
      for (let i = 0; i < stride; i++) {
        const value = raw[rawOffset++]!;
        const left = i >= filterBpp ? row[i - filterBpp]! : 0;
        const up = previous[i]!;
        const upLeft = i >= filterBpp ? previous[i - filterBpp]! : 0;
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

      for (let px = 0; px < width; px++) {
        for (let channel = 0; channel < header.channels; channel++) {
          samples[channel] = readSample(row, px * header.channels + channel, header.bitDepth);
        }
        const x = pass.x + px * pass.dx;
        const y = pass.y + py * pass.dy;
        writePixel(
          out,
          (y * header.width + x) * 4,
          samples,
          header,
          palette,
          paletteAlpha,
          transparent,
        );
      }
      previous = row;
    }
  }

  if (rawOffset !== raw.length) {
    throw new Error(`PNG decompressed data has ${raw.length - rawOffset} trailing bytes`);
  }
  return out;
}

export async function decodePng(
  bytes: Uint8Array,
  pixelBudget: number = LIMITS.texturePixels,
): Promise<DecodedPng> {
  if (bytes.byteLength > LIMITS.textureFileBytes) {
    throw new Error(`PNG exceeds ${LIMITS.textureFileBytes} encoded bytes`);
  }
  if (!Number.isSafeInteger(pixelBudget) || pixelBudget < 0) {
    throw new Error(`PNG pixel budget must be a non-negative safe integer`);
  }
  if (bytes.length < SIGNATURE.length) throw new Error("not a PNG file (truncated signature)");
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error("not a PNG file");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header: Header | null = null;
  let palette: Uint8Array | null = null;
  let paletteAlpha: Uint8Array | null = null;
  let transparent: number[] | null = null;
  const idat: Uint8Array[] = [];
  let offset = 8;
  let chunks = 0;
  let idatChunks = 0;
  let sawIdat = false;
  let endedIdat = false;
  let sawIend = false;
  let sawTrns = false;
  let sawGamma = false;
  let sawChromaticities = false;
  let sawSrgb = false;
  let sawIccProfile = false;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error("PNG ends inside a chunk header");
    const length = view.getUint32(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) {
      throw new Error("PNG ends inside a chunk");
    }
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw new Error("PNG contains an invalid chunk type");
    }
    if ((bytes[offset + 6]! & 0x20) !== 0) {
      throw new Error(`PNG ${type} chunk has an invalid reserved bit`);
    }
    const expectedCrc = view.getUint32(dataEnd);
    const actualCrc = chunkCrc(bytes, offset + 4, dataEnd);
    if (actualCrc !== expectedCrc) throw new Error(`PNG ${type} chunk has an invalid CRC`);
    if (chunks === 0 && type !== "IHDR") throw new Error("PNG IHDR must be the first chunk");
    chunks++;
    if (chunks > RUNTIME_LIMITS.pngChunks) {
      throw new Error(`PNG exceeds ${RUNTIME_LIMITS.pngChunks} chunks`);
    }
    if (sawIdat && type !== "IDAT" && type !== "IEND") endedIdat = true;

    if (type === "IHDR") {
      if (header) throw new Error("PNG has multiple IHDR chunks");
      if (length !== 13) throw new Error("PNG IHDR must contain 13 bytes");
      const width = view.getUint32(dataStart);
      const height = view.getUint32(dataStart + 4);
      const bitDepth = bytes[dataStart + 8]!;
      const colorType = bytes[dataStart + 9]!;
      const channels = CHANNELS.get(colorType);
      const validDepths = VALID_DEPTHS.get(colorType);
      if (width === 0 || height === 0) throw new Error("PNG dimensions must be positive");
      if (width > LIMITS.textureDimension || height > LIMITS.textureDimension) {
        throw new Error(`PNG dimensions exceed ${LIMITS.textureDimension}px per axis`);
      }
      const allowedPixels = Math.min(LIMITS.texturePixels, pixelBudget);
      if (width * height > allowedPixels) {
        throw new Error(`PNG exceeds its ${allowedPixels} decoded pixels (decoded-pixel budget)`);
      }
      if (!channels || !validDepths?.includes(bitDepth)) {
        throw new Error(`unsupported PNG layout (bit depth ${bitDepth}, color type ${colorType})`);
      }
      if (bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0) {
        throw new Error("unsupported PNG compression or filter method");
      }
      const interlace = bytes[dataStart + 12]!;
      if (interlace !== 0 && interlace !== 1) {
        throw new Error(`unsupported PNG interlace method ${interlace}`);
      }
      header = { width, height, bitDepth, colorType, channels, interlace };
    } else if (type === "PLTE") {
      if (!header) throw new Error("PNG PLTE appears before IHDR");
      if (sawIdat) throw new Error("PNG PLTE appears after IDAT");
      if (sawTrns) throw new Error("PNG PLTE appears after tRNS");
      if (palette) throw new Error("PNG has multiple PLTE chunks");
      if (length === 0 || length % 3 !== 0 || length > 256 * 3) {
        throw new Error("PNG PLTE has an invalid length");
      }
      if (header.colorType === 0 || header.colorType === 4) {
        throw new Error(`PNG color type ${header.colorType} does not permit PLTE`);
      }
      palette = bytes.slice(dataStart, dataEnd);
    } else if (type === "tRNS") {
      if (!header) throw new Error("PNG tRNS appears before IHDR");
      if (sawIdat) throw new Error("PNG tRNS appears after IDAT");
      if (sawTrns) throw new Error("PNG has multiple tRNS chunks");
      if (header.colorType === 0) {
        if (length !== 2) throw new Error("grayscale PNG tRNS must contain 2 bytes");
        transparent = [view.getUint16(dataStart) & (2 ** header.bitDepth - 1)];
      } else if (header.colorType === 2) {
        if (length !== 6) throw new Error("RGB PNG tRNS must contain 6 bytes");
        const maxSample = 2 ** header.bitDepth - 1;
        transparent = [
          view.getUint16(dataStart) & maxSample,
          view.getUint16(dataStart + 2) & maxSample,
          view.getUint16(dataStart + 4) & maxSample,
        ];
      } else if (header.colorType === 3) {
        if (!palette) throw new Error("palette PNG tRNS appears before PLTE");
        if (length > palette.length / 3) {
          throw new Error("palette PNG tRNS must not exceed the PLTE entry count");
        }
        paletteAlpha = bytes.slice(dataStart, dataEnd);
      } else {
        throw new Error(`PNG color type ${header.colorType} does not permit tRNS`);
      }
      sawTrns = true;
    } else if (type === "gAMA") {
      if (sawGamma) throw new Error("PNG has multiple gAMA chunks");
      if (palette || sawIdat) throw new Error("PNG gAMA appears after PLTE or IDAT");
      if (length !== 4 || view.getUint32(dataStart) === 0) {
        throw new Error("PNG gAMA must contain one non-zero 4-byte value");
      }
      sawGamma = true;
    } else if (type === "cHRM") {
      if (sawChromaticities) throw new Error("PNG has multiple cHRM chunks");
      if (palette || sawIdat) throw new Error("PNG cHRM appears after PLTE or IDAT");
      if (length !== 32) throw new Error("PNG cHRM must contain 32 bytes");
      sawChromaticities = true;
    } else if (type === "sRGB") {
      if (sawSrgb) throw new Error("PNG has multiple sRGB chunks");
      if (palette || sawIdat) throw new Error("PNG sRGB appears after PLTE or IDAT");
      if (length !== 1 || bytes[dataStart]! > 3) {
        throw new Error("PNG sRGB must contain one rendering-intent byte in 0..3");
      }
      sawSrgb = true;
    } else if (type === "iCCP") {
      if (sawIccProfile) throw new Error("PNG has multiple iCCP chunks");
      if (palette || sawIdat) throw new Error("PNG iCCP appears after PLTE or IDAT");
      validateIccProfileChunk(bytes, dataStart, dataEnd);
      sawIccProfile = true;
    } else if (type === "IDAT") {
      if (!header) throw new Error("PNG IDAT appears before IHDR");
      if (endedIdat) throw new Error("PNG IDAT chunks must be consecutive");
      if (header.colorType === 3 && !palette) {
        throw new Error("palette PNG is missing PLTE before IDAT");
      }
      sawIdat = true;
      if (++idatChunks > RUNTIME_LIMITS.pngIdatChunks) {
        throw new Error(`PNG exceeds ${RUNTIME_LIMITS.pngIdatChunks} IDAT chunks`);
      }
      idat.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      if (length !== 0) throw new Error("PNG IEND must be empty");
      sawIend = true;
      offset = chunkEnd;
      break;
    } else if ((bytes[offset + 4]! & 0x20) === 0) {
      throw new Error(`unsupported critical PNG chunk ${type}`);
    }
    offset = chunkEnd;
  }

  if (!header) throw new Error("PNG missing IHDR");
  if (!sawIdat || idat.length === 0) throw new Error("PNG missing IDAT");
  if (!sawIend) throw new Error("PNG missing IEND");
  if (offset !== bytes.length) throw new Error("PNG has trailing data after IEND");
  if (header.colorType === 3) {
    if (!palette) throw new Error("palette PNG is missing PLTE");
    if (palette.length / 3 > 2 ** header.bitDepth) {
      throw new Error("PNG PLTE has more entries than its bit depth permits");
    }
  }
  const compressedLength = idat.reduce((total, chunk) => total + chunk.length, 0);
  const compressed = new Uint8Array(compressedLength);
  let compressedOffset = 0;
  for (const chunk of idat) {
    compressed.set(chunk, compressedOffset);
    compressedOffset += chunk.length;
  }
  const raw = await inflate(compressed, expectedInflatedBytes(header));
  return {
    width: header.width,
    height: header.height,
    data: decodePixels(raw, header, palette, paletteAlpha, transparent),
  };
}
