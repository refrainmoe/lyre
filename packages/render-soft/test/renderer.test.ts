import { describe, expect, it } from "vitest";
import { LIMITS, premultiplyStraightRGBA8 } from "@refrain-lyre/core";
import type {
  DeformedGeometry,
  DrawItem,
  EvalFrame,
  PremultipliedImage,
  SpriteNode,
} from "@refrain-lyre/core";
import { createSoftRenderer } from "../src/index.js";

const fakeSprite = { id: "s" } as SpriteNode;

function quadGeometry(
  rect: readonly [number, number, number, number],
  texture: string,
): DeformedGeometry {
  const [x, y, w, h] = rect;
  return {
    sprite: fakeSprite,
    texture,
    positions: Float64Array.of(x, y, x + w, y, x, y + h, x + w, y + h),
    uvs: Float64Array.of(0, 0, 1, 0, 0, 1, 1, 1),
    indices: Uint32Array.of(0, 1, 3, 0, 3, 2),
  };
}

function drawItem(
  rect: readonly [number, number, number, number],
  texture: string,
  overrides: Partial<DrawItem> = {},
): DrawItem {
  return {
    ...quadGeometry(rect, texture),
    opacity: 1,
    blend: "normal",
    effectiveZ: 0,
    mask: null,
    ...overrides,
  };
}

function frame(
  drawList: DrawItem[],
  size = 8,
  maskGroups: EvalFrame["maskGroups"] = [],
): EvalFrame {
  return { canvas: { width: size, height: size }, drawList, maskGroups };
}

/** Solid straight-alpha texture, premultiplied through the shared core helper. */
function solidTexture(
  w: number,
  h: number,
  rgba: [number, number, number, number],
): PremultipliedImage {
  const straight = new Uint8Array(w * h * 4);
  for (let i = 0; i < straight.length; i += 4) straight.set(rgba, i);
  return { width: w, height: h, data: premultiplyStraightRGBA8(straight) };
}

function px(surface: Uint8Array, size: number, x: number, y: number): number[] {
  const o = (y * size + x) * 4;
  return [surface[o]!, surface[o + 1]!, surface[o + 2]!, surface[o + 3]!];
}

