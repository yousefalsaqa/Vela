import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(here, "../data/vela.db");

/** Where the assistant's own database lives. `VELA_DB` overrides it. */
export const dbPath = (): string => process.env.VELA_DB ?? DEFAULT_DB;

const SCHEMA = `
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS memory (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    content    TEXT NOT NULL UNIQUE,
    tags       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS memory_kind_idx ON memory(kind);

  CREATE TABLE IF NOT EXISTS project (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    path       TEXT NOT NULL,
    notes      TEXT NOT NULL DEFAULT '',
    last_used  TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS watch (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    note         TEXT NOT NULL UNIQUE,
    cue          TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'active',
    last_spoke   TEXT,
    last_message TEXT NOT NULL DEFAULT '',
    trigger_kind TEXT NOT NULL DEFAULT '',
    trigger_arg  TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS watch_status_idx ON watch(status);
`;

export type MemoryKind = "preference" | "project" | "fact" | "reference";

export interface MemoryRow {
  id: number;
  kind: string;
  content: string;
  tags: string;
  updated_at: string;
}

export interface ProjectRow {
  id: number;
  name: string;
  path: string;
  notes: string;
}

/**
 * What wakes a watch up early. Without one it is only looked at on the
 * heartbeat's timer; with one it can report within seconds and costs nothing
 * in between.
 */
export type Trigger =
  /** Fire when a file is written to — a build log, an output file. */
  | { kind: "file"; arg: string }
  /** Fire when a named process that was running stops running. */
  | { kind: "process"; arg: string };

export interface WatchRow {
  id: number;
  note: string;
  cue: string;
  last_message: string;
  trigger_kind: string;
  trigger_arg: string;
  /** Minutes since this watch was last mentioned unprompted; null if never. */
  minutes_since_spoke: number | null;
}

/**
 * Everything Vela remembers, bound to one database file.
 *
 * This is a factory rather than a module-level singleton so tests can hold a
 * throwaway `:memory:` store and the running assistant can hold the real one,
 * without either knowing about the other.
 */
