/**
 * §3.2: PNGs store straight alpha; runtimes premultiply at load and do all
 * filtering/blending in premultiplied space. This is the single premultiply
 * implementation shared by every renderer and the validator, so all consumers
 * agree byte-for-byte (built-in browser/GL premultiplication has unspecified
 * rounding and must not be used).
 *
 * Rounding: round-half-up of c·a/255 (computed in integers).
 */
export function premultiplyStraightRGBA8(data: Uint8Array | Uint8ClampedArray): Uint8Array {
  if (data.length % 4 !== 0) {
    throw new RangeError(`straight RGBA8 data length must be a multiple of 4 bytes`);
  }
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]!;
    if (a === 255) {
      out[i] = data[i]!;
      out[i + 1] = data[i + 1]!;
      out[i + 2] = data[i + 2]!;
    } else if (a !== 0) {
      out[i] = ((data[i]! * a + 127) / 255) | 0;
      out[i + 1] = ((data[i + 1]! * a + 127) / 255) | 0;
      out[i + 2] = ((data[i + 2]! * a + 127) / 255) | 0;
    }
    out[i + 3] = a;
  }
  return out;
}
