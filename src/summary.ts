import type { CtxConfig, StandupFormat } from "./config.ts";
import { loadConfig, resolveGeminiSettings } from "./config.ts";
import type { BranchNote, BranchTodo, CtxStore, TrackedRepo } from "./db.ts";
import { callGemini, type GeminiRequest } from "./gemini.ts";
import {
  type CommitMetadata,
  getCommitMetadataSince,
  getGitAuthor,
  getPrMetadata,
  getRepoStatus,
  type PrMetadata,
} from "./git.ts";

export interface StandupRepoMetadata {
  repoId: number;
  repoName: string;
  rootPath: string;
  currentBranch: string;
  dirtyFilePaths: string[];
  commits: CommitMetadata[];
  completedTodos: Array<{ branch: string; text: string; completedAt: string | null }>;
  openTodos: Array<{ branch: string; text: string }>;
  branchNotes: Array<{ branch: string; content: string; link: string | null }>;
}

export interface StandupPayload {
  sinceIso: string;
  sinceLabel: string;
  authorMode: "self" | "all";
  generatedAt: string;
  repos: StandupRepoMetadata[];
}

export interface PrPayload {
  repoName: string;
  branch: string;
  baseBranch: string;
  ticketLink: string | null;
  commits: PrMetadata["commits"];
  files: PrMetadata["files"];
  notes: BranchNote[];
  todos: BranchTodo[];
}

export interface SummaryOutput<T> {
  mode: "gemini" | "fallback" | "raw";
  warning?: string;
  markdown: string;
  payload: T;
}

export type GeminiCaller = (req: GeminiRequest) => ReturnType<typeof callGemini>;

/**
 * Compute default standup cutoff: local midnight of the previous workday
 * (Friday on Sunday/Monday, yesterday otherwise).
 */
export function computeDefaultSince(now: Date = new Date()): { sinceIso: string; label: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = start.getDay(); // 0 = Sun, 1 = Mon
  const daysBack = day === 1 ? 3 : day === 0 ? 2 : 1;
  start.setDate(start.getDate() - daysBack);
  const label = daysBack === 1 ? "since yesterday" : "since last workday (Fri)";
  return { sinceIso: start.toISOString(), label };
}

export function parseSinceInput(
  input?: string,
  now: Date = new Date(),
): { sinceIso: string; label: string } {
  const raw = input?.trim();
  if (!raw) return computeDefaultSince(now);

  const lower = raw.toLowerCase();
  if (lower === "today") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return { sinceIso: d.toISOString(), label: "since today" };
  }
  if (lower === "yesterday") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    return { sinceIso: d.toISOString(), label: "since yesterday" };
  }

  const relMatch = /^(\d+)\s*([hdw])$/i.exec(raw);
  if (relMatch) {
    const count = Number(relMatch[1]);
    const unit = relMatch[2]?.toLowerCase();
    const msPerUnit = unit === "h" ? 3600_000 : unit === "d" ? 86400_000 : 7 * 86400_000;
    const target = new Date(now.getTime() - count * msPerUnit);
    return { sinceIso: target.toISOString(), label: `last ${count}${unit}` };
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return { sinceIso: parsed.toISOString(), label: `since ${raw}` };
  }

  return { sinceIso: raw, label: `since ${raw}` };
}

