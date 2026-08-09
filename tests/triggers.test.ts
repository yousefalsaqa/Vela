import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTriggers, type TriggerSource } from "../src/triggers.js";
import { createStore, type Store } from "../src/memory.js";

/**
 * A fake world: file changes are pushed by hand, and process liveness is
 * whatever the test says it is.
 */
function fakeWorld() {
  const watched = new Map<string, (() => void)[]>();
  const released: string[] = [];
  const running = new Set<string>();
  const missing = new Set<string>();
  let polls = 0;

  const source: TriggerSource = {
    watchFile(path, onChange) {
      // fs.watch throws on a path that isn't there yet.
      if (missing.has(path)) throw new Error("ENOENT");
      const list = watched.get(path) ?? [];
      list.push(onChange);
      watched.set(path, list);
      return () => {
        released.push(path);
        watched.delete(path);
      };
    },
    async isProcessRunning(name) {
      polls++;
      return running.has(name);
    },
  };

  return {
    source,
    released,
    watching: () => [...watched.keys()],
    polls: () => polls,
    touch: (path: string) => watched.get(path)?.forEach((cb) => cb()),
    setRunning: (name: string, isRunning: boolean) =>
      isRunning ? running.add(name) : running.delete(name),
    setMissing: (path: string, isMissing: boolean) =>
      isMissing ? missing.add(path) : missing.delete(path),
  };
}

