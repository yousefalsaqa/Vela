import { test, describe as suite } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readVersion, readCommit, describe } from "../src/version.js";

/** A throwaway directory that looks enough like a checkout to read from. */
function sandbox(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "vela-version-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  return dir;
}

const SHA = "c5e439de4f0a1b2c3d4e5f60718293a4b5c6d7e8";

suite("readVersion", () => {
  test("reads the version out of package.json", () => {
    const dir = sandbox({ "package.json": '{"name":"vela","version":"1.3.0"}' });
    assert.equal(readVersion(dir), "1.3.0");
    rmSync(dir, { recursive: true, force: true });
  });

  test("says nothing rather than crashing when there is no package.json", () => {
    const dir = sandbox({});
    assert.equal(readVersion(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("survives a package.json that isn't JSON", () => {
    const dir = sandbox({ "package.json": "{ not json" });
    assert.equal(readVersion(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("ignores a version field that isn't a string", () => {
    const dir = sandbox({ "package.json": '{"version":3}' });
    assert.equal(readVersion(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });
});

suite("readCommit", () => {
  test("follows HEAD to the branch it points at", () => {
    const dir = sandbox({
      HEAD: "ref: refs/heads/main\n",
      "refs/heads/main": `${SHA}\n`,
    });
    assert.equal(readCommit(dir), "c5e439d");
    rmSync(dir, { recursive: true, force: true });
  });

  test("takes the sha directly when HEAD is detached", () => {
    const dir = sandbox({ HEAD: `${SHA}\n` });
    assert.equal(readCommit(dir), "c5e439d");
    rmSync(dir, { recursive: true, force: true });
  });

  test("falls back to packed-refs, where a branch lands after a gc", () => {
    // A gc deletes the loose ref file, and reading only that reports no commit
    // at all on a repo that has simply been tidied.
    const dir = sandbox({
      HEAD: "ref: refs/heads/main\n",
      "packed-refs": `# pack-refs with: peeled fully-peeled sorted\n${SHA} refs/heads/main\n`,
    });
    assert.equal(readCommit(dir), "c5e439d");
    rmSync(dir, { recursive: true, force: true });
  });

  test("doesn't confuse a different branch in packed-refs for HEAD", () => {
    const dir = sandbox({
      HEAD: "ref: refs/heads/main\n",
      "packed-refs": `${SHA} refs/heads/other\n`,
    });
    assert.equal(readCommit(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("says nothing when there is no repository", () => {
    const dir = sandbox({});
    assert.equal(readCommit(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("says nothing when HEAD points at a branch with no commits yet", () => {
    const dir = sandbox({ HEAD: "ref: refs/heads/main\n" });
    assert.equal(readCommit(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });
});

suite("describe", () => {
  test("puts the commit after the version", () => {
    assert.equal(describe("1.3.0", "c5e439d"), "1.3.0 (c5e439d)");
  });

  test("a tarball with no .git still has a version", () => {
    assert.equal(describe("1.3.0", null), "1.3.0");
  });

  test("a checkout with no package.json still has a commit", () => {
    assert.equal(describe(null, "c5e439d"), "(c5e439d)");
  });

  test("neither is empty, not the word undefined", () => {
    assert.equal(describe(null, null), "");
  });
});
