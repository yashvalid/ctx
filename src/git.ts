import fs from "node:fs";
import path from "node:path";
import { canonicalPath } from "./config.ts";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RepoIdentity {
  rootPath: string;
  commonDir: string;
  name: string;
  branch: string;
  remoteUrl: string | null;
}

export interface DirtyFileMeta {
  code: string;
  path: string;
}

export interface LastCommitMeta {
  hash: string;
  subject: string;
  committedAt: string;
  authorName: string;
}

export interface RepoStatus {
  missing: boolean;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  conflicted: number;
  stashCount: number;
  dirtyFiles: DirtyFileMeta[];
  lastCommit: LastCommitMeta | null;
  error?: string;
}

export interface CommitFileChange {
  status: string;
  path: string;
}

export interface CommitMetadata {
  hash: string;
  shortHash: string;
  subject: string;
  committedAt: string;
  authorName: string;
  authorEmail: string;
  files: CommitFileChange[];
}

export interface PrFileStat {
  added: number | null;
  deleted: number | null;
  path: string;
}

export interface PrMetadata {
  branch: string;
  baseBranch: string;
  commits: Array<{
    hash: string;
    shortHash: string;
    subject: string;
    committedAt: string;
    authorName: string;
  }>;
  files: PrFileStat[];
}

export interface HookStatus {
  installed: boolean;
  hookPath: string;
  hasOtherHookContent: boolean;
  customHooksPath: string | null;
}

const HOOK_START = "# >>> ctx-hook >>>";
const HOOK_END = "# <<< ctx-hook <<<";

const SKIP_SCAN_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  "vendor",
  "coverage",
  ".cache",
  "out",
  ".idea",
  ".vs",
]);

