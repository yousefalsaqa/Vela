import { query } from "@anthropic-ai/claude-agent-sdk";
import { velaTools } from "./tools.js";
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
    // Internet reach, via the agent-reach skill on this machine. It routes to
    // per-platform CLIs itself, so there is nothing to wrap.
    skills: ["agent-reach"],
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.thinking ? {} : { thinking: { type: "disabled" as const } }),
    cwd: process.cwd(),
    includePartialMessages: true,
  };
}

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

  // One pump for the life of the session, rather than a loop per turn.
  const pump = (async () => {
    try {
      for await (const msg of session) {
        if (stopped) break;

        const lines = toolActivity(msg);
        if (lines.length) emit({ type: "activity", lines });

        const delta = streamedText(msg);
        if (delta !== null && delta !== "") {
          streamedThisTurn = true;
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
          streamedThisTurn = false;
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
        store,
      })
    : null;

  // The timer is a floor; a watch with a trigger wakes itself in seconds.
  const stopTriggers = heartbeat
    ? watch({ store, onFire: (ids) => heartbeat.check(ids) })
    : () => {};

  return {
    send(text: string) {
      if (stopped) return;
      busy = true;
      streamedThisTurn = false;
      turns.send(text);
    },

    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    isBusy: () => busy,

    stop() {
      stopped = true;
      stopTriggers();
      heartbeat?.stop();
      turns.end();
      session.close();
      listeners.clear();
      void pump;
    },
  };
}
