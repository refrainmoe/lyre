import type { SpriteNode } from "./types/model.js";

export interface MeshData {
  /** Rest control points in model space, xy pairs, row-major from top-left (§5.4). */
  points: Float64Array;
  /** Normalized texture coordinates over the sprite's rect, xy pairs. */
  uvs: Float64Array;
  indices: Uint32Array;
}

/**
 * Derive a sprite's mesh deterministically from its declaration (§5.4).
 * Grid: control points at the uniform (C+1)×(R+1) grid over rect, each cell
 * split into two triangles along the ↘ diagonal.
 */
export function buildMesh(sprite: SpriteNode): MeshData {
  const [rx, ry, rw, rh] = sprite.rect;
  if (sprite.mesh.type === "grid") {
    const c = sprite.mesh.cols;
    const r = sprite.mesh.rows;
    const nx = c + 1;
    const ny = r + 1;
    const points = new Float64Array(nx * ny * 2);
    const uvs = new Float64Array(nx * ny * 2);
    for (let row = 0; row < ny; row++) {
      for (let col = 0; col < nx; col++) {
        const i = row * nx + col;
        const u = col / c;
        const v = row / r;
        points[2 * i] = rx + u * rw;
        points[2 * i + 1] = ry + v * rh;
        uvs[2 * i] = u;
        uvs[2 * i + 1] = v;
      }
    }
    const indices = new Uint32Array(c * r * 6);
    let k = 0;
    for (let row = 0; row < r; row++) {
      for (let col = 0; col < c; col++) {
        const a = row * nx + col; // top-left
        const b = a + 1; // top-right
        const d = a + nx; // bottom-left
        const e = d + 1; // bottom-right
        // ↘ diagonal a–e.
        indices[k++] = a;
        indices[k++] = b;
        indices[k++] = e;
        indices[k++] = a;
        indices[k++] = e;
        indices[k++] = d;
      }
    }
    return { points, uvs, indices };
  }

  // Explicit mesh: UVs derive from rest position relative to rect.
  const pts = sprite.mesh.points;
  const points = new Float64Array(pts.length * 2);
  const uvs = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i]!;
    points[2 * i] = x;
    points[2 * i + 1] = y;
    uvs[2 * i] = rw === 0 ? 0 : (x - rx) / rw;
    uvs[2 * i + 1] = rh === 0 ? 0 : (y - ry) / rh;
  }
  const tris = sprite.mesh.tris;
  const indices = new Uint32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    indices[3 * i] = tris[i]![0];
    indices[3 * i + 1] = tris[i]![1];
    indices[3 * i + 2] = tris[i]![2];
  }
  return { points, uvs, indices };
}

/** Number of control points of a sprite's mesh (for verts-binding arity). */
export function meshPointCount(sprite: SpriteNode): number {
  return sprite.mesh.type === "grid"
    ? (sprite.mesh.cols + 1) * (sprite.mesh.rows + 1)
    : sprite.mesh.points.length;
}
