import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { spawn as realSpawn, type Spawner } from "./proc.js";

/**
 * Knowing when he has finished.
 *
 * The gate decides he is done after a fixed second of quiet. A shorter wait
 * cut him off mid-thought ("I'm trying to look for something to eat", a
 * breath, and she was already answering), so the second stays, and it is most
 * of the pause between him finishing and her answering. A fixed wait is the
 * wrong shape for it: "how are you?" is over the moment it ends, and "can you
 * find me, um..." is not over however long he stops for.
 *
 * Two clues are already to hand a third of a second into any pause. Whisper
 * reads what was said so far at that moment anyway (see WAKE_EARLY_MS), and a
 * sentence that ends like a sentence is evidence. And how it ended sounds
 * different: a falling finish against a trailing "um", which is what Smart
 * Turn listens for (scripts/turn_worker.py). Both agreeing is the call.
 *
 * It starts out taking notes rather than acting on them: every pause is
 * logged with both clues and what he actually did next, so where to set the
 * bar comes from his speech and not from a benchmark's.
 */

/**
 * Words a sentence does not end on. Whisper will put a full stop after "and"
 * when he trails off, so the punctuation alone is not enough.
 */
export const TRAILING = new Set([
  "and", "but", "or", "so", "because", "cause", "cos", "then", "than", "if", "that",
  "um", "uh", "er", "erm", "hmm", "like",
  "the", "a", "an", "my", "your", "his", "her", "their", "our", "its", "this", "these", "those",
  "to", "of", "for", "with", "in", "on", "at", "from", "into", "about", "by", "as",
  "is", "are", "was", "were", "be", "can", "could", "would", "should", "will", "do", "does",
  "just", "also", "maybe", "which", "where", "when", "while",
]);

/**
 * Does what whisper read so far end like a finished sentence?
 *
 * Whisper punctuates, so a finished one ends in . ? or !, but an ellipsis is
 * whisper hearing him trail off, and a full stop after "and" is whisper being
 * tidy rather than him being done.
 */
export function soundsFinished(text: string): boolean {
  const t = text.trim();
  if (!/[.?!]["')\]]*$/.test(t) || /(\.\.\.|…)["')\]]*$/.test(t)) return false;
  const words = t.toLowerCase().match(/[a-z']+/g);
  if (!words?.length) return false;
  return !TRAILING.has(words[words.length - 1]);
}

/** Both clues together: finished on the page, and finished to the ear. */
export function callTurn(textDone: boolean, p: number | null, threshold: number): "done" | "wait" {
  return textDone && p !== null && p >= threshold ? "done" : "wait";
}

export interface TurnJudge {
  /** Everything said so far in, the model's probability that he is done out. Null when it can't say. */
  judge: (pcm: Buffer) => Promise<number | null>;
  /** Start the worker now, if it isn't running. */
  warm: () => void;
  stop: () => void;
}

/**
 * The Smart Turn worker, kept warm. Same line protocol as the whisper worker,
 * replies matched to requests by id.
 *
 * Asked inside a pause he may be about to break, so a slow answer is no
 * answer: it gives up after `timeoutMs` and says null, and the gate's own
 * second carries on as if it had never been asked.
 */
export function createTurnJudge(opts: {
  python: string;
  worker: string;
  model: string;
  lazy?: boolean;
  timeoutMs?: number;
  onProblem?: (why: string) => void;
  spawn?: Spawner;
}): TurnJudge {
  const spawn = opts.spawn ?? realSpawn;
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const dir = mkdtempSync(join(tmpdir(), "vela-turn-"));
  const waiting = new Map<number, (done: number | null) => void>();
  let nextId = 0;
  let stopped = false;
  let worker: ChildProcess | null = null;

  let complained = false;
  const complain = (why: string) => {
    if (complained) return;
    complained = true;
    opts.onProblem?.(why);
  };

  const ensure = (): ChildProcess => {
    if (worker) return worker;
    const started = spawn(opts.python, [opts.worker, opts.model], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    started.on("error", (err) => complain(`couldn't start the turn worker: ${err.message}`));
    let buffered = "";
    started.stdout?.setEncoding("utf8");
    started.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      for (let cut = buffered.indexOf("\n"); cut >= 0; cut = buffered.indexOf("\n")) {
        const line = buffered.slice(0, cut).trim();
        buffered = buffered.slice(cut + 1);
        if (!line.startsWith("ok ") && !line.startsWith("err ")) continue;
        let reply: { id?: unknown; done?: unknown; error?: unknown } = {};
        try {
          reply = JSON.parse(line.slice(line.indexOf(" ") + 1)) as typeof reply;
        } catch {
          /* not ours */
        }
        const done = typeof reply.id === "number" ? waiting.get(reply.id) : undefined;
        if (line.startsWith("err ")) complain(`turn worker: ${String(reply.error ?? line.slice(4))}`);
        if (!done) continue;
        waiting.delete(reply.id as number);
        done(line.startsWith("ok ") && typeof reply.done === "number" ? reply.done : null);
      }
    });
    worker = started;
    return started;
  };

  if (!opts.lazy) ensure();

  return {
    judge(pcm) {
      if (stopped || !pcm.length) return Promise.resolve(null);
      const live = ensure();
      if (!live.stdin?.writable) return Promise.resolve(null);
      const id = nextId++;
      const file = join(dir, `${id}.pcm`);
      writeFileSync(file, pcm);
      return new Promise<number | null>((resolve) => {
        const finish = (done: number | null) => {
          rmSync(file, { force: true });
          resolve(done);
        };
        waiting.set(id, finish);
        live.stdin!.write(`${JSON.stringify({ id, pcm: file, rate: 16_000 })}\n`);
        setTimeout(() => {
          if (waiting.delete(id)) finish(null);
        }, timeoutMs).unref?.();
      });
    },
    warm() {
      if (!stopped) ensure();
    },
    stop() {
      stopped = true;
      for (const done of waiting.values()) done(null);
      waiting.clear();
      worker?.stdin?.end();
      worker?.kill();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* the OS will get it */
      }
    },
  };
}
