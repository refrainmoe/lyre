#!/usr/bin/env node

// Publishing through npm would run the lifecycle hook but then pack the
// workspace manifest itself, bypassing pnpm's workspace-range rewriting.
// Refuse that path and route every public publish through the pinned pnpm
// release gate.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packageManagerMatch = /^pnpm@(\d+\.\d+\.\d+)$/.exec(rootManifest.packageManager ?? "");
if (!packageManagerMatch || rootManifest.engines?.pnpm !== packageManagerMatch[1]) {
  process.stderr.write(
    "The root packageManager and engines.pnpm pins must be the same exact version.\n",
  );
  process.exit(1);
}
const expectedPnpm = packageManagerMatch[1];
const userAgent = process.env.npm_config_user_agent ?? "";
const execPath = process.env.npm_execpath ?? "";
if (
  !userAgent.startsWith(`pnpm/${expectedPnpm} `) ||
  !/(?:^|[/\\])pnpm(?:\.[cm]?js)?$/.test(execPath)
) {
  process.stderr.write(
    `Lyre packages must be published with pnpm ${expectedPnpm} from the repository workspace.\n`,
  );
  process.exit(1);
}

const result = spawnSync("pnpm", ["--dir", root, "release:check"], {
  stdio: "inherit",
  env: process.env,
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
