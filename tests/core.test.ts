import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createCore, type CoreEvent, type Session } from "../src/core.js";
import { createStore, type Store } from "../src/memory.js";

/**
 * A scripted session: the test decides what the "model" emits, and when.
 * Nothing here reaches the network.
 */
function scriptedSession() {
  const queued: unknown[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const sent: string[] = [];
  let closed = false;

  const session: Session = {
    close: () => {
      closed = true;
      ended = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queued.length) yield queued.shift();
        if (ended) return;
        await new Promise<void>((r) => (wake = r));
      }
    },
  };

  return {
    session,
    sent,
    wasClosed: () => closed,
    /** Feed the core a message as if the model had produced it. */
    emit(msg: unknown) {
      queued.push(msg);
      const w = wake;
      wake = null;
      w?.();
    },
    /** Read what the core streamed into the session, until the queue ends. */
    async collectTurns(stream: AsyncGenerator<{ message: { content: string } }>, n: number) {
      for (let i = 0; i < n; i++) {
        const { value, done } = await stream.next();
        if (done) return;
        sent.push(value.message.content);
      }
    },
  };
}

const text = (t: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text: t } },
});
const toolUse = (name: string, input: Record<string, unknown>) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, input }] },
});
const result = (ms = 1200, r?: string) => ({ type: "result", duration_ms: ms, result: r });

/** Wait until `check` passes, so tests don't depend on tick counts. */
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("createCore", () => {
  let store: Store;
  let script: ReturnType<typeof scriptedSession>;
  let events: CoreEvent[];

  const build = (over: Record<string, unknown> = {}) => {
    const core = createCore({
      systemPrompt: "test",
      store,
      session: (stream) => {
        void script.collectTurns(stream as never, 5);
        return script.session;
      },
      heartbeatMs: 0,
      ...over,
    });
    core.subscribe((e) => events.push(e));
    return core;
  };

  beforeEach(() => {
    store = createStore(":memory:");
    script = scriptedSession();
    events = [];
  });

  test("passes a turn through to the session", async () => {
    const core = build();
    core.send("hello");
    await until(() => script.sent.length > 0, "the turn to reach the session");
    assert.deepEqual(script.sent, ["hello"]);
    core.stop();
  });

  test("reports streamed text as it arrives", async () => {
    const core = build();
    core.send("hi");
    script.emit(text("Hel"));
    script.emit(text("lo."));
    await until(() => events.length === 2, "two deltas");
    assert.deepEqual(events, [
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo." },
    ]);
    core.stop();
  });

  test("reports tool activity", async () => {
    const core = build();
    core.send("hi");
    script.emit(toolUse("Read", { file_path: "C:/a/index.html" }));
    await until(() => events.length > 0, "an activity event");
    assert.deepEqual(events[0], { type: "activity", lines: ["Read index.html"] });
    core.stop();
  });

  test("closes the turn with a result carrying the duration", async () => {
    const core = build();
    core.send("hi");
    script.emit(text("done"));
    script.emit(result(1500));
    await until(() => events.some((e) => e.type === "result"), "a result");
    assert.deepEqual(events.at(-1), { type: "result", ms: 1500 });
    core.stop();
  });

  test("carries the text on the result when nothing streamed", async () => {
    const core = build();
    core.send("hi");
    script.emit(result(900, "the whole answer"));
    await until(() => events.some((e) => e.type === "result"), "a result");
    assert.deepEqual(events.at(-1), { type: "result", ms: 900, text: "the whole answer" });
    core.stop();
  });

  test("is busy only while a turn is in flight", async () => {
    const core = build();
    assert.equal(core.isBusy(), false);
    core.send("hi");
    assert.equal(core.isBusy(), true, "the heartbeat must not cut in mid-turn");
    script.emit(result());
    await until(() => !core.isBusy(), "the turn to finish");
  });

  test("resets the streamed flag between turns", async () => {
    const core = build();
    core.send("one");
    script.emit(text("streamed"));
    script.emit(result(100));
    await until(() => events.filter((e) => e.type === "result").length === 1, "first result");

    core.send("two");
    script.emit(result(200, "not streamed"));
    await until(() => events.filter((e) => e.type === "result").length === 2, "second result");
    assert.deepEqual(events.at(-1), { type: "result", ms: 200, text: "not streamed" });
    core.stop();
  });

  test("reports a dead session as an error rather than throwing", async () => {
    const core = createCore({
      systemPrompt: "test",
      store,
      heartbeatMs: 0,
      session: () => ({
        close: () => {},
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          throw new Error("session died");
        },
      }),
    });
    core.subscribe((e) => events.push(e));
    await until(() => events.length > 0, "an error event");
    assert.deepEqual(events[0], { type: "error", message: "session died" });
    core.stop();
  });

  describe("subscribers", () => {
    test("all of them see the same events", async () => {
      const core = build();
      const second: CoreEvent[] = [];
      core.subscribe((e) => second.push(e));
      core.send("hi");
      script.emit(text("x"));
      await until(() => second.length > 0, "the second subscriber");
      assert.deepEqual(second, events);
      core.stop();
    });

    test("unsubscribing stops delivery to that one only", async () => {
      const core = build();
      const second: CoreEvent[] = [];
      const off = core.subscribe((e) => second.push(e));
      off();
      core.send("hi");
      script.emit(text("x"));
      await until(() => events.length > 0, "the remaining subscriber");
      assert.deepEqual(second, []);
      core.stop();
    });
  });

  describe("stop", () => {
    test("closes the session and ignores later turns", async () => {
      const core = build();
      core.stop();
      assert.equal(script.wasClosed(), true);
      core.send("too late");
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(script.sent, []);
    });

    test("stays quiet after stopping", async () => {
      const core = build();
      core.stop();
      script.emit(text("ignored"));
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(events, []);
    });
  });
});