describe("startTriggers", () => {
  let store: Store;
  let world: ReturnType<typeof fakeWorld>;
  let fired: number[][];

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    store = createStore(":memory:");
    world = fakeWorld();
    fired = [];
  });
  afterEach(() => mock.timers.reset());

  const start = (over: Record<string, unknown> = {}) =>
    startTriggers({
      store,
      source: world.source,
      onFire: (ids) => {
        fired.push(ids);
        return Promise.resolve();
      },
      pollMs: 15_000,
      debounceMs: 2_000,
      cooldownMs: 60_000,
      ...over,
    });

  /** Advance the clock and let any queued promise work settle. */
  const advance = async (ms: number) => {
    mock.timers.tick(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };

  describe("file triggers", () => {
    beforeEach(() => {
      store.addWatch("the build", "tail build.log", {
        kind: "file",
        arg: "C:/tmp/build.log",
      });
    });

    test("attaches a watcher to the file", async () => {
      start();
      await advance(0);
      assert.deepEqual(world.watching(), ["C:/tmp/build.log"]);
    });

    test("fires for that watch alone after the file settles", async () => {
      start();
      await advance(0);
      world.touch("C:/tmp/build.log");
      assert.deepEqual(fired, [], "must wait for the writes to stop");
      await advance(2_000);
      assert.deepEqual(fired, [[1]]);
    });

    test("coalesces a burst of writes into one check", async () => {
      start();
      await advance(0);
      for (let i = 0; i < 20; i++) {
        world.touch("C:/tmp/build.log");
        await advance(100); // a compiler writing steadily
      }
      assert.deepEqual(fired, [], "a live log must not fire on every line");
      await advance(2_000);
      assert.deepEqual(fired, [[1]], "one check once it goes quiet");
    });

    test("will not check the same watch again inside the cooldown", async () => {
      start();
      await advance(0);
      world.touch("C:/tmp/build.log");
      await advance(2_000);
      assert.equal(fired.length, 1);

      world.touch("C:/tmp/build.log");
      await advance(2_000);
      assert.equal(fired.length, 1, "cooldown protects the token budget");

      await advance(60_000);
      world.touch("C:/tmp/build.log");
      await advance(2_000);
      assert.equal(fired.length, 2, "and lifts once the cooldown passes");
    });

    test("releases the watcher when the watch is resolved", async () => {
      start();
      await advance(0);
      store.resolveWatch(1);
      await advance(15_000);
      assert.deepEqual(world.released, ["C:/tmp/build.log"]);
      assert.deepEqual(world.watching(), []);
    });

    test("picks up a watch added after it started", async () => {
      start();
      await advance(0);
      store.addWatch("the deploy", "", { kind: "file", arg: "C:/tmp/deploy.log" });
      await advance(15_000);
      assert.deepEqual(world.watching().sort(), [
        "C:/tmp/build.log",
        "C:/tmp/deploy.log",
      ]);
    });

    test("survives a file that doesn't exist yet, and attaches once it does", async () => {
      // "Tell me when the build finishes" usually precedes the log existing.
      world.setMissing("C:/tmp/build.log", true);
      start();
      await advance(0);
      assert.deepEqual(world.watching(), [], "must not crash on a missing file");

      world.setMissing("C:/tmp/build.log", false);
      await advance(15_000);
      assert.deepEqual(world.watching(), ["C:/tmp/build.log"]);

      world.touch("C:/tmp/build.log");
      await advance(2_000);
      assert.deepEqual(fired, [[1]]);
    });

    test("moves to the new file when a watch is retargeted", async () => {
      start();
      await advance(0);
      store.addWatch("the build", "tail other.log", {
        kind: "file",
        arg: "C:/tmp/other.log",
      });
      await advance(15_000);
      assert.deepEqual(world.released, ["C:/tmp/build.log"]);
      assert.deepEqual(world.watching(), ["C:/tmp/other.log"]);

      world.touch("C:/tmp/other.log");
      await advance(2_000);
      assert.deepEqual(fired, [[1]]);
    });

    test("uses sane defaults when none are given", async () => {
      startTriggers({
        store,
        source: world.source,
        onFire: (ids) => {
          fired.push(ids);
        },
      });
      await advance(0);
      world.touch("C:/tmp/build.log");
      await advance(1_000);
      assert.deepEqual(fired, [], "default debounce is longer than a second");
      await advance(2_000);
      assert.deepEqual(fired, [[1]]);
    });

    test("stops watching everything once stopped", async () => {
      const stop = start();
      await advance(0);
      stop();
      assert.deepEqual(world.watching(), []);
      world.touch("C:/tmp/build.log");
      await advance(60_000);
      assert.deepEqual(fired, []);
    });
  });

  describe("process triggers", () => {
    beforeEach(() => {
      store.addWatch("the build", "", { kind: "process", arg: "node" });
    });

    test("says nothing while the process is still running", async () => {
      world.setRunning("node", true);
      start();
      await advance(15_000);
      await advance(15_000);
      assert.deepEqual(fired, []);
    });

    test("fires when a running process goes away", async () => {
      world.setRunning("node", true);
      start();
      await advance(15_000);
      world.setRunning("node", false);
      await advance(15_000);
      assert.deepEqual(fired, [[1]]);
    });

    test("does not fire for a process that was never seen running", async () => {
      // Otherwise every process watch reports the instant it is created.
      start();
      await advance(15_000);
      await advance(15_000);
      assert.deepEqual(fired, [], "needs a running→gone edge, not just absence");
    });

    test("fires once, not on every poll after it exits", async () => {
      world.setRunning("node", true);
      start();
      await advance(15_000);
      world.setRunning("node", false);
      await advance(15_000);
      await advance(15_000);
      await advance(15_000);
      assert.deepEqual(fired, [[1]]);
    });
  });

  describe("watches without triggers", () => {
    test("are left entirely to the heartbeat's timer", async () => {
      store.addWatch("something vague");
      start();
      await advance(60_000);
      assert.deepEqual(world.watching(), []);
      assert.equal(world.polls(), 0, "nothing to poll costs nothing");
      assert.deepEqual(fired, []);
    });
  });

  describe("failure", () => {
    test("a check that throws does not kill the trigger loop", async () => {
      store.addWatch("the build", "", { kind: "process", arg: "node" });
      world.setRunning("node", true);
      start({
        onFire: (ids: number[]) => {
          fired.push(ids);
          return Promise.reject(new Error("model unreachable"));
        },
      });
      await advance(15_000);
      world.setRunning("node", false);
      await advance(15_000);
      assert.equal(fired.length, 1);

      // Still alive: a later edge is still noticed.
      world.setRunning("node", true);
      await advance(15_000);
      world.setRunning("node", false);
      await advance(60_000);
      await advance(15_000);
      assert.equal(fired.length, 2);
    });

    test("a probe that throws is treated as unknown, not as exited", async () => {
      store.addWatch("the build", "", { kind: "process", arg: "node" });
      world.setRunning("node", true);
      const source: TriggerSource = {
        ...world.source,
        isProcessRunning: async () => {
          throw new Error("powershell unavailable");
        },
      };
      start({ source });
      await advance(15_000);
      await advance(15_000);
      assert.deepEqual(fired, [], "a failed probe must not look like an exit");
    });
  });
});

/**
 * The fake above proves the logic; this proves the wiring. fs.watch on Windows
 * has its own ideas about how many events an append produces, so the real
 * source gets exercised at least once. No mock timers here.
 */
describe("against the real filesystem", () => {
  test("a real write to a real file wakes its watch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vela-trigger-"));
    const file = join(dir, "build.log");
    writeFileSync(file, "compiling...\n");

    const store = createStore(":memory:");
    store.addWatch("the build", "", { kind: "file", arg: file });

    const fired: number[][] = [];
    const stop = startTriggers({
      store,
      source: undefined, // the real one
      onFire: (ids) => {
        fired.push(ids);
      },
      pollMs: 5_000,
      debounceMs: 50,
      cooldownMs: 5_000,
    });

    try {
      await new Promise((r) => setTimeout(r, 50)); // let the watcher attach
      appendFileSync(file, "BUILD SUCCEEDED\n");

      const deadline = Date.now() + 5_000;
      while (!fired.length && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.deepEqual(fired, [[1]], "the real watcher must fire exactly once");
    } finally {
      stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
