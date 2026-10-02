import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createCore,
  sessionOptions,
  endedOnAPromise,
  UNFINISHED,
  type CoreEvent,
  type Session,
  WARM_UP,
  WARM_AFTER_MS,
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

  test("a session that ends without a result does not leave her stuck busy", async () => {
    // The real wedge: with streaming input the SDK stream only ends when the
    // subprocess dies (a hit usage limit, lapsed credentials). The loop
    // finished with no result, so busy used to stay true for ever and every
    // later turn queued into a session that was already gone.
    let calls = 0;
    const dead: Session = {
      close: () => {},
      async *[Symbol.asyncIterator]() {
        /* ends immediately: the subprocess is gone */
      },
    };
    const live = scriptedSession();
    const core = createCore({
      systemPrompt: "test",
      store,
      heartbeatMs: 0,
      reconnectMs: [0],
      session: (stream) => {
        if (calls++ === 0) return dead;
        void live.collectTurns(stream as never, 5);
        return live.session;
      },
    });
    core.subscribe((e) => events.push(e));

    await until(() => events.some((e) => e.type === "error"), "the drop to be reported");
    assert.equal(core.isBusy(), false, "a dead session must not leave her frozen busy");
    core.stop();
  });

  test("stands a fresh session up so his next turn lands somewhere alive", async () => {
    let calls = 0;
    const dead: Session = {
      close: () => {},
      async *[Symbol.asyncIterator]() {},
    };
    const live = scriptedSession();
    const core = createCore({
      systemPrompt: "test",
      store,
      heartbeatMs: 0,
      reconnectMs: [0],
      session: (stream) => {
        if (calls++ === 0) return dead;
        void live.collectTurns(stream as never, 5);
        return live.session;
      },
    });
    core.subscribe((e) => events.push(e));

    await until(() => calls === 2, "a new session to be built");
    core.send("you there?");
    await until(() => live.sent.includes("you there?"), "the turn to reach the healed session");
    live.emit(result(50, "Right here."));
    await until(() => events.some((e) => e.type === "result"), "her answer");
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

  describe("a turn that only promised", () => {
    const promise = "I'll fetch a real diagram and put it up. Give me a second.";

    test("is handed straight back to her, so the work actually starts", async () => {
      const core = build();
      core.send("can you put up a diagram");
      await until(() => script.sent.length === 1, "the turn to reach the session");
      script.emit(text(promise));
      script.emit(result(2100));
      await until(() => script.sent.length === 2, "the note to go back");
      assert.equal(script.sent[1], UNFINISHED);
      core.stop();
    });

    test("stays busy across it, so the heartbeat does not cut in", async () => {
      // From his side this is still one turn: she is going to answer him.
      const core = build();
      core.send("can you put up a diagram");
      await until(() => script.sent.length === 1, "the turn");
      script.emit(text(promise));
      script.emit(result(2100));
      await until(() => script.sent.length === 2, "the note");
      assert.equal(core.isBusy(), true, "an interjection here would talk over her");
      core.stop();
    });

    test("happens once, because a second one would be a loop", async () => {
      const core = build();
      core.send("can you put up a diagram");
      await until(() => script.sent.length === 1, "the turn");
      script.emit(text(promise));
      script.emit(result(2100));
      await until(() => script.sent.length === 2, "the note");

      // She promises again. Handing it back for ever would be worse than the
      // habit it is fixing.
      script.emit(text(promise));
      script.emit(result(2100));
      await new Promise((r) => setImmediate(r));
      assert.equal(script.sent.length, 2, "a stubborn turn must be allowed to end");
      core.stop();
    });

    test("a turn that did the work is left alone", async () => {
      const core = build();
      core.send("put up a diagram");
      await until(() => script.sent.length === 1, "the turn");
      script.emit(toolUse("Read", { file_path: "C:/a/b.png" }));
      script.emit(text(promise));
      script.emit(result(2100));
      await new Promise((r) => setImmediate(r));
      assert.equal(script.sent.length, 1, "she ran something, so she was working");
      core.stop();
    });

    test("the next thing he says gets its own chance to be nudged", async () => {
      const core = build();
      core.send("one");
      await until(() => script.sent.length === 1, "the first turn");
      script.emit(text(promise));
      script.emit(result(100));
      await until(() => script.sent.length === 2, "the first note");

      script.emit(text("Right, done."));
      script.emit(result(100));
      core.send("two");
      await until(() => script.sent.length === 3, "the second turn");
      script.emit(text(promise));
      script.emit(result(100));
      await until(() => script.sent.length === 4, "the second note");
      assert.equal(script.sent[3], UNFINISHED);
      core.stop();
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

  describe("him talking over her", () => {
    test("stops the turn at the model, so his next one isn't waiting behind the rest of it", async () => {
      let interrupts = 0;
      script.session.interrupt = async () => {
        interrupts++;
      };
      const core = build();
      core.send("tell me about the history of Rome");
      script.emit(text("Rome was founded"));
      core.interrupt();
      assert.equal(interrupts, 1);
      core.stop();
    });

    test("a reply he cut off on 'let me check' isn't taken for a promise she broke", async () => {
      // Otherwise the nudge would send her straight back to it, over him.
      script.session.interrupt = async () => {};
      const core = build();
      core.send("what's on tonight");
      script.emit(text("Let me check the listings."));
      await until(() => events.length === 1, "her first words");
      core.interrupt();
      script.emit(result());
      await until(() => !core.isBusy(), "the turn to end");
      assert.deepEqual(script.sent, ["what's on tonight"], "no nudge after a reply he stopped");
      core.stop();
    });

    test("with nothing being answered there is nothing to stop", () => {
      let interrupts = 0;
      script.session.interrupt = async () => {
        interrupts++;
      };
      const core = build();
      core.interrupt();
      assert.equal(interrupts, 0);
      core.stop();
    });
  });

  describe("warming her up when she hears her name", () => {
    /** A clock the test moves, so "idle for six minutes" takes no time. */
    const clock = () => {
      let t = 1_000_000;
      return { now: () => t, pass: (ms: number) => (t += ms) };
    };

    test("after a long idle a silent turn goes, and not a word of it reaches anyone", async () => {
      const c = clock();
      const core = build({ now: c.now });
      assert.equal(core.warm(), true);
      await until(() => script.sent.length === 1, "the warm-up to reach the session");
      assert.deepEqual(script.sent, [WARM_UP]);
      script.emit(text("ok"));
      script.emit(result());
      await until(() => !core.isBusy(), "the warm-up to finish");
      assert.deepEqual(events, [], "a warm-up the hub showed or she said would be a word nobody asked for");
      core.stop();
    });

    test("with the model asked inside the last four minutes, the cache is still warm and nothing is sent", async () => {
      // A warm-up costs a model call against his usage; one that warms what
      // is already warm is that cost for nothing.
      const c = clock();
      const core = build({ now: c.now });
      core.send("how are you");
      script.emit(result());
      await until(() => !core.isBusy(), "the turn to finish");
      c.pass(WARM_AFTER_MS - 1);
      assert.equal(core.warm(), false);
      c.pass(1);
      assert.equal(core.warm(), true);
      core.stop();
    });

    test("never on top of a turn already running, which has the cache warm anyway", async () => {
      // Running longer than the idle limit, as a long tool job does, so it is
      // the turn in flight that refuses this and not the idle clock.
      const c = clock();
      const core = build({ now: c.now });
      core.send("build the fantasy project");
      c.pass(WARM_AFTER_MS + 1);
      assert.equal(core.warm(), false);
      core.stop();
    });

    test("his turn, sent while the warm-up is still out, is answered after it and in full", async () => {
      // The usual case: she hears her name, warms, and his question arrives
      // before the warm-up has come back.
      const core = build({ now: clock().now });
      core.warm();
      core.send("what's the time");
      await until(() => script.sent.length === 2, "both turns in the session");
      assert.deepEqual(script.sent, [WARM_UP, "what's the time"], "his turn behind the warm-up, not lost or merged");
      script.emit(text("ok"));
      script.emit(result());
      script.emit(text("Half four."));
      // His first words arriving means the warm-up's end has been read, since
      // the session answers in order; and his own end hasn't been yet.
      await until(() => events.length === 1, "his first words");
      assert.equal(core.isBusy(), true, "still busy: his turn is the one in flight now");
      script.emit(result(900));
      await until(() => events.length === 2, "his answer");
      assert.deepEqual(events, [{ type: "delta", text: "Half four." }, { type: "result", ms: 900 }]);
      assert.equal(core.isBusy(), false);
      core.stop();
    });

    test("his spoken turn stays behind the warm-up when both have to wait for the model switch", async () => {
      script.session.setModel = () => Promise.resolve();
      const core = build({ model: "opus", talkModel: "sonnet", now: clock().now });
      core.warm();
      core.send("what's the time", { spoken: true });
      await until(() => script.sent.length === 2, "both turns");
      assert.deepEqual(script.sent, [WARM_UP, "what's the time"], "out of order, his answer is the one swallowed");
      core.stop();
    });

    test("it warms the talking model's cache, the one his spoken turn will use", async () => {
      const asked: (string | undefined)[] = [];
      script.session.setModel = (model?: string) => {
        asked.push(model);
        return Promise.resolve();
      };
      const core = build({ model: "opus", talkModel: "sonnet", now: clock().now });
      core.warm();
      await until(() => script.sent.length === 1, "the warm-up");
      assert.deepEqual(asked, ["sonnet"]);
      core.stop();
    });
  });

  describe("the talking model", () => {
    /** The session's setModel, answering each call from `answers` in order. */
    const switching = (answers: ("ok" | Error)[]) => {
      const asked: (string | undefined)[] = [];
      script.session.setModel = (model?: string) => {
        asked.push(model);
        const answer = answers.shift() ?? "ok";
        return answer === "ok" ? Promise.resolve() : Promise.reject(answer);
      };
      return asked;
    };
    const refusal = () => new Error('"claude-sonnet-5-5" isn\'t described by this version\'s model catalog');

    test("a spoken turn is sent only after the session has moved to the talking model", async () => {
      const asked = switching(["ok"]);
      const core = build({ model: "opus", talkModel: "sonnet" });
      core.send("how's it going", { spoken: true });
      await until(() => script.sent.length > 0, "the turn to reach the session");
      assert.deepEqual(asked, ["sonnet"]);
      core.stop();
    });

    test("a switch the session refused is asked for again on the next spoken turn", async () => {
      const asked = switching([refusal(), "ok"]);
      const core = build({ model: "opus", talkModel: "sonnet" });
      core.send("how's it going", { spoken: true });
      await until(() => script.sent.length === 1, "the first turn, on whatever model");
      script.emit(result());
      core.send("what's up", { spoken: true });
      await until(() => script.sent.length === 2, "the second turn");
      assert.deepEqual(
        asked,
        ["sonnet", "sonnet"],
        "recorded as done when it was refused, every spoken turn after it stays on the slow model",
      );
      core.stop();
    });

    test("a refused switch still sends the turn, and is said once rather than every turn", async () => {
      switching([refusal(), refusal()]);
      const problems: string[] = [];
      const core = build({ model: "opus", talkModel: "sonnet", onProblem: (why: string) => problems.push(why) });
      core.send("how's it going", { spoken: true });
      await until(() => script.sent.length === 1, "the turn, despite the refusal");
      script.emit(result());
      core.send("what's up", { spoken: true });
      await until(() => script.sent.length === 2, "the second turn");
      assert.equal(problems.length, 1, "the same refusal on every turn is noise in the log");
      assert.match(problems[0], /sonnet/);
      core.stop();
    });

    test("a switch that worked is not asked for again while the conversation stays spoken", async () => {
      const asked = switching(["ok", "ok"]);
      const core = build({ model: "opus", talkModel: "sonnet" });
      core.send("how's it going", { spoken: true });
      await until(() => script.sent.length === 1, "the first turn");
      script.emit(result());
      core.send("what's up", { spoken: true });
      await until(() => script.sent.length === 2, "the second turn");
      assert.deepEqual(asked, ["sonnet"], "a control request per turn would put a round trip in front of every answer");
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

describe("endedOnAPromise", () => {
  // The real one, off his screen. She said it, ran nothing, and stopped.
  const real = "I'll fetch a real diagram rather than draw one from memory, then put it up. Give me a second.";

  test("catches the turn that stopped at the promise", () => {
    assert.equal(endedOnAPromise(real, 0), true);
  });

  test("the same words are fine once something actually ran", () => {
    // Narrating while working is a different complaint, and not this one's.
    assert.equal(endedOnAPromise(real, 3), false);
  });

  test("catches the ways she says it", () => {
    for (const said of [
      "I'll grab that and put it on the screen.",
      "Let me look at the repo first.",
      "Hang on.",
      "Two seconds.",
      "I'm going to check the log.",
      "Bear with me.",
    ]) {
      assert.equal(endedOnAPromise(said, 0), true, said);
    }
  });

  test("a finished answer is left alone, however it ends", () => {
    // False positives are the expensive half: a nudge here talks over a turn
    // that was already complete, and she answers a question nobody asked.
    for (const said of [
      "Sensor 9 is the one drifting, about four degrees over eighty cycles.",
      "Right here.",
      "No, that dataset is FD001 through FD004.",
      "Renamed it, tests pass.",
      "I'll remember that.",
      "Done. Twelve of them were stale.",
      "",
    ]) {
      assert.equal(endedOnAPromise(said, 0), false, said);
    }
  });

  test("only the end of a reply counts", () => {
    // She often says what she is about to do and then does it inside the same
    // turn; what is broken is stopping there.
    const narrated =
      "Let me check the log. " + "x".repeat(300) + " Twelve entries, all from Tuesday.";
    assert.equal(endedOnAPromise(narrated, 0), false);
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
