import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDailyBuckets, collectActivityFeed, runGlobalSearch, toLocalDateKey } from "../src/activity.ts";
import { CtxStore } from "../src/db.ts";
import { resolveRepoInfo, runGit } from "../src/git.ts";

const tempDirs: string[] = [];
const originalCtxHome = process.env.CTX_HOME;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-act-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalCtxHome === undefined) delete process.env.CTX_HOME;
  else process.env.CTX_HOME = originalCtxHome;

  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("Activity Feed & Global Search", () => {
  test("buildDailyBuckets aggregates commits, notes, and TODOs in local calendar days", () => {
    const now = new Date(2026, 4, 15, 14, 0, 0);
    const todayKey = toLocalDateKey(now)!;
    const yesterday = new Date(2026, 4, 14, 10, 0, 0);
    const yesterdayKey = toLocalDateKey(yesterday)!;

    const buckets = buildDailyBuckets(
      14,
      [{ committedAt: now.toISOString() }, { committedAt: yesterday.toISOString() }],
      [{ createdAt: now.toISOString() }],
      [{ createdAt: yesterday.toISOString(), completedAt: now.toISOString() }],
      now,
    );

    expect(buckets.length).toBe(14);
    expect(buckets[buckets.length - 1]!.date).toBe(todayKey);

    const todayBucket = buckets.find((b) => b.date === todayKey)!;
    expect(todayBucket.commits).toBe(1);
    expect(todayBucket.notes).toBe(1);
    expect(todayBucket.todos).toBe(1);
    expect(todayBucket.total).toBe(3);

    const yesterdayBucket = buckets.find((b) => b.date === yesterdayKey)!;
    expect(yesterdayBucket.commits).toBe(1);
    expect(yesterdayBucket.total).toBe(1);
  });

  test("searchContext escapes SQL LIKE wildcards and searches notes, TODOs, and links", async () => {
    const tmp = makeTempDir();
    process.env.CTX_HOME = path.join(tmp, "ctx-home");

    const store = new CtxStore();
    try {
      const fakeDir = path.join(tmp, "repo-a", ".git");
      store.addNote(fakeDir, "feat/perf", "100% cache hit achieved");
      store.addNote(fakeDir, "feat/perf", "Completely unrelated entry");
      store.addTodo(fakeDir, "feat/perf", "Check _underscore_ token");
      store.setBranchLink(fakeDir, "feat/perf", "https://linear.app/org/issue/ENG-42");

      const pctHits = store.searchContext("100%");
      expect(pctHits.length).toBe(1);
      expect(pctHits[0]!.text).toContain("100% cache hit");

      const underHits = store.searchContext("_underscore_");
      expect(underHits.length).toBe(1);
      expect(underHits[0]!.kind).toBe("todo");

      const linkHits = store.searchContext("ENG-42");
      expect(linkHits.length).toBe(1);
      expect(linkHits[0]!.kind).toBe("link");
    } finally {
      store.close();
    }
  });

  test("collectActivityFeed and runGlobalSearch span repos, respect fixed-strings & author filters", async () => {
    const tmp = makeTempDir();
    process.env.CTX_HOME = path.join(tmp, "ctx-home");

    const repoA = path.join(tmp, "api-service");
    const repoB = path.join(tmp, "web-app");
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });

    await runGit(repoA, ["init", "-b", "main"]);
    await runGit(repoA, ["config", "user.name", "Alice"]);
    await runGit(repoA, ["config", "user.email", "alice@example.com"]);
    fs.writeFileSync(path.join(repoA, "server.ts"), "export const ok = true;\n", "utf8");
    await runGit(repoA, ["add", "server.ts"]);
    await runGit(repoA, ["commit", "-m", "fix(auth): validate JWT signature [v2]"]);

    await runGit(repoB, ["init", "-b", "main"]);
    await runGit(repoB, ["config", "user.name", "Alice"]);
    await runGit(repoB, ["config", "user.email", "alice@example.com"]);
    fs.writeFileSync(path.join(repoB, "app.ts"), "export const ui = 1;\n", "utf8");
    await runGit(repoB, ["add", "app.ts"]);
    await runGit(repoB, ["commit", "-m", "feat(ui): render dashboard header"]);

    // Add a commit by a different author in repoB
    await runGit(repoB, ["-c", "user.name=Bob", "-c", "user.email=bob@example.com", "commit", "--allow-empty", "-m", "fix(auth): handle bob session"]);

    const infoA = (await resolveRepoInfo(repoA))!;
    const infoB = (await resolveRepoInfo(repoB))!;

    const store = new CtxStore();
    try {
      store.upsertRepo(infoA);
      store.upsertRepo(infoB);
      store.addNote(infoA.commonDir, "main", "Coordinate auth rollout with mobile team");
      store.addTodo(infoB.commonDir, "main", "Audit auth cookies before release");

      const feed = await collectActivityFeed(store, { since: "14d" });
      expect(feed.days.length).toBe(14);
      expect(feed.commits.length).toBe(2); // Bob filtered out by default
      expect(feed.contextEvents.length).toBe(2);

      const allFeed = await collectActivityFeed(store, { since: "14d", allAuthors: true });
      expect(allFeed.commits.length).toBe(3);

      // Search using regex metacharacters (`fix(auth):`, `[v2]`) to verify --fixed-strings works
      const metaSearch = await runGlobalSearch(store, "fix(auth): validate JWT signature [v2]");
      expect(metaSearch.commitHits.length).toBe(1);
      expect(metaSearch.commitHits[0]!.repoName).toBe("api-service");

      // Search across both notes/todos and commits
      const authDefault = await runGlobalSearch(store, "auth");
      expect(authDefault.contextHits.length).toBe(2);
      expect(authDefault.commitHits.length).toBe(1);

      const authAll = await runGlobalSearch(store, "auth", { allAuthors: true });
      expect(authAll.commitHits.length).toBe(2);
    } finally {
      store.close();
    }
  }, 15000);
});
