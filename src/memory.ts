import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createVault, type Note, type Vault } from "./vault.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = resolve(here, "../data/vela.db");
const DEFAULT_VAULT = resolve(here, "../vault");

/** Where the assistant's own database lives. `VELA_DB` overrides it. */
export const dbPath = (): string => process.env.VELA_DB ?? DEFAULT_DB;

/**
 * The Obsidian vault holding what she remembers. `VELA_VAULT` overrides it.
 * Notes go in a Memory subfolder so the vault root stays free for his own.
 */
export const vaultPath = (): string =>
  join(process.env.VELA_VAULT ?? DEFAULT_VAULT, "Memory");

const SCHEMA = `
  PRAGMA journal_mode = WAL;

  -- Memories used to live here. They're markdown notes in the vault now, so
  -- he can read and correct them; the table stays only so an existing
  -- database can still be migrated out of. See migrateMemoriesToVault.
  CREATE TABLE IF NOT EXISTS memory (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    content    TEXT NOT NULL UNIQUE,
    tags       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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

  -- Voiceprints, one per person, saved only with that person's yes. The print
  -- is a JSON array: 192 numbers, compared and blended in src/voices.ts.
  -- samples is how many utterances it is the average of.
  CREATE TABLE IF NOT EXISTS voice (
    name       TEXT PRIMARY KEY COLLATE NOCASE,
    print      TEXT NOT NULL,
    samples    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

export type MemoryKind = "preference" | "project" | "fact" | "reference";

/** A memory is a note now; its filename is its identity. */
export type MemoryRow = Note;

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

/** One person she knows by voice. See src/voices.ts. */
export interface VoiceRow {
  name: string;
  print: number[];
  samples: number;
}

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
export function createStore(
  path: string = dbPath(),
  // A throwaway database gets a throwaway vault. Otherwise `createStore(":memory:")`
  // reads as isolated while quietly writing notes into his real one.
  vault: Vault = createVault(
    path === ":memory:"
      ? mkdtempSync(join(tmpdir(), "vela-scratch-vault-"))
      : vaultPath(),
  ),
) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const db = new DatabaseSync(path);
  db.exec(SCHEMA);

  // Anything left in the old table becomes a note the first time she runs.
  migrateMemoriesToVault(db, vault);

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

  const remember = (kind: MemoryKind, content: string, tags: string[] = []) =>
    vault.remember(kind, content, tags);

  const recall = (query?: string, kind?: MemoryKind): MemoryRow[] =>
    vault.recall(query, kind);

  const forget = (name: string): string => vault.forget(name);

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

  /** Everyone whose voice she knows. */
  function listVoices(): VoiceRow[] {
    return (
      db.prepare(`SELECT name, print, samples FROM voice ORDER BY name`).all() as unknown as {
        name: string;
        print: string;
        samples: number;
      }[]
    ).map((r) => ({ name: r.name, print: JSON.parse(r.print) as number[], samples: r.samples }));
  }

  /**
   * Save a voiceprint, or replace the one under that name. Whether it should
   * be saved, and what it is the average of, is decided in src/voices.ts.
   * The name keeps the spelling it was first saved with.
   */
  function saveVoice(name: string, print: number[], samples: number): void {
    db.prepare(
      `INSERT INTO voice (name, print, samples) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         print = excluded.print,
         samples = excluded.samples,
         updated_at = datetime('now')`,
    ).run(name, JSON.stringify(print), samples);
  }

  function forgetVoice(name: string): boolean {
    return db.prepare(`DELETE FROM voice WHERE name = ?`).run(name).changes > 0;
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
    const memories = vault.recall().slice(0, 30);

    const parts: string[] = [];

    if (memories.length) {
      parts.push(
        "## What you know about Yousef\n" +
          memories.map((m) => `- [${m.kind}] ${m.body}`).join("\n"),
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
    vault,
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
    listVoices,
    saveVoice,
    forgetVoice,
    buildContextBlock,
    close: () => db.close(),
  };
}

/**
 * Carry an old database's memories over into the vault, once. Rows are deleted
 * as they're written, so this is a no-op on every run after the first and the
 * table drains rather than growing a second copy of everything.
 */
export function migrateMemoriesToVault(
  db: DatabaseSync,
  vault: Vault,
): number {
  const rows = db
    .prepare(`SELECT id, kind, content, tags FROM memory ORDER BY id`)
    .all() as unknown as { id: number; kind: string; content: string; tags: string }[];

  for (const row of rows) {
    vault.remember(
      row.kind,
      row.content,
      row.tags ? row.tags.split(",").filter(Boolean) : [],
    );
    db.prepare(`DELETE FROM memory WHERE id = ?`).run(row.id);
  }
  return rows.length;
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
export const listVoices: Store["listVoices"] = () => store().listVoices();
export const saveVoice: Store["saveVoice"] = (...a) => store().saveVoice(...a);
export const forgetVoice: Store["forgetVoice"] = (...a) => store().forgetVoice(...a);
export const buildContextBlock: Store["buildContextBlock"] = () =>
  store().buildContextBlock();

export function close(): void {
  singleton?.close();
  singleton = undefined;
}
