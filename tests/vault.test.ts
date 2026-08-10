import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseNote,
  parseTags,
  formatNote,
  slugify,
  createVault,
  type Vault,
} from "../src/vault.js";

describe("slugify", () => {
  test("names a note after the sentence, so the vault reads as statements", () => {
    assert.equal(slugify("Yousef prefers Python."), "yousef-prefers-python");
  });

  test("drops punctuation a filename can't hold", () => {
    assert.equal(slugify("He uses C:/Users/Yousef & likes it!"), "he-uses-c-users-yousef-likes");
  });

  test("won't end on a stranded filler word", () => {
    // Cutting at a fixed count produced "...engineering-from-queen", which
    // reads worse than stopping a word earlier.
    assert.equal(
      slugify("Yousef graduated Mechatronics Robotics Engineering from Queen's"),
      "yousef-graduated-mechatronics-robotics-engineering",
    );
  });

  test("keeps a short fact whole", () => {
    assert.equal(slugify("Owns a Civic."), "owns-a-civic");
  });

  test("never returns an empty filename", () => {
    assert.equal(slugify("!!! ???"), "note");
    assert.equal(slugify(""), "note");
  });

  test("keeps a leading stopword rather than emptying the name", () => {
    assert.equal(slugify("the"), "the");
  });
});

describe("parseTags", () => {
  test("reads the inline list Obsidian writes", () => {
    assert.deepEqual(parseTags("[voice, tts]"), ["voice", "tts"]);
  });

  test("reads a bare comma list, which is what a person types", () => {
    assert.deepEqual(parseTags("voice, tts"), ["voice", "tts"]);
  });

  test("strips quotes", () => {
    assert.deepEqual(parseTags(`["voice", 'tts']`), ["voice", "tts"]);
  });

  test("copes with nothing at all", () => {
    assert.deepEqual(parseTags(""), []);
    assert.deepEqual(parseTags("[]"), []);
  });
});

describe("parseNote", () => {
  test("splits frontmatter from prose", () => {
    const note = parseNote(
      `---\nkind: preference\ntags: [voice]\ncreated: 2026-08-01\nupdated: 2026-08-10\n---\n\nHe likes bf_emma.\n`,
      "he-likes-bf-emma",
    );
    assert.equal(note.kind, "preference");
    assert.deepEqual(note.tags, ["voice"]);
    assert.equal(note.created, "2026-08-01");
    assert.equal(note.updated, "2026-08-10");
    assert.equal(note.body, "He likes bf_emma.");
  });

  test("survives a note he wrote himself, with no frontmatter", () => {
    const note = parseNote("Just a thought I had.", "thought");
    assert.equal(note.kind, "fact", "an unmarked note is still a fact");
    assert.equal(note.body, "Just a thought I had.");
    assert.deepEqual(note.tags, []);
  });

  test("keeps frontmatter keys it doesn't know about", () => {
    // Obsidian plugins add their own. Eating them on the next write would
    // quietly destroy his setup.
    const note = parseNote(
      `---\nkind: fact\naliases: [civic]\ncssclass: wide\n---\n\nOwns a Civic.`,
      "owns-a-civic",
    );
    assert.equal(note.extra?.get("aliases"), "[civic]");
    assert.equal(note.extra?.get("cssclass"), "wide");
    assert.match(formatNote(note), /aliases: \[civic\]/);
    assert.match(formatNote(note), /cssclass: wide/);
  });

  test("falls back to created when he hasn't got an updated date", () => {
    const note = parseNote(`---\nkind: fact\ncreated: 2026-01-01\n---\n\nOld.`, "old");
    assert.equal(note.updated, "2026-01-01");
  });

  test("handles CRLF, which is what Windows editors write", () => {
    const note = parseNote(`---\r\nkind: fact\r\n---\r\n\r\nOn Windows.`, "n");
    assert.equal(note.kind, "fact");
    assert.equal(note.body, "On Windows.");
  });

  test("does not treat a colon in the prose as frontmatter", () => {
    const note = parseNote("He said: run the build.", "n");
    assert.equal(note.body, "He said: run the build.");
    assert.equal(note.kind, "fact");
  });
});

describe("formatNote", () => {
  test("omits dates it hasn't got rather than writing empty keys", () => {
    // A hand-written note has no dates until she next touches it, and
    // `created:` with nothing after it is not valid frontmatter.
    const out = formatNote({
      name: "n",
      kind: "fact",
      tags: [],
      created: "",
      updated: "",
      body: "Bare.",
    });
    assert.doesNotMatch(out, /created:/);
    assert.doesNotMatch(out, /updated:/);
    assert.match(out, /kind: fact/);
  });
});

describe("formatNote round trip", () => {
  test("what it writes is what it reads back", () => {
    const original = {
      name: "he-prefers-python",
      kind: "preference",
      tags: ["language", "python"],
      created: "2026-08-01",
      updated: "2026-08-10",
      body: "He prefers Python.\n\nEven for the web, given the choice.",
    };
    assert.deepEqual(parseNote(formatNote(original), original.name), {
      ...original,
      extra: undefined,
    });
  });
});

