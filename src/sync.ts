import type { BranchSummaryEntry, CtxStore, TrackedRepo } from "./db.ts";
import { discoverGitRepos, getHookStatus, getRepoStatus, type RepoStatus } from "./git.ts";

export interface RepoOverviewItem {
  repo: TrackedRepo;
  status: RepoStatus;
  currentBranchNotes: number;
  currentBranchOpenTodos: number;
  currentBranchLink: string | null;
  totalOpenTodos: number;
  hookInstalled: boolean;
}

/** Discover any new git repos inside watched directories and upsert them into the store. */
export async function syncWatchedDirs(store: CtxStore): Promise<TrackedRepo[]> {
  const watched = store.listWatchedDirs();
  if (watched.length === 0) return store.listRepos();

  const discovered = await discoverGitRepos(watched.map((w) => w.dirPath));
  for (const info of discovered) {
    store.upsertRepo(info);
  }
  return store.listRepos();
}

export function isRepoDirty(status: RepoStatus): boolean {
  return (
    status.staged > 0 ||
    status.modified > 0 ||
    status.untracked > 0 ||
    status.conflicted > 0 ||
    status.ahead > 0 ||
    status.behind > 0 ||
    status.stashCount > 0
  );
}

/** Collect live git status + stored branch context summaries for all tracked repositories. */
export async function collectRepoOverview(
  store: CtxStore,
  options: { syncWatched?: boolean; dirtyOnly?: boolean } = {},
): Promise<RepoOverviewItem[]> {
  const repos = options.syncWatched ? await syncWatchedDirs(store) : store.listRepos();

  const summariesByDir = new Map<string, BranchSummaryEntry[]>();
  for (const entry of store.listBranchSummaries()) {
    const arr = summariesByDir.get(entry.commonDir) ?? [];
    arr.push(entry);
    summariesByDir.set(entry.commonDir, arr);
  }

  const items = await Promise.all(
    repos.map(async (repo): Promise<RepoOverviewItem> => {
      const [status, hook] = await Promise.all([
        getRepoStatus(repo.rootPath),
        repo.rootPath ? getHookStatus(repo.rootPath) : Promise.resolve({ installed: false }),
      ]);

      const branchEntries = summariesByDir.get(repo.commonDir) ?? [];
      const currentEntry = branchEntries.find((e) => e.branch === status.branch);
      const totalOpenTodos = branchEntries.reduce((sum, e) => sum + e.openTodoCount, 0);

      return {
        repo,
        status,
        currentBranchNotes: currentEntry?.noteCount ?? 0,
        currentBranchOpenTodos: currentEntry?.openTodoCount ?? 0,
        currentBranchLink: currentEntry?.link ?? null,
        totalOpenTodos,
        hookInstalled: hook.installed,
      };
    }),
  );

  if (options.dirtyOnly) {
    return items.filter((item) => isRepoDirty(item.status) || item.status.missing);
  }
  return items;
}
