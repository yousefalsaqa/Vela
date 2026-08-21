import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  present,
  clear,
  current,
  onScreen,
  contentTypeFor,
  publicScreen,
  type ScreenMeta,
} from "../src/screen.js";

// One temp dir for the whole file; each test writes what it needs into it.
const dir = mkdtempSync(join(tmpdir(), "vela-screen-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const page = (name: string, body = "<p>hi</p>") => {
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  return path;
};

describe("present", () => {
  beforeEach(() => {
    clear();
  });

  test("stores the screen and reports the title", () => {
    const path = page("sensors.html");
    const said = present({ title: "The 21 sensors", path });
    assert.match(said, /On the screen/);
    assert.equal(current()?.title, "The 21 sensors");
    assert.equal(current()?.path, path);
  });

  test("refuses a file that does not exist, naming the path", () => {
    const missing = join(dir, "never-written.html");
    const said = present({ title: "Ghost", path: missing });
    assert.ok(said.includes(missing), "she needs to see which path was wrong");
    assert.equal(current(), null, "a refused show must not replace what is up");
  });

  test("refuses an extension the hub cannot render, naming what it takes", () => {
    const said = present({ title: "Raw data", path: page("dump.csv", "a,b") });
    assert.match(said, /\.html/, "the message should teach the fix");
    assert.equal(current(), null);
  });

  test("a refusal leaves the previous screen up rather than blanking it", () => {
    present({ title: "First", path: page("first.html") });
    present({ title: "Broken", path: join(dir, "missing.html") });
    assert.equal(current()?.title, "First");
  });

  test("carries the note when one was given, and omits the key when not", () => {
    present({ title: "With", path: page("with.html"), note: "why it breaks" });
    assert.equal(current()?.note, "why it breaks");
    present({ title: "Without", path: page("without.html") });
    assert.equal("note" in (current() ?? {}), false);
  });

  test("a second show replaces the first", () => {
    present({ title: "One", path: page("one.html") });
    present({ title: "Two", path: page("two.html") });
    assert.equal(current()?.title, "Two");
  });

  test("every show gets its own id, which is what 'go back to the engine' will need", () => {
    present({ title: "One", path: page("one.html") });
    const first = current()?.id;
    present({ title: "One", path: page("one.html") });
    assert.match(first ?? "", /^[0-9a-f]{8}$/);
    assert.notEqual(current()?.id, first, "the same page shown twice is two showings");
  });

  test("notifies subscribers with the new screen", () => {
    const seen: (ScreenMeta | null)[] = [];
    const off = onScreen((s) => seen.push(s));
    present({ title: "Live", path: page("live.html") });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.title, "Live");
    off();
  });

  test("a refused show stays silent, because the hub would blank on a lie", () => {
    const seen: (ScreenMeta | null)[] = [];
    const off = onScreen((s) => seen.push(s));
    present({ title: "Nope", path: join(dir, "nope.html") });
    assert.deepEqual(seen, []);
    off();
  });
});

describe("clear", () => {
  test("takes the screen down and notifies with null", () => {
    present({ title: "Up", path: page("up.html") });
    const seen: (ScreenMeta | null)[] = [];
    const off = onScreen((s) => seen.push(s));
    assert.match(clear(), /Cleared/);
    assert.equal(current(), null);
    assert.deepEqual(seen, [null]);
    off();
  });

  test("says so when there was nothing up, without notifying anyone", () => {
    clear();
    const seen: (ScreenMeta | null)[] = [];
    const off = onScreen((s) => seen.push(s));
    assert.match(clear(), /already empty/);
    assert.deepEqual(seen, [], "a no-op clear must not make the hub re-render");
    off();
  });
});

describe("onScreen", () => {
  test("unsubscribing stops delivery to that listener only", () => {
    clear();
    const a: (ScreenMeta | null)[] = [];
    const b: (ScreenMeta | null)[] = [];
    const offA = onScreen((s) => a.push(s));
    const offB = onScreen((s) => b.push(s));
    offA();
    present({ title: "After", path: page("after.html") });
    assert.deepEqual(a, []);
    assert.equal(b.length, 1);
    offB();
  });
});

describe("publicScreen", () => {
  test("keeps the id, title, note and timestamp but never the path", () => {
    clear();
    present({ title: "Public", path: page("public.html"), note: "n" });
    const meta = publicScreen(current());
    assert.deepEqual(Object.keys(meta ?? {}).sort(), ["id", "note", "shownAt", "title"]);
    assert.equal(meta?.title, "Public");
  });

  test("passes null through", () => {
    assert.equal(publicScreen(null), null);
  });
});

describe("contentTypeFor", () => {
  test("knows the shapes a screen can take", () => {
    assert.equal(contentTypeFor("a.html"), "text/html; charset=utf-8");
    assert.equal(contentTypeFor("b.svg"), "image/svg+xml");
    assert.equal(contentTypeFor("c.PNG"), "image/png", "extensions are not case-sensitive on Windows");
    assert.equal(contentTypeFor("d.pdf"), "application/pdf");
  });

  test("returns null for anything else, which is what makes present refuse it", () => {
    assert.equal(contentTypeFor("e.csv"), null);
    assert.equal(contentTypeFor("no-extension"), null);
  });
});
