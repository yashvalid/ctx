import type { CtxConfig, LlmProvider, LlmSettings, StandupFormat } from "./config.ts";
import { loadConfig, resolveLlmSettings } from "./config.ts";
import type { BranchNote, BranchTodo, CtxStore, TrackedRepo } from "./db.ts";
import { callLlm, type GeminiRequest, type GeminiResult } from "./gemini.ts";
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
  provider?: LlmProvider;
  model?: string;
  warning?: string;
  markdown: string;
  payload: T;
}

export type GeminiCaller = (req: GeminiRequest) => Promise<GeminiResult>;

const CONVENTIONAL_PREFIX_RE =
  /^(feat|fix|chore|docs|test|refactor|perf|build|ci|style|revert)(\([^)]+\))?!?:\s*/i;

/** Convert a raw commit subject like "feat(ui): add button" into clean readable prose. */
export function humanizeCommitSubject(subject: string): string {
  const cleaned = subject.trim().replace(CONVENTIONAL_PREFIX_RE, "").replace(/\.+$/, "").trim();
  if (!cleaned) return subject.trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

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

function uniqueReadableCommits(commits: CommitMetadata[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of commits) {
    const label = humanizeCommitSubject(c.subject);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

export function formatStandupFallback(
  payload: StandupPayload,
  format: StandupFormat = "markdown",
): string {
  if (payload.repos.length === 0) {
    return `No recent commits, uncommitted changes, or open tasks found (${payload.sinceLabel}).`;
  }

  const h2 = (title: string) => (format === "slack" ? `*${title}*` : `## ${title}`);
  const h3 = (title: string) => (format === "slack" ? `*${title}*` : `### ${title}`);
  const bold = (text: string) => (format === "slack" ? `*${text}*` : `**${text}**`);

  const completedSections: string[] = [];
  const inProgressSections: string[] = [];
  const noteLines: string[] = [];

  for (const repo of payload.repos) {
    const commitItems = uniqueReadableCommits(repo.commits);
    const repoCompleted: string[] = [
      ...commitItems.map((line) => `- ${line}`),
      ...repo.completedTodos.map((done) => `- Completed: ${done.text}`),
    ];
    if (repoCompleted.length > 0) {
      completedSections.push(`${h3(repo.repoName)}\n${repoCompleted.join("\n")}`);
    }

    const repoInProgress: string[] = repo.openTodos.map((todo) => `- Next: ${todo.text}`);
    if (repo.dirtyFilePaths.length > 0) {
      const count = repo.dirtyFilePaths.length;
      repoInProgress.push(
        `- Uncommitted changes in progress (${count} file${count === 1 ? "" : "s"})`,
      );
    }
    if (repoInProgress.length > 0) {
      inProgressSections.push(
        `${h3(`${repo.repoName} (\`${repo.currentBranch}\`)`)}\n${repoInProgress.join("\n")}`,
      );
    }

    for (const note of repo.branchNotes) {
      const linkSuffix = note.link ? ` (${note.link})` : "";
      noteLines.push(
        `- ${bold(repo.repoName)} (\`${note.branch}\`): ${note.content}${linkSuffix}`,
      );
    }
  }

  const lines: string[] = [
    `${h2(`Completed (${payload.sinceLabel})`)}`,
    completedSections.length > 0
      ? completedSections.join("\n\n")
      : "- No completed commits or tasks recorded.",
    "",
    h2("In Progress / Today"),
    inProgressSections.length > 0
      ? inProgressSections.join("\n\n")
      : "- No open tasks or active working-tree edits.",
  ];

  if (noteLines.length > 0) {
    lines.push("", h2("Notes & Blockers"), noteLines.join("\n"));
  }

  return lines.join("\n");
}

function buildStandupPrompt(payload: StandupPayload, format: StandupFormat): string {
  const formatHint =
    format === "slack"
      ? "Use Slack formatting (*Section Headers* and concise `-` bullets, no `#` headings)."
      : "Use clean Markdown with `## Completed`, `## In Progress / Today`, and `## Notes & Blockers` (only include Notes & Blockers when notes exist).";

  return [
    `Write a natural, human-readable engineering standup update (${payload.sinceLabel}) suitable for pasting directly to teammates.`,
    formatHint,
    "Style guidelines:",
    "- Write in clear plain English, not raw git log dumps.",
    "- Group updates under each repository name and synthesize related commits into 1-4 concise outcome bullets.",
    "- NEVER include commit SHA hashes, raw conventional-commit prefixes like `feat(scope):`, or raw file-path lists unless a specific filename clarifies the change.",
    "- Under Completed: summarize shipped commits and completed tasks.",
    "- Under In Progress / Today: summarize open tasks and active uncommitted work.",
    "- Strict honesty: only state facts present in the provided metadata; never invent work or blockers.",
    "",
    "Metadata:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

async function runConfiguredLlm(
  llm: LlmSettings,
  systemInstruction: string,
  prompt: string,
  fallbackTarget: "summary" | "PR draft",
  injectedCaller?: GeminiCaller,
): Promise<
  | { ok: true; text: string }
  | { ok: false; warning: string }
> {
  if (!llm.isConfigured) {
    return {
      ok: false,
      warning: `${llm.envVar} is not set for ${llm.providerLabel}. Showing structured offline ${fallbackTarget}. Configure it in Settings or run \`ctx config set apiKey <key>\`.`,
    };
  }

  const res = injectedCaller
    ? await injectedCaller({
        apiKey: llm.apiKey ?? "",
        model: llm.model,
        baseUrl: llm.baseUrl,
        systemInstruction,
        prompt,
      })
    : await callLlm({
        provider: llm.provider,
        apiKey: llm.apiKey,
        model: llm.model,
        baseUrl: llm.baseUrl,
        systemInstruction,
        prompt,
      });

  if (!res.ok) {
    return {
      ok: false,
      warning: `${res.error} Showing structured offline ${fallbackTarget}.`,
    };
  }
  return { ok: true, text: res.text };
}

export async function generateStandupSummary(
  store: CtxStore,
  options: {
    since?: string;
    allAuthors?: boolean;
    repoIds?: number[];
    format?: StandupFormat;
    raw?: boolean;
    provider?: LlmProvider;
    model?: string;
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

  if (options.raw || payload.repos.length === 0) {
    return { mode: "raw", markdown: formatStandupFallback(payload, format), payload };
  }

  const llm = resolveLlmSettings(config, {
    provider: options.provider,
    model: options.model,
  });

  const modelOut = await runConfiguredLlm(
    llm,
    "You are a senior software engineer writing a clear, natural daily standup for teammates from git activity and branch notes. Keep prose concise and never invent facts.",
    buildStandupPrompt(payload, format),
    "summary",
    options.geminiCaller,
  );

  if (!modelOut.ok) {
    return {
      mode: "fallback",
      provider: llm.provider,
      model: llm.model,
      warning: modelOut.warning,
      markdown: formatStandupFallback(payload, format),
      payload,
    };
  }

  return {
    mode: "gemini",
    provider: llm.provider,
    model: llm.model,
    markdown: modelOut.text,
    payload,
  };
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
  const title =
    payload.commits.length === 1
      ? humanizeCommitSubject(payload.commits[0]!.subject)
      : humanizeCommitSubject(payload.branch.replace(/[-_/]+/g, " "));

  const totalAdded = payload.files.reduce((sum, f) => sum + (f.added ?? 0), 0);
  const totalDeleted = payload.files.reduce((sum, f) => sum + (f.deleted ?? 0), 0);
  const diffStats = totalAdded + totalDeleted > 0 ? ` (+${totalAdded}/-${totalDeleted} lines)` : "";

  const lines: string[] = [
    `# ${title}`,
    "",
    "## Summary",
    `Merges \`${payload.branch}\` into \`${payload.baseBranch}\` in **${payload.repoName}** (${payload.commits.length} commit${payload.commits.length === 1 ? "" : "s"}, ${payload.files.length} file${payload.files.length === 1 ? "" : "s"}${diffStats}).`,
  ];

  if (payload.ticketLink) {
    lines.push("", `Reference: ${payload.ticketLink}`);
  }
  if (payload.notes.length > 0) {
    lines.push("", ...payload.notes.map((n) => `- ${n.content}`));
  }

  lines.push("", "## Key Changes");
  const seenSubjects = new Set<string>();
  const readableChanges: string[] = [];
  for (const c of payload.commits) {
    const clean = humanizeCommitSubject(c.subject);
    const key = clean.toLowerCase();
    if (!clean || seenSubjects.has(key)) continue;
    seenSubjects.add(key);
    readableChanges.push(`- ${clean}`);
  }
  if (readableChanges.length === 0) {
    lines.push("- No commits ahead of the base branch.");
  } else {
    lines.push(...readableChanges);
  }

  lines.push("", "## Files Touched");
  if (payload.files.length === 0) {
    lines.push("- None");
  } else {
    for (const f of payload.files.slice(0, 30)) {
      const stat = f.added !== null && f.deleted !== null ? ` (+${f.added}/-${f.deleted})` : "";
      lines.push(`- \`${f.path}\`${stat}`);
    }
    if (payload.files.length > 30) {
      lines.push(`- ...and ${payload.files.length - 30} more files`);
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
    `Draft a clear, human-readable Pull Request description for branch \`${payload.branch}\` targeting \`${payload.baseBranch}\` in repo \`${payload.repoName}\`.`,
    "Include:",
    "1. Suggested PR title (`# Title`) in plain, outcome-focused language",
    "2. `## Summary` (2-3 plain-English sentences explaining the change and context)",
    "3. `## Key Changes` (synthesized bullets grouped logically — avoid echoing commit SHAs or conventional prefixes)",
    "4. `## Checklist` (from branch TODOs if present, plus any ticket link)",
    "Rules:",
    "- Strictly rely on the provided metadata. Do NOT fabricate implementation details or test results.",
    "",
    "Metadata:",
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
    provider?: LlmProvider;
    model?: string;
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
  const llm = resolveLlmSettings(config, {
    provider: options.provider,
    model: options.model,
  });

  const modelOut = await runConfiguredLlm(
    llm,
    "You are a senior software engineer drafting a crisp, reviewer-friendly Pull Request description from commit history, file stats, and developer notes. Never invent facts.",
    buildPrPrompt(payload),
    "PR draft",
    options.geminiCaller,
  );

  if (!modelOut.ok) {
    return {
      result: {
        mode: "fallback",
        provider: llm.provider,
        model: llm.model,
        warning: modelOut.warning,
        markdown: formatPrFallback(payload),
        payload,
      },
    };
  }

  return {
    result: {
      mode: "gemini",
      provider: llm.provider,
      model: llm.model,
      markdown: modelOut.text,
      payload,
    },
  };
}
