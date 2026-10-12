import {
  type Binding,
  type GroupNode,
  type Model,
  type ParamDef,
  type SpriteNode,
} from "@refrain-lyre/core";
import { describe, expect, it } from "vitest";
import { lintModel } from "../src/lints.js";

function modelWithMovingSprites(count: number, identicalFunctions: boolean): Model {
  const root: GroupNode = {
    id: "root",
    type: "group",
    parent: null,
    order: 0,
    opacity: 1,
    children: [],
  };
  const param: ParamDef = {
    id: "p",
    min: 0,
    max: 1,
    default: 0,
    wrap: false,
  };
  const sprites: SpriteNode[] = [];
  const bindings: Binding[] = [];

  for (let index = 0; index < count; index++) {
    const sprite: SpriteNode = {
      id: `s${index}`,
      type: "sprite",
      parent: root,
      order: index + 1,
      rect: [0, 0, 1, 1],
      texture: "texture",
      z: 0,
      opacity: 1,
      blend: "normal",
      mesh: { type: "grid", cols: 2, rows: 2 },
      mask: null,
      spriteOrder: index,
    };
    root.children.push(sprite);
    sprites.push(sprite);
    bindings.push({
      target: sprite,
      property: "z",
      params: [param],
      axes: [[0, 1]],
      values: Float64Array.of(0, identicalFunctions ? 10 : 10 + index),
      arity: 1,
      kind: "additive",
    });
  }

  return {
    specVersion: { major: 1, minor: 0 },
    id: "lint-test",
    name: null,
    canvas: { width: 1, height: 1, origin: [0, 0] },
    capabilities: new Set(["core"]),
    params: [param],
    paramsById: new Map([[param.id, param]]),
    root,
    nodesById: new Map([[root.id, root], ...sprites.map((sprite) => [sprite.id, sprite] as const)]),
    sprites,
    bindings,
    expressions: [],
    motions: [],
    physics: null,
    variantSlots: [],
    atlas: null,
    warnings: [],
  };
}

describe("z-tie lint work bounds", () => {
  it("caps warnings from a densely overlapping set", () => {
    const issues = lintModel(modelWithMovingSprites(24, false));
    expect(issues.filter((issue) => issue.code === "z_tie_possible")).toHaveLength(256);
    expect(issues.filter((issue) => issue.code === "z_tie_analysis_truncated")).toHaveLength(1);
  });

  it("caps candidate checks even when correlation suppresses every warning", () => {
    const issues = lintModel(modelWithMovingSprites(449, true));
    expect(issues.filter((issue) => issue.code === "z_tie_possible")).toHaveLength(0);
    expect(issues.filter((issue) => issue.code === "z_tie_analysis_truncated")).toHaveLength(1);
  });

  it("bounds inherited-binding work and z-conflict diagnostics", () => {
    const model = modelWithMovingSprites(300, true);
    const param = model.params[0]!;
    for (let i = 0; i < 400; i++) {
      model.bindings.push({
        target: model.root,
        property: "z",
        params: [param],
        axes: [[0, 1]],
        values: Float64Array.of(0, 10),
        arity: 1,
        kind: "additive",
      });
    }

    const issues = lintModel(model);
    expect(issues.filter((issue) => issue.code === "z_conflict")).toHaveLength(256);
    expect(issues.filter((issue) => issue.code === "z_conflict_analysis_truncated")).toHaveLength(
      1,
    );
    expect(issues.filter((issue) => issue.code === "z_tie_analysis_truncated")).toHaveLength(1);
    expect(issues.find((issue) => issue.code === "z_tie_analysis_truncated")?.message).toContain(
      "binding-visit budget",
    );
  });
});
