import { query } from "@anthropic-ai/claude-agent-sdk";
import { velaTools } from "./tools.js";
import { store as defaultStore, type Store, type WatchRow } from "./memory.js";

/**
 * The heartbeat: every interval, if Yousef has asked Vela to keep an eye on
 * something, wake up, look, and speak only if there is a reason to.
 *
 * Two rules keep this from being expensive or annoying:
 *   - No active watches means no model call at all. Idle costs nothing.
 *   - Each tick is a fresh session. Continuity comes from the watch rows
 *     (what was said, how long ago), not from a transcript that grows all day.
 */

const SILENT = "SILENT";

const AMBIENT_PROMPT = `
You are running as a background heartbeat, not in conversation. Yousef did not
ask you anything — you woke up on a timer to check on things he asked you to
watch.

You are observing, not acting. Look at the world (files, commands, open
windows), decide whether anything has changed enough to be worth interrupting
him, and stop. Do not fix, edit, launch, or change anything.

The bar for speaking is high. Interrupting someone who is concentrating costs
more than staying quiet costs. Speak only when a watch has actually resolved or
changed state — not to report that things are still in progress, and never to
repeat something you already said.

Reply with exactly ${SILENT} when there is nothing worth saying. That is the
normal outcome; most ticks should be silent.

Otherwise reply with one line, in one of these two forms:

#<watch id>: <what happened, in one sentence>
#<watch id> done: <what happened, in one sentence>

Use the "done" form when the thing you were watching has settled for good and
there is nothing left to check — that closes the watch. Use the plain form when
it is worth mentioning but the watch should stay open.

Lead with the outcome. No preamble, no offer to help — he'll ask if he wants
something done about it.
`.trim();

export type Reply =
  | { silent: true }
  | { silent: false; id: number | null; done: boolean; message: string };

/**
 * Read the heartbeat's reply. The reply is the whole contract — whether to
 * speak, about which watch, and whether that watch is finished — so this is
 * deliberately forgiving about everything except the leading SILENT.
 */
export function parseReply(text: string): Reply {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith(SILENT)) return { silent: true };

  const tagged = trimmed.match(/^#(\d+)\s*(done)?\s*[:：]\s*([\s\S]+)$/i);
  if (!tagged) {
    return { silent: false, id: null, done: false, message: trimmed };
  }
  return {
    silent: false,
    id: Number(tagged[1]),
    done: Boolean(tagged[2]),
    message: tagged[3].trim(),
  };
}

/** The watch list as the heartbeat sees it, including what it already said. */
export function renderWatches(watches: WatchRow[]): string {
  return watches
    .map((w) => {
      const lines = [`#${w.id} ${w.note}`];
      if (w.cue) lines.push(`   how to check: ${w.cue}`);
      if (w.minutes_since_spoke !== null) {
        lines.push(
          `   you already said ${w.minutes_since_spoke} min ago: "${w.last_message}"`,
        );
      }
      return lines.join("\n");
    })
    .join("\n");
}

/** The real model call. Swapped out in tests. */
async function askModel(prompt: string, model: string): Promise<string> {
  const response = query({
    prompt,
    options: {
      systemPrompt: { type: "preset", preset: "claude_code", append: AMBIENT_PROMPT },
      mcpServers: { vela: velaTools },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Observation only. The heartbeat runs unsupervised, so it does not get
      // the tools that change things — on disk or on the desktop.
      disallowedTools: [
        "Write",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
        "mcp__vela__launch_app",
        "mcp__vela__media_control",
        "mcp__vela__forget",
        "mcp__vela__remember",
      ],
      // Reach is read-only, so a watch can be about a PR or a feed, not just
      // something on this machine.
      skills: ["agent-reach"],
      // A heartbeat is a look-and-report, not a reasoning task.
      thinking: { type: "disabled" },
      model,
      maxTurns: 8,
      cwd: process.cwd(),
    },
  });

  let text = "";
  for await (const msg of response) {
    if (msg.type === "result" && "result" in msg && msg.result) {
      text = msg.result;
    }
  }
  return text;
}

export interface HeartbeatOptions {
  /** Print an unprompted message to the user. */
  say: (message: string) => void;
  /** True while a foreground turn is streaming — the tick is skipped. */
  isBusy: () => boolean;
  intervalMs: number;
  model: string;
  /** Defaults to the assistant's own store; tests pass a throwaway one. */
  store?: Store;
  /** Defaults to a real model call; tests pass a stub. */
  ask?: (prompt: string, model: string) => Promise<string>;
}

/**
 * One heartbeat check. Pass `only` to check specific watches — that is what a
 * trigger does, so a woken watch doesn't drag every other one into the prompt.
 */
export async function tick(
  opts: HeartbeatOptions,
  only?: number[],
): Promise<void> {
  if (opts.isBusy()) return;

  const store = opts.store ?? defaultStore();
  const active = store.listWatches();
  const watches = only
    ? active.filter((w) => only.includes(w.id))
    : active;
  if (!watches.length) return;

  const reply = parseReply(
    await (opts.ask ?? askModel)(
      `It is ${new Date().toLocaleString()}. You are watching:\n\n` +
        `${renderWatches(watches)}\n\n` +
        `Check them and reply with ${SILENT} or a single #id line.`,
      opts.model,
    ),
  );

  if (reply.silent) return;
  // A tick that ran long enough for Yousef to start typing has missed its
  // moment; hold it rather than cutting across him. Nothing is recorded, so
  // the next tick is free to raise it again.
  if (opts.isBusy()) return;

  if (reply.id !== null) {
    store.markSpoke(reply.id, reply.message);
    if (reply.done) store.resolveWatch(reply.id);
  }

  opts.say(reply.message);
}

export interface Heartbeat {
  /** Check now. Triggers use this; the timer uses it too. */
  check: (only?: number[]) => Promise<void>;
  stop: () => void;
}

/** Start the heartbeat. */
export function startHeartbeat(opts: HeartbeatOptions): Heartbeat {
  let timer: NodeJS.Timeout;
  let stopped = false;

  // Checks are serialised: a triggered check and a scheduled one must never
  // talk over each other, and two model calls at once would be worse still.
  // A heartbeat that can't reach the model stays quiet about it — erroring
  // every interval would be worse than the missed check.
  let chain: Promise<void> = Promise.resolve();
  const check = (only?: number[]): Promise<void> => {
    chain = chain.then(() => tick(opts, only)).catch(() => {});
    return chain;
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await check();
      schedule();
    }, opts.intervalMs);
    // Never hold the process open on the assistant's account.
    timer.unref();
  };

  schedule();
  return {
    check,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