describe("SoftRenderer — exactness", () => {
  it("rejects surfaces above the aggregate canvas-pixel ceiling before allocation", () => {
    expect(() => createSoftRenderer(LIMITS.canvasPixels + 1, 1)).toThrow(/total pixels/);
  });

  it("rejects finite-area edge overflow before changing the completed surface", () => {
    const renderer = createSoftRenderer(1, 1);
    renderer.setTexture("solid", solidTexture(1, 1, [30, 60, 90, 255]));
    renderer.render(frame([drawItem([0, 0, 1, 1], "solid")], 1));
    const before = renderer.readSurface();
    const hostile: DrawItem = {
      sprite: fakeSprite,
      texture: "solid",
      positions: Float64Array.of(
        -9.530902153346688e80,
        0.5,
        0.5,
        -9.914179312763735e126,
        8.831968987360597e94,
        6.122969036223368e222,
      ),
      uvs: Float64Array.of(0, 0, 1, 0, 0, 1),
      indices: Uint32Array.of(0, 1, 2),
      opacity: 1,
      blend: "normal",
      effectiveZ: 0,
      mask: null,
    };

    expect(() => renderer.render(frame([hostile], 1))).toThrow(
      /raster edge arithmetic.*non-finite/,
    );
    expect(renderer.readSurface()).toEqual(before);
  });

  it("rejects affine UV overflow before changing the completed surface", () => {
    const renderer = createSoftRenderer(1, 1);
    renderer.setTexture("solid", solidTexture(1, 1, [30, 60, 90, 255]));
    renderer.render(frame([drawItem([0, 0, 1, 1], "solid")], 1));
    const before = renderer.readSurface();
    const max = Number.MAX_VALUE;
    const hostile: DrawItem = {
      sprite: fakeSprite,
      texture: "solid",
      positions: Float64Array.of(
        0.5000000029818814,
        0.4999999964442607,
        0.49999999098257164,
        0.5000000129488712,
        0.49999998715009064,
        0.500000008562772,
      ),
      uvs: Float64Array.of(max, 0.5, max, 0.5, max, 0.5),
      indices: Uint32Array.of(0, 1, 2),
      opacity: 1,
      blend: "normal",
      effectiveZ: 0,
      mask: null,
    };

    expect(() => renderer.render(frame([hostile], 1))).toThrow(/affine UV arithmetic.*non-finite/);
    expect(renderer.readSurface()).toEqual(before);
  });

  it("clamps huge finite UVs before crop-coordinate multiplication", () => {
    const renderer = createSoftRenderer(1, 1);
    renderer.setTexture("two", {
      width: 2,
      height: 1,
      data: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255),
    });
    const item = drawItem([0, 0, 1, 1], "two");
    item.uvs.fill(1e308);
    renderer.render(frame([item], 1));
    expect(Array.from(renderer.readSurface())).toEqual([0, 255, 0, 255]);
  });

  it("snapshots registered texture bytes", () => {
    const renderer = createSoftRenderer(1, 1);
    const image = {
      width: 1,
      height: 1,
      data: Uint8Array.of(255, 0, 0, 255),
    };
    renderer.setTexture("mutable", image);
    image.data.set([0, 255, 0, 255]);
    renderer.render(frame([drawItem([0, 0, 1, 1], "mutable")], 1));
    expect(Array.from(renderer.readSurface())).toEqual([255, 0, 0, 255]);
  });

  it("snapshots atlas rectangles on initial and same-source registration", () => {
    const renderer = createSoftRenderer(1, 1);
    const atlas = {
      width: 2,
      height: 1,
      data: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255),
    };

    const initialCrop: [number, number, number, number] = [0, 0, 1, 1];
    renderer.setTexture("initial", atlas, initialCrop);
    initialCrop[0] = 1;
    renderer.render(frame([drawItem([0, 0, 1, 1], "initial")], 1));
    expect(Array.from(renderer.readSurface())).toEqual([255, 0, 0, 255]);

    renderer.setTexture("reused", atlas, [0, 0, 1, 1]);
    const replacementCrop: [number, number, number, number] = [1, 0, 1, 1];
    renderer.setTexture("reused", atlas, replacementCrop);
    replacementCrop[0] = 0;
    renderer.render(frame([drawItem([0, 0, 1, 1], "reused")], 1));
    expect(Array.from(renderer.readSurface())).toEqual([0, 255, 0, 255]);
  });

  it("resizes its target without copying or dropping registered textures", () => {
    const renderer = createSoftRenderer(2, 1);
    renderer.setTexture("solid", solidTexture(1, 1, [30, 60, 90, 255]));
    renderer.render({
      canvas: { width: 2, height: 1 },
      drawList: [drawItem([0, 0, 2, 1], "solid")],
      maskGroups: [],
    });
    expect(renderer.readSurface()).toEqual(Uint8Array.of(30, 60, 90, 255, 30, 60, 90, 255));

    renderer.resize(1, 2);
    renderer.render({
      canvas: { width: 1, height: 2 },
      drawList: [drawItem([0, 0, 1, 2], "solid")],
      maskGroups: [],
    });
    expect([renderer.width, renderer.height]).toEqual([1, 2]);
    expect(renderer.readSurface()).toEqual(Uint8Array.of(30, 60, 90, 255, 30, 60, 90, 255));
  });

  it("rejects oversized or malformed texture inputs before rendering", () => {
    const r = createSoftRenderer(1, 1);
    expect(() =>
      r.setTexture("huge", {
        width: LIMITS.textureDimension,
        height: LIMITS.textureDimension,
        data: new Uint8Array(),
      }),
    ).toThrow(/total pixels/);
    expect(() => r.setTexture("short", { width: 1, height: 1, data: new Uint8Array(3) })).toThrow(
      /expected 4/,
    );
    expect(() => r.setTexture("crop", solidTexture(1, 1, [0, 0, 0, 0]), [0, 0, 2, 1])).toThrow(
      /inside the texture/,
    );
    r.setTexture("atomic", solidTexture(1, 1, [30, 60, 90, 255]));
    expect(() =>
      r.setTexture("atomic", {
        width: 1,
        height: 1,
        data: Uint8Array.of(255, 0, 0, 0),
      }),
    ).toThrow(/premultiplied.*alpha/);
    r.render(frame([drawItem([0, 0, 1, 1], "atomic")], 1));
    expect(r.readSurface()).toEqual(Uint8Array.of(30, 60, 90, 255));
  });

  it("rejects invalid frame enums before changing the rendered surface", () => {
    const renderer = createSoftRenderer(1, 1);
    renderer.setTexture("solid", solidTexture(1, 1, [30, 60, 90, 255]));
    renderer.render(frame([drawItem([0, 0, 1, 1], "solid")], 1));
    const before = renderer.readSurface();

    const invalidBlend = drawItem([0, 0, 1, 1], "solid");
    (invalidBlend as { blend: string }).blend = "screen";
    expect(() => renderer.render(frame([invalidBlend], 1))).toThrow(/blend.*invalid/);
    expect(renderer.readSurface()).toEqual(before);

    const invalidMask = drawItem([0, 0, 1, 1], "solid", {
      mask: { mode: "alpha", group: 0 },
    });
    (invalidMask.mask as { mode: string }).mode = "bogus";
    expect(() =>
      renderer.render(
        frame([invalidMask], 1, [{ sources: [quadGeometry([0, 0, 1, 1], "solid")] }]),
      ),
    ).toThrow(/mask mode.*invalid/);
    expect(renderer.readSurface()).toEqual(before);
  });

  it("copies texels exactly for an axis-aligned integer-rect quad", () => {
    // Deterministic non-uniform texture.
    const straight = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) {
      straight[4 * i] = (i * 37) % 256;
      straight[4 * i + 1] = (i * 101) % 256;
      straight[4 * i + 2] = (i * 197) % 256;
      straight[4 * i + 3] = (i * 53) % 256;
    }
    const pm = premultiplyStraightRGBA8(straight);
    const r = createSoftRenderer(4, 4);
    r.setTexture("t", { width: 4, height: 4, data: pm });
    r.render(frame([drawItem([0, 0, 4, 4], "t")], 4));
    expect(Array.from(r.readSurface())).toEqual(Array.from(pm));
  });

  it("rasterizes shared mesh edges exactly once (top-left rule)", () => {
    // Additive blend makes double-covered pixels visible as 2× values.
    const r = createSoftRenderer(8, 8);
    r.setTexture("t", solidTexture(2, 2, [100, 100, 100, 255]));
    r.render(frame([drawItem([0, 0, 8, 8], "t", { blend: "additive" })]));
    const s = r.readSurface();
    // Additive writes RGB but no alpha; every pixel must be exactly 100,
    // with no double-hit along the quad's shared diagonal.
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        expect(px(s, 8, x, y)[0], `pixel ${x},${y}`).toBe(100);
      }
    }
  });
});

