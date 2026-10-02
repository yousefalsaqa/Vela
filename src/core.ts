import { query } from "@anthropic-ai/claude-agent-sdk";
import { velaTools } from "./tools.js";
import { onScreen, type ScreenMeta } from "./screen.js";
import { onFace, type Expression } from "./face.js";
import { onWork } from "./work.js";
import { store as defaultStore, type Store } from "./memory.js";
import { startHeartbeat, type Heartbeat } from "./ambient.js";
import { startTriggers } from "./triggers.js";
import { streamedText, toolActivity } from "./repl.js";
import { createTurnQueue, type UserTurn } from "./session.js";

/**
 * Vela's brain, with no idea a terminal exists.
 *
 * Everything that used to live inside the REPL loop — the session, the
 * heartbeat, the triggers — lives here and reports through events. That is
 * what lets a second face (voice, a HUD) attach later without rebuilding any
 * of it, and what lets the assistant outlive the window you started it from.
 */

export type CoreEvent =
  /** Tools the assistant is running, one line each. */
  | { type: "activity"; lines: string[] }
  /** A chunk of the assistant's reply, as it is produced. */
  | { type: "delta"; text: string }
  /** The turn is over. `text` is set only if nothing streamed. */
  | { type: "result"; ms: number; text?: string }
  /** Something unprompted — a watch fired. */
  | { type: "say"; text: string }
  /** She put something on the screen (or took it down: null). */
  | { type: "show"; screen: ScreenMeta | null }
  /** She pulled a face. The hub draws it over the conversation for a moment. */
  | { type: "face"; expression: Expression }
  | { type: "error"; message: string };

export type Listener = (event: CoreEvent) => void;

/** The subset of the SDK's Query that the core actually uses. */
export interface Session extends AsyncIterable<unknown> {
  close: () => void;
  /** Change the model for the requests that follow. The real SDK session has it. */
  setModel?: (model?: string) => Promise<void>;
}
export type SessionFactory = (turns: AsyncGenerator<UserTurn>) => Session;

export interface CoreOptions {
  systemPrompt: string;
  store?: Store;
  /** Defaults to a real SDK session; tests pass a scripted one. */
  session?: SessionFactory;
  /** Backoff before rebuilding a session that died, growing per failure. Tests shorten it. */
  reconnectMs?: number[];
  /** 0 disables the heartbeat and, with it, triggers. */
  heartbeatMs?: number;
  heartbeatModel?: string;
  /** Undefined leaves the SDK on its own default. The model for work. */
  model?: string;
  /**
   * The model for a spoken turn. Undefined keeps every turn on `model`. See
   * TALK_MODEL in config.ts.
   */
  talkModel?: string;
  /**
   * The built-in tools the session is given. Undefined is all of them. See
   * BUILTIN_TOOLS in config.ts for what they cost.
   */
  tools?: string[];
  thinking?: boolean;
  /** How hard she works a turn. See sessionOptions for why this has to be set. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Skill names the session may reach for. Empty means none are offered. */
  skills?: string[];
  /** The heartbeat's own, shorter list — it runs unsupervised. */
  heartbeatSkills?: string[];
  /**
   * The ambient half. Defaults to the real thing; tests pass versions that
   * never reach the model, which is the only way to exercise the path where
   * she speaks up on her own.
   */
  heartbeat?: typeof startHeartbeat;
  triggers?: typeof startTriggers;
  /**
   * Something went wrong that costs her speed rather than the turn, so it is
   * said here and not as an error event: an error ends a spoken turn.
   */
  onProblem?: (why: string) => void;
  /** How long idle before warm() bothers. See WARM_AFTER_MS. */
  warmAfterMs?: number;
  now?: () => number;
}

/**
 * Idle this long and the model's cache has probably gone.
 *
 * Anthropic keeps a prompt's cache for five minutes. Every turn sends about
 * 30,000 tokens, nearly all of it the same, and measured on 2026-10-02 a turn
 * after six idle minutes rewrote 4,836 of them where one after thirty seconds
 * rewrote 72, and the first word came 0.7 to 1.2s later for it. That was the
 * first answer of every conversation. Four minutes leaves room for the warm-up
 * itself to land inside the five.
 */
export const WARM_AFTER_MS = 240_000;

/**
 * The silent turn. It is real history, so it says what it is, and asks for
 * the least the model can answer with; the answer goes nowhere.
 */
