import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  parseReply,
  renderWatches,
  tick,
  startHeartbeat,
} from "../src/ambient.js";
import { createStore, type Store } from "../src/memory.js";

describe("parseReply", () => {
  const silent = [
    ["the exact contract word", "SILENT"],
    ["an empty reply", ""],
    ["whitespace only", "   \n  "],
    ["the word with trailing chatter", "SILENT — nothing worth saying"],
    ["the word on its own line", "SILENT\n"],
  ];
  for (const [name, input] of silent) {
    test(`stays silent for ${name}`, () => {
      assert.deepEqual(parseReply(input), { silent: true });
    });
  }

  test("pulls the watch id and message out of a report", () => {
    assert.deepEqual(parseReply("#3: Build succeeded in 41s."), {
      silent: false,
      id: 3,
      done: false,
      message: "Build succeeded in 41s.",
    });
  });

  test("recognises the done marker and closes the watch", () => {
    assert.deepEqual(parseReply("#12 done: PR was merged."), {
      silent: false,
      id: 12,
      done: true,
      message: "PR was merged.",
    });
  });

  test("is not case sensitive about DONE", () => {
    const parsed = parseReply("#4 DONE: finished.");
    assert.equal(parsed.silent, false);
    assert.equal(parsed.silent === false && parsed.done, true);
  });

  test("tolerates a full-width colon", () => {
    // The model occasionally emits '：' — a report is too valuable to drop
    // over punctuation.
    assert.deepEqual(parseReply("#7： Tests are green."), {
      silent: false,
      id: 7,
      done: false,
      message: "Tests are green.",
    });
  });

  test("keeps a multi-line message intact", () => {
    const parsed = parseReply("#1: line one\nline two");
    assert.equal(parsed.silent, false);
    assert.equal(parsed.message, "line one\nline two");
  });

  test("still reports an untagged message rather than swallowing it", () => {
    assert.deepEqual(parseReply("The build failed."), {
      silent: false,
      id: null,
      done: false,
      message: "The build failed.",
    });
  });

  test("does not treat a message that merely mentions silence as silent", () => {
    assert.equal(parseReply("#2: the log has gone silent").silent, false);
  });
});

