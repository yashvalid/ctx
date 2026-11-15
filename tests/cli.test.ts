import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../src/cli.ts";
import { runGit } from "../src/git.ts";

const tempDirs: string[] = [];
const originalCtxHome = process.env.CTX_HOME;
const originalEnvKey = process.env.GEMINI_API_KEY;

function makeTempDir(prefix = "ctx-cli-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalCtxHome === undefined) delete process.env.CTX_HOME;
  else process.env.CTX_HOME = originalCtxHome;

  if (originalEnvKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalEnvKey;

  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("CLI end-to-end", () => {
  test("tracks repo, saves notes/todos/links, installs hook, and recalls context on real git checkout", async () => {
    const tmp = makeTempDir();
    process.env.CTX_HOME = path.join(tmp, "ctx-home");
    delete process.env.GEMINI_API_KEY;

    const repoDir = path.join(tmp, "api-svc");
    fs.mkdirSync(repoDir, { recursive: true });
    await runGit(repoDir, ["init", "-b", "main"]);
    await runGit(repoDir, ["config", "user.name", "Alice"]);
    await runGit(repoDir, ["config", "user.email", "alice@example.com"]);
    fs.writeFileSync(path.join(repoDir, "main.ts"), "console.log('hi');\n", "utf8");
    await runGit(repoDir, ["add", "main.ts"]);
    await runGit(repoDir, ["commit", "-m", "chore: initial"]);

    await runGit(repoDir, ["checkout", "-b", "feat/cache"]);
    fs.writeFileSync(path.join(repoDir, "cache.ts"), "export const ttl = 60;\n", "utf8");
    await runGit(repoDir, ["add", "cache.ts"]);
    await runGit(repoDir, ["commit", "-m", "feat: add ttl cache"]);

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));

    try {
      expect(await runCli(["note", "Check Redis eviction policy"], repoDir)).toBe(0);
      expect(await runCli(["todo", "Benchmark cache hit rate"], repoDir)).toBe(0);
      expect(await runCli(["link", "https://linear.app/team/issue/ENG-101"], repoDir)).toBe(0);
      expect(await runCli(["hook", "install"], repoDir)).toBe(0);
      expect(await runCli(["status", "--json"], repoDir)).toBe(0);
      expect(await runCli(["search", "Redis"], repoDir)).toBe(0);
      expect(await runCli(["search", "ttl cache", "--json"], repoDir)).toBe(0);
      expect(await runCli(["activity", "--since", "7d"], repoDir)).toBe(0);
      expect(await runCli(["standup", "--raw"], repoDir)).toBe(0);
      expect(await runCli(["pr", "--raw"], repoDir)).toBe(0);
    } finally {
      console.log = origLog;
    }

    const joined = logs.join("\n");
    expect(joined).toContain("Saved note");
    expect(joined).toContain("Added TODO");
    expect(joined).toContain("ENG-101");
    expect(joined).toContain("Benchmark cache hit rate");
    expect(joined).toContain("feat: add ttl cache");
    expect(joined).toContain("Search:");
    expect(joined).toContain("Recent Activity");

    // Verify real git checkout triggers the installed post-checkout hook without error
    const toMain = await runGit(repoDir, ["checkout", "main"]);
    expect(toMain.ok).toBe(true);
    const backToFeat = await runGit(repoDir, ["checkout", "feat/cache"]);
    expect(backToFeat.ok).toBe(true);
    const hookOutput = `${backToFeat.stdout}\n${backToFeat.stderr}`;
    expect(hookOutput).toContain("Check Redis eviction policy");
    expect(hookOutput).toContain("Benchmark cache hit rate");
  }, 15000);
});