export const WARM_UP = "[He just said your name, and what he wants is in the next message. Reply with only: ok]";

export interface Core {
  /**
   * Hand the assistant a turn. `spoken` when he said it out loud rather than
   * typed it, which is what decides the model when talkModel is set.
   */
  send: (text: string, how?: { spoken?: boolean }) => void;
  /** Listen for everything it does. Returns an unsubscribe function. */
  subscribe: (listener: Listener) => () => void;
  /** True while a turn is in flight — the heartbeat waits for this. */
  isBusy: () => boolean;
  /**
   * He has just said her name, so a turn is seconds away: if the model has
   * been idle long enough for its cache to have gone cold, send a silent turn
   * now so his lands on a warm one. Nothing of it is emitted. True if sent.
   */
  warm: () => boolean;
  stop: () => void;
}

/**
 * The options the real session is opened with. Pulled out so the parts that
 * decide how fast she feels — the model, whether she thinks first — can be
 * asserted on without a session that reaches the model.
 */
export function sessionOptions(opts: CoreOptions): Record<string, unknown> {
  return {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: opts.systemPrompt,
    },
    mcpServers: { vela: velaTools },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // Skills are named, not wrapped: agent-reach routes to per-platform CLIs
    // itself, skill-creator writes files. The list is discovered at startup in
    // config.ts, so one she wrote for herself is hers on the next start.
    ...(opts.skills?.length ? { skills: opts.skills } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    // Two things his Claude Code has that she should not. His claude.ai
    // connectors (Claude Docs: tools and instructions she never uses), and
    // Claude Code's memory of this repo, which is notes about building her,
    // written for the agent that builds her, not for her.
    env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
    // Thinking off is what keeps a spoken turn under two seconds, and the
    // effort has to come with it. The SDK inherits effortLevel from Claude
    // Code's settings.json, and xhigh with thinking disabled is refused
    // outright: every turn comes back as "API Error: 400". Started from a
    // shell that had already set it, this never appeared; started clean from
    // the scheduled task at logon, she answered nothing else.
    ...(opts.thinking
      ? { ...(opts.effort ? { effort: opts.effort } : {}) }
      : { thinking: { type: "disabled" as const }, effort: opts.effort ?? "high" }),
    cwd: process.cwd(),
    includePartialMessages: true,
  };
}

/**
 * A turn that stopped at the promise.
 *
 * "I'll fetch a real diagram, then put it up. Give me a second." reads like
 * work starting. It is the end: a turn is over the moment she stops writing,
 * there is no second, and he is left watching a finished reply for something
 * that will never begin.
 *
 * Prose alone does not fix it, because from inside the turn the sentence is
 * true when she writes it. What gives it away is that nothing ran — the whole
 * reply is an intention with no tool call under it. That pair is checkable,
 * so it is checked here rather than hoped for in the prompt.
 */
