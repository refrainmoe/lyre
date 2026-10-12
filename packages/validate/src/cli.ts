#!/usr/bin/env node
// lyre-validate CLI entry point (§12).

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runConformance } from "./conformance.js";
import { validateModelPath } from "./validate.js";
import { computeStats, mergeStats, statsMarkdown, type ModelStats } from "./stats.js";
import { loadContainer } from "./container.js";

const USAGE = `lyre-validate — Lyrical Refrain model validator

Usage:
  lyre-validate <model-dir | model.lyre> [--json]
  lyre-validate conformance <corpus-dir> [--regen] [--filter <substr>]
  lyre-validate stats <model-or-corpus...> [--markdown]
  lyre-validate --stats <model-or-corpus...> [--markdown]

Exit codes: 0 valid/pass, 1 errors found, 2 usage.
`;

export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

class UsageError extends Error {}

function fail(message?: string): never {
  throw new UsageError(message);
}

/** Expand a model path or a conformance corpus into concrete model paths. */
function statsTargets(path: string): string[] {
  const stat = statSync(path);
  if (!stat.isDirectory() || existsSync(join(path, "manifest.json"))) return [path];

  const nestedModels = join(path, "models");
  const modelRoot =
    existsSync(nestedModels) && statSync(nestedModels).isDirectory() ? nestedModels : path;
  const targets = readdirSync(modelRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        (entry.isFile() && entry.name.endsWith(".lyre")) ||
        (entry.isDirectory() &&
          (entry.name.endsWith(".lyre") ||
            existsSync(join(modelRoot, entry.name, "manifest.json")))),
    )
    .map((entry) => join(modelRoot, entry.name))
    .sort();
  if (targets.length === 0) {
    fail(`stats found no models in corpus directory ${path}`);
  }
  return targets;
}

async function cmdValidate(args: string[], io: CliIo): Promise<number> {
  let target: string | undefined;
  let json = false;
  for (const a of args) {
    if (a === "--json") json = true;
    else if (a.startsWith("--")) fail(`unknown option ${a}`);
    else if (target === undefined) target = a;
    else fail(`unexpected argument ${a}`);
  }
  if (target === undefined) fail("missing model path");

  const report = await validateModelPath(target);
  if (json) {
    io.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    for (const issue of report.issues) {
      const tag = issue.level === "error" ? "ERROR" : "warn ";
      const at = issue.id !== undefined ? ` [${issue.id}]` : "";
      io.stdout.write(`${tag} ${issue.code}${at}: ${issue.message}\n`);
    }
    const errors = report.issues.filter((i) => i.level === "error").length;
    const warnings = report.issues.length - errors;
    io.stdout.write(
      `${report.ok ? "VALID" : "INVALID"} ${target} — ${errors} error(s), ${warnings} warning(s)\n`,
    );
  }
  return report.ok ? 0 : 1;
}

function cmdConformance(args: string[], io: CliIo): number {
  let dir: string | undefined;
  let regen = false;
  let filter: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--regen") regen = true;
    else if (a === "--filter") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) fail("--filter requires a value");
      filter = value;
      i++;
    } else if (a.startsWith("--")) fail(`unknown option ${a}`);
    else if (dir === undefined) dir = a;
    else fail(`unexpected argument ${a}`);
  }
  if (dir === undefined) fail("conformance requires a corpus directory");

  const report = runConformance(dir, { regen, ...(filter !== undefined ? { filter } : {}) });
  for (const issue of report.issues) {
    io.stderr.write(`FAIL ${issue.timeline}: ${issue.message}\n`);
  }
  const verb = regen ? "regenerated goldens for" : "checked";
  io.stdout.write(`${verb} ${report.ran.length} timeline(s); ${report.issues.length} issue(s)\n`);
  return report.issues.length > 0 ? 1 : 0;
}

async function cmdStats(args: string[], io: CliIo): Promise<number> {
  let markdown = false;
  const paths: string[] = [];
  for (const a of args) {
    if (a === "--markdown") markdown = true;
    else if (a.startsWith("--")) fail(`unknown option ${a}`);
    else paths.push(a);
  }
  if (paths.length === 0) fail("stats requires at least one model path");

  const targets = paths.flatMap(statsTargets);
  const all: ModelStats[] = [];
  for (const p of targets) {
    const container = await loadContainer(p);
    try {
      all.push(computeStats(container));
    } finally {
      container.source.close();
    }
  }
  const merged = mergeStats(all);
  if (markdown) {
    const title =
      targets.length === 1
        ? `§16 observed maxima — ${paths[0]}`
        : `§16 observed maxima — ${targets.length} models`;
    io.stdout.write(statsMarkdown(merged, title));
  } else {
    io.stdout.write(JSON.stringify(merged, null, 2) + "\n");
  }
  return 0;
}

export async function runCli(argv: string[], io: CliIo = process): Promise<number> {
  try {
    if (argv[0] === "--help" || argv[0] === "-h") {
      io.stdout.write(USAGE);
      return 0;
    }
    if (argv.length === 0) fail();
    if (argv[0] === "conformance") return cmdConformance(argv.slice(1), io);
    if (argv[0] === "stats" || argv[0] === "--stats") {
      return await cmdStats(argv.slice(1), io);
    }
    return await cmdValidate(argv, io);
  } catch (error) {
    if (error instanceof UsageError) {
      if (error.message) io.stderr.write(`lyre-validate: ${error.message}\n\n`);
      io.stderr.write(USAGE);
      return 2;
    }
    const detail = error instanceof Error ? error.message : String(error);
    io.stderr.write(`lyre-validate: ${detail}\n`);
    return 1;
  }
}

let isMain = false;
if (process.argv[1] !== undefined) {
  try {
    // Resolve both sides so an npm/pnpm bin symlink still executes normally.
    isMain = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    isMain = false;
  }
}
if (isMain) process.exitCode = await runCli(process.argv.slice(2));
