import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCore,
  sessionOptions,
  type CoreEvent,
  type Session,
} from "../src/core.js";
import { createStore, type Store } from "../src/memory.js";
import { present, clear as clearScreen } from "../src/screen.js";

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
    core.stop();
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

  test("reports a result that came back without a duration as zero", async () => {
    const core = build();
    core.send("hello");
    // The SDK omits duration_ms on some result shapes; NaN in the terminal is
    // worse than 0.0s.
    script.emit({ type: "result" });
    await until(() => events.some((e) => e.type === "result"), "the result");

    const done = events.find((e) => e.type === "result") as { ms: number };
    assert.equal(done.ms, 0);
    core.stop();
  });

  describe("the ambient half", () => {
    /**
     * The path where she speaks up unprompted. The real heartbeat calls the
     * model on a timer, so both halves are scripted here: the test decides
     * when a check happens and what a watch firing looks like.
     */
    const ambient = (over: Record<string, unknown> = {}) => {
      let say: ((text: string) => void) | undefined;
      let isBusy: (() => boolean) | undefined;
      let model: string | undefined;
      let skills: string[] | undefined;
      let onFire: ((ids: number[]) => void) | undefined;
      const checked: (number[] | undefined)[] = [];
      let heartbeatStopped = false;
      let triggersStopped = false;

      const core = build({
        heartbeatMs: 600_000,
        heartbeat: (opts: Record<string, unknown>) => {
          say = opts.say as typeof say;
          isBusy = opts.isBusy as typeof isBusy;
          model = opts.model as string;
          skills = opts.skills as string[];
          return {
            check: async (only?: number[]) => void checked.push(only),
            stop: () => void (heartbeatStopped = true),
          };
        },
        triggers: (opts: Record<string, unknown>) => {
          onFire = opts.onFire as typeof onFire;
          return () => void (triggersStopped = true);
        },
        ...over,
      } as Record<string, unknown>);

      return {
        core,
        checked,
        speakUp: (text: string) => say!(text),
        busy: () => isBusy!(),
        fire: (ids: number[]) => onFire!(ids),
        model: () => model,
        skills: () => skills,
        stopped: () => ({ heartbeat: heartbeatStopped, triggers: triggersStopped }),
      };
    };

    test("an unprompted line reaches every subscriber", () => {
      const a = ambient();
      const second: CoreEvent[] = [];
      a.core.subscribe((e) => second.push(e));

      a.speakUp("The build finished.");

      assert.deepEqual(events.at(-1), { type: "say", text: "The build finished." });
      assert.deepEqual(second.at(-1), { type: "say", text: "The build finished." });
      a.core.stop();
    });

    test("tells the heartbeat when a turn is in flight, so it waits its turn", async () => {
      const a = ambient();
      assert.equal(a.busy(), false);

      a.core.send("hello");
      assert.equal(a.busy(), true, "checking in mid-answer would talk over her");

      script.emit(result());
      await until(() => events.some((e) => e.type === "result"), "the result");
      assert.equal(a.busy(), false);
      a.core.stop();
    });

    test("a watch firing asks the heartbeat to check just those watches", () => {
      const a = ambient();
      a.fire([3, 7]);
      // The timer is only a floor — a triggered watch wakes itself in seconds.
      assert.deepEqual(a.checked, [[3, 7]]);
      a.core.stop();
    });

    test("checks in on haiku unless told otherwise", () => {
      const a = ambient();
      assert.equal(a.model(), "haiku");
      a.core.stop();
    });

    test("takes the heartbeat model it was given", () => {
      const a = ambient({ heartbeatModel: "sonnet" });
      assert.equal(a.model(), "sonnet");
      a.core.stop();
    });

    test("hands the heartbeat its own skill list, which is shorter on purpose", () => {
      const a = ambient({ heartbeatSkills: ["agent-reach"] });
      assert.deepEqual(a.skills(), ["agent-reach"]);
      a.core.stop();
    });

    test("no heartbeat skills means an empty list, not the session's", () => {
      const a = ambient();
      assert.deepEqual(a.skills(), []);
      a.core.stop();
    });

    test("stopping shuts down both halves", () => {
      const a = ambient();
      a.core.stop();
      assert.deepEqual(a.stopped(), { heartbeat: true, triggers: true });
    });

    test("stopping twice is not an error", () => {
      const a = ambient();
      a.core.stop();
      assert.doesNotThrow(() => a.core.stop());
    });
  });

  describe("the screen", () => {
    // The screen module is process-global, which is the point: the tool
    // handler and the core share it. These tests share it with them too.
    const dir = mkdtempSync(join(tmpdir(), "vela-core-screen-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const page = (name: string) => {
      const path = join(dir, name);
      writeFileSync(path, "<p>hi</p>", "utf8");
      return path;
    };

    beforeEach(() => {
      clearScreen();
    });

    test("a presented screen reaches subscribers as a show event, without the path", () => {
      const core = build();
      present({ title: "The 21 sensors", path: page("sensors.html"), note: "why they drift" });
      const show = events.find((e) => e.type === "show");
      assert.ok(show, "a face that never hears about the screen cannot draw it");
      assert.equal(show.screen?.title, "The 21 sensors");
      assert.equal(show.screen?.note, "why they drift");
      assert.equal("path" in (show.screen ?? {}), false, "the browser has no use for his filesystem layout");
      core.stop();
    });

    test("clearing the screen shows as null, which is how the hub knows to close the stage", () => {
      const core = build();
      present({ title: "Up", path: page("up.html") });
      clearScreen();
      assert.deepEqual(events.at(-1), { type: "show", screen: null });
      core.stop();
    });

    test("a stopped core no longer relays the screen", () => {
      const core = build();
      const mine: CoreEvent[] = [];
      core.subscribe((e) => mine.push(e));
      core.stop();
      present({ title: "Too late", path: page("late.html") });
      assert.equal(mine.some((e) => e.type === "show"), false);
    });
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

/**
 * The knobs that decide how fast she feels. A scripted session replaces the
 * real one everywhere else in this file, so these would otherwise only ever be
 * exercised by running her.
 */
describe("sessionOptions", () => {
  test("leaves the model to the SDK when none was named", () => {
    assert.equal("model" in sessionOptions({ systemPrompt: "" }), false);
  });

  test("pins the model it was given", () => {
    assert.equal(sessionOptions({ systemPrompt: "", model: "sonnet" }).model, "sonnet");
  });

  test("turns thinking off by default, because it doubles time to first token", () => {
    assert.deepEqual(sessionOptions({ systemPrompt: "" }).thinking, {
      type: "disabled",
    });
  });

  test("leaves thinking alone when it was asked for", () => {
    assert.equal("thinking" in sessionOptions({ systemPrompt: "", thinking: true }), false);
  });

  test("caps the effort when thinking is off, because the pair is refused", () => {
    // Claude Code's own settings.json carries effortLevel: xhigh, and the SDK
    // inherits it. With thinking disabled that combination is a 400 on every
    // single turn: "effort 'xhigh' is not supported when thinking is
    // disabled". Launched from a shell that had already overridden it this
    // never showed; launched clean from the scheduled task, she was mute.
    assert.equal(sessionOptions({ systemPrompt: "" }).effort, "high");
  });

  test("leaves the effort to the SDK once thinking is on, where xhigh is legal", () => {
    assert.equal("effort" in sessionOptions({ systemPrompt: "", thinking: true }), false);
  });

  test("takes an effort it was given, so he can spend more or less on a turn", () => {
    assert.equal(sessionOptions({ systemPrompt: "", effort: "low" }).effort, "low");
    assert.equal(
      sessionOptions({ systemPrompt: "", thinking: true, effort: "max" }).effort,
      "max",
    );
  });

  test("streams partial messages, which is what lets her talk as she writes", () => {
    assert.equal(sessionOptions({ systemPrompt: "" }).includePartialMessages, true);
  });

  test("offers the skills it was given", () => {
    assert.deepEqual(
      sessionOptions({ systemPrompt: "", skills: ["agent-reach", "skill-creator"] }).skills,
      ["agent-reach", "skill-creator"],
    );
  });

  test("omits skills entirely when none are installed, rather than sending an empty list", () => {
    assert.equal("skills" in sessionOptions({ systemPrompt: "" }), false);
    assert.equal("skills" in sessionOptions({ systemPrompt: "", skills: [] }), false);
  });

  test("appends the persona to the preset rather than replacing it", () => {
    assert.deepEqual(sessionOptions({ systemPrompt: "you are Vela" }).systemPrompt, {
      type: "preset",
      preset: "claude_code",
      append: "you are Vela",
    });
  });
});