const PROMISE =
  /\b(?:i(?:'|’)?ll|i will|let me|going to|gonna)\s+(?:go\s+|just\s+|quickly\s+)?(?:fetch|grab|get|find|look|check|pull|put|make|draw|build|write|run|read|search|dig|see|have a look)\b|\bgive me (?:a|one) (?:sec|second|moment|minute)\b|\b(?:one|two) (?:sec|secs|second|seconds|moment)\b|\bhang on\b|\bbear with me\b|\bstand by\b/i;

/**
 * Did she finish, or only say she would?
 *
 * Only the tail is looked at: "I'll check the log" in the middle of a reply
 * that then checks the log is her narrating, which is a different complaint.
 * At the end, with nothing having run, it is a turn that did not happen.
 */
export function endedOnAPromise(said: string, toolsUsed: number): boolean {
  if (toolsUsed > 0) return false;
  const tail = said.trim().slice(-180);
  return tail.length > 0 && PROMISE.test(tail);
}

/** What she is told when she does it. Phrased as the fact, not a telling-off. */
export const UNFINISHED =
  "[That turn ended where it started: you said you were about to do " +
  "something and then nothing ran, so he is looking at a promise. Do it now, " +
  "and tell him what happened rather than what is about to.]";

export function createCore(opts: CoreOptions): Core {
  const store = opts.store ?? defaultStore();
  const listeners = new Set<Listener>();
  const emit = (event: CoreEvent) => {
    for (const l of [...listeners]) l(event);
  };

  let turns = createTurnQueue();

  const makeSession: SessionFactory =
    opts.session ??
    ((stream) =>
      query({
        prompt: stream,
        options: sessionOptions(opts) as Parameters<typeof query>[0]["options"],
      }) as unknown as Session);

  let session = makeSession(turns.stream());

  /**
   * The model the session is on now. A session starts on `model`; a spoken
   * turn moves it to talkModel and a typed one moves it back. Undefined is the
   * SDK's own default, which is also what `model` unset means.
   */
  let onModel: string | undefined = opts.model;
  /**
   * Change model before the next request, if it is not already the one.
   *
   * The switch is recorded only once the session has taken it. It used to be
   * recorded first and its failure swallowed, and on 2026-10-01 that was every
   * spoken turn of the day: the SDK's bundled Claude Code did not know
   * claude-sonnet-5-5, refused the switch, and she answered "how's it going"
   * on Opus at three seconds a time while believing she was on Sonnet. Left
   * unrecorded, the next spoken turn tries again, and the failure is said.
   */
  let refused = "";
  const useModel = (want: string | undefined): Promise<void> => {
    if (want === onModel || !session.setModel) return Promise.resolve();
    return session.setModel(want).then(
      () => {
        onModel = want;
      },
      (err: Error) => {
        // The turn still goes, on whichever model the session is on. A switch
        // that failed must not cost him the answer. Said once per reason.
        const why = `couldn't move her to ${want ?? "the default model"} (${err?.message ?? err})`;
        if (why !== refused) opts.onProblem?.(why);
        refused = why;
      },
    );
  };

  let busy = false;
  let streamedThisTurn = false;
  let stopped = false;
  // Enough of the turn to tell whether it actually happened.
  let saidThisTurn = "";
  let toolsThisTurn = 0;
  let pushedThisTurn = false;
  /** Silent turns still in flight, whose output goes nowhere. See warm(). */
  let silent = 0;
  /** A real turn was sent while a warm-up was in flight, so she is busy after it. */
  let queuedBehindWarm = false;
  const now = opts.now ?? Date.now;
  /** When the model was last asked anything; never, to start with. */
  let lastAsked = -Infinity;

  /**
   * How long to wait before standing a dead session back up, growing with each
   * failure so a persistent outage (a hit usage limit, say) is not hammered.
   * A fresh session costs nothing until a turn reaches it, so healing while he
   * is not talking is free; the wait only spaces out his failed attempts.
   */
  const RECONNECT_MS = opts.reconnectMs ?? [1_000, 4_000, 15_000, 30_000, 60_000];
  let deaths = 0;

  const wait = (ms: number) =>
    ms <= 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms);
          if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
        });

  /**
   * One pump for the life of the core, across sessions rather than within one.
   *
   * With streaming input the SDK stream stays open across turns and only ends
   * when the input ends (stop) or the subprocess dies. So a loop that finishes
   * while she is still meant to be running means the session died under her —
   * the model refused, the credentials lapsed, the usage limit was hit — and
   * the query behind it will never resume. Left there, `busy` stays true, the
   * heartbeat freezes, and every "you there?" queues into a session that is
   * already gone, which reads as her being stuck. Instead: say so, drop the
   * turn that died with it, and stand a fresh session up so the next thing he
   * says lands somewhere alive.
   */
  const pump = (async () => {
    while (!stopped) {
      let threw: Error | null = null;
      try {
        for await (const msg of session) {
          if (stopped) break;

          const m = msg as { type?: string; duration_ms?: number; result?: string };
          // A warm-up's answer: swallowed whole, including its end. Turns
          // are answered in order, so the first result is the warm-up's.
          if (silent > 0) {
            if (m.type === "result") {
              silent--;
              busy = silent > 0 || queuedBehindWarm;
              queuedBehindWarm = false;
              deaths = 0;
            }
            continue;
          }

          const lines = toolActivity(msg);
          if (lines.length) {
            toolsThisTurn += lines.length;
            emit({ type: "activity", lines });
          }

          const delta = streamedText(msg);
          if (delta !== null && delta !== "") {
            streamedThisTurn = true;
            saidThisTurn += delta;
            emit({ type: "delta", text: delta });
          }

          if (m.type === "result") {
            busy = false;
            deaths = 0; // a turn came back, so whatever was wrong has passed
            emit({
              type: "result",
              ms: m.duration_ms ?? 0,
              ...(streamedThisTurn ? {} : { text: m.result }),
            });

            const said = streamedThisTurn ? saidThisTurn : m.result ?? "";
            // Once per turn. Handing the note back to a turn that was itself
            // the note would be a loop, and a stubborn one.
            const owed = !pushedThisTurn && endedOnAPromise(said, toolsThisTurn);
            streamedThisTurn = false;
            saidThisTurn = "";
            toolsThisTurn = 0;
            if (owed) {
              pushedThisTurn = true;
              busy = true;
              turns.send(UNFINISHED);
            }
          }
        }
      } catch (err) {
        threw = err as Error;
      }
      if (stopped) break;

      // The stream is gone and she is meant to be here. Surface it, reset the
      // turn that fell in the hole, and rebuild.
      busy = false;
      silent = 0;
      queuedBehindWarm = false;
      streamedThisTurn = false;
      saidThisTurn = "";
      toolsThisTurn = 0;
      emit({
        type: "error",
        message: threw
          ? threw.message
          : "Lost the connection to the model. Reconnecting.",
      });

      const backoff = RECONNECT_MS[Math.min(deaths, RECONNECT_MS.length - 1)];
      deaths++;
      await wait(backoff);
      if (stopped) break;

      turns.end();
      turns = createTurnQueue();
      session = makeSession(turns.stream());
      onModel = opts.model;
    }
  })();

  const beat = opts.heartbeat ?? startHeartbeat;
  const watch = opts.triggers ?? startTriggers;

  const heartbeat: Heartbeat | null = opts.heartbeatMs
    ? beat({
        say: (text) => emit({ type: "say", text }),
        isBusy: () => busy,
        intervalMs: opts.heartbeatMs,
        model: opts.heartbeatModel ?? "haiku",
        skills: opts.heartbeatSkills ?? [],
        store,
      })
    : null;

  // The timer is a floor; a watch with a trigger wakes itself in seconds.
  const stopTriggers = heartbeat
    ? watch({ store, onFire: (ids) => heartbeat.check(ids) })
    : () => {};

  // The show_screen tool talks to the screen module; faces hear about it
  // through the same stream everything else arrives on.
  const offScreen = onScreen((screen) => emit({ type: "show", screen }));
  const offFace = onFace((expression) => emit({ type: "face", expression }));
  // A spoken turn that turned out to be real work: the rest of it goes to the
  // strong model. The next spoken turn goes back to talking.
  const offWork = onWork(() => {
    if (opts.talkModel === undefined) return;
    void useModel(opts.model);
  });

  return {
    send(text: string, how: { spoken?: boolean } = {}) {
      if (stopped) return;
      lastAsked = now();
      if (silent > 0) queuedBehindWarm = true;
      busy = true;
      streamedThisTurn = false;
      saidThisTurn = "";
      toolsThisTurn = 0;
      // A turn he started is allowed its own one nudge.
      pushedThisTurn = false;
      if (opts.talkModel === undefined) {
        turns.send(text);
        return;
      }
      // The switch is a request to the session, so the turn waits for it: sent
      // first, the turn would be answered by the model it was meant to leave.
      void useModel(how.spoken ? opts.talkModel : opts.model).then(() => {
        if (!stopped) turns.send(text);
      });
    },

    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    isBusy: () => busy,

    warm() {
      if (stopped || busy || now() - lastAsked < (opts.warmAfterMs ?? WARM_AFTER_MS)) return false;
      lastAsked = now();
      silent++;
      busy = true;
      // Queued exactly the way send() queues his turn, so it is always ahead
      // of it: turns are answered in order, and a warm-up behind his turn
      // would have its "ok" spoken and his answer swallowed.
      if (opts.talkModel === undefined) {
        turns.send(WARM_UP);
        return true;
      }
      // On the model his turn will be on, or it warms the wrong cache.
      void useModel(opts.talkModel).then(() => {
        if (!stopped) turns.send(WARM_UP);
      });
      return true;
    },

    stop() {
      stopped = true;
      offScreen();
      offFace();
      offWork();
      stopTriggers();
      heartbeat?.stop();
      turns.end();
      session.close();
      listeners.clear();
      void pump;
    },
  };
}
