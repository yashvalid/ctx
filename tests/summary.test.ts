import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveLlmSettings } from "../src/config.ts";
import { CtxStore } from "../src/db.ts";
import { callGemini, callLlm } from "../src/gemini.ts";
import { resolveRepoInfo, runGit } from "../src/git.ts";
import {
  computeDefaultSince,
  generatePrSummary,
  generateStandupSummary,
  humanizeCommitSubject,
  parseSinceInput,
} from "../src/summary.ts";

const tempDirs: string[] = [];
const originalEnvKey = process.env.GEMINI_API_KEY;
const originalCtxHome = process.env.CTX_HOME;

function makeTempDir(prefix = "ctx-sum-test-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function setupSampleRepo(baseDir: string) {
  const repoDir = path.join(baseDir, "payments-api");
  fs.mkdirSync(repoDir, { recursive: true });
  await runGit(repoDir, ["init", "-b", "main"]);
  await runGit(repoDir, ["config", "user.name", "Alice"]);
  await runGit(repoDir, ["config", "user.email", "alice@company.com"]);

  fs.writeFileSync(path.join(repoDir, "index.ts"), "export const ok = true;\n", "utf8");
  await runGit(repoDir, ["add", "index.ts"]);
  await runGit(repoDir, ["commit", "-m", "chore: init repo"]);

  await runGit(repoDir, ["checkout", "-b", "feat/retries"]);
  fs.writeFileSync(
    path.join(repoDir, "retry.ts"),
    "const PROPRIETARY_SOURCE_DIFF_MARKER = 'NEVER_SEND_TO_GEMINI';\n",
    "utf8",
  );
  await runGit(repoDir, ["add", "retry.ts"]);
  await runGit(repoDir, ["commit", "-m", "feat: add exponential backoff retries"]);

  // Teammate commit that should be filtered out by default personal standup
  await runGit(repoDir, ["config", "user.name", "Bob"]);
  await runGit(repoDir, ["config", "user.email", "bob@company.com"]);
  fs.writeFileSync(path.join(repoDir, "bob.ts"), "export const bob = 1;\n", "utf8");
  await runGit(repoDir, ["add", "bob.ts"]);
  await runGit(repoDir, ["commit", "-m", "feat: bob unrelated task"]);

  // Switch git config back to Alice
  await runGit(repoDir, ["config", "user.name", "Alice"]);
  await runGit(repoDir, ["config", "user.email", "alice@company.com"]);

  const info = await resolveRepoInfo(repoDir);
  return { repoDir, info: info! };
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

describe("summary & gemini", () => {
  test("computeDefaultSince rolls Monday and Sunday back to Friday", () => {
    // 2026-11-16 is Monday
    const monday = new Date(2026, 10, 16, 9, 30);
    const monCut = computeDefaultSince(monday);
    expect(new Date(monCut.sinceIso).getDay()).toBe(5); // Friday
    expect(monCut.label).toContain("Fri");

    // 2026-11-15 is Sunday
    const sunday = new Date(2026, 10, 15, 11, 0);
    const sunCut = computeDefaultSince(sunday);
    expect(new Date(sunCut.sinceIso).getDay()).toBe(5);

    // 2026-11-18 is Wednesday -> Tuesday
    const wed = new Date(2026, 10, 18, 10, 0);
    const wedCut = computeDefaultSince(wed);
    expect(new Date(wedCut.sinceIso).getDay()).toBe(2);
    expect(wedCut.label).toBe("since yesterday");

    const rel = parseSinceInput("3d", wed);
    expect(rel.label).toBe("last 3d");
  });

  test("callGemini sends key via x-goog-api-key header (never query string) and extracts response", async () => {
    let seenUrl = "";
    let seenHeaderKey = "";

    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      const headers = new Headers(init?.headers);
      seenHeaderKey = headers.get("x-goog-api-key") ?? "";
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "## Yesterday\n- Shipped retry logic" }] } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await callGemini({
      apiKey: "test-secret-key",
      model: "gemini-2.5-flash",
      systemInstruction: "Be brief",
      prompt: "Summarize",
      fetchImpl: mockFetch,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("Shipped retry logic");
    }
    expect(seenUrl).not.toContain("test-secret-key");
    expect(seenHeaderKey).toBe("test-secret-key");
  });

  test("standup & PR generation enforce metadata-only privacy, author filtering, and offline fallback", async () => {
    const tmp = makeTempDir();
    process.env.CTX_HOME = path.join(tmp, "ctx-home");
    delete process.env.GEMINI_API_KEY;

    const { info } = await setupSampleRepo(tmp);
    const store = new CtxStore();

    try {
      const repo = store.upsertRepo(info);
      store.addNote(info.commonDir, "feat/retries", "Wait on gateway timeout spec");
      store.addTodo(info.commonDir, "feat/retries", "Add jitter unit test");
      store.setBranchLink(info.commonDir, "feat/retries", "https://github.com/org/pay/pull/99");

      // Without API key -> readable offline fallback (strips conventional prefixes & SHAs)
      const offline = await generateStandupSummary(store, { since: "2d" });
      expect(offline.mode).toBe("fallback");
      expect(offline.warning).toContain("GEMINI_API_KEY");
      expect(offline.markdown).toContain("### payments-api");
      expect(offline.markdown).toContain("- Add exponential backoff retries");
      expect(offline.markdown).not.toContain("feat: add exponential backoff retries");
      expect(offline.markdown).not.toContain("bob unrelated task");
      expect(offline.markdown).toContain("Add jitter unit test");
      expect(offline.markdown).toContain("## Notes & Blockers");

      // Strict metadata-only check on Gemini prompt!
      let capturedPrompt = "";
      const aiStandup = await generateStandupSummary(store, {
        since: "2d",
        config: {
          geminiKey: "fake-key",
          geminiModel: "gemini-2.5-flash",
          standupFormat: "markdown",
        },
        geminiCaller: async (req) => {
          capturedPrompt = req.prompt;
          return { ok: true, text: "## Yesterday\n- Added retry backoff" };
        },
      });

      expect(aiStandup.mode).toBe("gemini");
      expect(capturedPrompt).toContain("feat: add exponential backoff retries");
      expect(capturedPrompt).toContain("retry.ts");
      expect(capturedPrompt).not.toContain("PROPRIETARY_SOURCE_DIFF_MARKER");
      expect(capturedPrompt).not.toContain("NEVER_SEND_TO_GEMINI");

      // PR metadata also excludes source code text
      let capturedPrPrompt = "";
      const prOut = await generatePrSummary(store, repo, {
        config: {
          geminiKey: "fake-key",
          geminiModel: "gemini-2.5-flash",
          standupFormat: "markdown",
        },
        geminiCaller: async (req) => {
          capturedPrPrompt = req.prompt;
          return { ok: true, text: "# Retry backoff\n## Summary\nAdds retries." };
        },
      });
      expect(prOut.error).toBeUndefined();
      expect(prOut.result?.mode).toBe("gemini");
      expect(capturedPrPrompt).toContain("retry.ts");
      expect(capturedPrPrompt).toContain("https://github.com/org/pay/pull/99");
      expect(capturedPrPrompt).not.toContain("PROPRIETARY_SOURCE_DIFF_MARKER");
    } finally {
      store.close();
    }
  }, 15000);

  test("humanizeCommitSubject cleans conventional commit prefixes and callLlm supports OpenAI, Anthropic, and Ollama", async () => {
    expect(humanizeCommitSubject("feat(ui): add dark theme.")).toBe("Add dark theme");
    expect(humanizeCommitSubject("fix!: handle 429 retry-after")).toBe("Handle 429 retry-after");
    expect(humanizeCommitSubject("Refactor token cache")).toBe("Refactor token cache");

    // Provider isolation + key-optional local Ollama
    const openaiCfg = resolveLlmSettings({
      geminiModel: "gemini-2.5-flash",
      standupFormat: "markdown",
      llmProvider: "openai",
      llmModel: "gpt-4o-mini",
      llmApiKey: "sk-openai-only",
    });
    expect(openaiCfg.provider).toBe("openai");
    expect(openaiCfg.model).toBe("gpt-4o-mini");
    expect(openaiCfg.apiKey).toBe("sk-openai-only");

    const switchedToGemini = resolveLlmSettings(
      {
        geminiModel: "gemini-2.5-flash",
        standupFormat: "markdown",
        llmProvider: "openai",
        llmApiKey: "sk-openai-only",
      },
      { provider: "gemini" },
    );
    expect(switchedToGemini.apiKey).toBeUndefined();

    const ollamaCfg = resolveLlmSettings({
      geminiModel: "gemini-2.5-flash",
      standupFormat: "markdown",
      llmProvider: "ollama",
      llmModel: "llama3.2",
    });
    expect(ollamaCfg.isConfigured).toBe(true);
    expect(ollamaCfg.baseUrl).toBe("http://127.0.0.1:11434/v1");

    // OpenAI-compatible HTTP call
    let openAiUrl = "";
    let openAiAuth = "";
    const openAiRes = await callLlm({
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      systemInstruction: "Be clear",
      prompt: "Standup please",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        openAiUrl = String(url);
        openAiAuth = new Headers(init?.headers).get("Authorization") ?? "";
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "## Completed\n- Shipped retry backoff" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    expect(openAiRes.ok).toBe(true);
    expect(openAiUrl).toBe("https://api.openai.com/v1/chat/completions");
    expect(openAiAuth).toBe("Bearer sk-test");

    // Anthropic Messages API HTTP call
    let antUrl = "";
    let antKey = "";
    let antVer = "";
    const antRes = await callLlm({
      provider: "anthropic",
      apiKey: "sk-ant-test",
      model: "claude-sonnet-4-20250514",
      systemInstruction: "Be clear",
      prompt: "PR please",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        antUrl = String(url);
        const headers = new Headers(init?.headers);
        antKey = headers.get("x-api-key") ?? "";
        antVer = headers.get("anthropic-version") ?? "";
        return new Response(
          JSON.stringify({ content: [{ type: "text", text: "## Summary\nImproves retry resilience." }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });
    expect(antRes.ok).toBe(true);
    if (antRes.ok) expect(antRes.text).toContain("Improves retry resilience");
    expect(antUrl).toBe("https://api.anthropic.com/v1/messages");
    expect(antKey).toBe("sk-ant-test");
    expect(antVer).toBe("2023-06-01");
  });
});
