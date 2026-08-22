import { query } from "@anthropic-ai/claude-agent-sdk";
import { velaTools } from "./tools.js";
import { onScreen, type ScreenMeta } from "./screen.js";
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
  | { type: "error"; message: string };

export type Listener = (event: CoreEvent) => void;

/** The subset of the SDK's Query that the core actually uses. */
export interface Session extends AsyncIterable<unknown> {
  close: () => void;
}
export type SessionFactory = (turns: AsyncGenerator<UserTurn>) => Session;

export interface CoreOptions {
  systemPrompt: string;
  store?: Store;
  /** Defaults to a real SDK session; tests pass a scripted one. */
  session?: SessionFactory;
  /** 0 disables the heartbeat and, with it, triggers. */
  heartbeatMs?: number;
  heartbeatModel?: string;
  /** Undefined leaves the SDK on its own default. */
  model?: string;
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
}

export interface Core {
  /** Hand the assistant a turn. */
  send: (text: string) => void;
  /** Listen for everything it does. Returns an unsubscribe function. */
  subscribe: (listener: Listener) => () => void;
  /** True while a turn is in flight — the heartbeat waits for this. */
  isBusy: () => boolean;
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
    ...(opts.model ? { model: opts.model } : {}),
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

  const turns = createTurnQueue();

  const makeSession: SessionFactory =
    opts.session ??
    ((stream) =>
      query({
        prompt: stream,
        options: sessionOptions(opts) as Parameters<typeof query>[0]["options"],
      }) as unknown as Session);

  const session = makeSession(turns.stream());

  let busy = false;
  let streamedThisTurn = false;
  let stopped = false;
  // Enough of the turn to tell whether it actually happened.
  let saidThisTurn = "";
  let toolsThisTurn = 0;
  let pushedThisTurn = false;

  // One pump for the life of the session, rather than a loop per turn.
  const pump = (async () => {
    try {
      for await (const msg of session) {
        if (stopped) break;

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

        const m = msg as { type?: string; duration_ms?: number; result?: string };
        if (m.type === "result") {
          busy = false;
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
      busy = false;
      if (!stopped) emit({ type: "error", message: (err as Error).message });
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

  return {
    send(text: string) {
      if (stopped) return;
      busy = true;
      streamedThisTurn = false;
      saidThisTurn = "";
      toolsThisTurn = 0;
      // A turn he started is allowed its own one nudge.
      pushedThisTurn = false;
      turns.send(text);
    },

    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    isBusy: () => busy,

    stop() {
      stopped = true;
      offScreen();
      stopTriggers();
      heartbeat?.stop();
      turns.end();
      session.close();
      listeners.clear();
      void pump;
    },
  };
}
