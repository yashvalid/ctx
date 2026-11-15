import type { BranchContext, BranchSummaryEntry } from "./db.ts";
import type { RepoStatus } from "./git.ts";
import type { RepoOverviewItem } from "./sync.ts";

const USE_COLOR = !process.env.NO_COLOR && process.stdout.isTTY;

function c(code: string, text: string): string {
  return USE_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const paint = {
  bold: (s: string) => c("1", s),
  dim: (s: string) => c("2", s),
  cyan: (s: string) => c("36", s),
  green: (s: string) => c("32", s),
  yellow: (s: string) => c("33", s),
  red: (s: string) => c("31", s),
  magenta: (s: string) => c("35", s),
  blue: (s: string) => c("34", s),
};

export function formatRelativeTime(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "-";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "-";
  const diffSec = Math.max(0, Math.floor((now.getTime() - ts) / 1000));
  if (diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function formatWorkingTreeBadge(status: RepoStatus): string {
  if (status.missing) return paint.red("missing");
  if (status.error) return paint.red("error");

  const parts: string[] = [];
  if (status.conflicted > 0) parts.push(paint.red(`!${status.conflicted}`));
  if (status.staged > 0) parts.push(paint.green(`+${status.staged}`));
  if (status.modified > 0) parts.push(paint.yellow(`~${status.modified}`));
  if (status.untracked > 0) parts.push(paint.cyan(`?${status.untracked}`));
  if (status.stashCount > 0) parts.push(paint.magenta(`stash:${status.stashCount}`));
  return parts.length > 0 ? parts.join(" ") : paint.dim("clean");
}

function formatSyncBadge(status: RepoStatus): string {
  if (status.missing || status.error) return "";
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(paint.green(`↑${status.ahead}`));
  if (status.behind > 0) parts.push(paint.yellow(`↓${status.behind}`));
  return parts.join(" ");
}

export function formatBranchContextBanner(
  repoName: string,
  ctx: BranchContext,
  options: { compact?: boolean; status?: RepoStatus } = {},
): string {
  const headerParts = [paint.bold(repoName), paint.cyan(`[${ctx.branch}]`)];
  if (options.status) {
    const wt = formatWorkingTreeBadge(options.status);
    const sync = formatSyncBadge(options.status);
    headerParts.push(wt);
    if (sync) headerParts.push(sync);
  }
  if (ctx.lastVisitedAt && !options.compact) {
    headerParts.push(paint.dim(`visited ${formatRelativeTime(ctx.lastVisitedAt)}`));
  }

  const lines: string[] = [headerParts.join("  ")];
  if (ctx.link) {
    lines.push(`  ${paint.dim("link:")} ${paint.blue(ctx.link)}`);
  }

  if (ctx.notes.length > 0) {
    lines.push(`  ${paint.bold("Notes:")}`);
    for (const note of ctx.notes) {
      lines.push(`    ${paint.dim(`#${note.id}`)} ${note.content}`);
    }
  }

  const openTodos = ctx.todos.filter((t) => !t.done);
  const doneTodos = ctx.todos.filter((t) => t.done);
  if (ctx.todos.length > 0) {
    lines.push(`  ${paint.bold("TODOs:")}`);
    for (const todo of openTodos) {
      lines.push(`    [ ] ${paint.dim(`#${todo.id}`)} ${todo.text}`);
    }
    if (!options.compact) {
      for (const todo of doneTodos) {
        lines.push(`    ${paint.green("[x]")} ${paint.dim(`#${todo.id} ${todo.text}`)}`);
      }
    } else if (doneTodos.length > 0) {
      lines.push(`    ${paint.dim(`(${doneTodos.length} completed)`)}`);
    }
  }

  if (!options.compact && !ctx.link && ctx.notes.length === 0 && ctx.todos.length === 0) {
    lines.push(paint.dim("  No notes, TODOs, or links saved for this branch yet."));
    lines.push(paint.dim('  Try: ctx note "..."  |  ctx todo "..."  |  ctx link <url>'));
  }

  return lines.join("\n");
}

export function formatRepoOverviewTable(items: RepoOverviewItem[]): string {
  if (items.length === 0) {
    return [
      paint.dim("No repositories tracked yet."),
      `Run ${paint.cyan("ctx add")} inside a git repo, or ${paint.cyan("ctx watch <folder>")} to auto-discover repos.`,
    ].join("\n");
  }

  const lines: string[] = [];
  const nameWidth = Math.min(28, Math.max(10, ...items.map((i) => i.repo.name.length)));
  const branchWidth = Math.min(28, Math.max(10, ...items.map((i) => i.status.branch.length)));

  for (const item of items) {
    const name = item.repo.name.padEnd(nameWidth);
    const branch = item.status.branch.slice(0, branchWidth).padEnd(branchWidth);
    const wt = formatWorkingTreeBadge(item.status);
    const sync = formatSyncBadge(item.status);
    const ctxParts: string[] = [];
    if (item.currentBranchOpenTodos > 0) {
      ctxParts.push(paint.yellow(`${item.currentBranchOpenTodos} todo`));
    }
    if (item.currentBranchNotes > 0) {
      ctxParts.push(paint.cyan(`${item.currentBranchNotes} note`));
    }
    if (item.currentBranchLink) {
      ctxParts.push(paint.blue("link"));
    }
    const lastAge = item.status.lastCommit
      ? paint.dim(formatRelativeTime(item.status.lastCommit.committedAt))
      : paint.dim("-");

    const row = [
      paint.bold(name),
      paint.cyan(branch),
      wt,
      sync,
      ctxParts.join(" "),
      lastAge,
    ]
      .filter(Boolean)
      .join("  ");
    lines.push(row);
  }

  return lines.join("\n");
}

export function formatBranchSummaryList(
  entries: BranchSummaryEntry[],
  repoNameByDir: Map<string, string>,
  showRepoColumn: boolean,
): string {
  if (entries.length === 0) {
    return paint.dim("No branch contexts saved yet.");
  }

  return entries
    .map((e) => {
      const repoPrefix = showRepoColumn
        ? `${paint.bold(repoNameByDir.get(e.commonDir) ?? "repo")} `
        : "";
      const parts = [
        `${repoPrefix}${paint.cyan(e.branch)}`,
        e.noteCount > 0 ? `${e.noteCount} note${e.noteCount === 1 ? "" : "s"}` : "",
        e.openTodoCount > 0 ? paint.yellow(`${e.openTodoCount} open`) : "",
        e.doneTodoCount > 0 ? paint.dim(`${e.doneTodoCount} done`) : "",
        e.link ? paint.blue("link") : "",
        e.lastVisitedAt ? paint.dim(`visited ${formatRelativeTime(e.lastVisitedAt)}`) : "",
      ].filter(Boolean);
      return parts.join("  ");
    })
    .join("\n");
}

export function formatHelp(): string {
  return [
    `${paint.bold("ctx")} — Git multi-repo cockpit, branch context memory, and AI standup/PR summarizer`,
    "",
    paint.bold("Usage:"),
    "  ctx                       Show current branch context (or repo overview outside a repo)",
    "  ctx status [--dirty] [--fetch] [--json]",
    "                            Multi-repo status dashboard across tracked & watched repos",
    "  ctx note [<text>] [-b <branch>] [--rm <id>] [--clear]",
    "                            Add or view notes tied to the current branch",
    "  ctx todo [<text>] [-b <branch>] [--done <id>] [--undone <id>] [--rm <id>]",
    "                            Add or manage TODOs tied to the current branch",
    "  ctx done <id>             Mark a TODO item complete",
    "  ctx link [<url>] [--clear]",
    "                            Attach or view a PR / Jira / Linear link on the current branch",
    "  ctx branches [--all]      List branches with saved context or recent visits",
    "",
    paint.bold("AI Summaries (metadata-only via Gemini):"),
    "  ctx standup [--since 2d] [--all-authors] [--format slack|markdown] [--raw] [--copy]",
    "                            Generate daily standup from commit metadata + branch TODOs",
    "  ctx pr [--base main] [--raw] [--copy]",
    "                            Draft a PR title, summary, and checklist for the current branch",
    "",
    paint.bold("Workspace, Hooks & UI:"),
    "  ctx ui [--port 4312] [--no-open]",
    "                            Launch the local web dashboard",
    "  ctx watch [<dir>]         Watch a parent folder to auto-discover git repos",
    "  ctx unwatch <dir|id>      Stop watching a parent folder",
    "  ctx add [<dir>]           Register current (or specified) repo",
    "  ctx rm <name|path|id>     Untrack a repo",
    "  ctx hook [install|uninstall|status]",
    "                            Manage opt-in post-checkout hook for branch recall",
    "  ctx config [set <key> <val> | unset <key>]",
    "                            Configure geminiKey, geminiModel, standupFormat",
  ].join("\n");
}
