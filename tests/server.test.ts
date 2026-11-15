import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CtxStore } from "../src/db.ts";
import { resolveRepoInfo, runGit } from "../src/git.ts";
import { startUiServer } from "../src/server.ts";

const tempDirs: string[] = [];
const originalEnvKey = process.env.GEMINI_API_KEY;
const originalCtxHome = process.env.CTX_HOME;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-srv-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (originalEnvKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalEnvKey;

  if (originalCtxHome === undefined) delete process.env.CTX_HOME;
  else process.env.CTX_HOME = originalCtxHome;

  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("UI HTTP Server", () => {
  test("serves UI, manages repos/notes/todos/hooks, and redacts Gemini key in config API", async () => {
    const tmp = makeTempDir();
    process.env.CTX_HOME = path.join(tmp, "ctx-home");
    delete process.env.GEMINI_API_KEY;

    const repoDir = path.join(tmp, "demo-repo");
    fs.mkdirSync(repoDir, { recursive: true });
    await runGit(repoDir, ["init", "-b", "main"]);
    await runGit(repoDir, ["config", "user.name", "Dev"]);
    await runGit(repoDir, ["config", "user.email", "dev@example.com"]);
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Demo\n", "utf8");
    await runGit(repoDir, ["add", "README.md"]);
    await runGit(repoDir, ["commit", "-m", "chore: initial"]);

    const info = await resolveRepoInfo(repoDir);
    expect(info).not.toBeNull();

    const store = new CtxStore();
    const server = startUiServer({
      store,
      cliEntryPath: path.resolve(import.meta.dir, "../src/cli.ts"),
      port: 0,
      geminiCaller: async () => ({ ok: true, text: "## Yesterday\n- Demo" }),
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;

      // Dashboard HTML
      const htmlRes = await fetch(`${baseUrl}/`);
      expect(htmlRes.status).toBe(200);
      expect(await htmlRes.text()).toContain("ctx — Git Context");

      // Register repo via API
      const addRes = await fetch(`${baseUrl}/api/repos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: repoDir }),
      });
      expect(addRes.status).toBe(201);
      const { repo } = (await addRes.json()) as { repo: { id: number; commonDir: string } };

      // Add note & todo via API
      const noteRes = await fetch(`${baseUrl}/api/context/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commonDir: repo.commonDir,
          branch: "main",
          content: "Verify deployment env vars",
        }),
      });
      expect(noteRes.status).toBe(201);

      const todoRes = await fetch(`${baseUrl}/api/context/todos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commonDir: repo.commonDir,
          branch: "main",
          text: "Write API smoke test",
        }),
      });
      expect(todoRes.status).toBe(201);
      const { todo } = (await todoRes.json()) as { todo: { id: number } };

      await fetch(`${baseUrl}/api/context/todos/${todo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ done: true }),
      });

      // Overview reflects saved context
      const ovRes = await fetch(`${baseUrl}/api/overview`);
      const ov = (await ovRes.json()) as {
        items: Array<{ currentBranchNotes: number; repo: { name: string } }>;
      };
      expect(ov.items).toHaveLength(1);
      expect(ov.items[0]?.currentBranchNotes).toBe(1);

      // Hook install via API
      const hookRes = await fetch(`${baseUrl}/api/repos/${repo.id}/hook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install" }),
      });
      expect(hookRes.status).toBe(200);
      const hookJson = (await hookRes.json()) as { hook: { installed: boolean } };
      expect(hookJson.hook.installed).toBe(true);

      // Save key in config -> response MUST NOT echo the raw secret back
      const cfgPut = await fetch(`${baseUrl}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ geminiKey: "super-secret-gemini-key", geminiModel: "gemini-2.5-flash" }),
      });
      const cfgBody = await cfgPut.text();
      expect(cfgBody).not.toContain("super-secret-gemini-key");
      const cfgParsed = JSON.parse(cfgBody) as { hasGeminiKey: boolean; keySource: string };
      expect(cfgParsed.hasGeminiKey).toBe(true);
      expect(cfgParsed.keySource).toBe("config");

      // Standup generation works via injected geminiCaller
      const stRes = await fetch(`${baseUrl}/api/standup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ since: "2d" }),
      });
      const stJson = (await stRes.json()) as { mode: string; markdown: string };
      expect(stJson.mode).toBe("gemini");
      expect(stJson.markdown).toContain("Demo");
    } finally {
      server.stop(true);
      store.close();
    }
  }, 15000);
});
