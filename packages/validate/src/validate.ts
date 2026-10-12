// `lyre-validate <model>` orchestration (§12): container safety and bounded
// JSON reads → normative loader ceilings/integrity/shapes → schemas → texture
// checks → lints → rest-pose check → stats.

import { statSync } from "node:fs";
import { LyreLoadError, loadModel, type Model, type PremultipliedImage } from "@refrain-lyre/core";
import {
  addTexturePixels,
  atlasConsistencyProblems,
  checkContainerPath,
  decodePngBuffer,
  dirFileSource,
  inspectPngBuffer,
  readPngBytes,
  readRawDocs,
  zipFileSource,
  type FileSource,
  type LoadedContainer,
} from "./container.js";
import { validateSchemas } from "./schema.js";
import { lintModel } from "./lints.js";
import { checkRestPose } from "./restpose.js";
import { computeStats } from "./stats.js";
import {
  CATASTROPHIC_CHANNEL_TOLERANCE,
  CATASTROPHIC_REGION_PIXEL_LIMIT,
  CHANNEL_TOLERANCE,
} from "./conformance.js";
import type { ValidationIssue, ValidationReport } from "./report.js";

const MAX_TEXTURE_DIAGNOSTICS = 256;

function errorIssue(code: string, message: string, id?: string): ValidationIssue {
  return id !== undefined
    ? { level: "error", code, message, id }
    : { level: "error", code, message };
}

