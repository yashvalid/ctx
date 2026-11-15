import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CtxStore } from "../src/db.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-db-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("CtxStore", () => {
  test("tracks repos, worktrees sharing commonDir, notes, todos, and links", () => {
    const tmp = makeTempDir();
    const dbFile = path.join(tmp, "ctx.db");
    const repoMain = path.join(tmp, "app");
    const repoWorktree = path.join(tmp, "app-wt");
    const commonGit = path.join(repoMain, ".git");
    fs.mkdirSync(commonGit, { recursive: true });
    fs.mkdirSync(repoWorktree, { recursive: true });

    const store = new CtxStore(dbFile);
    try {
      const r1 = store.upsertRepo({ rootPath: repoMain, commonDir: commonGit, name: "app" });
      const r2 = store.upsertRepo({
        rootPath: repoWorktree,
        commonDir: commonGit,
        name: "app-wt",
      });
      expect(r1.id).not.toBe(r2.id);
      expect(store.listRepos()).toHaveLength(2);

      // Notes & TODOs added on commonDir/branch are shared across worktrees
      const note = store.addNote(commonGit, "feat/auth", "Check JWT clock skew");
      const todo1 = store.addTodo(commonGit, "feat/auth", "Add refresh rotation test");
      const todo2 = store.addTodo(commonGit, "feat/auth", "Update docs");
      store.setBranchLink(commonGit, "feat/auth", "https://github.com/org/app/pull/42");
      store.recordBranchVisit(commonGit, "feat/auth");

      store.setTodoDone(todo1.id, true);

      const ctx = store.getBranchContext(commonGit, "feat/auth");
      expect(ctx.link).toBe("https://github.com/org/app/pull/42");
      expect(ctx.lastVisitedAt).not.toBeNull();
      expect(ctx.notes.map((n) => n.content)).toEqual(["Check JWT clock skew"]);
      expect(ctx.todos).toHaveLength(2);
      expect(ctx.todos.find((t) => t.id === todo1.id)?.done).toBe(true);
      expect(ctx.todos.find((t) => t.id === todo2.id)?.done).toBe(false);

      // Update & delete operations
      const edited = store.updateNote(note.id, "Check JWT skew + leeway");
      expect(edited?.content).toBe("Check JWT skew + leeway");
      expect(store.deleteTodo(todo2.id)).toBe(true);
      expect(store.getOpenTodosForRepo(commonGit)).toHaveLength(0);

      const recentDone = store.getCompletedTodosSince(
        commonGit,
        new Date(Date.now() - 60_000).toISOString(),
      );
      expect(recentDone).toHaveLength(1);
      expect(recentDone[0]?.text).toBe("Add refresh rotation test");

      const summaries = store.listBranchSummaries(commonGit);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.noteCount).toBe(1);
      expect(summaries[0]?.doneTodoCount).toBe(1);

      expect(store.clearNotes(commonGit, "feat/auth")).toBe(1);
      expect(store.getBranchContext(commonGit, "feat/auth").notes).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("manages watched directories cleanly", () => {
    const tmp = makeTempDir();
    const store = new CtxStore(path.join(tmp, "ctx.db"));
    try {
      const w = store.addWatchedDir(tmp);
      expect(store.listWatchedDirs()).toHaveLength(1);
      expect(store.removeWatchedDir(String(w.id))).toBe(true);
      expect(store.listWatchedDirs()).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