/** Run git safely via argv array (never shell interpolation) with terminal prompts disabled. */
export async function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 8000,
): Promise<GitResult> {
  if (!fs.existsSync(cwd)) {
    return { ok: false, stdout: "", stderr: `Directory does not exist: ${cwd}`, exitCode: 1 };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // ignore if already exited
        }
        reject(new Error(`git ${args[0] ?? ""} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeoutPromise,
    ]);

    return { ok: exitCode === 0, stdout, stderr, exitCode };
  } catch (err) {
    return {
      ok: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Remove embedded credentials from HTTP(S) git remote URLs before storing or displaying. */
export function sanitizeRemoteUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      parsed.username = "";
      parsed.password = "";
      return parsed.toString();
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export async function resolveCurrentBranch(cwd: string): Promise<string> {
  const sym = await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (sym.ok && sym.stdout.trim()) {
    return sym.stdout.trim();
  }
  const sha = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  if (sha.ok && sha.stdout.trim()) {
    return `HEAD@${sha.stdout.trim()}`;
  }
  return "HEAD";
}

export async function resolveRepoInfo(cwd: string): Promise<RepoIdentity | null> {
  const res = await runGit(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
  if (!res.ok) return null;

  const lines = res.stdout.trim().split(/\r?\n/);
  const rawTop = lines[0]?.trim();
  const rawCommon = lines[1]?.trim();
  if (!rawTop || !rawCommon) return null;

  const rootPath = canonicalPath(rawTop);
  const commonDir = canonicalPath(path.isAbsolute(rawCommon) ? rawCommon : path.resolve(cwd, rawCommon));
  const [branch, remoteRes] = await Promise.all([
    resolveCurrentBranch(rootPath),
    runGit(rootPath, ["remote", "get-url", "origin"]),
  ]);

  return {
    rootPath,
    commonDir,
    name: path.basename(rootPath),
    branch,
    remoteUrl: remoteRes.ok ? sanitizeRemoteUrl(remoteRes.stdout) : null,
  };
}

export async function getRepoStatus(rootPath: string): Promise<RepoStatus> {
  if (!fs.existsSync(rootPath)) {
    return {
      missing: true,
      branch: "(missing)",
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicted: 0,
      stashCount: 0,
      dirtyFiles: [],
      lastCommit: null,
      error: "Repository folder no longer exists on disk",
    };
  }

  const [statusRes, stashRes, logRes] = await Promise.all([
    runGit(rootPath, ["status", "--porcelain=v2", "--branch"]),
    runGit(rootPath, ["stash", "list"]),
    runGit(rootPath, ["log", "-1", "--format=%H%x1f%s%x1f%cI%x1f%an"]),
  ]);

  if (!statusRes.ok) {
    return {
      missing: false,
      branch: "(error)",
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicted: 0,
      stashCount: 0,
      dirtyFiles: [],
      lastCommit: null,
      error: statusRes.stderr.trim() || "Failed to read git status",
    };
  }

  let branch = "HEAD";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicted = 0;
  const dirtyFiles: DirtyFileMeta[] = [];

  for (const line of statusRes.stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      branch = head === "(detached)" ? await resolveCurrentBranch(rootPath) : head;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim() || null;
    } else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+)\s+-(\d+)/.exec(line);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const xy = line.slice(2, 4);
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      if (x !== ".") staged += 1;
      if (y !== ".") modified += 1;
      if (dirtyFiles.length < 50) {
        const filePart = extractPorcelainV2Path(line);
        if (filePart) dirtyFiles.push({ code: xy, path: filePart });
      }
    } else if (line.startsWith("u ")) {
      conflicted += 1;
      if (dirtyFiles.length < 50) {
        const parts = line.split(" ");
        const filePath = parts.slice(10).join(" ");
        if (filePath) dirtyFiles.push({ code: "UU", path: filePath });
      }
    } else if (line.startsWith("? ")) {
      untracked += 1;
      if (dirtyFiles.length < 50) {
        dirtyFiles.push({ code: "??", path: line.slice(2) });
      }
    }
  }

  const stashCount = stashRes.ok && stashRes.stdout.trim()
    ? stashRes.stdout.trim().split(/\r?\n/).length
    : 0;

  let lastCommit: LastCommitMeta | null = null;
  if (logRes.ok && logRes.stdout.trim()) {
    const [hash, subject, committedAt, authorName] = logRes.stdout.trim().split("\x1f");
    if (hash && subject !== undefined && committedAt) {
      lastCommit = {
        hash,
        subject,
        committedAt,
        authorName: authorName ?? "",
      };
    }
  }

  return {
    missing: false,
    branch,
    upstream,
    ahead,
    behind,
    staged,
    modified,
    untracked,
    conflicted,
    stashCount,
    dirtyFiles,
    lastCommit,
  };
}

function extractPorcelainV2Path(line: string): string {
  if (line.startsWith("2 ")) {
    const tabIdx = line.indexOf("\t");
    const head = tabIdx >= 0 ? line.slice(0, tabIdx) : line;
    const fields = head.split(" ");
    return fields.slice(9).join(" ");
  }
  const fields = line.split(" ");
  return fields.slice(8).join(" ");
}

export async function fetchRepo(rootPath: string): Promise<{ ok: boolean; message: string }> {
  const res = await runGit(rootPath, ["fetch", "--prune"], 15000);
  if (res.ok) {
    return { ok: true, message: "Fetched" };
  }
  return { ok: false, message: res.stderr.trim() || "git fetch failed" };
}

export async function listLocalBranches(rootPath: string): Promise<string[]> {
  const res = await runGit(rootPath, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)",
    "refs/heads/",
  ]);
  if (!res.ok) return [];
  return res.stdout
    .split(/\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);
}

export async function getGitAuthor(rootPath: string): Promise<{ email?: string; name?: string }> {
  const [emailRes, nameRes] = await Promise.all([
    runGit(rootPath, ["config", "user.email"]),
    runGit(rootPath, ["config", "user.name"]),
  ]);
  return {
    email: emailRes.ok ? emailRes.stdout.trim() || undefined : undefined,
    name: nameRes.ok ? nameRes.stdout.trim() || undefined : undefined,
  };
}

/** Collect strictly commit metadata + changed file paths (never source code diffs). */
export async function getCommitMetadataSince(
  rootPath: string,
  sinceIso: string,
  authorFilter?: string,
): Promise<CommitMetadata[]> {
  const args = [
    "log",
    `--since=${sinceIso}`,
    "--no-merges",
    "--name-status",
    "--format=__CTX_COMMIT__%x1f%H%x1f%h%x1f%s%x1f%cI%x1f%an%x1f%ae",
  ];
  if (authorFilter?.trim()) {
    args.push("--regexp-ignore-case", `--author=${authorFilter.trim()}`);
  }

  const res = await runGit(rootPath, args, 10000);
  if (!res.ok || !res.stdout.trim()) return [];

  const commits: CommitMetadata[] = [];
  let current: CommitMetadata | null = null;

  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith("__CTX_COMMIT__\x1f")) {
      const [, hash, shortHash, subject, committedAt, authorName, authorEmail] = line.split("\x1f");
      current = {
        hash: hash ?? "",
        shortHash: shortHash ?? "",
        subject: subject ?? "",
        committedAt: committedAt ?? "",
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        files: [],
      };
      commits.push(current);
      continue;
    }

    if (current) {
      const parts = line.split("\t");
      const status = parts[0]?.trim();
      const filePath = parts.slice(1).join(" -> ").trim();
      if (status && filePath) {
        current.files.push({ status, path: filePath });
      }
    }
  }

  return commits;
}

export async function detectBaseBranch(rootPath: string, currentBranch: string): Promise<string | null> {
  const originHead = await runGit(rootPath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (originHead.ok && originHead.stdout.trim()) {
    const candidate = originHead.stdout.trim().replace(/^origin\//, "");
    if (candidate && candidate !== currentBranch) return candidate;
  }

  for (const candidate of ["main", "master", "develop", "dev"]) {
    if (candidate === currentBranch) continue;
    const localRef = await runGit(rootPath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${candidate}`,
    ]);
    if (localRef.ok) return candidate;
    const remoteRef = await runGit(rootPath, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${candidate}`,
    ]);
    if (remoteRef.ok) return `origin/${candidate}`;
  }

  return null;
}

/** Collect PR commit subjects and --numstat file line counts only (never source code diffs). */
export async function getPrMetadata(
  rootPath: string,
  requestedBase?: string,
  targetBranch?: string,
): Promise<{ data?: PrMetadata; error?: string }> {
  const currentBranch = targetBranch || (await resolveCurrentBranch(rootPath));
  const baseBranch = requestedBase?.trim() || (await detectBaseBranch(rootPath, currentBranch));

  if (!baseBranch) {
    return {
      error: "Could not detect base branch (main/master/develop). Pass --base <branch> explicitly.",
    };
  }

  const headRef = targetBranch || "HEAD";
  const [logRes, statRes] = await Promise.all([
    runGit(rootPath, [
      "log",
      `${baseBranch}..${headRef}`,
      "--no-merges",
      "--format=%H%x1f%h%x1f%s%x1f%cI%x1f%an",
    ]),
    runGit(rootPath, ["diff", "--numstat", `${baseBranch}...${headRef}`]),
  ]);

  if (!logRes.ok) {
    return { error: logRes.stderr.trim() || `Failed to compare ${baseBranch}..${headRef}` };
  }

  const commits = logRes.stdout
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((line) => {
      const [hash, shortHash, subject, committedAt, authorName] = line.split("\x1f");
      return {
        hash: hash ?? "",
        shortHash: shortHash ?? "",
        subject: subject ?? "",
        committedAt: committedAt ?? "",
        authorName: authorName ?? "",
      };
    });

  const files: PrFileStat[] = [];
  if (statRes.ok) {
    for (const line of statRes.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [addedRaw, deletedRaw, ...rest] = line.split("\t");
      const filePath = rest.join("\t").trim();
      if (!filePath) continue;
      files.push({
        added: addedRaw === "-" ? null : Number(addedRaw),
        deleted: deletedRaw === "-" ? null : Number(deletedRaw),
        path: filePath,
      });
    }
  }

  return {
    data: {
      branch: currentBranch,
      baseBranch,
      commits,
      files,
    },
  };
}

/** Walk watched parent directories up to maxDepth to discover git repositories. */
export async function discoverGitRepos(
  parentDirs: string[],
  maxDepth = 3,
): Promise<RepoIdentity[]> {
  const candidates: string[] = [];
  const visitedDirs = new Set<string>();

  function walk(dir: string, depth: number): void {
    const normalized = canonicalPath(dir);
    if (visitedDirs.has(normalized)) return;
    visitedDirs.add(normalized);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(normalized, { withFileTypes: true });
    } catch {
      return;
    }

    const hasGit = entries.some((e) => e.name === ".git");
    if (hasGit) {
      candidates.push(normalized);
      return;
    }

    if (depth >= maxDepth) return;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_SCAN_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(path.join(normalized, entry.name), depth + 1);
    }
  }

  for (const parent of parentDirs) {
    if (fs.existsSync(parent)) {
      walk(parent, 0);
    }
  }

  const resolved = await Promise.all(candidates.map((dir) => resolveRepoInfo(dir)));
  return resolved.filter((r): r is RepoIdentity => r !== null);
}

function toPosixShellPath(p: string): string {
  if (process.platform !== "win32") return p;
  return p.replace(/\\/g, "/");
}

function escapeSingleQuotedSh(val: string): string {
  return val.replace(/'/g, "'\\''");
}

export async function getHookStatus(rootPath: string): Promise<HookStatus> {
  const [hookPathRes, customHooksRes] = await Promise.all([
    runGit(rootPath, ["rev-parse", "--git-path", "hooks/post-checkout"]),
    runGit(rootPath, ["config", "--get", "core.hooksPath"]),
  ]);

  const rawHook = hookPathRes.ok ? hookPathRes.stdout.trim() : ".git/hooks/post-checkout";
  const hookPath = path.isAbsolute(rawHook) ? rawHook : path.resolve(rootPath, rawHook);
  const customHooksPath = customHooksRes.ok && customHooksRes.stdout.trim()
    ? customHooksRes.stdout.trim()
    : null;

  if (!fs.existsSync(hookPath)) {
    return { installed: false, hookPath, hasOtherHookContent: false, customHooksPath };
  }

  const content = fs.readFileSync(hookPath, "utf8");
  const installed = content.includes(HOOK_START) && content.includes(HOOK_END);
  const stripped = stripCtxHookBlock(content).replace(/^#!\/bin\/sh\s*/m, "").trim();
  return {
    installed,
    hookPath,
    hasOtherHookContent: stripped.length > 0,
    customHooksPath,
  };
}

function stripCtxHookBlock(content: string): string {
  const escapedStart = HOOK_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = HOOK_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, "g");
  return content.replace(regex, "\n");
}

function buildHookBlock(cliEntryPath: string): string {
  const bunBin = toPosixShellPath(process.execPath);
  const cliPath = toPosixShellPath(cliEntryPath);
  return [
    HOOK_START,
    "# Managed by ctx — records branch switches and prints saved branch notes/TODOs",
    'if [ "${3:-0}" = "1" ]; then',
    "  if command -v ctx >/dev/null 2>&1; then",
    '    ctx _hook post-checkout "$@"',
    `  elif [ -x '${escapeSingleQuotedSh(bunBin)}' ] && [ -f '${escapeSingleQuotedSh(cliPath)}' ]; then`,
    `    '${escapeSingleQuotedSh(bunBin)}' run '${escapeSingleQuotedSh(cliPath)}' _hook post-checkout "$@"`,
    "  fi",
    "fi",
    HOOK_END,
  ].join("\n");
}

export async function installPostCheckoutHook(
  rootPath: string,
  cliEntryPath: string,
): Promise<HookStatus> {
  const status = await getHookStatus(rootPath);
  fs.mkdirSync(path.dirname(status.hookPath), { recursive: true });

  const block = buildHookBlock(cliEntryPath);
  let nextContent: string;

  if (fs.existsSync(status.hookPath)) {
    const existing = fs.readFileSync(status.hookPath, "utf8").replace(/\r\n/g, "\n");
    const cleaned = stripCtxHookBlock(existing).trimEnd();
    if (cleaned) {
      nextContent = `${cleaned}\n\n${block}\n`;
    } else {
      nextContent = `#!/bin/sh\n\n${block}\n`;
    }
  } else {
    nextContent = `#!/bin/sh\n\n${block}\n`;
  }

  fs.writeFileSync(status.hookPath, nextContent, "utf8");
  if (process.platform !== "win32") {
    fs.chmodSync(status.hookPath, 0o755);
  }
  return getHookStatus(rootPath);
}

export async function uninstallPostCheckoutHook(rootPath: string): Promise<HookStatus> {
  const status = await getHookStatus(rootPath);
  if (!fs.existsSync(status.hookPath)) {
    return status;
  }

  const existing = fs.readFileSync(status.hookPath, "utf8").replace(/\r\n/g, "\n");
  const cleaned = stripCtxHookBlock(existing).trim();
  const nonShebang = cleaned.replace(/^#!\/bin\/sh\s*/m, "").trim();

  if (!nonShebang) {
    fs.unlinkSync(status.hookPath);
  } else {
    fs.writeFileSync(status.hookPath, `${cleaned}\n`, "utf8");
  }
  return getHookStatus(rootPath);
}
