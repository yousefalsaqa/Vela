import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { captureName, captureFile, SCREEN_DIR } from "../src/paths.js";

const dir = mkdtempSync(join(tmpdir(), "vela-paths-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("captureName", () => {
  test("says what the picture was of, so the folder reads later", () => {
    assert.equal(
      captureName("the schematic he's asking about", "abc123"),
      "capture-the-schematic-he-s-asking-about-abc123.png",
    );
  });

  test("two captures in the same second are two files", () => {
    // A clock orders things and an id names one, which is the reason this is
    // random rather than a timestamp: inside one second they would collide and
    // the second picture would quietly overwrite the first.
    assert.notEqual(captureName("same label"), captureName("same label"));
  });

  test("a label of pure punctuation still produces a usable name", () => {
    assert.equal(captureName("???", "abc123"), "capture-abc123.png");
    assert.equal(captureName("", "abc123"), "capture-abc123.png");
  });

  test("nothing he types can escape the filename", () => {
    // The label comes from the model, and the model is quoting him. A path
    // separator or a drive letter in there must not become part of a path.
    const name = captureName("../../windows/system32 C:\\evil.exe", "abc123");
    assert.equal(name.includes("/"), false, "a slash here would write outside the folder");
    assert.equal(name.includes("\\"), false);
    assert.equal(name.includes(".."), false);
    assert.match(name, /^capture-[a-z0-9-]*-?abc123\.png$/);
  });

  test("a long label is cut rather than making an unopenable path", () => {
    const name = captureName("x".repeat(200), "abc123");
    assert.ok(name.length < 60, `got ${name.length} characters`);
  });

  test("it is always a png, because that is what it writes", () => {
    assert.match(captureName("anything"), /\.png$/);
  });
});

describe("captureFile", () => {
  test("hands back an absolute path inside the folder it just made", () => {
    const target = join(dir, "screen");
    assert.equal(existsSync(target), false);
    const path = captureFile("a schematic", target);
    assert.ok(isAbsolute(path), "PowerShell is handed this directly");
    assert.equal(dirname(path), target);
    assert.equal(existsSync(target), true, "PowerShell will not create the folder for us");
  });

  test("a folder that already exists is not an error", () => {
    const target = join(dir, "twice");
    captureFile("one", target);
    assert.doesNotThrow(() => captureFile("two", target));
  });

  test("captures land under data by default, next to everything else of hers", () => {
    assert.match(SCREEN_DIR, /[\\/]data[\\/]screen$/);
  });
});
