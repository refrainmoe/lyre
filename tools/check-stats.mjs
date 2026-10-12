#!/usr/bin/env node

// Keep conformance/STATS.md's explanatory preamble while making its generated
// §16 table reproducible and freshness-checkable. The validator CLI is already
// built before this runs in CI; `pnpm stats:write` builds it for local use.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = join(root, "conformance", "STATS.md");
const cliPath = join(root, "packages", "validate", "dist", "cli.js");
const tableMarker = "| §16 quantity";

function fail(message) {
  process.stderr.write(`stats freshness: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--write") || args.filter((arg) => arg === "--write").length > 1) {
  fail("usage: node tools/check-stats.mjs [--write]");
}
const write = args.includes("--write");

if (!existsSync(cliPath)) {
  fail(
    'packages/validate/dist/cli.js is missing; run "pnpm --filter @refrain-lyre/validate build" first',
  );
}

const { runCli } = await import(pathToFileURL(cliPath).href);
let stdout = "";
let stderr = "";
const status = await runCli(["stats", join(root, "conformance"), "--markdown"], {
  stdout: { write: (text) => (stdout += text) },
  stderr: { write: (text) => (stderr += text) },
});
if (status !== 0) {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  fail(`validator stats command failed with exit code ${String(status)}`);
}

const generatedTableAt = stdout.indexOf(tableMarker);
if (generatedTableAt < 0) fail("validator stats output contains no §16 Markdown table");
const generatedTable = stdout.slice(generatedTableAt);

const current = readFileSync(reportPath, "utf8");
const currentTableAt = current.indexOf(tableMarker);
if (currentTableAt < 0) fail("conformance/STATS.md contains no replaceable §16 Markdown table");
const expected = current.slice(0, currentTableAt) + generatedTable;

if (expected === current) {
  process.stdout.write("STATS OK conformance/STATS.md\n");
} else if (write) {
  writeFileSync(reportPath, expected);
  process.stdout.write("UPDATED conformance/STATS.md\n");
} else {
  fail('conformance/STATS.md is stale; run "pnpm stats:write" and commit the result');
}