describe("SoftRenderer — §8.3 blend equations", () => {
  it("normal blend: out = src + dst·(1−src.a)", () => {
    const r = createSoftRenderer(8, 8);
    r.setTexture("red", solidTexture(2, 2, [255, 0, 0, 255]));
    r.setTexture("half_green", solidTexture(2, 2, [0, 255, 0, 128]));
    r.render(frame([drawItem([0, 0, 8, 8], "red"), drawItem([0, 0, 8, 8], "half_green")]));
    const [pr, pg, , pa] = px(r.readSurface(), 8, 3, 3);
    // src = (0, 128, 0, 128)/255 premultiplied; dst = (255,0,0,255)/255.
    // out.r = 0 + 1·(1−128/255) = 127/255 → 127; out.g = 128; out.a = 255.
    expect(pr).toBe(127);
    expect(pg).toBe(128);
    expect(pa).toBe(255);
  });

  it("preserves additive emission over transparency while writing no alpha (§8.3)", () => {
    const r = createSoftRenderer(8, 8);
    r.setTexture("glow", solidTexture(2, 2, [200, 200, 200, 200]));
    r.render(frame([drawItem([0, 0, 8, 8], "glow", { blend: "additive" })]));
    const s = r.readSurface();
    // RGB accumulates while alpha stays 0. Standard premultiplied `over`
    // therefore adds this emissive RGB to any later host background.
    const [pr, , , pa] = px(s, 8, 3, 3);
    expect(pa).toBe(0);
    expect(pr).toBeGreaterThan(0); // additive energy is present in rgb
  });

  it("multiply is a no-op over full transparency (§8.3)", () => {
    const r = createSoftRenderer(8, 8);
    r.setTexture("shade", solidTexture(2, 2, [64, 64, 64, 255]));
    r.render(frame([drawItem([0, 0, 8, 8], "shade", { blend: "multiply" })]));
    expect(px(r.readSurface(), 8, 3, 3)).toEqual([0, 0, 0, 0]);
  });

  it("multiply darkens an existing backdrop: out.rgb = dst.rgb·(src.rgb + 1 − src.a)", () => {
    const r = createSoftRenderer(8, 8);
    r.setTexture("white", solidTexture(2, 2, [255, 255, 255, 255]));
    r.setTexture("shade", solidTexture(2, 2, [128, 64, 255, 255]));
    r.render(
      frame([
        drawItem([0, 0, 8, 8], "white"),
        drawItem([0, 0, 8, 8], "shade", { blend: "multiply" }),
      ]),
    );
    const [pr, pg, pb, pa] = px(r.readSurface(), 8, 3, 3);
    expect(pr).toBe(128);
    expect(pg).toBe(64);
    expect(pb).toBe(255);
    expect(pa).toBe(255); // multiply writes no alpha; backdrop keeps its own
  });

  it("tints src by effective opacity as a single premultiplied multiply", () => {
    const r = createSoftRenderer(8, 8);
    r.setTexture("red", solidTexture(2, 2, [255, 0, 0, 255]));
    r.render(frame([drawItem([0, 0, 8, 8], "red", { opacity: 0.5 })]));
    const [pr, , , pa] = px(r.readSurface(), 8, 3, 3);
    expect(pr).toBe(128); // 0.5·255 rounded half-up
    expect(pa).toBe(128);
  });
});

