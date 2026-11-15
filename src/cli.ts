#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { collectActivityFeed, runGlobalSearch } from "./activity.ts";
import { loadConfig, redactConfig, saveConfig, type StandupFormat } from "./config.ts";
import { CtxStore } from "./db.ts";
import {
  formatActivityFeed,
  formatBranchContextBanner,
  formatBranchSummaryList,
  formatHelp,
  formatRepoOverviewTable,
  formatSearchResults,
  paint,
} from "./format.ts";
import {
  fetchRepo,
  getHookStatus,
  getRepoStatus,
  installPostCheckoutHook,
  type RepoIdentity,
  resolveRepoInfo,
  uninstallPostCheckoutHook,
} from "./git.ts";
import { startUiServer } from "./server.ts";
import { generatePrSummary, generateStandupSummary } from "./summary.ts";
import { collectRepoOverview, syncWatchedDirs } from "./sync.ts";

const VERSION = "0.1.0";

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set([
  "b",
  "branch",
  "since",
  "format",
  "base",
  "repo",
  "port",
  "rm",
  "done",
  "undone",
]);

function parseCliArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx > 2) {
        const key = token.slice(2, eqIdx);
        flags[key] = token.slice(eqIdx + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith("-")) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const key = token.slice(1);
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }

    positionals.push(token);
  }

  return { positionals, flags };
}

function flagString(flags: Record<string, string | boolean>, ...names: string[]): string | undefined {
  for (const name of names) {
    const val = flags[name];
    if (typeof val === "string") return val;
  }
  return undefined;
}

function flagBool(flags: Record<string, string | boolean>, ...names: string[]): boolean {
  return names.some((n) => flags[n] === true || typeof flags[n] === "string");
}