export async function collectStandupPayload(
  store: CtxStore,
  options: {
    since?: string;
    allAuthors?: boolean;
    repoIds?: number[];
    now?: Date;
  } = {},
): Promise<StandupPayload> {
  const { sinceIso, label } = parseSinceInput(options.since, options.now);
  let repos = store.listRepos();
  if (options.repoIds && options.repoIds.length > 0) {
    const allowed = new Set(options.repoIds);
    repos = repos.filter((r) => allowed.has(r.id));
  }

  const repoEntries = await Promise.all(
    repos.map(async (repo): Promise<StandupRepoMetadata | null> => {
      const status = await getRepoStatus(repo.rootPath);
      if (status.missing) return null;

      let authorFilter: string | undefined;
      if (!options.allAuthors) {
        const author = await getGitAuthor(repo.rootPath);
        authorFilter = author.email || author.name;
      }

      const commits = await getCommitMetadataSince(repo.rootPath, sinceIso, authorFilter);
      const completedTodos = store
        .getCompletedTodosSince(repo.commonDir, sinceIso)
        .map((t) => ({ branch: t.branch, text: t.text, completedAt: t.completedAt }));
      const openTodos = store
        .getOpenTodosForRepo(repo.commonDir)
        .map((t) => ({ branch: t.branch, text: t.text }));

      const notes = store.getNotesForRepo(repo.commonDir);
      const branchLinks = new Map<string, string | null>();
      for (const summary of store.listBranchSummaries(repo.commonDir)) {
        branchLinks.set(summary.branch, summary.link);
      }

      const branchNotes = notes.map((n) => ({
        branch: n.branch,
        content: n.content,
        link: branchLinks.get(n.branch) ?? null,
      }));

      return {
        repoId: repo.id,
        repoName: repo.name,
        rootPath: repo.rootPath,
        currentBranch: status.branch,
        dirtyFilePaths: status.dirtyFiles.map((d) => `${d.code} ${d.path}`),
        commits,
        completedTodos,
        openTodos,
        branchNotes,
      };
    }),
  );

  const activeRepos = repoEntries.filter((r): r is StandupRepoMetadata => {
    if (!r) return false;
    return (
      r.commits.length > 0 ||
      r.completedTodos.length > 0 ||
      r.openTodos.length > 0 ||
      r.branchNotes.length > 0 ||
      r.dirtyFilePaths.length > 0
    );
  });

  return {
    sinceIso,
    sinceLabel: label,
    authorMode: options.allAuthors ? "all" : "self",
    generatedAt: (options.now ?? new Date()).toISOString(),
    repos: activeRepos,
  };
}

export function formatStandupFallback(
  payload: StandupPayload,
  format: StandupFormat = "markdown",
): string {
  if (payload.repos.length === 0) {
    return `No commits, WIP files, or branch TODOs found (${payload.sinceLabel}).`;
  }

  const h = (title: string) => (format === "slack" ? `*${title}*` : `## ${title}`);
  const yesterdayLines: string[] = [];
  const todayLines: string[] = [];

  for (const repo of payload.repos) {
    for (const c of repo.commits) {
      const filesPreview = c.files.slice(0, 4).map((f) => f.path).join(", ");
      const suffix = c.files.length > 4 ? ` (+${c.files.length - 4} more)` : "";
      yesterdayLines.push(
        `- [${repo.repoName}] ${c.subject} (${c.shortHash}${filesPreview ? `: ${filesPreview}${suffix}` : ""})`,
      );
    }
    for (const done of repo.completedTodos) {
      yesterdayLines.push(`- [${repo.repoName}:${done.branch}] Completed TODO: ${done.text}`);
    }

    for (const todo of repo.openTodos) {
      todayLines.push(`- [${repo.repoName}:${todo.branch}] ${todo.text}`);
    }
    if (repo.dirtyFilePaths.length > 0) {
      todayLines.push(
        `- [${repo.repoName}:${repo.currentBranch}] Active WIP (${repo.dirtyFilePaths.length} modified/untracked files)`,
      );
    }
    for (const note of repo.branchNotes) {
      const linkSuffix = note.link ? ` (${note.link})` : "";
      todayLines.push(`- [${repo.repoName}:${note.branch}] Note: ${note.content}${linkSuffix}`);
    }
  }

  const sections = [
    `${h("Yesterday / Completed")} (${payload.sinceLabel})`,
    yesterdayLines.length > 0 ? yesterdayLines.join("\n") : "- No recorded commits or completed TODOs.",
    "",
    h("Today / In Progress"),
    todayLines.length > 0 ? todayLines.join("\n") : "- No open branch TODOs or active WIP.",
  ];

  return sections.join("\n");
}

