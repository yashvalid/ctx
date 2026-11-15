import fs from "node:fs";
import path from "node:path";
import type { ContextSearchHit, CtxStore, TrackedRepo } from "./db.ts";
import { getCommitMetadataSince, getGitAuthor, searchRepoCommits } from "./git.ts";
import { parseSinceInput } from "./summary.ts";

export interface RepoCommitEvent {
  repoId: number;
  repoName: string;
  commonDir: string;
  hash: string;
  shortHash: string;
  subject: string;
  committedAt: string;
  authorName: string;
  authorEmail: string;
  fileCount?: number;
}

export interface DailyActivityBucket {
  date: string;
  commits: number;
  notes: number;
  todos: number;
  total: number;
}

export interface ActivityContextEvent {
  kind: "note" | "todo";
  id: number;
  repoName: string;
  commonDir: string;
  branch: string;
  text: string;
  done?: boolean;
  timestamp: string;
}

export interface ActivityFeedResult {
  sinceIso: string;
  label: string;
  allAuthors: boolean;
  days: DailyActivityBucket[];
  commits: RepoCommitEvent[];
  contextEvents: ActivityContextEvent[];
}

export interface SearchContextMatch extends ContextSearchHit {
  repoName: string;
}

export interface GlobalSearchResult {
  query: string;
  allAuthors: boolean;
  contextHits: SearchContextMatch[];
  commitHits: RepoCommitEvent[];
}

export function toLocalDateKey(isoOrDate: string | Date): string | null {
  const date = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildDailyBuckets(
  daysCount: number,
  commits: Array<{ committedAt: string }>,
  notes: Array<{ createdAt: string }>,
  todos: Array<{ createdAt: string; completedAt: string | null }>,
  now: Date = new Date(),
): DailyActivityBucket[] {
  const count = Math.max(1, Math.min(daysCount, 60));
  const buckets: DailyActivityBucket[] = [];
  const byDate = new Map<string, DailyActivityBucket>();

  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = toLocalDateKey(d);
    if (!key) continue;
    const bucket: DailyActivityBucket = { date: key, commits: 0, notes: 0, todos: 0, total: 0 };
    buckets.push(bucket);
    byDate.set(key, bucket);
  }

  for (const commit of commits) {
    const key = toLocalDateKey(commit.committedAt);
    const bucket = key ? byDate.get(key) : undefined;
    if (bucket) {
      bucket.commits += 1;
      bucket.total += 1;
    }
  }

  for (const note of notes) {
    const key = toLocalDateKey(note.createdAt);
    const bucket = key ? byDate.get(key) : undefined;
    if (bucket) {
      bucket.notes += 1;
      bucket.total += 1;
    }
  }

  for (const todo of todos) {
    const key = toLocalDateKey(todo.completedAt ?? todo.createdAt);
    const bucket = key ? byDate.get(key) : undefined;
    if (bucket) {
      bucket.todos += 1;
      bucket.total += 1;
    }
  }

  return buckets;
}

function repoNameMap(repos: TrackedRepo[]): Map<string, TrackedRepo> {
  return new Map(repos.map((r) => [r.commonDir, r]));
}

function fallbackRepoName(commonDir: string, byDir: Map<string, TrackedRepo>): string {
  return byDir.get(commonDir)?.name ?? path.basename(path.dirname(commonDir));
}

async function resolveAuthorFilter(rootPath: string, allAuthors: boolean): Promise<string | undefined> {
  if (allAuthors) return undefined;
  const author = await getGitAuthor(rootPath);
  return author.email || author.name;
}

