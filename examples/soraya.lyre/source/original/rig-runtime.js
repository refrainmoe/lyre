import {
  clamp,
  lerp,
  mat3,
} from "./math.js";

const REQUIRED_VIEW_FIELDS = ["x", "y", "width", "height"];

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Invalid Soraya rig: ${message}`);
  }
}

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeRect(rect, label) {
  assert(rect && typeof rect === "object", `${label} is missing`);
  for (const field of REQUIRED_VIEW_FIELDS) {
    assert(Number.isFinite(rect[field]), `${label}.${field} must be finite`);
  }
  assert(rect.width > 0 && rect.height > 0, `${label} must have positive size`);
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function flattenOffsets(offsets, expectedPairs, label) {
  const flat = [];
  for (const value of offsets ?? []) {
    if (Array.isArray(value)) {
      assert(value.length === 2, `${label} offset pairs must contain x and y`);
      flat.push(finiteNumber(value[0]), finiteNumber(value[1]));
    } else {
      flat.push(finiteNumber(value));
    }
  }
  assert(
    flat.length === expectedPairs * 2,
    `${label} requires ${expectedPairs} [x,y] offsets`,
  );
  return new Float32Array(flat);
}

function sortKeyforms(keyforms, label) {
  assert(Array.isArray(keyforms) && keyforms.length > 0, `${label} has no keyforms`);
  const sorted = [...keyforms].sort((left, right) => left.value - right.value);
  for (const keyform of sorted) {
    assert(Number.isFinite(keyform.value), `${label} keyform value must be finite`);
  }
  return sorted;
}

export function validateRig(rig, atlasLayout) {
  assert(rig?.version === 1, "only rig version 1 is supported");
  assert(
    Number.isFinite(rig.canvas?.width) && Number.isFinite(rig.canvas?.height),
    "canvas dimensions are missing",
  );
  assert(rig.canvas.width > 0 && rig.canvas.height > 0, "canvas is empty");
  assert(rig.atlas?.image, "atlas.image is missing");
  assert(rig.atlas?.layout, "atlas.layout is missing");
  assert(rig.views && Object.keys(rig.views).length > 0, "views are missing");
  for (const [name, view] of Object.entries(rig.views)) {
    normalizeRect(view, `views.${name}`);
  }
  assert(Array.isArray(rig.groups) && rig.groups.length > 0, "groups are missing");
  assert(
    Array.isArray(rig.drawables) && rig.drawables.length > 0,
    "drawables are missing",
  );
  assert(atlasLayout?.version === 1, "only atlas layout version 1 is supported");
  assert(
    Number.isFinite(atlasLayout.width) && Number.isFinite(atlasLayout.height),
    "atlas dimensions are missing",
  );
  assert(Array.isArray(atlasLayout.layers), "atlas layers are missing");
  const layerNames = new Set();
  for (const layer of atlasLayout.layers) {
    assert(layer.name && !layerNames.has(layer.name), "atlas layer names must be unique");
    layerNames.add(layer.name);
    const source = normalizeRect(layer.source, `atlas.${layer.name}.source`);
    const atlas = normalizeRect(layer.atlas, `atlas.${layer.name}.atlas`);
    assert(
      source.width === atlas.width && source.height === atlas.height,
      `atlas layer ${layer.name} changed size`,
    );
    assert(
      atlas.x >= 0
        && atlas.y >= 0
        && atlas.x + atlas.width <= atlasLayout.width
        && atlas.y + atlas.height <= atlasLayout.height,
      `atlas layer ${layer.name} lies outside the texture`,
    );
  }
  return true;
}

function compileParameters(rig) {
  const defaults = {};
  const ranges = {};
  for (const [id, definition] of Object.entries(rig.parameters ?? {})) {
    const minimum = finiteNumber(definition.min, -1);
    const maximum = finiteNumber(definition.max, 1);
    assert(maximum >= minimum, `parameter ${id} has an inverted range`);
    ranges[id] = [minimum, maximum];
    defaults[id] = clamp(
      finiteNumber(definition.default, 0),
      minimum,
      maximum,
    );
  }
  return { defaults, ranges };
}

function compileGroups(rig) {
  const groups = new Map();
  for (const definition of rig.groups) {
    assert(definition.id, "a group is missing its id");
    assert(!groups.has(definition.id), `duplicate group ${definition.id}`);
    groups.set(definition.id, {
      id: definition.id,
      parent: definition.parent ?? null,
      pivot: [
        finiteNumber(definition.pivot?.[0]),
        finiteNumber(definition.pivot?.[1]),
      ],
      transform: {
        translateX: finiteNumber(definition.transform?.translateX),
        translateY: finiteNumber(definition.transform?.translateY),
        rotation: finiteNumber(definition.transform?.rotation),
        scaleX: finiteNumber(definition.transform?.scaleX, 1),
        scaleY: finiteNumber(definition.transform?.scaleY, 1),
      },
      bindings: definition.bindings ?? {},
      matrix: mat3.identity(),
      localMatrix: mat3.identity(),
      state: 0,
    });
  }
  for (const group of groups.values()) {
    assert(
      group.parent === null || groups.has(group.parent),
      `group ${group.id} references unknown parent ${group.parent}`,
    );
  }
  return groups;
}

function compileCageDeformer(definition, drawableId) {
  const columns = Math.max(2, Math.floor(definition.grid?.[0] ?? 0));
  const rows = Math.max(2, Math.floor(definition.grid?.[1] ?? 0));
  const count = columns * rows;
  const domain = definition.domain
    ? normalizeRect(
      definition.domain,
      `${drawableId}.${definition.parameter}.domain`,
    )
    : null;
  const keyforms = sortKeyforms(
    definition.keyforms,
    `${drawableId}.${definition.parameter}`,
  ).map((keyform) => ({
    value: keyform.value,
    offsets: keyform.offsets
      ? flattenOffsets(
        keyform.offsets,
        count,
        `${drawableId}.${definition.parameter}`,
      )
      : new Float32Array(count * 2),
  }));
  return {
    kind: "cage",
    parameter: definition.parameter,
    columns,
    rows,
    domain,
    keyforms,
  };
}

function compileAxisScaleDeformer(definition, drawableId) {
  const keyforms = sortKeyforms(
    definition.keyforms,
    `${drawableId}.${definition.parameter}`,
  ).map((keyform) => ({
    value: keyform.value,
    scale: finiteNumber(keyform.scale, 1),
    scaleAlong: finiteNumber(keyform.scaleAlong, 1),
    translate: finiteNumber(keyform.translate),
    curve: finiteNumber(keyform.curve),
  }));
  const angle = finiteNumber(definition.angleDegrees) * Math.PI / 180;
  return {
    kind: "axisScale",
    parameter: definition.parameter,
    center: [
      finiteNumber(definition.center?.[0]),
      finiteNumber(definition.center?.[1]),
    ],
    cosine: Math.cos(angle),
    sine: Math.sin(angle),
    keyforms,
  };
}

function compileDeformer(definition, drawableId) {
  assert(definition.parameter, `${drawableId} has a deformer without a parameter`);
  if (definition.kind === "cage") {
    return compileCageDeformer(definition, drawableId);
  }
  if (definition.kind === "axisScale") {
    return compileAxisScaleDeformer(definition, drawableId);
  }
  throw new Error(
    `Invalid Soraya rig: drawable ${drawableId} uses unknown deformer ${definition.kind}`,
  );
}

function createGrid(bounds, grid, atlasLayer, atlasSize) {
  const columns = Math.max(2, Math.floor(grid?.[0] ?? 2));
  const rows = Math.max(2, Math.floor(grid?.[1] ?? 2));
  const vertexCount = columns * rows;
  const basePositions = new Float32Array(vertexCount * 2);
  const positions = new Float32Array(vertexCount * 2);
  const normalized = new Float32Array(vertexCount * 2);
  const uvs = new Float32Array(vertexCount * 2);
  const indices = new Uint16Array((columns - 1) * (rows - 1) * 6);

  const layerSource = atlasLayer.source;
  const layerAtlas = atlasLayer.atlas;
  const cropOffsetX = bounds.x - layerSource.x;
  const cropOffsetY = bounds.y - layerSource.y;

  let vertexOffset = 0;
  for (let row = 0; row < rows; row += 1) {
    const v = row / (rows - 1);
    for (let column = 0; column < columns; column += 1) {
      const u = column / (columns - 1);
      const x = bounds.x + bounds.width * u;
      const y = bounds.y + bounds.height * v;
      basePositions[vertexOffset] = x;
      basePositions[vertexOffset + 1] = y;
      positions[vertexOffset] = x;
      positions[vertexOffset + 1] = y;
      normalized[vertexOffset] = u;
      normalized[vertexOffset + 1] = v;
      uvs[vertexOffset] = (
        layerAtlas.x + cropOffsetX + bounds.width * u
      ) / atlasSize.width;
      uvs[vertexOffset + 1] = (
        layerAtlas.y + cropOffsetY + bounds.height * v
      ) / atlasSize.height;
      vertexOffset += 2;
    }
  }

  let indexOffset = 0;
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const topLeft = row * columns + column;
      const topRight = topLeft + 1;
      const bottomLeft = topLeft + columns;
      const bottomRight = bottomLeft + 1;
      indices[indexOffset] = topLeft;
      indices[indexOffset + 1] = bottomLeft;
      indices[indexOffset + 2] = topRight;
      indices[indexOffset + 3] = topRight;
      indices[indexOffset + 4] = bottomLeft;
      indices[indexOffset + 5] = bottomRight;
      indexOffset += 6;
    }
  }

  return {
    columns,
    rows,
    vertexCount,
    basePositions,
    positions,
    normalized,
    uvs,
    indices,
  };
}

function compileOpacity(definition, drawableId) {
  if (!definition) {
    return null;
  }
  assert(definition.parameter, `${drawableId} opacity binding has no parameter`);
  return {
    parameter: definition.parameter,
    keyforms: sortKeyforms(
      definition.keyforms,
      `${drawableId}.opacity`,
    ).map((keyform) => ({
      value: keyform.value,
      opacity: clamp(finiteNumber(keyform.opacity, 1), 0, 1),
    })),
  };
}

function compileDrawables(rig, atlasLayout, groups) {
  const atlasLayers = new Map(
    atlasLayout.layers.map((layer) => [layer.name, layer]),
  );
  const seen = new Set();
  const definitions = rig.drawables
    .map((definition, authoredOrder) => ({
      definition,
      authoredOrder,
      atlasOrder: atlasLayers.get(
        definition.textureLayer ?? definition.id,
      )?.drawOrder,
    }))
    .sort((left, right) => (
      finiteNumber(left.atlasOrder, Number.MAX_SAFE_INTEGER)
      - finiteNumber(right.atlasOrder, Number.MAX_SAFE_INTEGER)
      || left.authoredOrder - right.authoredOrder
    ));
  return definitions.map(({ definition }, drawOrder) => {
    assert(definition.id, `drawable ${drawOrder} is missing its id`);
    assert(!seen.has(definition.id), `duplicate drawable ${definition.id}`);
    seen.add(definition.id);
    assert(groups.has(definition.group), `${definition.id} has unknown group`);
    const textureLayer = definition.textureLayer ?? definition.id;
    const atlasLayer = atlasLayers.get(textureLayer);
    assert(atlasLayer, `${definition.id} references missing atlas layer ${textureLayer}`);
    const bounds = normalizeRect(
      definition.bounds ?? atlasLayer.source,
      `${definition.id}.bounds`,
    );
    const layerRight = atlasLayer.source.x + atlasLayer.source.width;
    const layerBottom = atlasLayer.source.y + atlasLayer.source.height;
    assert(
      bounds.x >= atlasLayer.source.x
        && bounds.y >= atlasLayer.source.y
        && bounds.x + bounds.width <= layerRight
        && bounds.y + bounds.height <= layerBottom,
      `${definition.id} crop lies outside ${textureLayer}`,
    );
    return {
      id: definition.id,
      textureLayer,
      group: definition.group,
      drawOrder,
      clip: definition.clip ?? null,
      maskSource: Boolean(definition.maskSource),
      baseOpacity: clamp(finiteNumber(definition.opacity, 1), 0, 1),
      opacityBinding: compileOpacity(definition.opacityBinding, definition.id),
      deformers: (definition.deformers ?? []).map((deformer) => (
        compileDeformer(deformer, definition.id)
      )),
      bounds,
      mesh: createGrid(
        bounds,
        definition.grid,
        atlasLayer,
        { width: atlasLayout.width, height: atlasLayout.height },
      ),
    };
  });
}

export function compileRig(rig, atlasLayout) {
  validateRig(rig, atlasLayout);
  const parameters = compileParameters(rig);
  const parameterIds = new Set(Object.keys(parameters.defaults));
  for (const group of rig.groups) {
    for (const bindings of Object.values(group.bindings ?? {})) {
      for (const binding of bindings) {
        assert(
          parameterIds.has(binding.parameter),
          `group ${group.id} references unknown parameter ${binding.parameter}`,
        );
      }
    }
  }
  for (const drawable of rig.drawables) {
    for (const deformer of drawable.deformers ?? []) {
      assert(
        parameterIds.has(deformer.parameter),
        `drawable ${drawable.id} references unknown parameter ${deformer.parameter}`,
      );
    }
    if (drawable.opacityBinding) {
      assert(
        parameterIds.has(drawable.opacityBinding.parameter),
        `drawable ${drawable.id} opacity references unknown parameter`,
      );
    }
  }
  const groups = compileGroups(rig);
  const drawables = compileDrawables(rig, atlasLayout, groups);
  const clips = new Set(drawables.filter((part) => part.maskSource).map((part) => part.id));
  for (const drawable of drawables) {
    assert(
      drawable.clip === null || clips.has(drawable.clip),
      `${drawable.id} references unknown mask source ${drawable.clip}`,
    );
  }
  const compiled = {
    source: rig,
    atlasLayout,
    canvas: { ...rig.canvas },
    views: Object.fromEntries(
      Object.entries(rig.views).map(([name, view]) => [
        name,
        normalizeRect(view, `views.${name}`),
      ]),
    ),
    parameters,
    groups,
    drawables,
  };
  evaluateGroupMatrices(compiled, parameters.defaults);
  return compiled;
}

function evaluateBindingList(list, parameters) {
  let result = 0;
  for (const binding of list ?? []) {
    result += (
      finiteNumber(parameters[binding.parameter])
      * finiteNumber(binding.scale, 1)
      + finiteNumber(binding.offset)
    );
  }
  return result;
}

function makePivotMatrix(group) {
  const { pivot, transform, bindings } = group;
  const tx = transform.translateX + evaluateBindingList(
    bindings.translateX,
    group.parameters,
  );
  const ty = transform.translateY + evaluateBindingList(
    bindings.translateY,
    group.parameters,
  );
  const rotation = transform.rotation + evaluateBindingList(
    bindings.rotation,
    group.parameters,
  );
  const scaleBoth = evaluateBindingList(bindings.scale, group.parameters);
  const scaleX = transform.scaleX + scaleBoth + evaluateBindingList(
    bindings.scaleX,
    group.parameters,
  );
  const scaleY = transform.scaleY + scaleBoth + evaluateBindingList(
    bindings.scaleY,
    group.parameters,
  );

  const toPivot = mat3.fromTRS(pivot[0] + tx, pivot[1] + ty);
  const rotateScale = mat3.fromTRS(0, 0, rotation, scaleX, scaleY);
  const fromPivot = mat3.fromTRS(-pivot[0], -pivot[1]);
  return mat3.multiply(
    toPivot,
    mat3.multiply(rotateScale, fromPivot),
    group.localMatrix,
  );
}

export function evaluateGroupMatrices(compiledRig, inputParameters = {}) {
  const parameters = {
    ...compiledRig.parameters.defaults,
    ...inputParameters,
  };
  for (const [id, range] of Object.entries(compiledRig.parameters.ranges)) {
    parameters[id] = clamp(finiteNumber(parameters[id]), range[0], range[1]);
  }
  for (const group of compiledRig.groups.values()) {
    group.state = 0;
    group.parameters = parameters;
  }

  const visit = (group) => {
    if (group.state === 2) {
      return group.matrix;
    }
    assert(group.state !== 1, `group hierarchy contains a cycle at ${group.id}`);
    group.state = 1;
    makePivotMatrix(group);
    if (group.parent) {
      mat3.multiply(
        visit(compiledRig.groups.get(group.parent)),
        group.localMatrix,
        group.matrix,
      );
    } else {
      group.matrix.set(group.localMatrix);
    }
    group.state = 2;
    return group.matrix;
  };

  for (const group of compiledRig.groups.values()) {
    visit(group);
  }
  return parameters;
}

function keyformPair(keyforms, value) {
  if (value <= keyforms[0].value) {
    return [keyforms[0], keyforms[0], 0];
  }
  const last = keyforms[keyforms.length - 1];
  if (value >= last.value) {
    return [last, last, 0];
  }
  for (let index = 0; index < keyforms.length - 1; index += 1) {
    const left = keyforms[index];
    const right = keyforms[index + 1];
    if (value >= left.value && value <= right.value) {
      return [
        left,
        right,
        (value - left.value) / (right.value - left.value),
      ];
    }
  }
  return [last, last, 0];
}

function sampleOffset(offsets, columns, rows, u, v) {
  const x = clamp(u, 0, 1) * (columns - 1);
  const y = clamp(v, 0, 1) * (rows - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(columns - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const index00 = (y0 * columns + x0) * 2;
  const index10 = (y0 * columns + x1) * 2;
  const index01 = (y1 * columns + x0) * 2;
  const index11 = (y1 * columns + x1) * 2;
  return [
    lerp(
      lerp(offsets[index00], offsets[index10], tx),
      lerp(offsets[index01], offsets[index11], tx),
      ty,
    ),
    lerp(
      lerp(offsets[index00 + 1], offsets[index10 + 1], tx),
      lerp(offsets[index01 + 1], offsets[index11 + 1], tx),
      ty,
    ),
  ];
}

function applyCage(deformer, value, u, v) {
  const [left, right, amount] = keyformPair(deformer.keyforms, value);
  const offsetLeft = sampleOffset(
    left.offsets,
    deformer.columns,
    deformer.rows,
    u,
    v,
  );
  if (left === right) {
    return offsetLeft;
  }
  const offsetRight = sampleOffset(
    right.offsets,
    deformer.columns,
    deformer.rows,
    u,
    v,
  );
  return [
    lerp(offsetLeft[0], offsetRight[0], amount),
    lerp(offsetLeft[1], offsetRight[1], amount),
  ];
}

function applyAxisScale(deformer, value, x, y, u) {
  const [left, right, amount] = keyformPair(deformer.keyforms, value);
  const scale = lerp(left.scale, right.scale, amount);
  const scaleAlong = lerp(left.scaleAlong, right.scaleAlong, amount);
  const translate = lerp(left.translate, right.translate, amount);
  const curve = lerp(left.curve, right.curve, amount);
  const relativeX = x - deformer.center[0];
  const relativeY = y - deformer.center[1];
  const along = (
    relativeX * deformer.cosine + relativeY * deformer.sine
  );
  const normal = (
    -relativeX * deformer.sine + relativeY * deformer.cosine
  );
  const curvedNormal = (
    normal * scale
    + translate
    + curve * (Math.pow(u * 2 - 1, 2) - 0.5)
  );
  const scaledAlong = along * scaleAlong;
  const transformedX = (
    deformer.center[0]
    + scaledAlong * deformer.cosine
    - curvedNormal * deformer.sine
  );
  const transformedY = (
    deformer.center[1]
    + scaledAlong * deformer.sine
    + curvedNormal * deformer.cosine
  );
  return [transformedX - x, transformedY - y];
}

function evaluateOpacity(binding, parameters) {
  if (!binding) {
    return 1;
  }
  const value = finiteNumber(parameters[binding.parameter]);
  const [left, right, amount] = keyformPair(binding.keyforms, value);
  return lerp(left.opacity, right.opacity, amount);
}

export function deformDrawable(drawable, compiledRig, parameters) {
  const { mesh } = drawable;
  const matrix = compiledRig.groups.get(drawable.group).matrix;
  const temporary = new Float32Array(2);
  for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
    const offset = vertex * 2;
    const baseX = mesh.basePositions[offset];
    const baseY = mesh.basePositions[offset + 1];
    const u = mesh.normalized[offset];
    const v = mesh.normalized[offset + 1];
    let x = baseX;
    let y = baseY;

    for (const deformer of drawable.deformers) {
      const value = finiteNumber(parameters[deformer.parameter]);
      const cageU = deformer.domain
        ? (baseX - deformer.domain.x) / deformer.domain.width
        : u;
      const cageV = deformer.domain
        ? (baseY - deformer.domain.y) / deformer.domain.height
        : v;
      const delta = deformer.kind === "cage"
        ? applyCage(deformer, value, cageU, cageV)
        : applyAxisScale(deformer, value, baseX, baseY, u);
      x += delta[0];
      y += delta[1];
    }

    mat3.transformPoint(matrix, x, y, temporary);
    mesh.positions[offset] = temporary[0];
    mesh.positions[offset + 1] = temporary[1];
  }
  return drawable.baseOpacity * evaluateOpacity(
    drawable.opacityBinding,
    parameters,
  );
}

export function fitViewToAspect(view, aspect) {
  const fitted = { ...view };
  const viewAspect = view.width / view.height;
  if (aspect > viewAspect) {
    fitted.width = view.height * aspect;
    fitted.x = view.x - (fitted.width - view.width) / 2;
  } else if (aspect < viewAspect) {
    fitted.height = view.width / aspect;
    fitted.y = view.y - (fitted.height - view.height) / 2;
  }
  return fitted;
}

export function interpolateView(from, to, amount) {
  return {
    x: lerp(from.x, to.x, amount),
    y: lerp(from.y, to.y, amount),
    width: lerp(from.width, to.width, amount),
    height: lerp(from.height, to.height, amount),
  };
}