function parsePositiveInt(raw: string | undefined, label: string): number {
  if (!raw || !/^\d+$/.test(raw.trim())) {
    throw new Error(`Invalid ${label}: ${raw ?? "(empty)"}`);
  }
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return n;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      const proc = Bun.spawn(
        ["powershell", "-NoProfile", "-Command", "Set-Clipboard -Value $env:CTX_CLIPBOARD"],
        {
          env: { ...process.env, CTX_CLIPBOARD: text },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      return (await proc.exited) === 0;
    }
    const cmd = process.platform === "darwin" ? ["pbcopy"] : ["xclip", "-selection", "clipboard"];
    const proc = Bun.spawn(cmd, {
      stdin: new TextEncoder().encode(text),
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" });
    } else if (process.platform === "darwin") {
      Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    } else {
      Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
    }
  } catch {
    // non-fatal if browser launcher unavailable
  }
}

async function requireCurrentRepo(store: CtxStore, cwd: string): Promise<RepoIdentity> {
  const info = await resolveRepoInfo(cwd);
  if (!info) {
    throw new Error("Not inside a git repository. Run this inside a repo or pass --repo.");
  }
  store.upsertRepo(info);
  return info;
}

async function autoTrackIfInsideRepo(store: CtxStore, cwd: string): Promise<RepoIdentity | null> {
  const info = await resolveRepoInfo(cwd);
  if (info) {
    store.upsertRepo(info);
  }
  return info;
}

export async function runCli(argv: string[], cwd = process.cwd()): Promise<number> {
  const { positionals, flags } = parseCliArgs(argv);
  const cmd = positionals[0]?.toLowerCase();

  if (flagBool(flags, "h", "help") || cmd === "help") {
    console.log(formatHelp());
    return 0;
  }
  if (flagBool(flags, "v", "version") || cmd === "version") {
    console.log(`ctx ${VERSION}`);
    return 0;
  }

  const store = new CtxStore();
  try {
    // Internal hook handler: fast path
    if (cmd === "_hook") {
      const hookName = positionals[1];
      const branchFlag = positionals[4]; // args: prevHead newHead branchFlag
      if (hookName === "post-checkout" && branchFlag === "1") {
        const info = await resolveRepoInfo(cwd);
        if (!info) return 0;
        store.upsertRepo(info);
        store.recordBranchVisit(info.commonDir, info.branch);
        const ctx = store.getBranchContext(info.commonDir, info.branch);
        const openTodos = ctx.todos.filter((t) => !t.done);
        if (ctx.link || ctx.notes.length > 0 || openTodos.length > 0) {
          console.log("");
          console.log(formatBranchContextBanner(info.name, ctx, { compact: true }));
          console.log("");
        }
      }
      return 0;
    }

    // Default command with no args: current branch context inside repo, else status
    if (!cmd) {
      const info = await autoTrackIfInsideRepo(store, cwd);
      if (info) {
        store.recordBranchVisit(info.commonDir, info.branch);
        const status = await getRepoStatus(info.rootPath);
        const ctx = store.getBranchContext(info.commonDir, info.branch);
        console.log(formatBranchContextBanner(info.name, ctx, { status }));
        return 0;
      }
      const items = await collectRepoOverview(store, { syncWatched: true });
      console.log(formatRepoOverviewTable(items));
      return 0;
    }

    if (cmd === "status" || cmd === "st") {
      await autoTrackIfInsideRepo(store, cwd);
      await syncWatchedDirs(store);

      if (flagBool(flags, "fetch")) {
        const repos = store.listRepos();
        const results = await Promise.all(
          repos.map(async (r) => ({ repo: r.name, ...(await fetchRepo(r.rootPath)) })),
        );
        for (const r of results) {
          if (!r.ok) {
            console.error(paint.yellow(`fetch ${r.repo}: ${r.message}`));
          }
        }
      }

      const items = await collectRepoOverview(store, {
        dirtyOnly: flagBool(flags, "dirty"),
      });
      if (flagBool(flags, "json")) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        console.log(formatRepoOverviewTable(items));
      }
      return 0;
    }

    if (cmd === "note" || cmd === "n") {
      const info = await requireCurrentRepo(store, cwd);
      const branch = flagString(flags, "b", "branch") || info.branch;

      if (flagBool(flags, "clear")) {
        const count = store.clearNotes(info.commonDir, branch);
        console.log(`Cleared ${count} note(s) on ${info.name} [${branch}].`);
        return 0;
      }
      const rmId = flagString(flags, "rm");
      if (rmId) {
        const id = parsePositiveInt(rmId, "note id");
        if (!store.deleteNote(id)) {
          console.error(`Note #${id} not found.`);
          return 1;
        }
        console.log(`Deleted note #${id}.`);
        return 0;
      }

      const text = positionals.slice(1).join(" ").trim();
      if (!text) {
        const ctx = store.getBranchContext(info.commonDir, branch);
        console.log(formatBranchContextBanner(info.name, ctx));
        return 0;
      }

      const added = store.addNote(info.commonDir, branch, text);
      console.log(`${paint.green("Saved")} note #${added.id} on ${paint.cyan(branch)}: ${added.content}`);
      return 0;
    }

    if (cmd === "todo" || cmd === "t") {
      const info = await requireCurrentRepo(store, cwd);
      const branch = flagString(flags, "b", "branch") || info.branch;

      const doneId = flagString(flags, "done");
      if (doneId) {
        const id = parsePositiveInt(doneId, "todo id");
        const updated = store.setTodoDone(id, true);
        if (!updated) {
          console.error(`TODO #${id} not found.`);
          return 1;
        }
        console.log(`${paint.green("Done")} #${updated.id}: ${updated.text}`);
        return 0;
      }

      const undoneId = flagString(flags, "undone");
      if (undoneId) {
        const id = parsePositiveInt(undoneId, "todo id");
        const updated = store.setTodoDone(id, false);
        if (!updated) {
          console.error(`TODO #${id} not found.`);
          return 1;
        }
        console.log(`Reopened #${updated.id}: ${updated.text}`);
        return 0;
      }

      const rmId = flagString(flags, "rm");
      if (rmId) {
        const id = parsePositiveInt(rmId, "todo id");
        if (!store.deleteTodo(id)) {
          console.error(`TODO #${id} not found.`);
          return 1;
        }
        console.log(`Deleted TODO #${id}.`);
        return 0;
      }

      const text = positionals.slice(1).join(" ").trim();
      if (!text) {
        const ctx = store.getBranchContext(info.commonDir, branch);
        console.log(formatBranchContextBanner(info.name, ctx));
        return 0;
      }

      const added = store.addTodo(info.commonDir, branch, text);
      console.log(`${paint.green("Added")} TODO #${added.id} on ${paint.cyan(branch)}: ${added.text}`);
      return 0;
    }

    if (cmd === "done") {
      await autoTrackIfInsideRepo(store, cwd);
      const id = parsePositiveInt(positionals[1], "todo id");
      const updated = store.setTodoDone(id, true);
      if (!updated) {
        console.error(`TODO #${id} not found.`);
        return 1;
      }
      console.log(`${paint.green("Done")} #${updated.id}: ${updated.text}`);
      return 0;
    }

    if (cmd === "link") {
      const info = await requireCurrentRepo(store, cwd);
      const branch = flagString(flags, "b", "branch") || info.branch;

      if (flagBool(flags, "clear")) {
        store.setBranchLink(info.commonDir, branch, null);
        console.log(`Cleared link on ${info.name} [${branch}].`);
        return 0;
      }

      const url = positionals.slice(1).join(" ").trim();
      if (!url) {
        const ctx = store.getBranchContext(info.commonDir, branch);
        console.log(ctx.link ?? paint.dim(`No link set on ${branch}.`));
        return 0;
      }
      store.setBranchLink(info.commonDir, branch, url);
      console.log(`${paint.green("Linked")} ${paint.cyan(branch)} -> ${url}`);
      return 0;
    }

    if (cmd === "branches" || cmd === "br") {
      const all = flagBool(flags, "all");
      const info = await autoTrackIfInsideRepo(store, cwd);
      const repos = store.listRepos();
      const nameByDir = new Map(repos.map((r) => [r.commonDir, r.name]));

      if (!all && info) {
        const entries = store.listBranchSummaries(info.commonDir);
        console.log(formatBranchSummaryList(entries, nameByDir, false));
        return 0;
      }
      const entries = store.listBranchSummaries();
      console.log(formatBranchSummaryList(entries, nameByDir, true));
      return 0;
    }

    if (cmd === "search" || cmd === "find") {
      const query = positionals.slice(1).join(" ").trim();
      if (!query) {
        console.error("Usage: ctx search <query> [--all-authors] [--json]");
        return 1;
      }

      await autoTrackIfInsideRepo(store, cwd);
      await syncWatchedDirs(store);

      const result = await runGlobalSearch(store, query, {
        allAuthors: flagBool(flags, "all-authors", "all"),
      });

      if (flagBool(flags, "json")) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatSearchResults(result));
      }
      return 0;
    }

    if (cmd === "activity" || cmd === "log") {
      await autoTrackIfInsideRepo(store, cwd);
      await syncWatchedDirs(store);

      const feed = await collectActivityFeed(store, {
        since: flagString(flags, "since"),
        allAuthors: flagBool(flags, "all-authors", "all"),
      });

      if (flagBool(flags, "json")) {
        console.log(JSON.stringify(feed, null, 2));
      } else {
        console.log(formatActivityFeed(feed));
      }
      return 0;
    }

    if (cmd === "standup") {
      await autoTrackIfInsideRepo(store, cwd);
      await syncWatchedDirs(store);

      const repoFilter = flagString(flags, "repo");
      let repoIds: number[] | undefined;
      if (repoFilter) {
        const found = store.findRepo(repoFilter);
        if (!found) {
          console.error(`Repository not found: ${repoFilter}`);
          return 1;
        }
        repoIds = [found.id];
      }

      const rawFormat = flagString(flags, "format");
      const format: StandupFormat | undefined =
        rawFormat === "slack" || rawFormat === "markdown" ? rawFormat : undefined;

      const out = await generateStandupSummary(store, {
        since: flagString(flags, "since"),
        allAuthors: flagBool(flags, "all-authors", "all"),
        repoIds,
        format,
        raw: flagBool(flags, "raw"),
      });

      if (out.warning) {
        console.error(paint.yellow(`Note: ${out.warning}`));
      }

      if (flagBool(flags, "json")) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(out.markdown);
      }

      if (flagBool(flags, "copy")) {
        const copied = await copyToClipboard(out.markdown);
        console.error(copied ? paint.green("Copied standup to clipboard.") : paint.yellow("Could not copy to clipboard."));
      }
      return 0;
    }

    if (cmd === "pr") {
      const repoArg = flagString(flags, "repo");
      let repo = repoArg ? store.findRepo(repoArg) : null;
      if (!repo) {
        if (repoArg) {
          console.error(`Repository not found: ${repoArg}`);
          return 1;
        }
        const info = await requireCurrentRepo(store, cwd);
        repo = store.upsertRepo(info);
      }

      const out = await generatePrSummary(store, repo, {
        baseBranch: flagString(flags, "base"),
        branch: flagString(flags, "b", "branch"),
        raw: flagBool(flags, "raw"),
      });

      if (!out.result) {
        console.error(out.error || "Failed to generate PR description.");
        return 1;
      }

      if (out.result.warning) {
        console.error(paint.yellow(`Note: ${out.result.warning}`));
      }
      if (flagBool(flags, "json")) {
        console.log(JSON.stringify(out.result, null, 2));
      } else {
        console.log(out.result.markdown);
      }

      if (flagBool(flags, "copy")) {
        const copied = await copyToClipboard(out.result.markdown);
        console.error(copied ? paint.green("Copied PR description to clipboard.") : paint.yellow("Could not copy to clipboard."));
      }
      return 0;
    }

    if (cmd === "watch") {
      const target = positionals[1] ? path.resolve(cwd, positionals[1]) : null;
      if (!target) {
        const dirs = store.listWatchedDirs();
        if (dirs.length === 0) {
          console.log("No watched folders yet. Run `ctx watch <folder>` to add one.");
        } else {
          for (const d of dirs) {
            console.log(`${paint.dim(`#${d.id}`)}  ${d.dirPath}`);
          }
        }
        return 0;
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
        console.error(`Not a directory: ${target}`);
        return 1;
      }
      const saved = store.addWatchedDir(target);
      const before = store.listRepos().length;
      const afterRepos = await syncWatchedDirs(store);
      const addedCount = Math.max(0, afterRepos.length - before);
      console.log(
        `${paint.green("Watching")} ${saved.dirPath} (${afterRepos.length} tracked repos total, +${addedCount} discovered).`,
      );
      return 0;
    }

    if (cmd === "unwatch") {
      const target = positionals[1];
      if (!target) {
        console.error("Usage: ctx unwatch <dir|id>");
        return 1;
      }
      const resolved = /^\d+$/.test(target) ? target : path.resolve(cwd, target);
      if (!store.removeWatchedDir(resolved)) {
        console.error(`Watched folder not found: ${target}`);
        return 1;
      }
      console.log(`Stopped watching ${target}.`);
      return 0;
    }

    if (cmd === "add") {
      const target = positionals[1] ? path.resolve(cwd, positionals[1]) : cwd;
      const info = await resolveRepoInfo(target);
      if (!info) {
        console.error(`Not a git repository: ${target}`);
        return 1;
      }
      const repo = store.upsertRepo(info);
      console.log(`${paint.green("Tracked")} ${repo.name} (${repo.rootPath})`);
      return 0;
    }

    if (cmd === "rm" || cmd === "remove") {
      const target = positionals[1];
      if (!target) {
        console.error("Usage: ctx rm <name|path|id>");
        return 1;
      }
      const repo = store.findRepo(target);
      if (!repo) {
        console.error(`Tracked repo not found: ${target}`);
        return 1;
      }
      store.removeRepo(repo.id);
      console.log(`Untracked ${repo.name} (${repo.rootPath}).`);
      return 0;
    }

    if (cmd === "repos") {
      await syncWatchedDirs(store);
      const repos = store.listRepos();
      if (repos.length === 0) {
        console.log("No tracked repos. Run `ctx add` or `ctx watch <dir>`.");
        return 0;
      }
      for (const r of repos) {
        console.log(`${paint.dim(`#${r.id}`)}  ${paint.bold(r.name)}  ${r.rootPath}`);
      }
      return 0;
    }

    if (cmd === "hook") {
      const info = await requireCurrentRepo(store, cwd);
      const action = (positionals[1] ?? "status").toLowerCase();
      if (action === "status") {
        const st = await getHookStatus(info.rootPath);
        console.log(`Hook installed: ${st.installed ? paint.green("yes") : paint.yellow("no")}`);
        console.log(`Hook path:      ${st.hookPath}`);
        if (st.customHooksPath) {
          console.log(paint.yellow(`Warning: core.hooksPath is set to "${st.customHooksPath}".`));
        }
        return 0;
      }
      if (action === "install") {
        const st = await installPostCheckoutHook(info.rootPath, import.meta.path);
        console.log(`${paint.green("Installed")} post-checkout hook at ${st.hookPath}`);
        if (st.customHooksPath) {
          console.log(
            paint.yellow(
              `Note: core.hooksPath is currently "${st.customHooksPath}", so Git writes hooks there.`,
            ),
          );
        }
        return 0;
      }
      if (action === "uninstall" || action === "remove") {
        await uninstallPostCheckoutHook(info.rootPath);
        console.log(`Removed ctx post-checkout hook from ${info.name}.`);
        return 0;
      }
      console.error(`Unknown hook action: ${action}. Use install, uninstall, or status.`);
      return 1;
    }

    if (cmd === "config") {
      const action = positionals[1]?.toLowerCase();
      if (!action || action === "show") {
        console.log(JSON.stringify(redactConfig(), null, 2));
        return 0;
      }
      if (action === "set") {
        const key = positionals[2];
        const value = positionals.slice(3).join(" ").trim();
        if (!key || !value) {
          console.error("Usage: ctx config set <geminiKey|geminiModel|standupFormat> <value>");
          return 1;
        }
        const cfg = loadConfig();
        if (key === "geminiKey") cfg.geminiKey = value;
        else if (key === "geminiModel") cfg.geminiModel = value;
        else if (key === "standupFormat" && (value === "markdown" || value === "slack")) {
          cfg.standupFormat = value;
        } else {
          console.error(`Invalid config key or value: ${key}=${value}`);
          return 1;
        }
        saveConfig(cfg);
        console.log(JSON.stringify(redactConfig(cfg), null, 2));
        return 0;
      }
      if (action === "unset") {
        const key = positionals[2];
        const cfg = loadConfig();
        if (key === "geminiKey") cfg.geminiKey = undefined;
        else if (key === "geminiModel") cfg.geminiModel = "gemini-2.5-flash";
        else if (key === "standupFormat") cfg.standupFormat = "markdown";
        else {
          console.error(`Unknown config key: ${key ?? ""}`);
          return 1;
        }
        saveConfig(cfg);
        console.log(JSON.stringify(redactConfig(cfg), null, 2));
        return 0;
      }
      console.error(`Unknown config subcommand: ${action}`);
      return 1;
    }

    if (cmd === "ui") {
      await autoTrackIfInsideRepo(store, cwd);
      await syncWatchedDirs(store);
      const portRaw = flagString(flags, "port");
      const port = portRaw ? parsePositiveInt(portRaw, "port") : 4312;
      const server = startUiServer({
        store,
        cliEntryPath: import.meta.path,
        port,
      });
      const url = `http://127.0.0.1:${server.port}`;
      console.log(`${paint.bold("ctx UI")} listening at ${paint.cyan(url)}`);
      console.log(paint.dim("Press Ctrl+C to stop."));
      if (!flagBool(flags, "no-open")) {
        openBrowser(url);
      }
      await new Promise<void>((resolve) => {
        const stop = () => {
          server.stop(true);
          resolve();
        };
        process.on("SIGINT", stop);
        process.on("SIGTERM", stop);
      });
      return 0;
    }

    console.error(`Unknown command: ${cmd}\n`);
    console.error(formatHelp());
    return 1;
  } catch (err) {
    console.error(paint.red(err instanceof Error ? err.message : String(err)));
    return 1;
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