export async function collectActivityFeed(
  store: CtxStore,
  options: {
    since?: string;
    allAuthors?: boolean;
    now?: Date;
    days?: number;
  } = {},
): Promise<ActivityFeedResult> {
  const now = options.now ?? new Date();
  const allAuthors = Boolean(options.allAuthors);
  const sinceArg = options.since?.trim() || "14d";
  const { sinceIso, label } = parseSinceInput(sinceArg, now);

  const repos = store.listRepos();
  const byDir = repoNameMap(repos);

  const perRepoCommits = await Promise.all(
    repos.map(async (repo): Promise<RepoCommitEvent[]> => {
      if (!fs.existsSync(repo.rootPath)) return [];
      const authorFilter = await resolveAuthorFilter(repo.rootPath, allAuthors);
      const commits = await getCommitMetadataSince(repo.rootPath, sinceIso, authorFilter);
      return commits.map((c) => ({
        repoId: repo.id,
        repoName: repo.name,
        commonDir: repo.commonDir,
        hash: c.hash,
        shortHash: c.shortHash,
        subject: c.subject,
        committedAt: c.committedAt,
        authorName: c.authorName,
        authorEmail: c.authorEmail,
        fileCount: c.files.length,
      }));
    }),
  );

  const commits = perRepoCommits
    .flat()
    .sort((a, b) => b.committedAt.localeCompare(a.committedAt));

  const recentNotes = store.getRecentNotesSince(sinceIso, 100);
  const recentTodos = store.getRecentTodosSince(sinceIso, 100);

  const contextEvents: ActivityContextEvent[] = [
    ...recentNotes.map((note) => ({
      kind: "note" as const,
      id: note.id,
      repoName: fallbackRepoName(note.commonDir, byDir),
      commonDir: note.commonDir,
      branch: note.branch,
      text: note.content,
      timestamp: note.createdAt,
    })),
    ...recentTodos.map((todo) => ({
      kind: "todo" as const,
      id: todo.id,
      repoName: fallbackRepoName(todo.commonDir, byDir),
      commonDir: todo.commonDir,
      branch: todo.branch,
      text: todo.text,
      done: todo.done,
      timestamp: todo.completedAt ?? todo.createdAt,
    })),
  ].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  const inferredDays = Math.max(
    1,
    Math.min(30, Math.ceil((now.getTime() - new Date(sinceIso).getTime()) / 86400_000) || 14),
  );
  const days = buildDailyBuckets(
    options.days ?? (sinceArg === "14d" ? 14 : inferredDays),
    commits,
    recentNotes,
    recentTodos,
    now,
  );

  return {
    sinceIso,
    label,
    allAuthors,
    days,
    commits: commits.slice(0, 100),
    contextEvents: contextEvents.slice(0, 100),
  };
}

export async function runGlobalSearch(
  store: CtxStore,
  query: string,
  options: { allAuthors?: boolean; limit?: number } = {},
): Promise<GlobalSearchResult> {
  const trimmed = query.trim();
  const allAuthors = Boolean(options.allAuthors);
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));

  if (!trimmed) {
    return { query: "", allAuthors, contextHits: [], commitHits: [] };
  }

  const repos = store.listRepos();
  const byDir = repoNameMap(repos);

  const contextHits: SearchContextMatch[] = store.searchContext(trimmed, limit).map((hit) => ({
    ...hit,
    repoName: fallbackRepoName(hit.commonDir, byDir),
  }));

  const perRepoCommits = await Promise.all(
    repos.map(async (repo): Promise<RepoCommitEvent[]> => {
      if (!fs.existsSync(repo.rootPath)) return [];
      const authorFilter = await resolveAuthorFilter(repo.rootPath, allAuthors);
      const hits = await searchRepoCommits(repo.rootPath, trimmed, {
        authorFilter,
        limit: Math.min(limit, 25),
      });
      return hits.map((c) => ({
        repoId: repo.id,
        repoName: repo.name,
        commonDir: repo.commonDir,
        hash: c.hash,
        shortHash: c.shortHash,
        subject: c.subject,
        committedAt: c.committedAt,
        authorName: c.authorName,
        authorEmail: c.authorEmail,
      }));
    }),
  );

  const commitHits = perRepoCommits
    .flat()
    .sort((a, b) => b.committedAt.localeCompare(a.committedAt))
    .slice(0, limit);

  return {
    query: trimmed,
    allAuthors,
    contextHits,
    commitHits,
  };
}
