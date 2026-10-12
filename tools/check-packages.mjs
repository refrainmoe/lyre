#!/usr/bin/env node

// Public-package smoke test: begin without ignored build output, run each
// package's real prepack hook, then inspect the tarball rather than trusting
// the source package.json. This catches exports or bins that point nowhere.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageNames = ["core", "render-soft", "render-webgl", "schemas", "validate"];
const scratch = mkdtempSync(join(tmpdir(), "lyre-pack-check-"));
const expectedPackageManager = "pnpm@11.15.1";
const publicVersion = "0.1.0";
const sharedCorePackages = new Set(["render-soft", "render-webgl", "validate"]);
const rootLicense = readFileSync(join(root, "LICENSE"), "utf8");
const expectedRuntimeRanges = {
  core: [],
  "render-soft": ["peerDependencies:@refrain-lyre/core:^0.1.0"],
  "render-webgl": ["peerDependencies:@refrain-lyre/core:^0.1.0"],
  schemas: [],
  validate: [
    "dependencies:@refrain-lyre/render-soft:0.1.0",
    "dependencies:@refrain-lyre/schemas:0.1.0",
    "dependencies:ajv:^8.20.0",
    "dependencies:pngjs:^7.0.0",
    "dependencies:yauzl:^3.2.0",
    "peerDependencies:@refrain-lyre/core:^0.1.0",
  ],
};

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result.stdout;
}

function collectExportTargets(value, exportKey, out) {
  if (typeof value === "string") out.push({ exportKey, target: value });
  else if (Array.isArray(value)) {
    for (const item of value) collectExportTargets(item, exportKey, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectExportTargets(item, exportKey, out);
  }
  return out;
}

function publishedExports(value) {
  const out = [];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value);
    if (entries.some(([key]) => key.startsWith("."))) {
      for (const [key, target] of entries) {
        if (key.startsWith(".")) collectExportTargets(target, key, out);
      }
      return out;
    }
  }
  return collectExportTargets(value, ".", out);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Match Node export targets, where every target `*` receives the same replacement. */
function wildcardTargetRegex(target) {
  const archivePattern = `package/${target.replace(/^\.\//, "")}`;
  const parts = archivePattern.split("*");
  let source = escapeRegex(parts[0]);
  if (parts.length > 1) {
    source += "(.+)";
    for (let index = 1; index < parts.length; index++) {
      source += escapeRegex(parts[index]);
      if (index < parts.length - 1) source += "\\1";
    }
  }
  return new RegExp(`^${source}$`);
}

