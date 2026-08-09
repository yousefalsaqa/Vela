import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  dbPath,
  store as defaultStore,
  close as closeDefault,
  remember as rememberDefault,
  recall as recallDefault,
  forget as forgetDefault,
  addProject as addProjectDefault,
  listProjects as listProjectsDefault,
  touchProject as touchProjectDefault,
  addWatch as addWatchDefault,
  listWatches as listWatchesDefault,
  markSpoke as markSpokeDefault,
  resolveWatch as resolveWatchDefault,
  buildContextBlock as buildContextBlockDefault,
  type Store,
} from "../src/memory.js";

let s: Store;
beforeEach(() => {
  s = createStore(":memory:");
});

describe("remember / recall / forget", () => {
  test("stores a fact and hands back its id", () => {
    assert.equal(s.remember("fact", "Yousef is at Queen's."), "Saved memory #1.");
    assert.equal(s.recall()[0].content, "Yousef is at Queen's.");
  });

  test("re-saving the same fact updates it instead of duplicating", () => {
    s.remember("fact", "He prefers Python.", ["lang"]);
    assert.equal(
      s.remember("preference", "He prefers Python.", ["lang", "style"]),
      "Saved memory #1.",
      "same content must keep the same id",
    );
    const rows = s.recall();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "preference");
    assert.equal(rows[0].tags, "lang,style");
  });

  test("searches content and tags alike", () => {
    s.remember("fact", "Owns a 3D printer.", ["fabrication"]);
    s.remember("fact", "Drives a Civic.", ["car"]);
    assert.equal(s.recall("printer").length, 1);
    assert.equal(s.recall("fabrication").length, 1, "tags are searchable too");
    assert.equal(s.recall("helicopter").length, 0);
  });

  test("filters by kind, and combines kind with a query", () => {
    s.remember("preference", "Likes short answers.");
    s.remember("fact", "Likes espresso.");
    assert.equal(s.recall(undefined, "preference").length, 1);
    assert.equal(s.recall("Likes", "fact").length, 1);
  });

  test("caps a recall at 40 rows", () => {
    for (let i = 0; i < 50; i++) s.remember("fact", `fact number ${i}`);
    assert.equal(s.recall().length, 40);
  });

  test("forgets a real memory and says so when there isn't one", () => {
    s.remember("fact", "Temporary.");
    assert.equal(s.forget(1), "Deleted memory #1.");
    assert.equal(s.forget(1), "No memory #1.");
    assert.deepEqual(s.recall(), []);
  });
});

describe("projects", () => {
  test("registers and lists a project", () => {
    assert.equal(
      s.addProject("fantasy", "C:/Users/Yousef/Desktop/LaLigaFantasy", "next.js"),
      "Registered fantasy → C:/Users/Yousef/Desktop/LaLigaFantasy",
    );
    // node:sqlite returns null-prototype rows, so compare field by field.
    assert.deepEqual({ ...s.listProjects()[0] }, {
      id: 1,
      name: "fantasy",
      path: "C:/Users/Yousef/Desktop/LaLigaFantasy",
      notes: "next.js",
    });
  });

  test("re-registering moves the path rather than adding a second row", () => {
    s.addProject("fantasy", "C:/old");
    s.addProject("fantasy", "C:/new");
    const rows = s.listProjects();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].path, "C:/new");
  });

  test("touching a project is harmless when it doesn't exist", () => {
    assert.doesNotThrow(() => s.touchProject("ghost"));
  });
});

