/**
 * Small, allocation-conscious math helpers used by the rig and motion system.
 * Matrices are 3x3 column-major arrays, matching WebGL conventions.
 */

export function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

export function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) {
    return value < edge0 ? 0 : 1;
  }

  const amount = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return amount * amount * (3 - 2 * amount);
}

export function mat3Identity(out = new Float32Array(9)) {
  out[0] = 1;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;
  out[4] = 1;
  out[5] = 0;
  out[6] = 0;
  out[7] = 0;
  out[8] = 1;
  return out;
}

/**
 * Multiplies two matrices as `left * right`.
 */
export function mat3Multiply(
  left,
  right,
  out = new Float32Array(9),
) {
  const a00 = left[0];
  const a01 = left[1];
  const a02 = left[2];
  const a10 = left[3];
  const a11 = left[4];
  const a12 = left[5];
  const a20 = left[6];
  const a21 = left[7];
  const a22 = left[8];

  const b00 = right[0];
  const b01 = right[1];
  const b02 = right[2];
  const b10 = right[3];
  const b11 = right[4];
  const b12 = right[5];
  const b20 = right[6];
  const b21 = right[7];
  const b22 = right[8];

  out[0] = a00 * b00 + a10 * b01 + a20 * b02;
  out[1] = a01 * b00 + a11 * b01 + a21 * b02;
  out[2] = a02 * b00 + a12 * b01 + a22 * b02;
  out[3] = a00 * b10 + a10 * b11 + a20 * b12;
  out[4] = a01 * b10 + a11 * b11 + a21 * b12;
  out[5] = a02 * b10 + a12 * b11 + a22 * b12;
  out[6] = a00 * b20 + a10 * b21 + a20 * b22;
  out[7] = a01 * b20 + a11 * b21 + a21 * b22;
  out[8] = a02 * b20 + a12 * b21 + a22 * b22;
  return out;
}

/**
 * Creates a 2D translation/rotation/scale matrix.
 *
 * @param {number} x translation in design units
 * @param {number} y translation in design units
 * @param {number} rotation rotation in radians
 * @param {number} scaleX horizontal scale
 * @param {number} scaleY vertical scale
 */
export function mat3FromTRS(
  x = 0,
  y = 0,
  rotation = 0,
  scaleX = 1,
  scaleY = scaleX,
  out = new Float32Array(9),
) {
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);

  out[0] = cosine * scaleX;
  out[1] = sine * scaleX;
  out[2] = 0;
  out[3] = -sine * scaleY;
  out[4] = cosine * scaleY;
  out[5] = 0;
  out[6] = x;
  out[7] = y;
  out[8] = 1;
  return out;
}

/**
 * Transforms either `(matrix, x, y, out)` or `(matrix, [x, y], out)`.
 */
export function mat3TransformPoint(
  matrix,
  xOrPoint,
  yOrOut,
  optionalOut,
) {
  let x;
  let y;
  let out;

  if (typeof xOrPoint === "number") {
    x = xOrPoint;
    y = yOrOut;
    out = optionalOut ?? new Float32Array(2);
  } else {
    x = xOrPoint[0];
    y = xOrPoint[1];
    out = yOrOut ?? new Float32Array(2);
  }

  out[0] = matrix[0] * x + matrix[3] * y + matrix[6];
  out[1] = matrix[1] * x + matrix[4] * y + matrix[7];
  return out;
}

export const mat3 = Object.freeze({
  identity: mat3Identity,
  multiply: mat3Multiply,
  fromTRS: mat3FromTRS,
  transformPoint: mat3TransformPoint,
});