describe("SoftRenderer — §8.4 masks", () => {
  it("combines sources as a coverage union and clips by it", () => {
    const r = createSoftRenderer(8, 8);
    r.setTexture("white", solidTexture(2, 2, [255, 255, 255, 255]));
    r.setTexture("half", solidTexture(2, 2, [255, 255, 255, 128]));
    const maskGroups = [
      { sources: [quadGeometry([0, 0, 8, 8], "half"), quadGeometry([0, 0, 8, 8], "half")] },
    ];
    r.render(
      frame(
        [drawItem([0, 0, 8, 8], "white", { mask: { mode: "alpha", group: 0 } })],
        8,
        maskGroups,
      ),
    );
    // m = 1 − (1 − 128/255)² ≈ 0.7517; out = 255·m ≈ 192.
    const [pr, , , pa] = px(r.readSurface(), 8, 3, 3);
    const m = 1 - (1 - 128 / 255) ** 2;
    expect(pr).toBe(Math.round(255 * m));
    expect(pa).toBe(Math.round(255 * m));
  });

  it("inverted mode multiplies by 1 − m", () => {
    const r = createSoftRenderer(8, 8);
    r.setTexture("white", solidTexture(2, 2, [255, 255, 255, 255]));
    r.setTexture("opaque", solidTexture(2, 2, [0, 0, 0, 255]));
    const maskGroups = [{ sources: [quadGeometry([0, 0, 4, 8], "opaque")] }];
    r.render(
      frame(
        [drawItem([0, 0, 8, 8], "white", { mask: { mode: "inverted", group: 0 } })],
        8,
        maskGroups,
      ),
    );
    const s = r.readSurface();
    expect(px(s, 8, 1, 1)).toEqual([0, 0, 0, 0]); // inside source → clipped
    expect(px(s, 8, 6, 1)).toEqual([255, 255, 255, 255]); // outside → kept
  });

  it("an empty source set yields m = 0 (alpha-masked sprite invisible)", () => {
    const r = createSoftRenderer(8, 8);
    r.setTexture("white", solidTexture(2, 2, [255, 255, 255, 255]));
    r.render(
      frame([drawItem([0, 0, 8, 8], "white", { mask: { mode: "alpha", group: 0 } })], 8, [
        { sources: [] },
      ]),
    );
    expect(px(r.readSurface(), 8, 3, 3)).toEqual([0, 0, 0, 0]);
  });
});