function buildStandupPrompt(payload: StandupPayload, format: StandupFormat): string {
  const formatHint =
    format === "slack"
      ? "Use Slack-friendly formatting (*Bold Headers* and concise `-` bullets, no # markdown headings)."
      : "Use clean Markdown (## Yesterday, ## Today, ## Blockers / Notes if applicable).";

  return [
    `Generate a concise daily engineering standup update (${payload.sinceLabel}).`,
    formatHint,
    "Rules:",
    "- Group logically by repo or initiative when helpful.",
    "- Include Yesterday (from commits and completed TODOs) and Today (from open branch TODOs, notes, and active WIP).",
    "- Omit Blockers unless a note explicitly mentions being blocked.",
    "- Be crisp and concrete. Do NOT invent changes or details not present in the JSON metadata.",
    "",
    "Metadata (strictly commit subjects, file paths, and developer notes — no source diffs):",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

export async function generateStandupSummary(
  store: CtxStore,
  options: {
    since?: string;
    allAuthors?: boolean;
    repoIds?: number[];
    format?: StandupFormat;
    raw?: boolean;
    config?: CtxConfig;
    geminiCaller?: GeminiCaller;
  } = {},
): Promise<SummaryOutput<StandupPayload>> {
  const config = options.config ?? loadConfig();
  const format = options.format ?? config.standupFormat;
  const payload = await collectStandupPayload(store, {
    since: options.since,
    allAuthors: options.allAuthors,
    repoIds: options.repoIds,
  });

  if (options.raw) {
    return { mode: "raw", markdown: formatStandupFallback(payload, format), payload };
  }

  if (payload.repos.length === 0) {
    return {
      mode: "raw",
      markdown: formatStandupFallback(payload, format),
      payload,
    };
  }

  const gemini = resolveGeminiSettings(config);
  if (!gemini.apiKey) {
    return {
      mode: "fallback",
      warning:
        "GEMINI_API_KEY is not set. Showing structured offline summary. Set GEMINI_API_KEY or run `ctx config set geminiKey <key>`.",
      markdown: formatStandupFallback(payload, format),
      payload,
    };
  }

  const caller = options.geminiCaller ?? callGemini;
  const result = await caller({
    apiKey: gemini.apiKey,
    model: gemini.model,
    systemInstruction:
      "You are a pragmatic senior software engineer writing a clear, honest daily standup from git commit metadata and branch notes. Never fabricate facts.",
    prompt: buildStandupPrompt(payload, format),
  });

  if (!result.ok) {
    return {
      mode: "fallback",
      warning: `${result.error} Falling back to structured offline summary.`,
      markdown: formatStandupFallback(payload, format),
      payload,
    };
  }

  return { mode: "gemini", markdown: result.text, payload };
}

export async function collectPrPayload(
  store: CtxStore,
  repo: TrackedRepo,
  options: { baseBranch?: string; branch?: string } = {},
): Promise<{ payload?: PrPayload; error?: string }> {
  const prMeta = await getPrMetadata(repo.rootPath, options.baseBranch, options.branch);
  if (!prMeta.data) {
    return { error: prMeta.error || "Failed to collect PR metadata." };
  }

  const ctx = store.getBranchContext(repo.commonDir, prMeta.data.branch);
  return {
    payload: {
      repoName: repo.name,
      branch: prMeta.data.branch,
      baseBranch: prMeta.data.baseBranch,
      ticketLink: ctx.link,
      commits: prMeta.data.commits,
      files: prMeta.data.files,
      notes: ctx.notes,
      todos: ctx.todos,
    },
  };
}

export function formatPrFallback(payload: PrPayload): string {
  const lines: string[] = [
    `# PR: ${payload.branch} -> ${payload.baseBranch} (${payload.repoName})`,
  ];
  if (payload.ticketLink) {
    lines.push(`Link: ${payload.ticketLink}`);
  }
  lines.push("", "## Commits");
  if (payload.commits.length === 0) {
    lines.push("- No commits ahead of base branch.");
  } else {
    for (const c of payload.commits) {
      lines.push(`- ${c.subject} (\`${c.shortHash}\`)`);
    }
  }

  lines.push("", "## Changed Files");
  if (payload.files.length === 0) {
    lines.push("- None");
  } else {
    for (const f of payload.files.slice(0, 40)) {
      const stat = f.added !== null && f.deleted !== null ? ` (+${f.added}/-${f.deleted})` : "";
      lines.push(`- \`${f.path}\`${stat}`);
    }
    if (payload.files.length > 40) {
      lines.push(`- ...and ${payload.files.length - 40} more files`);
    }
  }

  if (payload.notes.length > 0) {
    lines.push("", "## Branch Notes");
    for (const n of payload.notes) {
      lines.push(`- ${n.content}`);
    }
  }

  if (payload.todos.length > 0) {
    lines.push("", "## Checklist");
    for (const t of payload.todos) {
      lines.push(`- [${t.done ? "x" : " "}] ${t.text}`);
    }
  }

  return lines.join("\n");
}

function buildPrPrompt(payload: PrPayload): string {
  return [
    `Draft a concise, high-signal Pull Request description for branch \`${payload.branch}\` targeting \`${payload.baseBranch}\` in repo \`${payload.repoName}\`.`,
    "Include:",
    "1. A suggested PR Title (single line)",
    "2. ## Summary (2-4 crisp sentences or bullets)",
    "3. ## Key Changes (grouped logically from commit messages & file paths)",
    "4. ## Checklist (incorporating branch TODOs if present, plus any ticket link)",
    "Rules:",
    "- Strictly rely on the provided metadata. Do NOT fabricate implementation details or test claims not mentioned in the commits or notes.",
    "",
    "Metadata (commit subjects, file paths with line counts only, branch notes/TODOs — no source code):",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

export async function generatePrSummary(
  store: CtxStore,
  repo: TrackedRepo,
  options: {
    baseBranch?: string;
    branch?: string;
    raw?: boolean;
    config?: CtxConfig;
    geminiCaller?: GeminiCaller;
  } = {},
): Promise<{ result?: SummaryOutput<PrPayload>; error?: string }> {
  const { payload, error } = await collectPrPayload(store, repo, {
    baseBranch: options.baseBranch,
    branch: options.branch,
  });
  if (!payload) {
    return { error };
  }

  if (options.raw) {
    return {
      result: { mode: "raw", markdown: formatPrFallback(payload), payload },
    };
  }

  const config = options.config ?? loadConfig();
  const gemini = resolveGeminiSettings(config);
  if (!gemini.apiKey) {
    return {
      result: {
        mode: "fallback",
        warning:
          "GEMINI_API_KEY is not set. Showing structured offline PR draft. Set GEMINI_API_KEY or run `ctx config set geminiKey <key>`.",
        markdown: formatPrFallback(payload),
        payload,
      },
    };
  }

  const caller = options.geminiCaller ?? callGemini;
  const res = await caller({
    apiKey: gemini.apiKey,
    model: gemini.model,
    systemInstruction:
      "You are a senior software engineer drafting an accurate, concise Pull Request description strictly from commit subjects, file change stats, and developer notes. Never invent details.",
    prompt: buildPrPrompt(payload),
  });

  if (!res.ok) {
    return {
      result: {
        mode: "fallback",
        warning: `${res.error} Falling back to structured offline PR draft.`,
        markdown: formatPrFallback(payload),
        payload,
      },
    };
  }

  return {
    result: { mode: "gemini", markdown: res.text, payload },
  };
}
