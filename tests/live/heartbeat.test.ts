import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tick } from "../../src/ambient.js";
import { createStore, type Store } from "../../src/memory.js";

/**
 * These cost money and take real seconds — `npm run test:live`.
 *
 * Everything else in tests/ stubs the model out, which means nothing else
 * checks the thing most likely to drift: whether the real model actually
 * honours the SILENT / #id done contract the parser is built around.
 */

const enabled = Boolean(process.env.VELA_LIVE);
const model = process.env.VELA_HEARTBEAT_MODEL ?? "haiku";

describe("the real heartbeat", { skip: !enabled && "set VELA_LIVE=1 to run" }, () => {
  let dir: string;
  let log: string;
  let store: Store;
  let said: string[];

  const opts = () => ({
    say: (m: string) => said.push(m),
    isBusy: () => false,
    intervalMs: 0,
    model,
    store,
  });

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "vela-live-"));
    log = join(dir, "build.log");
    store = createStore(":memory:");
    said = [];
    store.addWatch(
      "the build finishing",
      `Read the file ${log.replace(/\\/g, "/")}. While it is running the last ` +
        `line says "compiling"; when it is finished it says BUILD SUCCEEDED ` +
        `or BUILD FAILED.`,
    );
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test("stays quiet while the watched thing is still in progress", async () => {
    writeFileSync(log, "compiling module 3 of 40...\n");
    await tick(opts());
    assert.deepEqual(said, [], "interrupting over nothing is the failure mode");
    assert.equal(store.listWatches()[0].minutes_since_spoke, null);
  });

  test("reports once and closes the watch when it finishes", async () => {
    writeFileSync(log, "compiling module 40 of 40...\nBUILD SUCCEEDED in 41s\n");
    await tick(opts());
    assert.equal(said.length, 1, `expected one line, got ${JSON.stringify(said)}`);
    assert.match(said[0], /succe/i);
    assert.deepEqual(
      store.listWatches(),
      [],
      "a finished watch must close, or it ticks forever",
    );
  });

  test("does not repeat itself on the next tick", async () => {
    // The watch closed above, so there is nothing left to check and the model
    // should never be called again.
    await tick(opts());
    assert.equal(said.length, 1);
  });
});