describe("SoftRenderer — bounded frame work", () => {
  it("rejects an excessive candidate-pixel workload before rasterization", () => {
    const renderer = createSoftRenderer(512, 512);
    renderer.setTexture("white", solidTexture(1, 1, [255, 255, 255, 255]));
    const sprite = { id: "work_bomb" } as DrawItem["sprite"];
    const triangleCount = 257;
    const indices = new Uint32Array(triangleCount * 3);
    for (let i = 0; i < triangleCount; i++) {
      indices[i * 3] = 0;
      indices[i * 3 + 1] = 1;
      indices[i * 3 + 2] = 2;
    }
    const item: DrawItem = {
      sprite,
      texture: "white",
      positions: Float64Array.of(0, 0, 512, 0, 0, 512),
      uvs: Float64Array.of(0, 0, 1, 0, 0, 1),
      indices,
      opacity: 1,
      blend: "normal",
      effectiveZ: 0,
      mask: null,
    };
    expect(() =>
      renderer.render({
        canvas: { width: 512, height: 512 },
        drawList: [item],
        maskGroups: [],
      }),
    ).toThrow(/raster candidate tests/);
  });
});

describe("SoftRenderer — atlas (§3.2)", () => {
  it("renders byte-identically from per-file textures and a packed atlas", () => {
    const red = solidTexture(4, 4, [255, 0, 0, 255]);
    const blue = solidTexture(4, 4, [0, 0, 255, 128]);

    const perFile = createSoftRenderer(8, 8);
    perFile.setTexture("a", red);
    perFile.setTexture("b", blue);
    const scene = [drawItem([0, 0, 6, 6], "a"), drawItem([2, 2, 5, 5], "b")];
    perFile.render(frame(scene));

    // Pack both into one 8×4 atlas.
    const atlasImg: PremultipliedImage = { width: 8, height: 4, data: new Uint8Array(8 * 4 * 4) };
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        atlasImg.data.set(red.data.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4), (y * 8 + x) * 4);
        atlasImg.data.set(
          blue.data.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4),
          (y * 8 + x + 4) * 4,
        );
      }
    }
    const atlas = createSoftRenderer(8, 8);
    atlas.setTexture("a", atlasImg, [0, 0, 4, 4]);
    atlas.setTexture("b", atlasImg, [4, 0, 4, 4]);
    atlas.render(frame(scene));

    expect(Array.from(atlas.readSurface())).toEqual(Array.from(perFile.readSurface()));
  });
});
