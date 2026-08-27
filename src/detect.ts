import { type ChildProcess } from "node:child_process";
import { spawn as realSpawn, type Spawner } from "./proc.js";

/**
 * The wake word, as a model that only answers one question.
 *
 * What this replaces: a loudness gate deciding something might be speech,
 * whisper writing down what it thought it heard, and a search through that
 * text for her name. Three stages, each lossy, and the middle one answers
 * "nothing was said" by inventing a sentence. Her name is out of whisper's
 * vocabulary, so a real one came back as "Hello" — and priming the decoder to
 * expect it made it write the name out of room tone instead. One knob, two
 * failures, pulling opposite ways.
 *
 * A wake word model scores an 80ms frame between 0 and 1 and has no opinion
 * about anything else. See scripts/wake_worker.py for the process at the far
 * end, and README for the measurements.
 */
export interface WakeDetector {
  /** Feed it whatever came off the microphone, in the mic's own chunks. */
  push: (pcm: Buffer) => void;
  /**
   * Did it fire recently enough to belong to the utterance being considered?
   *
   * The detection lands mid-phrase — "hey vella" is over before the sentence
   * after it is — so the answer arrives before the transcript it belongs to
   * and has to keep until the transcript catches up.
   */
  firedSince: (ms: number) => boolean;
  /** The score it last fired on. Diagnostics, and the log line. */
  lastScore: () => number;
  /** Resolves once the model is loaded and scoring. */
  ready: Promise<void>;
  stop: () => void;
}

/** 80ms of 16-bit mono at 16kHz, which is the frame the models were trained on. */
export const FRAME_BYTES = 1280 * 2;

export function openDetector(opts: {
  python: string;
  worker: string;
  /** A bundled name ("hey_jarvis") or a path to a .onnx of her own. */
  model: string;
  threshold?: number;
  vad?: number;
  onWake?: (score: number) => void;
  onProblem?: (why: string) => void;
  spawn?: Spawner;
  now?: () => number;
}): WakeDetector {
  const spawn = opts.spawn ?? realSpawn;
  const now = opts.now ?? Date.now;
  let firedAt = 0;
  let score = 0;
  let stopped = false;

  let proc: ChildProcess | null = null;
  let settle: (() => void) | null = null;
  const ready = new Promise<void>((resolve) => (settle = resolve));

  /**
   * The worker speaks in whole lines and the pipe does not, so a line that
   * arrives in two reads has to be held rather than parsed twice.
   */
  let rest = "";
  const take = (chunk: Buffer) => {
    rest += chunk.toString("utf8");
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      if (text === "ready") {
        settle?.();
        settle = null;
      } else if (text.startsWith("wake ")) {
        score = Number(text.slice(5)) || 0;
        firedAt = now();
        opts.onWake?.(score);
      } else if (text.startsWith("err ")) {
        opts.onProblem?.(text.slice(4));
      }
    }
  };

  const child = spawn(
    opts.python,
    [
      opts.worker,
      opts.model,
      String(opts.threshold ?? 0.5),
      String(opts.vad ?? 0.5),
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  child.stdout?.on("data", take);
  child.on("error", (err) => {
    proc = null;
    // Resolve rather than hang: the caller is waiting to know whether this
    // ever started, and "no" is an answer it can act on.
    settle?.();
    settle = null;
    opts.onProblem?.(`couldn't run the wake model: ${err.message}`);
  });
  child.on("close", () => {
    if (stopped) return;
    proc = null;
    settle?.();
    settle = null;
    opts.onProblem?.("the wake model stopped");
  });
  // A worker that dies mid-frame must not take the assistant with it.
  child.stdin?.on("error", () => {});
  proc = child;

  return {
    push(pcm: Buffer) {
      if (stopped || !proc || !pcm.length) return;
      proc.stdin?.write(pcm);
    },

    firedSince(ms: number) {
      return firedAt > 0 && now() - firedAt <= ms;
    },

    lastScore: () => score,
    ready,

    stop() {
      stopped = true;
      proc?.kill();
      proc = null;
    },
  };
}
