import { Database } from "bun:sqlite";
import path from "node:path";
import { canonicalPath, ensureDataDir, getDbPath } from "./config.ts";

export interface TrackedRepo {
  id: number;
  rootPath: string;
  commonDir: string;
  name: string;
  remoteUrl: string | null;
  lastSeenAt: string;
  createdAt: string;
}

export interface WatchedDir {
  id: number;
  dirPath: string;
  createdAt: string;
}

export interface BranchNote {
  id: number;
  commonDir: string;
  branch: string;
  content: string;
  createdAt: string;
}

export interface BranchTodo {
  id: number;
  commonDir: string;
  branch: string;
  text: string;
  done: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface BranchContext {
  commonDir: string;
  branch: string;
  link: string | null;
  lastVisitedAt: string | null;
  updatedAt: string | null;
  notes: BranchNote[];
  todos: BranchTodo[];
}

export interface BranchSummaryEntry {
  commonDir: string;
  branch: string;
  link: string | null;
  lastVisitedAt: string | null;
  updatedAt: string | null;
  noteCount: number;
  openTodoCount: number;
  doneTodoCount: number;
}

export interface ContextSearchHit {
  kind: "note" | "todo" | "link";
  commonDir: string;
  branch: string;
  text: string;
  done?: boolean;
  timestamp: string | null;
}

interface RepoRow {
  id: number;
  root_path: string;
  common_dir: string;
  name: string;
  remote_url: string | null;
  last_seen_at: string;
  created_at: string;
}

interface NoteRow {
  id: number;
  common_dir: string;
  branch: string;
  content: string;
  created_at: string;
}

interface TodoRow {
  id: number;
  common_dir: string;
  branch: string;
  text: string;
  done: number;
  created_at: string;
  completed_at: string | null;
}

interface MetaRow {
  common_dir: string;
  branch: string;
  link: string | null;
  last_visited_at: string | null;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function escapeLikePattern(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function mapRepo(row: RepoRow): TrackedRepo {
  return {
    id: row.id,
    rootPath: row.root_path,
    commonDir: row.common_dir,
    name: row.name,
    remoteUrl: row.remote_url,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function mapNote(row: NoteRow): BranchNote {
  return {
    id: row.id,
    commonDir: row.common_dir,
    branch: row.branch,
    content: row.content,
    createdAt: row.created_at,
  };
}

function mapTodo(row: TodoRow): BranchTodo {
  return {
    id: row.id,
    commonDir: row.common_dir,
    branch: row.branch,
    text: row.text,
    done: row.done === 1,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/** SQLite persistence store for tracked repositories, watched directories, and branch contexts. */
export class CtxStore {
  readonly db: Database;

  constructor(dbFilePath?: string) {
    if (!dbFilePath) {
      ensureDataDir();
    }
    const targetPath = dbFilePath ?? getDbPath();
    if (targetPath !== ":memory:") {
      ensureDataDir();
    }
    this.db = new Database(targetPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_path TEXT UNIQUE NOT NULL,
        common_dir TEXT NOT NULL,
        name TEXT NOT NULL,
        remote_url TEXT,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_repos_common_dir ON repos(common_dir);

      CREATE TABLE IF NOT EXISTS watched_dirs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dir_path TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS branch_meta (
        common_dir TEXT NOT NULL,
        branch TEXT NOT NULL,
        link TEXT,
        last_visited_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (common_dir, branch)
      );

      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        common_dir TEXT NOT NULL,
        branch TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_notes_repo_branch ON notes(common_dir, branch);

      CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        common_dir TEXT NOT NULL,
        branch TEXT NOT NULL,
        text TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_todos_repo_branch ON todos(common_dir, branch);
    `);
  }

  close(): void {
    this.db.close();
  }

  upsertRepo(input: {
    rootPath: string;
    commonDir: string;
    name?: string;
    remoteUrl?: string | null;
  }): TrackedRepo {
    const rootPath = canonicalPath(input.rootPath);
    const commonDir = canonicalPath(input.commonDir);
    const name = input.name?.trim() || path.basename(rootPath);
    const remoteUrl = input.remoteUrl ?? null;
    const now = nowIso();

    this.db
      .query(
        `INSERT INTO repos (root_path, common_dir, name, remote_url, last_seen_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(root_path) DO UPDATE SET
           common_dir = excluded.common_dir,
           name = excluded.name,
           remote_url = COALESCE(excluded.remote_url, repos.remote_url),
           last_seen_at = excluded.last_seen_at`,
      )
      .run(rootPath, commonDir, name, remoteUrl, now);

    const row = this.db
      .query("SELECT * FROM repos WHERE root_path = ?1")
      .get(rootPath) as RepoRow;
    return mapRepo(row);
  }

  listRepos(): TrackedRepo[] {
    const rows = this.db
      .query("SELECT * FROM repos ORDER BY name COLLATE NOCASE ASC, root_path ASC")
      .all() as RepoRow[];
    return rows.map(mapRepo);
  }

  getRepoById(id: number): TrackedRepo | null {
    const row = this.db.query("SELECT * FROM repos WHERE id = ?1").get(id) as RepoRow | null;
    return row ? mapRepo(row) : null;
  }

  findRepo(identifier: string): TrackedRepo | null {
    const trimmed = identifier.trim();
    if (/^\d+$/.test(trimmed)) {
      const byId = this.getRepoById(Number(trimmed));
      if (byId) return byId;
    }
    const normalized = canonicalPath(trimmed);
    const byPath = this.db
      .query("SELECT * FROM repos WHERE root_path = ?1")
      .get(normalized) as RepoRow | null;
    if (byPath) return mapRepo(byPath);

    const byName = this.db
      .query("SELECT * FROM repos WHERE lower(name) = lower(?1) LIMIT 1")
      .get(trimmed) as RepoRow | null;
    return byName ? mapRepo(byName) : null;
  }

  removeRepo(id: number): boolean {
    const res = this.db.query("DELETE FROM repos WHERE id = ?1").run(id);
    return res.changes > 0;
  }

  addWatchedDir(dirPath: string): WatchedDir {
    const normalized = canonicalPath(dirPath);
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO watched_dirs (dir_path, created_at) VALUES (?1, ?2)
         ON CONFLICT(dir_path) DO NOTHING`,
      )
      .run(normalized, now);
    const row = this.db
      .query("SELECT id, dir_path, created_at FROM watched_dirs WHERE dir_path = ?1")
      .get(normalized) as { id: number; dir_path: string; created_at: string };
    return { id: row.id, dirPath: row.dir_path, createdAt: row.created_at };
  }

  removeWatchedDir(dirPathOrId: string): boolean {
    const trimmed = dirPathOrId.trim();
    if (/^\d+$/.test(trimmed)) {
      const res = this.db.query("DELETE FROM watched_dirs WHERE id = ?1").run(Number(trimmed));
      if (res.changes > 0) return true;
    }
    const normalized = canonicalPath(trimmed);
    const res = this.db.query("DELETE FROM watched_dirs WHERE dir_path = ?1").run(normalized);
    return res.changes > 0;
  }

  listWatchedDirs(): WatchedDir[] {
    const rows = this.db
      .query("SELECT id, dir_path, created_at FROM watched_dirs ORDER BY dir_path ASC")
      .all() as Array<{ id: number; dir_path: string; created_at: string }>;
    return rows.map((r) => ({ id: r.id, dirPath: r.dir_path, createdAt: r.created_at }));
  }

  private touchBranchMeta(commonDir: string, branch: string): void {
    const dir = canonicalPath(commonDir);
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO branch_meta (common_dir, branch, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(common_dir, branch) DO UPDATE SET updated_at = excluded.updated_at`,
      )
      .run(dir, branch, now);
  }

  recordBranchVisit(commonDir: string, branch: string): void {
    const dir = canonicalPath(commonDir);
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO branch_meta (common_dir, branch, last_visited_at, updated_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(common_dir, branch) DO UPDATE SET
           last_visited_at = excluded.last_visited_at,
           updated_at = excluded.updated_at`,
      )
      .run(dir, branch, now);
  }

  setBranchLink(commonDir: string, branch: string, link: string | null): void {
    const dir = canonicalPath(commonDir);
    const clean = link?.trim() || null;
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO branch_meta (common_dir, branch, link, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(common_dir, branch) DO UPDATE SET
           link = excluded.link,
           updated_at = excluded.updated_at`,
      )
      .run(dir, branch, clean, now);
  }

  addNote(commonDir: string, branch: string, content: string): BranchNote {
    const dir = canonicalPath(commonDir);
    const text = content.trim();
    const now = nowIso();
    const res = this.db
      .query("INSERT INTO notes (common_dir, branch, content, created_at) VALUES (?1, ?2, ?3, ?4)")
      .run(dir, branch, text, now);
    this.touchBranchMeta(dir, branch);
    const row = this.db
      .query("SELECT * FROM notes WHERE id = ?1")
      .get(Number(res.lastInsertRowid)) as NoteRow;
    return mapNote(row);
  }

  updateNote(id: number, content: string): BranchNote | null {
    const text = content.trim();
    const res = this.db.query("UPDATE notes SET content = ?1 WHERE id = ?2").run(text, id);
    if (res.changes === 0) return null;
    const row = this.db.query("SELECT * FROM notes WHERE id = ?1").get(id) as NoteRow | null;
    if (!row) return null;
    this.touchBranchMeta(row.common_dir, row.branch);
    return mapNote(row);
  }

  deleteNote(id: number): boolean {
    const res = this.db.query("DELETE FROM notes WHERE id = ?1").run(id);
    return res.changes > 0;
  }

  clearNotes(commonDir: string, branch: string): number {
    const dir = canonicalPath(commonDir);
    const res = this.db
      .query("DELETE FROM notes WHERE common_dir = ?1 AND branch = ?2")
      .run(dir, branch);
    return res.changes;
  }

  addTodo(commonDir: string, branch: string, text: string): BranchTodo {
    const dir = canonicalPath(commonDir);
    const clean = text.trim();
    const now = nowIso();
    const res = this.db
      .query(
        "INSERT INTO todos (common_dir, branch, text, done, created_at) VALUES (?1, ?2, ?3, 0, ?4)",
      )
      .run(dir, branch, clean, now);
    this.touchBranchMeta(dir, branch);
    const row = this.db
      .query("SELECT * FROM todos WHERE id = ?1")
      .get(Number(res.lastInsertRowid)) as TodoRow;
    return mapTodo(row);
  }

  setTodoDone(id: number, done: boolean): BranchTodo | null {
    const completedAt = done ? nowIso() : null;
    const res = this.db
      .query("UPDATE todos SET done = ?1, completed_at = ?2 WHERE id = ?3")
      .run(done ? 1 : 0, completedAt, id);
    if (res.changes === 0) return null;
    const row = this.db.query("SELECT * FROM todos WHERE id = ?1").get(id) as TodoRow | null;
    if (!row) return null;
    this.touchBranchMeta(row.common_dir, row.branch);
    return mapTodo(row);
  }

  updateTodoText(id: number, text: string): BranchTodo | null {
    const clean = text.trim();
    const res = this.db.query("UPDATE todos SET text = ?1 WHERE id = ?2").run(clean, id);
    if (res.changes === 0) return null;
    const row = this.db.query("SELECT * FROM todos WHERE id = ?1").get(id) as TodoRow | null;
    return row ? mapTodo(row) : null;
  }

  deleteTodo(id: number): boolean {
    const res = this.db.query("DELETE FROM todos WHERE id = ?1").run(id);
    return res.changes > 0;
  }

  getBranchContext(commonDir: string, branch: string): BranchContext {
    const dir = canonicalPath(commonDir);
    const meta = this.db
      .query("SELECT * FROM branch_meta WHERE common_dir = ?1 AND branch = ?2")
      .get(dir, branch) as MetaRow | null;
    const noteRows = this.db
      .query("SELECT * FROM notes WHERE common_dir = ?1 AND branch = ?2 ORDER BY id ASC")
      .all(dir, branch) as NoteRow[];
    const todoRows = this.db
      .query("SELECT * FROM todos WHERE common_dir = ?1 AND branch = ?2 ORDER BY done ASC, id ASC")
      .all(dir, branch) as TodoRow[];

    return {
      commonDir: dir,
      branch,
      link: meta?.link ?? null,
      lastVisitedAt: meta?.last_visited_at ?? null,
      updatedAt: meta?.updated_at ?? null,
      notes: noteRows.map(mapNote),
      todos: todoRows.map(mapTodo),
    };
  }

  listBranchSummaries(commonDir?: string): BranchSummaryEntry[] {
    const dirFilter = commonDir ? canonicalPath(commonDir) : null;
    const query = `
      WITH keys AS (
        SELECT common_dir, branch FROM branch_meta
        UNION
        SELECT common_dir, branch FROM notes
        UNION
        SELECT common_dir, branch FROM todos
      )
      SELECT
        k.common_dir,
        k.branch,
        m.link,
        m.last_visited_at,
        m.updated_at,
        (SELECT COUNT(*) FROM notes n WHERE n.common_dir = k.common_dir AND n.branch = k.branch) AS note_count,
        (SELECT COUNT(*) FROM todos t WHERE t.common_dir = k.common_dir AND t.branch = k.branch AND t.done = 0) AS open_todo_count,
        (SELECT COUNT(*) FROM todos t WHERE t.common_dir = k.common_dir AND t.branch = k.branch AND t.done = 1) AS done_todo_count
      FROM keys k
      LEFT JOIN branch_meta m ON m.common_dir = k.common_dir AND m.branch = k.branch
      ${dirFilter ? "WHERE k.common_dir = ?1" : ""}
      ORDER BY COALESCE(m.updated_at, m.last_visited_at, '') DESC, k.branch ASC
    `;
    const rows = (
      dirFilter ? this.db.query(query).all(dirFilter) : this.db.query(query).all()
    ) as Array<{
      common_dir: string;
      branch: string;
      link: string | null;
      last_visited_at: string | null;
      updated_at: string | null;
      note_count: number;
      open_todo_count: number;
      done_todo_count: number;
    }>;

    return rows.map((r) => ({
      commonDir: r.common_dir,
      branch: r.branch,
      link: r.link,
      lastVisitedAt: r.last_visited_at,
      updatedAt: r.updated_at,
      noteCount: r.note_count,
      openTodoCount: r.open_todo_count,
      doneTodoCount: r.done_todo_count,
    }));
  }

  getOpenTodosForRepo(commonDir: string): BranchTodo[] {
    const dir = canonicalPath(commonDir);
    const rows = this.db
      .query("SELECT * FROM todos WHERE common_dir = ?1 AND done = 0 ORDER BY branch ASC, id ASC")
      .all(dir) as TodoRow[];
    return rows.map(mapTodo);
  }

  getCompletedTodosSince(commonDir: string, sinceIso: string): BranchTodo[] {
    const dir = canonicalPath(commonDir);
    const rows = this.db
      .query(
        `SELECT * FROM todos
         WHERE common_dir = ?1 AND done = 1 AND completed_at IS NOT NULL AND completed_at >= ?2
         ORDER BY completed_at ASC`,
      )
      .all(dir, sinceIso) as TodoRow[];
    return rows.map(mapTodo);
  }

  getNotesForRepo(commonDir: string): BranchNote[] {
    const dir = canonicalPath(commonDir);
    const rows = this.db
      .query("SELECT * FROM notes WHERE common_dir = ?1 ORDER BY branch ASC, id ASC")
      .all(dir) as NoteRow[];
    return rows.map(mapNote);
  }

  searchContext(query: string, limit = 50): ContextSearchHit[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const pattern = `%${escapeLikePattern(trimmed)}%`;
    const safeLimit = Math.max(1, Math.min(limit, 200));

    interface SearchRow {
      kind: "note" | "todo" | "link";
      common_dir: string;
      branch: string;
      text: string;
      done: number | null;
      ts: string | null;
    }

    const rows = this.db
      .query(
        `SELECT 'note' AS kind, common_dir, branch, content AS text, NULL AS done, created_at AS ts
         FROM notes
         WHERE LOWER(content) LIKE LOWER(?1) ESCAPE '\\'
         UNION ALL
         SELECT 'todo' AS kind, common_dir, branch, text, done, COALESCE(completed_at, created_at) AS ts
         FROM todos
         WHERE LOWER(text) LIKE LOWER(?1) ESCAPE '\\'
         UNION ALL
         SELECT 'link' AS kind, common_dir, branch, link AS text, NULL AS done, COALESCE(updated_at, last_visited_at) AS ts
         FROM branch_meta
         WHERE link IS NOT NULL AND link != '' AND LOWER(link) LIKE LOWER(?1) ESCAPE '\\'
         ORDER BY ts DESC
         LIMIT ?2`,
      )
      .all(pattern, safeLimit) as SearchRow[];

    return rows.map((row) => ({
      kind: row.kind,
      commonDir: row.common_dir,
      branch: row.branch,
      text: row.text,
      done: row.kind === "todo" ? row.done === 1 : undefined,
      timestamp: row.ts,
    }));
  }

  getRecentNotesSince(sinceIso: string, limit = 100): BranchNote[] {
    const safeLimit = Math.max(1, Math.min(limit, 300));
    const rows = this.db
      .query("SELECT * FROM notes WHERE created_at >= ?1 ORDER BY created_at DESC, id DESC LIMIT ?2")
      .all(sinceIso, safeLimit) as NoteRow[];
    return rows.map(mapNote);
  }

  getRecentTodosSince(sinceIso: string, limit = 100): BranchTodo[] {
    const safeLimit = Math.max(1, Math.min(limit, 300));
    const rows = this.db
      .query(
        `SELECT * FROM todos
         WHERE created_at >= ?1 OR (completed_at IS NOT NULL AND completed_at >= ?1)
         ORDER BY COALESCE(completed_at, created_at) DESC, id DESC
         LIMIT ?2`,
      )
      .all(sinceIso, safeLimit) as TodoRow[];
    return rows.map(mapTodo);
  }
}