describe("watches", () => {
  test("adds a watch and reports its id", () => {
    assert.equal(
      s.addWatch("the build finishing", "tail build.log"),
      "Watching #1: the build finishing",
    );
    const [w] = s.listWatches();
    assert.equal(w.cue, "tail build.log");
    assert.equal(w.minutes_since_spoke, null, "nothing said yet");
    assert.equal(w.last_message, "");
  });

  test("resolving takes it out of the active list, and only works once", () => {
    s.addWatch("the build");
    assert.equal(s.resolveWatch(1), "Closed watch #1.");
    assert.deepEqual(s.listWatches(), []);
    assert.equal(s.resolveWatch(1), "No active watch #1.");
    assert.equal(s.resolveWatch(99), "No active watch #99.");
  });

  test("asking for the same watch again reopens the closed one", () => {
    s.addWatch("the build", "old cue");
    s.resolveWatch(1);
    assert.equal(s.addWatch("the build", "new cue"), "Watching #1: the build");
    const [w] = s.listWatches();
    assert.equal(w.id, 1, "must reuse the row, not orphan it");
    assert.equal(w.cue, "new cue");
  });

  test("markSpoke records the message and resets the clock", () => {
    s.addWatch("the build");
    s.markSpoke(1, "Build succeeded.");
    const [w] = s.listWatches();
    assert.equal(w.last_message, "Build succeeded.");
    assert.equal(w.minutes_since_spoke, 0);
  });

  test("markSpoke on a missing id is a no-op, not a crash", () => {
    assert.doesNotThrow(() => s.markSpoke(99, "into the void"));
  });
});

describe("watch triggers", () => {
  test("a watch can carry a file trigger", () => {
    s.addWatch("the build finishing", "tail build.log", {
      kind: "file",
      arg: "C:/tmp/build.log",
    });
    const [w] = s.listWatches();
    assert.equal(w.trigger_kind, "file");
    assert.equal(w.trigger_arg, "C:/tmp/build.log");
  });

  test("a watch without a trigger reports none, rather than null", () => {
    s.addWatch("something vague");
    const [w] = s.listWatches();
    assert.equal(w.trigger_kind, "");
    assert.equal(w.trigger_arg, "");
  });

  test("re-adding a watch can attach a trigger to an existing one", () => {
    s.addWatch("the build finishing", "tail build.log");
    s.addWatch("the build finishing", "tail build.log", {
      kind: "process",
      arg: "node",
    });
    const rows = s.listWatches();
    assert.equal(rows.length, 1, "must update the row, not add one");
    assert.equal(rows[0].trigger_kind, "process");
    assert.equal(rows[0].trigger_arg, "node");
  });

  test("re-adding without a trigger clears a stale one", () => {
    s.addWatch("the build", "", { kind: "file", arg: "C:/gone.log" });
    s.addWatch("the build");
    assert.equal(s.listWatches()[0].trigger_kind, "");
  });
});

