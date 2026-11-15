import fs from "node:fs";
import path from "node:path";
import {
  isLlmProvider,
  loadConfig,
  type LlmProvider,
  redactConfig,
  saveConfig,
  type StandupFormat,
} from "./config.ts";
import type { CtxStore } from "./db.ts";
import {
  fetchRepo,
  getHookStatus,
  getRepoStatus,
  installPostCheckoutHook,
  listLocalBranches,
  resolveCurrentBranch,
  resolveRepoInfo,
  uninstallPostCheckoutHook,
} from "./git.ts";
import { collectActivityFeed, runGlobalSearch } from "./activity.ts";
import {
  type GeminiCaller,
  generatePrSummary,
  generateStandupSummary,
} from "./summary.ts";
import { collectRepoOverview, syncWatchedDirs } from "./sync.ts";

const UI_HTML_PATH = path.join(import.meta.dir, "ui.html");

export interface ServerOptions {
  store: CtxStore;
  cliEntryPath: string;
  port?: number;
  geminiCaller?: GeminiCaller;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function badRequest(message: string, status = 400): Response {
  return json({ error: message }, status);
}

async function readJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

function parseIdParam(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Start the localhost-only HTTP server serving the web dashboard and REST API. */
export function startUiServer(options: ServerOptions) {
  const { store, cliEntryPath, geminiCaller } = options;
  const port = options.port ?? 4312;

  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;
      const method = req.method.toUpperCase();

      if (method === "GET" && pathname === "/") {
        return new Response(Bun.file(UI_HTML_PATH), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // Overview across tracked + watched repositories
      if (method === "GET" && pathname === "/api/overview") {
        const doSync = url.searchParams.get("sync") === "1";
        const doFetch = url.searchParams.get("fetch") === "1";
        const dirtyOnly = url.searchParams.get("dirty") === "1";

        if (doSync) {
          await syncWatchedDirs(store);
        }
        if (doFetch) {
          const repos = store.listRepos();
          await Promise.all(repos.map((r) => fetchRepo(r.rootPath)));
        }

        const items = await collectRepoOverview(store, { dirtyOnly });
        return json({ items });
      }

      // Register repo
      if (method === "POST" && pathname === "/api/repos") {
        const body = await readJsonBody<{ path?: string }>(req);
        const rawPath = body?.path?.trim();
        if (!rawPath) return badRequest("path is required");
        if (!fs.existsSync(rawPath)) return badRequest(`Path does not exist: ${rawPath}`, 404);
        const info = await resolveRepoInfo(rawPath);
        if (!info) return badRequest(`Not a git repository: ${rawPath}`);
        const repo = store.upsertRepo(info);
        return json({ repo }, 201);
      }

      // Repo-scoped routes: /api/repos/:id/(context|fetch|hook) or DELETE /api/repos/:id
      const repoMatch = /^\/api\/repos\/(\d+)(?:\/(context|fetch|hook))?$/.exec(pathname);
      if (repoMatch) {
        const repoId = parseIdParam(repoMatch[1]);
        const sub = repoMatch[2];
        if (!repoId) return badRequest("Invalid repository id");

        const repo = store.getRepoById(repoId);
        if (!repo) return badRequest("Repository not found", 404);

        if (method === "DELETE" && !sub) {
          store.removeRepo(repoId);
          return json({ ok: true });
        }

        if (method === "GET" && sub === "context") {
          const [status, currentBranch, localBranches, hook] = await Promise.all([
            getRepoStatus(repo.rootPath),
            resolveCurrentBranch(repo.rootPath),
            listLocalBranches(repo.rootPath),
            getHookStatus(repo.rootPath),
          ]);
          const selectedBranch = url.searchParams.get("branch")?.trim() || currentBranch;
          const context = store.getBranchContext(repo.commonDir, selectedBranch);
          const branchSummaries = store.listBranchSummaries(repo.commonDir);

          return json({
            repo,
            status,
            currentBranch,
            selectedBranch,
            localBranches,
            branchSummaries,
            context,
            hook,
          });
        }

        if (method === "POST" && sub === "fetch") {
          const res = await fetchRepo(repo.rootPath);
          if (!res.ok) return badRequest(res.message, 502);
          return json({ ok: true, message: res.message });
        }

        if (method === "POST" && sub === "hook") {
          const body = await readJsonBody<{ action?: string }>(req);
          if (body?.action === "install") {
            const hook = await installPostCheckoutHook(repo.rootPath, cliEntryPath);
            return json({ hook });
          }
          if (body?.action === "uninstall") {
            const hook = await uninstallPostCheckoutHook(repo.rootPath);
            return json({ hook });
          }
          return badRequest("action must be 'install' or 'uninstall'");
        }
      }

      // Watched folders
      if (method === "GET" && pathname === "/api/watch") {
        return json({ dirs: store.listWatchedDirs() });
      }
      if (method === "POST" && pathname === "/api/watch") {
        const body = await readJsonBody<{ dirPath?: string }>(req);
        const dirPath = body?.dirPath?.trim();
        if (!dirPath) return badRequest("dirPath is required");
        if (!fs.existsSync(dirPath)) return badRequest(`Folder does not exist: ${dirPath}`, 404);
        const dir = store.addWatchedDir(dirPath);
        await syncWatchedDirs(store);
        return json({ dir }, 201);
      }
      if (method === "DELETE" && pathname === "/api/watch") {
        const idOrPath = url.searchParams.get("id") || url.searchParams.get("dirPath");
        if (!idOrPath) return badRequest("id or dirPath query parameter is required");
        const removed = store.removeWatchedDir(idOrPath);
        if (!removed) return badRequest("Watched folder not found", 404);
        return json({ ok: true });
      }

      // Notes CRUD
      if (method === "POST" && pathname === "/api/context/notes") {
        const body = await readJsonBody<{ commonDir?: string; branch?: string; content?: string }>(req);
        if (!body?.commonDir || !body?.branch || !body?.content?.trim()) {
          return badRequest("commonDir, branch, and content are required");
        }
        const note = store.addNote(body.commonDir, body.branch, body.content);
        return json({ note }, 201);
      }
      const noteMatch = /^\/api\/context\/notes\/(\d+)$/.exec(pathname);
      if (noteMatch) {
        const id = parseIdParam(noteMatch[1]);
        if (!id) return badRequest("Invalid note id");
        if (method === "PUT") {
          const body = await readJsonBody<{ content?: string }>(req);
          if (!body?.content?.trim()) return badRequest("content is required");
          const note = store.updateNote(id, body.content);
          if (!note) return badRequest("Note not found", 404);
          return json({ note });
        }
        if (method === "DELETE") {
          if (!store.deleteNote(id)) return badRequest("Note not found", 404);
          return json({ ok: true });
        }
      }

      // TODOs CRUD
      if (method === "POST" && pathname === "/api/context/todos") {
        const body = await readJsonBody<{ commonDir?: string; branch?: string; text?: string }>(req);
        if (!body?.commonDir || !body?.branch || !body?.text?.trim()) {
          return badRequest("commonDir, branch, and text are required");
        }
        const todo = store.addTodo(body.commonDir, body.branch, body.text);
        return json({ todo }, 201);
      }
      const todoMatch = /^\/api\/context\/todos\/(\d+)$/.exec(pathname);
      if (todoMatch) {
        const id = parseIdParam(todoMatch[1]);
        if (!id) return badRequest("Invalid todo id");
        if (method === "PATCH") {
          const body = await readJsonBody<{ done?: boolean; text?: string }>(req);
          let todo = null;
          if (typeof body?.done === "boolean") {
            todo = store.setTodoDone(id, body.done);
          }
          if (typeof body?.text === "string" && body.text.trim()) {
            todo = store.updateTodoText(id, body.text);
          }
          if (!todo) return badRequest("TODO not found or no updates provided", 404);
          return json({ todo });
        }
        if (method === "DELETE") {
          if (!store.deleteTodo(id)) return badRequest("TODO not found", 404);
          return json({ ok: true });
        }
      }

      // Link PUT
      if (method === "PUT" && pathname === "/api/context/link") {
        const body = await readJsonBody<{ commonDir?: string; branch?: string; link?: string | null }>(req);
        if (!body?.commonDir || !body?.branch) {
          return badRequest("commonDir and branch are required");
        }
        store.setBranchLink(body.commonDir, body.branch, body.link ?? null);
        return json({ ok: true });
      }

      // Standup generation
      if (method === "POST" && pathname === "/api/standup") {
        const body = await readJsonBody<{
          since?: string;
          allAuthors?: boolean;
          repoIds?: number[];
          format?: StandupFormat;
          raw?: boolean;
          provider?: string;
          model?: string;
        }>(req);
        const provider = body?.provider && isLlmProvider(body.provider) ? body.provider : undefined;
        const result = await generateStandupSummary(store, {
          since: body?.since,
          allAuthors: body?.allAuthors,
          repoIds: body?.repoIds,
          format: body?.format,
          raw: body?.raw,
          provider,
          model: body?.model,
          geminiCaller,
        });
        return json(result);
      }

      // PR draft generation
      if (method === "POST" && pathname === "/api/pr") {
        const body = await readJsonBody<{
          repoId?: number;
          baseBranch?: string;
          branch?: string;
          raw?: boolean;
          provider?: string;
          model?: string;
        }>(req);
        if (!body?.repoId) return badRequest("repoId is required");
        const repo = store.getRepoById(body.repoId);
        if (!repo) return badRequest("Repository not found", 404);
        const provider = body?.provider && isLlmProvider(body.provider) ? body.provider : undefined;
        const out = await generatePrSummary(store, repo, {
          baseBranch: body.baseBranch,
          branch: body.branch,
          raw: body.raw,
          provider,
          model: body.model,
          geminiCaller,
        });
        if (!out.result) return badRequest(out.error || "Failed to generate PR description");
        return json(out.result);
      }

      // Cross-repo activity feed
      if (method === "GET" && pathname === "/api/activity") {
        const since = url.searchParams.get("since") ?? undefined;
        const allAuthors =
          url.searchParams.get("allAuthors") === "1" ||
          url.searchParams.get("allAuthors") === "true" ||
          url.searchParams.get("all") === "1";
        const feed = await collectActivityFeed(store, { since, allAuthors });
        return json(feed);
      }

      // Cross-repo global search (notes, TODOs, links, and commit subjects)
      if (method === "GET" && pathname === "/api/search") {
        const q = url.searchParams.get("q")?.trim() ?? "";
        if (!q) return badRequest("q is required");
        const allAuthors =
          url.searchParams.get("allAuthors") === "1" ||
          url.searchParams.get("allAuthors") === "true" ||
          url.searchParams.get("all") === "1";
        const result = await runGlobalSearch(store, q, { allAuthors });
        return json(result);
      }

      // Config (always redacted on GET and PUT response)
      if (method === "GET" && pathname === "/api/config") {
        return json(redactConfig());
      }
      if (method === "PUT" && pathname === "/api/config") {
        const body = await readJsonBody<{
          geminiKey?: string;
          clearGeminiKey?: boolean;
          geminiModel?: string;
          standupFormat?: StandupFormat;
          llmProvider?: LlmProvider;
          llmModel?: string;
          llmApiKey?: string;
          clearApiKey?: boolean;
          llmBaseUrl?: string;
          clearBaseUrl?: boolean;
        }>(req);
        const current = loadConfig();
        const prevProvider = current.llmProvider ?? "gemini";

        if (body?.llmProvider !== undefined) {
          if (!isLlmProvider(body.llmProvider)) {
            return badRequest("Unsupported llmProvider");
          }
          current.llmProvider = body.llmProvider;
          if (body.llmProvider !== prevProvider) {
            current.llmModel = undefined;
            current.llmBaseUrl = undefined;
            if (!body.llmApiKey && !body.clearApiKey) {
              current.llmApiKey = undefined;
            }
          }
        }

        const activeProvider = current.llmProvider ?? "gemini";

        if (body?.clearApiKey || body?.clearGeminiKey) {
          current.llmApiKey = undefined;
          if (activeProvider === "gemini" || body.clearGeminiKey) {
            current.geminiKey = undefined;
          }
        } else {
          if (body?.llmApiKey?.trim()) {
            current.llmApiKey = body.llmApiKey.trim();
            if (activeProvider === "gemini") {
              current.geminiKey = body.llmApiKey.trim();
            }
          }
          if (body?.geminiKey?.trim()) {
            current.geminiKey = body.geminiKey.trim();
            if (activeProvider === "gemini") {
              current.llmApiKey = body.geminiKey.trim();
            }
          }
        }

        if (body?.llmModel !== undefined) {
          const trimmed = body.llmModel.trim();
          current.llmModel = trimmed || undefined;
          if (activeProvider === "gemini" && trimmed) {
            current.geminiModel = trimmed;
          }
        }
        if (body?.geminiModel?.trim()) {
          current.geminiModel = body.geminiModel.trim();
          if (activeProvider === "gemini" && body.llmModel === undefined) {
            current.llmModel = body.geminiModel.trim();
          }
        }

        if (body?.clearBaseUrl) {
          current.llmBaseUrl = undefined;
        } else if (body?.llmBaseUrl !== undefined) {
          const rawUrl = body.llmBaseUrl.trim().replace(/\/+$/, "");
          if (rawUrl && !/^https?:\/\//i.test(rawUrl)) {
            return badRequest("Base URL must start with http:// or https://");
          }
          current.llmBaseUrl = rawUrl || undefined;
        }

        if (body?.standupFormat === "markdown" || body?.standupFormat === "slack") {
          current.standupFormat = body.standupFormat;
        }
        saveConfig(current);
        return json(redactConfig(current));
      }

      return badRequest("Not found", 404);
    },
  });
}
