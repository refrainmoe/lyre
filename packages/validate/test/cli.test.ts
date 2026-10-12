import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { baseDocs, tempDir, writeFixture } from "./helpers.js";

async function invoke(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const status = await runCli(args, {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });
  return { status, stdout, stderr };
}

describe("built lyre-validate CLI", () => {
  it("prints --help successfully", async () => {
    const result = await invoke("--help");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).toBe("");
  });

  it("accepts --stats and expands a conformance corpus directory", async () => {
    const corpus = tempDir();
    const models = join(corpus, "models");
    mkdirSync(models);
    renameSync(writeFixture(baseDocs()), join(models, "fixture.lyre"));

    const result = await invoke("--stats", corpus);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const stats = JSON.parse(result.stdout) as { nodes: number; containerFiles: number };
    expect(stats.nodes).toBe(2);
    expect(stats.containerFiles).toBe(3);
  });

  it("emits a formatter-stable Markdown stats table", async () => {
    const model = writeFixture(baseDocs());

    const result = await invoke("--stats", model, "--markdown");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const tableLines = result.stdout.split("\n").filter((line) => line.startsWith("|"));
    expect(new Set(tableLines.map((line) => line.length))).toHaveLength(1);
    expect(result.stdout).toContain("aggregate manifest-listed JSON document bytes");
  });

  it("rejects --filter when the following token is another option", async () => {
    const corpus = tempDir();

    const result = await invoke("conformance", corpus, "--filter", "--regen");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--filter requires a value");
  });

  it("returns a conformance failure for a corpus with no timelines", async () => {
    const corpus = tempDir();
    mkdirSync(join(corpus, "timelines"));

    const result = await invoke("conformance", corpus);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("contains no *.timeline.json files");
    expect(result.stdout).toContain("checked 0 timeline(s); 1 issue(s)");
  });

  it("returns a conformance failure when a supplied filter matches no timelines", async () => {
    const corpus = tempDir();
    mkdirSync(join(corpus, "timelines"));
    writeFileSync(join(corpus, "timelines", "live.timeline.json"), "{}\n");

    const result = await invoke("conformance", corpus, "--filter", "missing");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('filter "missing" matched no timeline files');
    expect(result.stdout).toContain("checked 0 timeline(s); 1 issue(s)");
  });

  it("reports stats filesystem failures without an unhandled stack trace", async () => {
    const missing = join(tempDir(), "missing.lyre");

    const result = await invoke("stats", missing);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("lyre-validate:");
    expect(result.stderr).toContain("ENOENT");
    expect(result.stderr).not.toContain(" at ");
    expect(result.stderr).not.toContain("Usage:");
  });
});