/** Validate a container (unpacked directory or packed `.lyre` ZIP). */
export async function validateModelPath(path: string): Promise<ValidationReport> {
  const issues: ValidationIssue[] = [];
  const report: ValidationReport = { path, ok: false, issues, stats: null };
  const done = (): ValidationReport => {
    report.ok = !issues.some((i) => i.level === "error");
    return report;
  };

  // 1. Container access (§16: path safety, symlinks, entry count, inflation).
  let source: FileSource;
  try {
    const st = statSync(path);
    source = st.isDirectory() ? dirFileSource(path) : await zipFileSource(path);
  } catch (e) {
    issues.push(errorIssue("container", (e as Error).message));
    return done();
  }

  try {
    // 2. Raw documents (JSON parse + per-file size ceiling).
    let raw: ReturnType<typeof readRawDocs>;
    try {
      raw = readRawDocs(source);
    } catch (e) {
      issues.push(errorIssue("container", (e as Error).message));
      return done();
    }

    // 3. Normative load: cheap §16 aggregate ceilings, referential integrity,
    // and shapes run before AJV traverses every document. This prevents a
    // schema-valid but aggregate-invalid model from amplifying schema work.
    let model: Model;
    try {
      model = loadModel(raw.raw);
    } catch (e) {
      if (e instanceof LyreLoadError) {
        issues.push(errorIssue(e.code, e.message, e.id));
      } else {
        issues.push(errorIssue("load", (e as Error).message));
      }
      return done();
    }
    for (const w of model.warnings) {
      issues.push({ level: "warning", code: "load", message: w });
    }

    // 4. Published JSON Schemas (§12), now over a normatively bounded model.
    issues.push(...validateSchemas(raw.raw, raw.rawPaths));

    // 5. Texture files: existence, decode, §16 dimension ceiling.
    const textures = new Map<string, PremultipliedImage>();
    const attemptedTextures = new Set<string>();
    let textureError = false;
    let textureDiagnostics = 0;
    let textureDiagnosticsTruncated = false;
    const textureIssue = (issue: ValidationIssue): boolean => {
      if (textureDiagnostics < MAX_TEXTURE_DIAGNOSTICS) {
        issues.push(issue);
        textureDiagnostics++;
        return true;
      }
      if (!textureDiagnosticsTruncated) {
        textureDiagnosticsTruncated = true;
        issues.push({
          level: issue.level,
          code: "texture_analysis_truncated",
          message: `texture/atlas analysis stopped after ${MAX_TEXTURE_DIAGNOSTICS} diagnostics; additional files or rects were omitted`,
        });
      }
      return false;
    };
    let decodedTexturePixels = 0;
    for (const sprite of model.sprites) {
      if (attemptedTextures.has(sprite.texture)) continue;
      attemptedTextures.add(sprite.texture);
      const rel = `textures/${sprite.texture}.png`;
      try {
        const bytes = readPngBytes(source, rel);
        const nextTexturePixels = addTexturePixels(
          decodedTexturePixels,
          inspectPngBuffer(bytes, rel),
          rel,
        );
        // Reserve inspected pixels before full decode. A CRC/filter failure
        // must not let many large corrupt files bypass the aggregate budget.
        decodedTexturePixels = nextTexturePixels;
        const decoded = decodePngBuffer(bytes, rel);
        textures.set(sprite.texture, decoded);
      } catch (e) {
        textureError = true;
        if (!textureIssue(errorIssue("bad_texture", (e as Error).message, sprite.texture))) break;
      }
    }
    let atlasImage: PremultipliedImage | null = null;
    if (model.atlas && !textureDiagnosticsTruncated) {
      try {
        checkContainerPath(model.atlas.image);
        const bytes = readPngBytes(source, model.atlas.image);
        const nextTexturePixels = addTexturePixels(
          decodedTexturePixels,
          inspectPngBuffer(bytes, model.atlas.image),
          model.atlas.image,
        );
        decodedTexturePixels = nextTexturePixels;
        atlasImage = decodePngBuffer(bytes, model.atlas.image);
        // Normative checks run before optional unused-rect warnings, so the
        // diagnostic cap can never hide an invalid referenced crop.
        for (const problem of atlasConsistencyProblems(model.atlas, textures, atlasImage)) {
          textureError = true;
          if (!textureIssue(errorIssue("bad_atlas", problem.message, problem.id))) break;
        }
        for (const id of textureDiagnosticsTruncated ? [] : model.atlas.rects.keys()) {
          if (!attemptedTextures.has(id)) {
            if (
              !textureIssue({
                level: "warning",
                code: "unused_atlas_rect",
                message: `atlas rect "${id}" is not referenced by any sprite; consistency was not checked`,
                id,
              })
            ) {
              break;
            }
          }
        }
        for (const id of textureDiagnosticsTruncated ? [] : textures.keys()) {
          if (!model.atlas.rects.has(id)) {
            if (
              !textureIssue({
                level: "warning",
                code: "bad_atlas",
                message: `texture "${id}" has no atlas rect; atlas-based runtimes fall back to the file`,
                id,
              })
            ) {
              break;
            }
          }
        }
      } catch (e) {
        textureError = true;
        textureIssue(errorIssue("bad_atlas", (e as Error).message));
      }
    }

    const container: LoadedContainer = {
      model,
      textures,
      atlasImage,
      raw: raw.raw,
      rawPaths: raw.rawPaths,
      source,
    };

    // 6. Lints (§12): draw-order hazards, excludable mask sources.
    try {
      issues.push(...lintModel(model));
    } catch (e) {
      issues.push(
        errorIssue(
          e instanceof RangeError ? "limit_exceeded" : "lint",
          `lint analysis failed: ${(e as Error).message}`,
        ),
      );
    }

    // 7. Rest-pose check (§12): all-defaults render vs flat layer composite.
    if (!textureError) {
      try {
        const cmp = checkRestPose(container);
        if (!cmp.pass) {
          issues.push(
            errorIssue(
              "rest_pose",
              `rest pose diverges from the exported-layer composite: ${cmp.outOfTolerancePixels}/${cmp.totalPixels} pixels out of ±${CHANNEL_TOLERANCE}/255; ${cmp.catastrophicPixels} pixels exceed ±${CATASTROPHIC_CHANNEL_TOLERANCE}/255, largest 8-connected region ${cmp.largestCatastrophicRegion}/${CATASTROPHIC_REGION_PIXEL_LIMIT} pixels (max channel diff ${cmp.maxChannelDiff})`,
            ),
          );
        }
      } catch (e) {
        issues.push(
          errorIssue(
            e instanceof RangeError ? "limit_exceeded" : "rest_pose",
            `rest-pose validation failed: ${(e as Error).message}`,
          ),
        );
      }
    }

    // 8. §16 observed maxima.
    try {
      report.stats = computeStats(container);
    } catch (e) {
      // Directory sources deliberately re-check identity/timestamps on every
      // metadata read. A file replaced after the initial safety scan must
      // become a normal validation error, not escape the validator promise.
      issues.push(errorIssue("container", (e as Error).message));
    }
    return done();
  } finally {
    source.close();
  }
}