export function createStore(path: string = dbPath()) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  // CREATE TABLE IF NOT EXISTS leaves an older database alone, so columns
  // added after the fact have to be applied by hand.
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(watch)`).all() as unknown as {
      name: string;
    }[]).map((c) => c.name),
  );
  for (const [name, ddl] of [
    ["trigger_kind", `ALTER TABLE watch ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT ''`],
    ["trigger_arg", `ALTER TABLE watch ADD COLUMN trigger_arg TEXT NOT NULL DEFAULT ''`],
  ] as const) {
    if (!columns.has(name)) db.exec(ddl);
  }

  function remember(
    kind: MemoryKind,
    content: string,
    tags: string[] = [],
  ): string {
    // content is UNIQUE, so an upsert keeps memory from filling with duplicates.
    db.prepare(
      `INSERT INTO memory (kind, content, tags) VALUES (?, ?, ?)
       ON CONFLICT(content) DO UPDATE SET
         kind = excluded.kind,
         tags = excluded.tags,
         updated_at = datetime('now')`,
    ).run(kind, content, tags.join(","));

    const row = db
      .prepare(`SELECT id FROM memory WHERE content = ?`)
      .get(content) as { id: number };
    return `Saved memory #${row.id}.`;
  }

  function recall(query?: string, kind?: MemoryKind): MemoryRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (kind) {
      where.push("kind = ?");
      params.push(kind);
    }
    if (query) {
      where.push("(content LIKE ? OR tags LIKE ?)");
      params.push(`%${query}%`, `%${query}%`);
    }
    const sql =
      `SELECT id, kind, content, tags, updated_at FROM memory` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY updated_at DESC, id DESC LIMIT 40`;
    return db.prepare(sql).all(...(params as never[])) as unknown as MemoryRow[];
  }

  function forget(id: number): string {
    const info = db.prepare(`DELETE FROM memory WHERE id = ?`).run(id);
    return info.changes ? `Deleted memory #${id}.` : `No memory #${id}.`;
  }

  function listProjects(): ProjectRow[] {
    return db
      .prepare(
        `SELECT id, name, path, notes FROM project ORDER BY last_used DESC, id DESC`,
      )
      .all() as unknown as ProjectRow[];
  }

  function addProject(name: string, path: string, notes = ""): string {
    db.prepare(
      `INSERT INTO project (name, path, notes) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         path = excluded.path,
         notes = excluded.notes,
         last_used = datetime('now')`,
    ).run(name, path, notes);
    return `Registered ${name} → ${path}`;
  }

  function touchProject(name: string): void {
    db.prepare(
      `UPDATE project SET last_used = datetime('now') WHERE name = ?`,
    ).run(name);
  }

  function addWatch(note: string, cue = "", trigger?: Trigger): string {
    db.prepare(
      `INSERT INTO watch (note, cue, trigger_kind, trigger_arg)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(note) DO UPDATE SET
         cue = excluded.cue,
         trigger_kind = excluded.trigger_kind,
         trigger_arg = excluded.trigger_arg,
         status = 'active'`,
    ).run(note, cue, trigger?.kind ?? "", trigger?.arg ?? "");
    const row = db
      .prepare(`SELECT id FROM watch WHERE note = ?`)
      .get(note) as { id: number };
    return `Watching #${row.id}: ${note}`;
  }

  function listWatches(): WatchRow[] {
    return db
      .prepare(
        `SELECT id, note, cue, last_message, trigger_kind, trigger_arg,
                CAST((julianday('now') - julianday(last_spoke)) * 1440 AS INTEGER)
                  AS minutes_since_spoke
         FROM watch WHERE status = 'active' ORDER BY id`,
      )
      .all() as unknown as WatchRow[];
  }

  function resolveWatch(id: number): string {
    const info = db
      .prepare(
        `UPDATE watch SET status = 'done' WHERE id = ? AND status = 'active'`,
      )
      .run(id);
    return info.changes ? `Closed watch #${id}.` : `No active watch #${id}.`;
  }

  /** Record that we spoke up about a watch, so the next tick doesn't repeat it. */
  function markSpoke(id: number, message: string): void {
    db.prepare(
      `UPDATE watch SET last_spoke = datetime('now'), last_message = ? WHERE id = ?`,
    ).run(message, id);
  }

  /**
   * The always-on context block injected into every session's system prompt.
   * Kept deliberately small — it rides along on every single request.
   */
  function buildContextBlock(): string {
    const memories = db
      .prepare(
        `SELECT kind, content FROM memory ORDER BY updated_at DESC, id DESC LIMIT 30`,
      )
      .all() as unknown as { kind: string; content: string }[];

    const parts: string[] = [];

    if (memories.length) {
      parts.push(
        "## What you know about Yousef\n" +
          memories.map((m) => `- [${m.kind}] ${m.content}`).join("\n"),
      );
    }

    const projects = listProjects();
    if (projects.length) {
      parts.push(
        "## Known projects\n" +
          projects
            .map(
              (p) => `- ${p.name} → ${p.path}${p.notes ? ` (${p.notes})` : ""}`,
            )
            .join("\n"),
      );
    }

    const watches = listWatches();
    if (watches.length) {
      parts.push(
        "## Things you're watching in the background\n" +
          watches.map((w) => `- #${w.id} ${w.note}`).join("\n"),
      );
    }

    return parts.join("\n\n");
  }

  return {
    db,
    remember,
    recall,
    forget,
    listProjects,
    addProject,
    touchProject,
    addWatch,
    listWatches,
    resolveWatch,
    markSpoke,
    buildContextBlock,
    close: () => db.close(),
  };
}

export type Store = ReturnType<typeof createStore>;

// The assistant's own store. Created on first use, so importing this module —
// as the tests do — doesn't open the real database as a side effect.
let singleton: Store | undefined;
export function store(): Store {
  return (singleton ??= createStore());
}

export const remember: Store["remember"] = (...a) => store().remember(...a);
export const recall: Store["recall"] = (...a) => store().recall(...a);
export const forget: Store["forget"] = (...a) => store().forget(...a);
export const listProjects: Store["listProjects"] = () => store().listProjects();
export const addProject: Store["addProject"] = (...a) => store().addProject(...a);
export const touchProject: Store["touchProject"] = (...a) =>
  store().touchProject(...a);
export const addWatch: Store["addWatch"] = (...a) => store().addWatch(...a);
export const listWatches: Store["listWatches"] = () => store().listWatches();
export const resolveWatch: Store["resolveWatch"] = (...a) =>
  store().resolveWatch(...a);
export const markSpoke: Store["markSpoke"] = (...a) => store().markSpoke(...a);
export const buildContextBlock: Store["buildContextBlock"] = () =>
  store().buildContextBlock();

export function close(): void {
  singleton?.close();
  singleton = undefined;
}