describe("createVault", () => {
  let dir: string;
  let vault: Vault;
  const dirs: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vela-vault-test-"));
    dirs.push(dir);
    vault = createVault(dir, () => "2026-08-10");
  });

  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("writes a note he can open, and reports the link", () => {
    assert.equal(vault.remember("fact", "Owns a Civic."), "Saved [[owns-a-civic]].");
    const raw = readFileSync(join(dir, "owns-a-civic.md"), "utf8");
    assert.match(raw, /^---\nkind: fact\n/);
    assert.match(raw, /Owns a Civic\./);
  });

  test("re-saving the same fact updates the note in place", () => {
    vault.remember("fact", "Owns a Civic.", ["car"]);
    vault.remember("preference", "Owns a Civic.", ["car", "honda"]);
    const notes = vault.all();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].kind, "preference");
    assert.deepEqual(notes[0].tags, ["car", "honda"]);
  });

  test("keeps the original created date when updating", () => {
    const old = createVault(dir, () => "2026-01-01");
    old.remember("fact", "Owns a Civic.");
    vault.remember("fact", "Owns a Civic.");

    const note = vault.all()[0];
    assert.equal(note.created, "2026-01-01", "he's known this since January");
    assert.equal(note.updated, "2026-08-10");
  });

  test("a different fact opening the same way gets its own note", () => {
    vault.remember("fact", "He prefers Python for scripting work.");
    vault.remember("fact", "He prefers Python for data work as well.");
    assert.equal(vault.all().length, 2, "the second must not overwrite the first");
  });

  test("searches the prose, the name and the tags", () => {
    vault.remember("fact", "Owns a 3D printer.", ["fabrication"]);
    vault.remember("fact", "Drives a Civic.", ["car"]);
    assert.equal(vault.recall("printer").length, 1);
    assert.equal(vault.recall("fabrication").length, 1, "tags are searchable");
    assert.equal(vault.recall("drives-a").length, 1, "so is the note name");
    assert.equal(vault.recall("helicopter").length, 0);
  });

  test("filters by kind", () => {
    vault.remember("preference", "Likes short answers.");
    vault.remember("fact", "Likes espresso.");
    assert.equal(vault.recall(undefined, "preference").length, 1);
    assert.equal(vault.recall("Likes", "fact").length, 1);
  });

  test("caps a recall at 40 notes", () => {
    for (let i = 0; i < 50; i++) vault.remember("fact", `fact number ${i}`);
    assert.equal(vault.recall().length, 40);
  });

  test("picks up a note he wrote in Obsidian himself", () => {
    // The whole point of the vault: he can add and correct things by hand.
    writeFileSync(join(dir, "hand-written.md"), "I hate popups.\n", "utf8");
    const found = vault.recall("popups");
    assert.equal(found.length, 1);
    assert.equal(found[0].body, "I hate popups.");
  });

  test("picks up an edit he made to one of hers", () => {
    vault.remember("fact", "He drives a Civic.");
    writeFileSync(
      join(dir, "he-drives-a-civic.md"),
      "---\nkind: fact\n---\n\nHe drives a Corolla, actually.\n",
      "utf8",
    );
    assert.equal(vault.all()[0].body, "He drives a Corolla, actually.");
  });

  test("forgets a note and says so when there isn't one", () => {
    vault.remember("fact", "Temporary.");
    assert.equal(vault.forget("temporary"), "Deleted temporary.");
    assert.equal(vault.forget("temporary"), "No memory called temporary.");
    assert.deepEqual(vault.all(), []);
  });

  test("forgets by the name a link would use, with or without the extension", () => {
    vault.remember("fact", "Temporary.");
    assert.equal(vault.forget("temporary.md"), "Deleted temporary.md.");
  });

  test("ignores everything that isn't a note", () => {
    // Obsidian keeps its config in .obsidian, and he'll drop images in here.
    mkdirSync(join(dir, ".obsidian"), { recursive: true });
    writeFileSync(join(dir, "screenshot.png"), "not markdown", "utf8");
    mkdirSync(join(dir, "Archive.md"), { recursive: true });
    vault.remember("fact", "The only real note.");

    assert.equal(vault.all().length, 1);
  });

  test("creates the folder if it isn't there yet", () => {
    const fresh = join(dir, "nested", "Memory");
    assert.doesNotThrow(() => createVault(fresh).remember("fact", "First."));
  });

  test("orders by name when two notes were touched the same day", () => {
    // Everything saved in one session shares a date, so without a tie-break
    // the context block's order would drift between reads.
    vault.remember("fact", "Zebra fact.");
    vault.remember("fact", "Apple fact.");
    vault.remember("fact", "Mango fact.");
    assert.deepEqual(
      vault.recall().map((n) => n.name),
      ["apple-fact", "mango-fact", "zebra-fact"],
    );
  });

  test("newer notes come first", () => {
    createVault(dir, () => "2026-01-01").remember("fact", "Old news.");
    createVault(dir, () => "2026-08-10").remember("fact", "Fresh news.");
    assert.deepEqual(
      vault.recall().map((n) => n.name),
      ["fresh-news", "old-news"],
    );
  });

  test("dates a note with today when nobody says otherwise", () => {
    // The clock is injected everywhere else in this file, so this is the one
    // place the real default gets exercised.
    const fresh = join(dir, "real-clock");
    createVault(fresh).remember("fact", "Saved just now.");
    assert.match(createVault(fresh).all()[0].created, /^\d{4}-\d{2}-\d{2}$/);
  });
});