try {
  const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (rootManifest.name !== "@refrain-lyre/monorepo" || rootManifest.private !== true) {
    throw new Error("root package must remain the private @refrain-lyre/monorepo workspace");
  }
  if (rootManifest.packageManager !== expectedPackageManager) {
    throw new Error(`packageManager must remain pinned to ${expectedPackageManager}`);
  }
  if (rootManifest.engines?.pnpm !== expectedPackageManager.slice("pnpm@".length)) {
    throw new Error(`engines.pnpm must remain pinned to ${expectedPackageManager}`);
  }
  const actualPnpm = run("pnpm", ["--version"], root).trim();
  if (`pnpm@${actualPnpm}` !== expectedPackageManager) {
    throw new Error(
      `release check requires ${expectedPackageManager}, but pnpm@${actualPnpm} is active`,
    );
  }
  const refusedNpmPublish = spawnSync(process.execPath, [join(root, "tools", "prepublish.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_user_agent: "npm/11.0.0 node/v22.0.0 linux x64",
      npm_execpath: "/usr/bin/npm",
    },
  });
  if (refusedNpmPublish.error) throw refusedNpmPublish.error;
  if (refusedNpmPublish.status !== 1 || !refusedNpmPublish.stderr.includes("must be published")) {
    throw new Error("tools/prepublish.mjs must refuse publishing through npm");
  }

  const tarballs = new Map();
  for (const name of packageNames) {
    const packageDir = join(root, "packages", name);
    const sourceManifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    if (sourceManifest.publishConfig?.access !== "public") {
      throw new Error(`@refrain-lyre/${name}: publishConfig.access must be public`);
    }
    if (sourceManifest.publishConfig?.registry !== "https://registry.npmjs.org/") {
      throw new Error(
        `@refrain-lyre/${name}: publishConfig.registry must pin the public npm registry`,
      );
    }
    if (sourceManifest.scripts?.prepublishOnly !== "node ../../tools/prepublish.mjs") {
      throw new Error(`@refrain-lyre/${name}: publish must be guarded by tools/prepublish.mjs`);
    }
    if (
      sharedCorePackages.has(name) &&
      sourceManifest.devDependencies?.["@refrain-lyre/core"] !== "workspace:*"
    ) {
      throw new Error(
        `@refrain-lyre/${name}: local builds require @refrain-lyre/core as a workspace devDependency`,
      );
    }
    rmSync(join(packageDir, "dist"), { recursive: true, force: true });

    const before = new Set(readdirSync(scratch));
    run("pnpm", ["pack", "--pack-destination", scratch], packageDir);
    const created = readdirSync(scratch).filter(
      (entry) => !before.has(entry) && entry.endsWith(".tgz"),
    );
    if (created.length !== 1) {
      throw new Error(`@refrain-lyre/${name}: expected one tarball, found ${created.length}`);
    }

    const tarball = join(scratch, created[0]);
    tarballs.set(name, tarball);
    const listing = new Set(run("tar", ["-tzf", tarball], root).trim().split("\n"));
    const packedManifest = JSON.parse(run("tar", ["-xOzf", tarball, "package/package.json"], root));
    if (
      packedManifest.name !== `@refrain-lyre/${name}` ||
      packedManifest.version !== publicVersion ||
      packedManifest.private === true ||
      packedManifest.license !== "Unlicense" ||
      packedManifest.type !== "module" ||
      typeof packedManifest.description !== "string" ||
      packedManifest.description.length === 0
    ) {
      throw new Error(`@refrain-lyre/${name}: packed identity or release metadata is invalid`);
    }
    if (
      packedManifest.publishConfig?.access !== "public" ||
      packedManifest.publishConfig?.registry !== "https://registry.npmjs.org/"
    ) {
      throw new Error(`@refrain-lyre/${name}: packed publish target is not public npm`);
    }
    if (!listing.has("package/LICENSE")) {
      throw new Error(`@refrain-lyre/${name}: public tarball is missing LICENSE`);
    }
    if (!listing.has("package/README.md")) {
      throw new Error(`@refrain-lyre/${name}: public tarball is missing README.md`);
    }
    const packedLicense = run("tar", ["-xOzf", tarball, "package/LICENSE"], root);
    if (packedLicense !== rootLicense) {
      throw new Error(`@refrain-lyre/${name}: packed LICENSE differs from the repository license`);
    }
    if (packedManifest.engines?.node !== ">=22") {
      throw new Error(`@refrain-lyre/${name}: engines.node must be >=22`);
    }
    if (
      packedManifest.repository?.url !== "git+https://github.com/refrainmoe/lyre.git" ||
      packedManifest.repository?.directory !== `packages/${name}` ||
      packedManifest.bugs?.url !== "https://github.com/refrainmoe/lyre/issues" ||
      packedManifest.homepage !==
        `https://github.com/refrainmoe/lyre/tree/master/packages/${name}#readme`
    ) {
      throw new Error(
        `@refrain-lyre/${name}: repository, homepage, or bugs metadata is incomplete`,
      );
    }
    for (const section of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
      "devDependencies",
    ]) {
      for (const [dependency, range] of Object.entries(packedManifest[section] ?? {})) {
        if (typeof range === "string" && range.startsWith("workspace:")) {
          throw new Error(
            `@refrain-lyre/${name}: ${section}.${dependency} still uses unpublished range ${range}`,
          );
        }
      }
    }
    if (sharedCorePackages.has(name)) {
      if (packedManifest.dependencies?.["@refrain-lyre/core"] !== undefined) {
        throw new Error(
          `@refrain-lyre/${name}: @refrain-lyre/core must not be a runtime dependency`,
        );
      }
      if (packedManifest.peerDependencies?.["@refrain-lyre/core"] !== "^0.1.0") {
        throw new Error(
          `@refrain-lyre/${name}: @refrain-lyre/core must be a ^0.1.0 peer dependency`,
        );
      }
    }

    const actualRuntimeRanges = [];
    for (const section of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [dependency, range] of Object.entries(packedManifest[section] ?? {})) {
        actualRuntimeRanges.push(`${section}:${dependency}:${String(range)}`);
      }
    }
    actualRuntimeRanges.sort();
    const expectedRanges = [...expectedRuntimeRanges[name]].sort();
    if (JSON.stringify(actualRuntimeRanges) !== JSON.stringify(expectedRanges)) {
      throw new Error(
        `@refrain-lyre/${name}: packed runtime dependency graph is ${JSON.stringify(actualRuntimeRanges)}, expected ${JSON.stringify(expectedRanges)}`,
      );
    }

    const expectedBin = name === "validate" ? { "lyre-validate": "./dist/cli.js" } : undefined;
    if (JSON.stringify(packedManifest.bin) !== JSON.stringify(expectedBin)) {
      throw new Error(`@refrain-lyre/${name}: packed bin metadata is invalid`);
    }
    const expectedExportKeys = name === "schemas" ? [".", "./schemas/*.json"] : ["."];
    const actualExportKeys = Object.keys(packedManifest.exports ?? {}).sort();
    if (JSON.stringify(actualExportKeys) !== JSON.stringify(expectedExportKeys.sort())) {
      throw new Error(`@refrain-lyre/${name}: packed export surface is invalid`);
    }

    const targets = publishedExports(packedManifest.exports);
    const binTargets = [];
    if (typeof packedManifest.bin === "string") binTargets.push(packedManifest.bin);
    else if (packedManifest.bin && typeof packedManifest.bin === "object") {
      binTargets.push(...Object.values(packedManifest.bin));
    }

    for (const { exportKey, target } of targets) {
      if (target.includes("*")) {
        if (!exportKey.includes("*")) {
          throw new Error(
            `@refrain-lyre/${name}: wildcard target ${target} has no wildcard export key`,
          );
        }
        const regex = wildcardTargetRegex(target);
        const matches = [...listing].filter((entry) => regex.test(entry));
        if (matches.length === 0) {
          throw new Error(
            `@refrain-lyre/${name}: wildcard target ${target} matches no packed files`,
          );
        }
        for (const archivePath of matches) {
          const wildcard = archivePath.match(regex)?.[1];
          if (!wildcard) throw new Error(`@refrain-lyre/${name}: could not resolve ${target}`);
          const concreteTarget = `package/${target.replace(/^\.\//, "").replaceAll("*", wildcard)}`;
          if (!listing.has(concreteTarget)) {
            throw new Error(
              `@refrain-lyre/${name}: ${exportKey.replaceAll("*", wildcard)} resolves to absent ${concreteTarget}`,
            );
          }
        }
        continue;
      }
      const archivePath = `package/${target.replace(/^\.\//, "")}`;
      if (!listing.has(archivePath)) {
        throw new Error(
          `@refrain-lyre/${name}: published target ${target} is absent from its tarball`,
        );
      }
    }
    for (const target of binTargets) {
      const archivePath = `package/${target.replace(/^\.\//, "")}`;
      if (!listing.has(archivePath)) {
        throw new Error(
          `@refrain-lyre/${name}: published bin ${target} is absent from its tarball`,
        );
      }
    }

    if (listing.has("package/README.md")) {
      const readme = run("tar", ["-xOzf", tarball, "package/README.md"], root);
      if (/\]\(\.\.\//.test(readme)) {
        throw new Error(`@refrain-lyre/${name}: packed README contains a monorepo-relative link`);
      }
    }

    if (name === "validate") {
      const library = run("tar", ["-xOzf", tarball, "package/dist/index.js"], root);
      const cli = run("tar", ["-xOzf", tarball, "package/dist/cli.js"], root);
      if (!/from\s+["']@refrain-lyre\/core["']/.test(library)) {
        throw new Error("@refrain-lyre/validate: library must externalize @refrain-lyre/core");
      }
      if (/from\s+["']@refrain-lyre\/(?:core|render-soft|schemas)["']/.test(cli)) {
        throw new Error("@refrain-lyre/validate: CLI must remain self-contained");
      }
    }
    process.stdout.write(`PACK OK @refrain-lyre/${name}\n`);
  }

  const consumerTypeScript = `import { loadModel, type EvalFrame, type Model } from "@refrain-lyre/core";
import { createSoftRenderer } from "@refrain-lyre/render-soft";
import { createWebGLRenderer } from "@refrain-lyre/render-webgl";
import { schemasByKind } from "@refrain-lyre/schemas";
import manifestSchema from "@refrain-lyre/schemas/schemas/manifest.schema.json" with { type: "json" };
import { decodeSurfacePng, type FileSource } from "@refrain-lyre/validate";

const source: FileSource = {
  files: () => [],
  has: () => false,
  read: () => new Uint8Array(),
  size: () => 0,
  close: () => {},
};
void [loadModel, createSoftRenderer, createWebGLRenderer, schemasByKind, manifestSchema, source];
decodeSurfacePng(new Uint8Array());

declare const borrowedModel: Model;
// @ts-expect-error normalized model collections are borrowed and read-only
borrowedModel.params.pop();
// @ts-expect-error normalized model entries are borrowed and read-only
borrowedModel.params[0]!.min = 0;
// @ts-expect-error normalized node children are borrowed and read-only
borrowedModel.root.children.push(borrowedModel.root);
// @ts-expect-error normalized binding buffers reject direct writes
borrowedModel.bindings[0]!.values[0] = 0;
// @ts-expect-error normalized binding buffers omit in-place mutators
borrowedModel.bindings[0]!.values.fill(0);
// @ts-expect-error normalized binding buffers hide mutable backing storage
borrowedModel.bindings[0]!.values.buffer;

declare const borrowedFrame: EvalFrame;
// @ts-expect-error evaluated draw lists are borrowed and read-only
borrowedFrame.drawList.pop();
// @ts-expect-error evaluated geometry buffers reject direct writes
borrowedFrame.drawList[0]!.positions[0] = 0;
// @ts-expect-error evaluated geometry buffers omit in-place mutators
borrowedFrame.drawList[0]!.positions.fill(0);
// @ts-expect-error evaluated geometry buffers hide mutable backing storage
borrowedFrame.drawList[0]!.positions.buffer;
// @ts-expect-error nested frame metadata is borrowed and read-only
borrowedFrame.drawList[0]!.mask!.group = 0;
`;
  const consumerRuntime = `import assert from "node:assert/strict";
import { LyreLoadError } from "@refrain-lyre/core";
import { createSoftRenderer } from "@refrain-lyre/render-soft";
import { createWebGLRenderer } from "@refrain-lyre/render-webgl";
import { schemasByKind } from "@refrain-lyre/schemas";
import manifestSchema from "@refrain-lyre/schemas/schemas/manifest.schema.json" with { type: "json" };
import { loadContainerFromSource } from "@refrain-lyre/validate";

assert.equal(typeof createSoftRenderer, "function");
assert.equal(typeof createWebGLRenderer, "function");
assert.equal(manifestSchema.$id, schemasByKind.manifest.$id);

const encoder = new TextEncoder();
const documents = new Map([
  ["manifest.json", encoder.encode("{}")],
  ["rig.json", encoder.encode("{}")],
]);
const source = {
  files: () => [...documents.keys()],
  has: (path) => documents.has(path),
  read: (path) => documents.get(path),
  size: (path) => documents.get(path).byteLength,
  close: () => {},
};
let caught;
try {
  loadContainerFromSource(source);
} catch (error) {
  caught = error;
}
assert.ok(caught instanceof LyreLoadError, "validator and consumer must share LyreLoadError");
`;
  const consumerTsconfig = `${JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        types: [],
        resolveJsonModule: true,
      },
      include: ["consumer.ts"],
    },
    null,
    2,
  )}\n`;

  function writeConsumerFixtures(directory) {
    writeFileSync(join(directory, "tsconfig.json"), consumerTsconfig);
    writeFileSync(join(directory, "consumer.ts"), consumerTypeScript);
    writeFileSync(join(directory, "runtime.mjs"), consumerRuntime);
  }

  // Type-check the packed artifacts exactly as a consumer with no ambient
  // @types/node package. This catches public declarations that leak Buffer or
  // other undeclared platform globals while still exercising package exports.
  const consumer = join(scratch, "consumer");
  const scopeDir = join(consumer, "node_modules", "@refrain-lyre");
  mkdirSync(scopeDir, { recursive: true });
  for (const [name, tarball] of tarballs) {
    const destination = join(scopeDir, name);
    mkdirSync(destination);
    run("tar", ["-xzf", tarball, "--strip-components=1", "-C", destination], root);
  }
  for (const dependency of ["ajv", "pngjs", "yauzl"]) {
    symlinkSync(
      realpathSync(join(root, "packages", "validate", "node_modules", dependency)),
      join(consumer, "node_modules", dependency),
      "junction",
    );
  }
  writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  writeConsumerFixtures(consumer);
  run(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", consumer],
    root,
  );
  process.stdout.write("TYPE OK clean packed-package consumer\n");

  run(process.execPath, [join(consumer, "runtime.mjs")], consumer);
  process.stdout.write("RUNTIME OK packed exports and shared @refrain-lyre/core identity\n");

  // Exercise a real package-manager install as well as the deliberately
  // minimal extracted layout above. Installing all five tarballs together
  // proves that their rewritten dependency and peer ranges form a resolvable
  // public graph; --offline ensures this check never depends on registry state.
  const installedConsumer = join(scratch, "installed-consumer");
  mkdirSync(installedConsumer);
  const installedDependencies = Object.fromEntries(
    [...tarballs].map(([name, tarball]) => [`@refrain-lyre/${name}`, `file:${tarball}`]),
  );
  // Do not override @refrain-lyre/core: it is a peer, and replacing its semver peer
  // request with a file: request would make pnpm compare protocols instead of
  // proving that the packed 0.1.0 package satisfies ^0.1.0.
  const installedOverrides = Object.fromEntries(
    Object.entries(installedDependencies).filter(([name]) => name !== "@refrain-lyre/core"),
  );
  for (const dependency of ["ajv", "pngjs", "yauzl"]) {
    installedOverrides[dependency] =
      `link:${realpathSync(join(root, "packages", "validate", "node_modules", dependency))}`;
  }
  writeFileSync(
    join(installedConsumer, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        type: "module",
        packageManager: expectedPackageManager,
        dependencies: installedDependencies,
      },
      null,
      2,
    )}\n`,
  );
  // pnpm 11 reads workspace settings from pnpm-workspace.yaml rather than the
  // legacy package.json `pnpm` field. Keep every dependency local so this
  // consumer proves the packed graph without consulting registry metadata.
  const overrideSettings = Object.entries(installedOverrides)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([dependency, target]) => `  ${JSON.stringify(dependency)}: ${JSON.stringify(target)}`)
    .join("\n");
  writeFileSync(
    join(installedConsumer, "pnpm-workspace.yaml"),
    `packages:\n  - .\noverrides:\n${overrideSettings}\n`,
  );
  writeConsumerFixtures(installedConsumer);
  run(
    "pnpm",
    ["install", "--offline", "--ignore-scripts", "--strict-peer-dependencies"],
    installedConsumer,
  );
  run(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", installedConsumer],
    root,
  );
  run(process.execPath, [join(installedConsumer, "runtime.mjs")], installedConsumer);
  const binName = process.platform === "win32" ? "lyre-validate.cmd" : "lyre-validate";
  const help = run(
    join(installedConsumer, "node_modules", ".bin", binName),
    ["--help"],
    installedConsumer,
  );
  if (!help.includes("lyre-validate") || !help.includes("model.lyre")) {
    throw new Error("@refrain-lyre/validate: installed CLI help is missing expected usage text");
  }
  process.stdout.write("INSTALL OK offline tarball graph, types, runtime, and CLI bin\n");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
