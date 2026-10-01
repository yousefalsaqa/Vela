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
 * about anything else. Two can sit at the far end: scripts/kws_worker.py, a
 * keyword spotter that listens for the phrase itself and is what she runs, and
 * scripts/wake_worker.py, the openWakeWord model it replaced. They speak the
 * same protocol. README has the measurements for both.
 */
export interface WakeDetector {
  /** Feed it whatever came off the microphone, in the mic's own chunks. */
  push: (pcm: Buffer) => void;
  /**
   * Be told the moment it fires, before there is any transcript at all.
   *
   * The phrase is over a third of a second before the utterance around it is,
   * and whisper takes another half second after that. Everything that should
   * feel instant — being put on screen, the models paging back in — hangs off
   * this rather than off the transcript.
   */
  onFire: (fn: (score: number) => void) => void;
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
  /**
   * Resolves once the model is loaded and scoring — true — or once it is
   * clear it never will be — false. The difference matters: a detector that
   * is present switches the transcript path off, so one that failed to load
   * and was kept anyway is an assistant that cannot hear her own name at all.
   */
  ready: Promise<boolean>;
  stop: () => void;
}

/** 80ms of 16-bit mono at 16kHz, which is the frame the models were trained on. */
export const FRAME_BYTES = 1280 * 2;

/** What every worker at the far end needs, whichever engine it runs. */
interface WorkerOptions {
  python: string;
  worker: string;
  onWake?: (score: number) => void;
  onProblem?: (why: string) => void;
  spawn?: Spawner;
  now?: () => number;
}

/** The openWakeWord model. See scripts/wake_worker.py. */
export function openDetector(
  opts: WorkerOptions & {
    /** A bundled name ("hey_jarvis") or a path to a .onnx of her own. */
    model: string;
    threshold?: number;
    vad?: number;
  },
): WakeDetector {
  return openWorker(
    [opts.model, String(opts.threshold ?? 0.5), String(opts.vad ?? 0.5)],
    opts,
  );
}

/**
 * The keyword spotter: a small streaming recogniser only allowed to hear the
 * phrase. See scripts/kws_worker.py for why, and for what was measured.
 */
export function openSpotter(
  opts: WorkerOptions & {
    /** The sherpa-onnx model directory: tokens.txt, bpe.model, the three .onnx. */
    model: string;
    /** "hey vela" and the spellings of it that sound the same. */
    phrases: string[];
    /** How hard the search favours the phrase. Higher hears more. */
    boost?: number;
    /** How sure it has to be before it fires. Lower hears more. */
    trigger?: number;
    /** Lift in dB before it listens. His microphone puts speech at -49 dBFS. */
    gainDb?: number;
    /** "on" for her chime, "off", or a path to a .wav. Played by the worker. */
    chime?: string;
  },
): WakeDetector {
  return openWorker(
    [
      opts.model,
      opts.phrases.join(","),
      String(opts.boost ?? 3),
      String(opts.trigger ?? 0.15),
      String(opts.gainDb ?? 0),
      opts.chime ?? "on",
    ],
    opts,
  );
}

function openWorker(args: string[], opts: WorkerOptions): WakeDetector {
  const spawn = opts.spawn ?? realSpawn;
  const now = opts.now ?? Date.now;
  let firedAt = 0;
  let score = 0;
  let stopped = false;
  const fired: ((score: number) => void)[] = opts.onWake ? [opts.onWake] : [];

  let proc: ChildProcess | null = null;
  let settle: ((up: boolean) => void) | null = null;
  const ready = new Promise<boolean>((resolve) => (settle = resolve));

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
        settle?.(true);
        settle = null;
      } else if (text.startsWith("wake ")) {
        // parseFloat, because the spotter says which phrase it heard after
        // the number: "wake 1 HEY_VELA".
        score = parseFloat(text.slice(5)) || 0;
        firedAt = now();
        for (const fn of fired) fn(score);
      } else if (text.startsWith("err ")) {
        opts.onProblem?.(text.slice(4));
      }
    }
  };

  const child = spawn(opts.python, [opts.worker, ...args], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.stdout?.on("data", take);
  child.on("error", (err) => {
    proc = null;
    // Resolve rather than hang: the caller is waiting to know whether this
    // ever started, and "no" is an answer it can act on.
    settle?.(false);
    settle = null;
    opts.onProblem?.(`couldn't run the wake model: ${err.message}`);
  });
  child.on("close", () => {
    if (stopped) return;
    proc = null;
    settle?.(false);
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

    onFire(fn) {
      fired.push(fn);
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