describe("renderWatches", () => {
  test("includes the cue so a fresh session knows how to check", () => {
    const out = renderWatches([
      {
        id: 1,
        note: "the build finishing",
        cue: "tail build.log",
        last_message: "",
        trigger_kind: "",
        trigger_arg: "",
        minutes_since_spoke: null,
      },
    ]);
    assert.match(out, /#1 the build finishing/);
    assert.match(out, /tail build\.log/);
    assert.doesNotMatch(out, /already said/);
  });

  test("replays what was already said so the model doesn't repeat itself", () => {
    const out = renderWatches([
      {
        id: 2,
        note: "the deploy",
        cue: "",
        last_message: "Deploy started.",
        trigger_kind: "",
        trigger_arg: "",
        minutes_since_spoke: 12,
      },
    ]);
    assert.match(out, /already said 12 min ago: "Deploy started\."/);
  });
});

describe("tick", () => {
  let store: Store;
  let said: string[];
  let asked: number;

  const opts = (
    reply: string | (() => Promise<string>),
    over: Partial<Parameters<typeof tick>[0]> = {},
  ) => ({
    say: (m: string) => said.push(m),
    isBusy: () => false,
    intervalMs: 1000,
    model: "test-model",
    store,
    ask: async () => {
      asked++;
      return typeof reply === "string" ? reply : await reply();
    },
    ...over,
  });

  beforeEach(() => {
    store = createStore(":memory:");
    said = [];
    asked = 0;
  });

  test("does not call the model when nothing is being watched", async () => {
    await tick(opts("#1: anything"));
    assert.equal(asked, 0, "an idle heartbeat must cost nothing");
    assert.deepEqual(said, []);
  });

  test("does not call the model while a foreground turn is streaming", async () => {
    store.addWatch("the build");
    await tick(opts("#1: done", { isBusy: () => true }));
    assert.equal(asked, 0);
    assert.deepEqual(said, []);
  });

  test("says nothing when the model returns SILENT", async () => {
    store.addWatch("the build");
    await tick(opts("SILENT"));
    assert.equal(asked, 1);
    assert.deepEqual(said, []);
    assert.equal(store.listWatches()[0].minutes_since_spoke, null);
  });

  test("speaks once and records what it said", async () => {
    store.addWatch("the build");
    await tick(opts("#1: Build succeeded."));
    assert.deepEqual(said, ["Build succeeded."]);
    const [w] = store.listWatches();
    assert.equal(w.last_message, "Build succeeded.");
    assert.equal(w.minutes_since_spoke, 0, "should be marked as just spoken");
  });

  test("closes the watch when the model marks it done", async () => {
    store.addWatch("the build");
    await tick(opts("#1 done: Build succeeded."));
    assert.deepEqual(said, ["Build succeeded."]);
    assert.deepEqual(store.listWatches(), [], "watch should be closed");
  });

  test("holds the message if Yousef started typing while it was thinking", async () => {
    store.addWatch("the build");
    let busy = false;
    await tick(
      opts(
        async () => {
          busy = true; // he started a turn mid-check
          return "#1 done: Build succeeded.";
        },
        { isBusy: () => busy },
      ),
    );
    assert.deepEqual(said, [], "must not cut across him");
    const [w] = store.listWatches();
    assert.ok(w, "an unspoken watch must stay open");
    assert.equal(w.minutes_since_spoke, null, "must not record an unsaid message");
  });

  test("reports an untagged message without touching any watch", async () => {
    store.addWatch("the build");
    await tick(opts("Build succeeded."));
    assert.deepEqual(said, ["Build succeeded."]);
    assert.equal(store.listWatches()[0].minutes_since_spoke, null);
  });

  test("ignores a report for a watch id that does not exist", async () => {
    store.addWatch("the build");
    await tick(opts("#99: Something about nothing."));
    assert.deepEqual(said, ["Something about nothing."]);
    assert.equal(store.listWatches().length, 1);
  });

  describe("checking only some watches", () => {
    let prompts: string[];

    const only = (ids: number[]) => {
      prompts = [];
      return tick(
        {
          say: (m: string) => said.push(m),
          isBusy: () => false,
          intervalMs: 1000,
          model: "test-model",
          store,
          ask: async (prompt: string) => {
            prompts.push(prompt);
            return "SILENT";
          },
        },
        ids,
      );
    };

    beforeEach(() => {
      store.addWatch("the build");
      store.addWatch("the deploy");
      store.addWatch("the PR");
    });

    test("asks about the triggered watch alone", async () => {
      await only([2]);
      assert.equal(prompts.length, 1);
      assert.match(prompts[0], /#2 the deploy/);
      assert.doesNotMatch(prompts[0], /the build/, "a woken watch stands alone");
      assert.doesNotMatch(prompts[0], /the PR/);
    });

    test("can be given several at once", async () => {
      await only([1, 3]);
      assert.match(prompts[0], /the build/);
      assert.match(prompts[0], /the PR/);
      assert.doesNotMatch(prompts[0], /the deploy/);
    });

    test("does not call the model when the id is already resolved", async () => {
      store.resolveWatch(2);
      await only([2]);
      assert.deepEqual(prompts, [], "a closed watch must not cost a call");
    });
  });

  describe("skills", () => {
    test("hands the model the allow list it was given", async () => {
      store.addWatch("the build");
      const seen: string[][] = [];
      await tick(
        opts("stay quiet", {
          skills: ["agent-reach"],
          ask: async (_p, _m, skills) => {
            seen.push(skills);
            return "stay quiet";
          },
        }),
      );
      assert.deepEqual(seen, [["agent-reach"]]);
    });

    test("offers none when none were allowed, rather than falling back to a default", async () => {
      store.addWatch("the build");
      const seen: string[][] = [];
      await tick(
        opts("stay quiet", {
          ask: async (_p, _m, skills) => {
            seen.push(skills);
            return "stay quiet";
          },
        }),
      );
      assert.deepEqual(seen, [[]]);
    });
  });
});

describe("startHeartbeat", () => {
  let store: Store;
  let said: string[];

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    store = createStore(":memory:");
    store.addWatch("the build");
    said = [];
  });
  afterEach(() => mock.timers.reset());

  const opts = (ask: () => Promise<string>) => ({
    say: (m: string) => said.push(m),
    isBusy: () => false,
    intervalMs: 60_000,
    model: "test-model",
    store,
    ask,
  });

  /**
   * Advance the clock, then let the tick's promise chain settle. setImmediate
   * is a macrotask and isn't mocked, so awaiting it drains every microtask the
   * fired timer queued — including the one that schedules the next interval.
   */
  const advance = async (ms: number) => {
    mock.timers.tick(ms);
    await new Promise((resolve) => setImmediate(resolve));
  };

  test("does nothing until the first interval elapses", async () => {
    startHeartbeat(opts(async () => "#1: tick"));
    await advance(59_000);
    assert.deepEqual(said, []);
    await advance(1_000);
    assert.deepEqual(said, ["tick"]);
  });

  test("keeps checking on every interval", async () => {
    let n = 0;
    startHeartbeat(opts(async () => `#1: tick ${++n}`));
    await advance(60_000);
    await advance(60_000);
    await advance(60_000);
    assert.deepEqual(said, ["tick 1", "tick 2", "tick 3"]);
  });

  test("stops for good once stopped", async () => {
    const hb = startHeartbeat(opts(async () => "#1: tick"));
    await advance(60_000);
    hb.stop();
    await advance(600_000);
    assert.equal(said.length, 1, "a stopped heartbeat must not fire again");
  });

  test("check() runs immediately, without waiting for the interval", async () => {
    const hb = startHeartbeat(opts(async () => "#1: right now"));
    await hb.check();
    assert.deepEqual(said, ["right now"]);
    hb.stop();
  });

  test("check() serialises — two model calls never overlap", async () => {
    let inFlight = 0;
    let overlapped = false;
    const hb = startHeartbeat(
      opts(async () => {
        if (++inFlight > 1) overlapped = true;
        await new Promise((r) => setImmediate(r));
        inFlight--;
        return "#1: done";
      }),
    );
    await Promise.all([hb.check(), hb.check(), hb.check()]);
    assert.equal(overlapped, false, "concurrent checks would double-spend");
    hb.stop();
  });

  test("survives a failing check and tries again next interval", async () => {
    let n = 0;
    startHeartbeat(
      opts(async () => {
        if (++n === 1) throw new Error("model unreachable");
        return "#1: recovered";
      }),
    );
    await advance(60_000);
    assert.deepEqual(said, [], "a failed check stays quiet rather than shouting");
    await advance(60_000);
    assert.deepEqual(said, ["recovered"]);
  });
});

