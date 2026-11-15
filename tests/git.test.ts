import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverGitRepos,
  getCommitMetadataSince,
  getHookStatus,
  getPrMetadata,
  getRepoStatus,
  installPostCheckoutHook,
  resolveRepoInfo,
  runGit,
  sanitizeRemoteUrl,
  uninstallPostCheckoutHook,
} from "../src/git.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix = "ctx-git-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function initRepo(dir: string, branch = "main"): Promise<void> {
  await runGit(dir, ["init", "-b", branch]);
  await runGit(dir, ["config", "user.name", "Test Engineer"]);
  await runGit(dir, ["config", "user.email", "engineer@example.com"]);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("git helpers", () => {
  test("sanitizeRemoteUrl strips embedded HTTP credentials and preserves SSH remotes", () => {
    expect(sanitizeRemoteUrl("https://user:ghp_secret123@github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git",
    );
    expect(sanitizeRemoteUrl("git@github.com:org/repo.git")).toBe("git@github.com:org/repo.git");
    expect(sanitizeRemoteUrl(null)).toBeNull();
  });

  test("handles unborn repo, dirty working tree, metadata-only commit logs, and PR numstat", async () => {
    const repoDir = makeTempDir();
    await initRepo(repoDir, "main");

    // Works even with zero commits (unborn HEAD)
    const unbornInfo = await resolveRepoInfo(repoDir);
    expect(unbornInfo).not.toBeNull();
    expect(unbornInfo?.branch).toBe("main");

    // Initial commit on main
    fs.writeFileSync(path.join(repoDir, "app.ts"), "export const v = 1;\n", "utf8");
    await runGit(repoDir, ["add", "app.ts"]);
    await runGit(repoDir, ["commit", "-m", "chore: initial app"]);

    // Feature branch with code containing sensitive secret string
    await runGit(repoDir, ["checkout", "-b", "feat/billing"]);
    const secretLine = "const PRIVATE_ALGO_SECRET = 'do-not-leak-source';\n";
    fs.writeFileSync(path.join(repoDir, "billing.ts"), secretLine, "utf8");
    await runGit(repoDir, ["add", "billing.ts"]);
    await runGit(repoDir, ["commit", "-m", "feat: add invoice rounding"]);

    // Dirty uncommitted file
    fs.writeFileSync(path.join(repoDir, "notes.tmp"), "wip\n", "utf8");
    fs.writeFileSync(path.join(repoDir, "app.ts"), "export const v = 2;\n", "utf8");

    const status = await getRepoStatus(repoDir);
    expect(status.branch).toBe("feat/billing");
    expect(status.modified).toBe(1);
    expect(status.untracked).toBe(1);
    expect(status.lastCommit?.subject).toBe("feat: add invoice rounding");

    // Commit metadata must NEVER contain source file contents
    const commits = await getCommitMetadataSince(
      repoDir,
      new Date(Date.now() - 3600_000).toISOString(),
      "engineer@example.com",
    );
    expect(commits.length).toBeGreaterThanOrEqual(2);
    const billingCommit = commits.find((c) => c.subject === "feat: add invoice rounding");
    expect(billingCommit).toBeDefined();
    expect(billingCommit?.files).toEqual([{ status: "A", path: "billing.ts" }]);
    expect(JSON.stringify(commits)).not.toContain("PRIVATE_ALGO_SECRET");

    // PR metadata compares against main using numstat only (zero source code lines)
    const pr = await getPrMetadata(repoDir);
    expect(pr.error).toBeUndefined();
    expect(pr.data?.baseBranch).toBe("main");
    expect(pr.data?.branch).toBe("feat/billing");
    expect(pr.data?.commits.map((c) => c.subject)).toEqual(["feat: add invoice rounding"]);
    expect(pr.data?.files).toEqual([{ added: 1, deleted: 0, path: "billing.ts" }]);
    expect(JSON.stringify(pr.data)).not.toContain("PRIVATE_ALGO_SECRET");
  });

  test("discovers repos in watched parent folders and skips node_modules", async () => {
    const workspace = makeTempDir("ctx-watch-");
    const repoA = path.join(workspace, "service-a");
    const nestedB = path.join(workspace, "group", "service-b");
    const ignoredRepo = path.join(workspace, "service-a", "node_modules", "pkg");

    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(nestedB, { recursive: true });
    fs.mkdirSync(ignoredRepo, { recursive: true });

    await initRepo(repoA);
    await initRepo(nestedB);
    await initRepo(ignoredRepo);

    const found = await discoverGitRepos([workspace]);
    const names = found.map((r) => r.name).sort();
    expect(names).toEqual(["service-a", "service-b"]);
  });

  test("installs and uninstalls post-checkout hook without clobbering existing hook content", async () => {
    const repoDir = makeTempDir();
    await initRepo(repoDir);

    const hookFile = path.join(repoDir, ".git", "hooks", "post-checkout");
    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    fs.writeFileSync(hookFile, "#!/bin/sh\necho 'custom existing hook'\n", "utf8");

    const installed = await installPostCheckoutHook(repoDir, path.join(repoDir, "cli.ts"));
    expect(installed.installed).toBe(true);
    expect(installed.hasOtherHookContent).toBe(true);

    const text = fs.readFileSync(hookFile, "utf8");
    expect(text).toContain("custom existing hook");
    expect(text).toContain("# >>> ctx-hook >>>");
    expect(text).not.toContain("\r\n");

    // Re-installing stays idempotent
    await installPostCheckoutHook(repoDir, path.join(repoDir, "cli.ts"));
    const reRead = fs.readFileSync(hookFile, "utf8");
    expect(reRead.match(/# >>> ctx-hook >>>/g)?.length).toBe(1);

    // Uninstalling removes ctx block while keeping custom hook
    const afterRemove = await uninstallPostCheckoutHook(repoDir);
    expect(afterRemove.installed).toBe(false);
    expect(afterRemove.hasOtherHookContent).toBe(true);
    expect(fs.readFileSync(hookFile, "utf8")).toContain("custom existing hook");
    expect(fs.readFileSync(hookFile, "utf8")).not.toContain("ctx-hook");

    // Installing when no hook existed removes file cleanly on uninstall
    fs.unlinkSync(hookFile);
    await installPostCheckoutHook(repoDir, path.join(repoDir, "cli.ts"));
    expect((await getHookStatus(repoDir)).installed).toBe(true);
    await uninstallPostCheckoutHook(repoDir);
    expect(fs.existsSync(hookFile)).toBe(false);
  });
});