describe("migration", () => {
  test("adds trigger columns to a database written before they existed", () => {
    const dir = mkdtempSync(join(tmpdir(), "vela-migrate-"));
    const file = join(dir, "old.db");
    try {
      // The schema exactly as it shipped before triggers existed.
      const old = new DatabaseSync(file);
      old.exec(`
        CREATE TABLE watch (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          note         TEXT NOT NULL UNIQUE,
          cue          TEXT NOT NULL DEFAULT '',
          status       TEXT NOT NULL DEFAULT 'active',
          last_spoke   TEXT,
          last_message TEXT NOT NULL DEFAULT '',
          created_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      old.prepare(`INSERT INTO watch (note, cue) VALUES (?, ?)`).run(
        "an old watch",
        "old cue",
      );
      old.close();

      const migrated = createStore(file);
      const [w] = migrated.listWatches();
      assert.equal(w.note, "an old watch", "existing rows must survive");
      assert.equal(w.cue, "old cue");
      assert.equal(w.trigger_kind, "", "new column defaults, not null");
      assert.doesNotThrow(
        () => migrated.addWatch("a new watch", "", { kind: "file", arg: "x" }),
        "must be writable after migrating",
      );
      migrated.close();

      // Opening it again must not try to migrate a second time.
      const reopened = createStore(file);
      assert.equal(reopened.listWatches().length, 2);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildContextBlock", () => {
  test("is empty when there is nothing to say", () => {
    assert.equal(s.buildContextBlock(), "");
  });

  test("includes only the sections that have content", () => {
    s.remember("fact", "Owns no 3D printer yet.");
    const block = s.buildContextBlock();
    assert.match(block, /## What you know about Yousef/);
    assert.match(block, /- \[fact\] Owns no 3D printer yet\./);
    assert.doesNotMatch(block, /## Known projects/);
    assert.doesNotMatch(block, /watching in the background/);
  });

  test("carries projects and active watches", () => {
    s.addProject("fantasy", "C:/f", "next.js");
    s.addWatch("the build finishing");
    const block = s.buildContextBlock();
    assert.match(block, /- fantasy → C:\/f \(next\.js\)/);
    assert.match(block, /- #1 the build finishing/);
  });

  test("leaves resolved watches out", () => {
    s.addWatch("the build");
    s.resolveWatch(1);
    assert.doesNotMatch(s.buildContextBlock(), /the build/);
  });

  test("stays small — at most 30 memories ride on every request", () => {
    for (let i = 0; i < 40; i++) s.remember("fact", `fact number ${i}`);
    const lines = s
      .buildContextBlock()
      .split("\n")
      .filter((l) => l.startsWith("- ["));
    assert.equal(lines.length, 30);
  });
});

describe("createStore", () => {
  test("gives each caller an isolated database", () => {
    const other = createStore(":memory:");
    s.remember("fact", "only in the first store");
    assert.deepEqual(other.recall(), []);
    other.close();
  });

  test("is safe to open twice against the same schema", () => {
    assert.doesNotThrow(() => createStore(":memory:").close());
  });
});

describe("the assistant's own store", () => {
  // Every test in this file runs in its own process, so pointing the default
  // store at :memory: here can't touch the real data/vela.db.
  beforeEach(() => {
    process.env.VELA_DB = ":memory:";
    closeDefault();
  });

  test("honours VELA_DB", () => {
    assert.equal(dbPath(), ":memory:");
    delete process.env.VELA_DB;
    assert.match(dbPath(), /data[\\/]vela\.db$/, "falls back to the real file");
  });

  test("is created once and reused", () => {
    assert.equal(defaultStore(), defaultStore());
  });

  test("is not opened merely by importing the module", () => {
    // Guards the laziness that lets the tests import this at all.
    closeDefault();
    assert.doesNotThrow(() => closeDefault(), "closing twice must be safe");
  });

  // Each bare export is a one-line delegate to the same method on the default
  // store. They're trivial, which is exactly why a mis-wired one — markSpoke
  // delegating to resolveWatch — would never be noticed by reading. These
  // assert on the effect, so only the correct method satisfies them.
  test("remember and recall delegate", () => {
    rememberDefault("fact", "routed through the default store");
    assert.equal(recallDefault()[0].content, "routed through the default store");
  });

  test("forget delegates", () => {
    rememberDefault("fact", "briefly true");
    const id = recallDefault("briefly")[0].id;
    assert.equal(forgetDefault(id), `Deleted memory #${id}.`);
    assert.deepEqual(recallDefault("briefly"), []);
  });

  test("addProject, listProjects and touchProject delegate", () => {
    addProjectDefault("vela", "C:/Users/Yousef/Desktop/Vela", "this");
    assert.equal(listProjectsDefault()[0].name, "vela");
    assert.doesNotThrow(() => touchProjectDefault("vela"));
    assert.equal(listProjectsDefault().length, 1, "touch must not add a row");
  });

  test("addWatch and listWatches delegate", () => {
    addWatchDefault("the build", "tail build.log");
    const [w] = listWatchesDefault();
    assert.equal(w.note, "the build");
    assert.equal(w.cue, "tail build.log");
  });

  test("markSpoke delegates — and records rather than resolves", () => {
    addWatchDefault("the build");
    markSpokeDefault(listWatchesDefault()[0].id, "Build succeeded.");
    const [w] = listWatchesDefault();
    assert.ok(w, "markSpoke must leave the watch open");
    assert.equal(w.last_message, "Build succeeded.");
  });

  test("resolveWatch delegates — and resolves rather than records", () => {
    addWatchDefault("the build");
    const id = listWatchesDefault()[0].id;
    assert.equal(resolveWatchDefault(id), `Closed watch #${id}.`);
    assert.deepEqual(listWatchesDefault(), []);
  });

  test("buildContextBlock delegates", () => {
    rememberDefault("fact", "in the context block");
    assert.match(buildContextBlockDefault(), /- \[fact\] in the context block/);
  });
});
