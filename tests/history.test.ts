import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromeTimeToDate,
  dateToChromeTime,
  historyFiles,
  searchOne,
  searchHistory,
  ago,
} from "../src/history.js";

describe("chrome timestamps", () => {
  test("converts the 1601 epoch to a real date", () => {
    // 13.3e15 µs is ~421.5 years after 1601-01-01, so mid-2022.
    assert.equal(chromeTimeToDate(13_300_000_000_000_000).toISOString(), "2022-06-18T04:26:40.000Z");
  });

  test("round-trips", () => {
    const when = new Date("2026-08-09T12:00:00.000Z");
    assert.equal(chromeTimeToDate(dateToChromeTime(when)).getTime(), when.getTime());
  });
});

describe("historyFiles", () => {
  test("returns nothing when no browser is installed there", () => {
    assert.deepEqual(historyFiles(join(tmpdir(), "definitely-not-appdata")), []);
  });
});

describe("searching history", () => {
  let dir: string;
  let file: string;

  const rows: [string, string, number, string][] = [
    ["https://meet.google.com/abc-defg-hij", "Weekly sync | Google Meet", 12, "2026-08-08T15:00:00Z"],
    ["https://meet.google.com/xyz-1234-klm", "Capstone review | Google Meet", 3, "2026-08-01T10:00:00Z"],
    ["https://github.com/yousefalsaqa/Vela", "yousefalsaqa/Vela", 40, "2026-08-09T09:00:00Z"],
    ["https://www.bbc.co.uk/sport", "BBC Sport", 5, "2026-07-02T08:00:00Z"],
    ["https://example.com/untitled", "", 1, "2026-08-09T08:00:00Z"],
  ];

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "vela-hist-"));
    file = join(dir, "History");
    const db = new DatabaseSync(file);
    // The real Chrome schema, trimmed to what we read.
    db.exec(`CREATE TABLE urls (
      id INTEGER PRIMARY KEY, url TEXT, title TEXT,
      visit_count INTEGER, last_visit_time INTEGER)`);
    const insert = db.prepare(
      `INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES (?, ?, ?, ?)`,
    );
    for (const [url, title, visits, when] of rows) {
      insert.run(url, title, visits, dateToChromeTime(new Date(when)));
    }
    db.close();
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test("finds a page by title", () => {
    const found = searchOne(file, "Chrome", "Capstone");
    assert.equal(found.length, 1);
    assert.equal(found[0].url, "https://meet.google.com/xyz-1234-klm");
    assert.equal(found[0].visits, 3);
    assert.equal(found[0].browser, "Chrome");
  });

  test("finds pages by URL, newest first", () => {
    const found = searchOne(file, "Chrome", "meet.google.com");
    assert.deepEqual(
      found.map((f) => f.title),
      ["Weekly sync | Google Meet", "Capstone review | Google Meet"],
      "the one he was on most recently has to come first",
    );
  });

  test("falls back to the URL when a page has no title", () => {
    const [found] = searchOne(file, "Chrome", "untitled");
    assert.equal(found.title, "https://example.com/untitled");
  });

  test("an empty query returns recent history", () => {
    const found = searchOne(file, "Chrome", "");
    assert.equal(found.length, 5);
    assert.match(found[0].url, /github/, "most recent first");
  });

  test("respects a limit", () => {
    assert.equal(searchOne(file, "Chrome", "", { limit: 2 }).length, 2);
  });

  test("sinceDays excludes older visits", () => {
    // Everything here is from 2026; relative to now, the BBC one is oldest.
    const recent = searchOne(file, "Chrome", "", { sinceDays: 3650 });
    assert.ok(recent.length >= 1);
    const none = searchOne(file, "Chrome", "", { sinceDays: 0.0001 });
    assert.deepEqual(none, [], "nothing was visited in the last few seconds");
  });

  test("finds nothing for a term that isn't there", () => {
    assert.deepEqual(searchOne(file, "Chrome", "zzzznotathing"), []);
  });

  test("reads timestamps past 2^53 instead of throwing", () => {
    // Real Chrome times are ~1.34e16 µs, beyond Number.MAX_SAFE_INTEGER.
    const [found] = searchOne(file, "Chrome", "Capstone");
    assert.ok(
      dateToChromeTime(found.lastVisit) > Number.MAX_SAFE_INTEGER,
      "the fixture must actually exercise the oversized case",
    );
    assert.equal(found.lastVisit.toISOString(), "2026-08-01T10:00:00.000Z");
  });

  test("searchHistory merges browsers and sorts across them", () => {
    const found = searchHistory("meet.google.com", {
      files: [
        { browser: "Chrome", file },
        { browser: "Edge", file },
      ],
    });
    assert.equal(found.length, 4, "both copies searched");
    assert.deepEqual(
      found.map((f) => f.title),
      [
        "Weekly sync | Google Meet",
        "Weekly sync | Google Meet",
        "Capstone review | Google Meet",
        "Capstone review | Google Meet",
      ],
      "merged in time order, not grouped by browser",
    );
  });

  test("a browser whose file can't be read is skipped, not fatal", () => {
    const found = searchHistory("meet", {
      files: [
        { browser: "Ghost", file: join(dir, "nope") },
        { browser: "Chrome", file },
      ],
    });
    assert.equal(found.length, 2);
    assert.equal(found[0].browser, "Chrome");
  });
});

describe("ago", () => {
  const now = new Date("2026-08-09T12:00:00Z");
  const at = (iso: string) => ago(new Date(iso), now);

  test("just now", () => assert.equal(at("2026-08-09T11:59:40Z"), "just now"));
  test("minutes", () => assert.equal(at("2026-08-09T11:30:00Z"), "30m ago"));
  test("hours", () => assert.equal(at("2026-08-09T09:00:00Z"), "3h ago"));
  test("yesterday", () => assert.equal(at("2026-08-08T11:00:00Z"), "yesterday"));
  test("days", () => assert.equal(at("2026-08-04T12:00:00Z"), "5d ago"));
  test("a future timestamp doesn't go negative", () =>
    assert.equal(at("2026-08-09T12:05:00Z"), "just now"));
});
