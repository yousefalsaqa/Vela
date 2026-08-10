import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { q } from "./desktop.js";

/**
 * Vela out loud — a second listener on the core, not a rewrite of it.
 *
 * Speech is spoken sentence by sentence as it streams, because waiting for the
 * whole reply before saying a word adds the length of the answer to a latency
 * budget that is already about a second and a half.
 */

/**
 * Words the synthesiser gets wrong. Only affects speech; what's printed on
 * screen is untouched.
 *
 * Two tables because the engines take different input. Kokoro understands
 * inline phonemes, which say exactly what's wanted. edge-tts and SAPI don't —
 * they'd read the brackets out — so those get a phonetic respelling instead.
 */
export const PRONOUNCE_PHONEMES: [RegExp, string][] = [
  [/\bYousef's\b/gi, "[Yousefs](/jˈuːsəfs/)"],
  [/\bYousef\b/gi, "[Yousef](/jˈuːsəf/)"],
];

export const PRONOUNCE_RESPELL: [RegExp, string][] = [
  // Left to itself every en-GB voice says "YO-sef".
  [/\bYousef('s)?\b/gi, "Yoosef$1"],
];

/**
 * Text that reads badly aloud, removed rather than pronounced.
 *
 * Pronunciation is applied last, after the markdown cleanup — otherwise the
 * link rule would strip `[Yousef](/jˈuːsəf/)` back down to plain "Yousef".
 */
export function speakable(
  text: string,
  pronounce: [RegExp, string][] = PRONOUNCE_RESPELL,
): string {
  const cleaned = (
    text
      // Code is not speech. Say that there was some and move on.
      .replace(/```[\s\S]*?```/g, " code block. ")
      .replace(/`([^`]+)`/g, "$1")
      // Links: keep any label, drop the URL.
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " a link ")
      // Markdown emphasis and headers are punctuation to the eye only.
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/(^|\s)[*_]([^*_]+)[*_]/g, "$1$2")
      .replace(/^\s*[-*]\s+/gm, "")
      // Windows paths read as gibberish; the filename is the useful part.
      .replace(/[A-Za-z]:[\\/][\w.\-\\/ ]+[\\/]([\w.\-]+)/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
  );

  let out = cleaned;
  for (const [pattern, replacement] of pronounce) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Pull complete sentences off the front of a streaming buffer, leaving any
 * partial one behind. `flush` takes whatever is left, at end of turn.
 */
export function sentences(
  buffer: string,
  flush = false,
): { ready: string[]; rest: string } {
  const ready: string[] = [];
  let rest = buffer;

  // A sentence ends at . ! ? followed by space, or at a blank line. A single
  // newline is deliberately not an ending — it would cut a fenced code block
  // into pieces before speakable() ever sees it was one.
  const boundary = /([.!?]+\s|\n\n)/;
  for (;;) {
    const match = boundary.exec(rest);
    if (!match) break;
    const end = match.index + match[0].length;
    const piece = rest.slice(0, end).trim();
    if (piece) ready.push(piece);
    rest = rest.slice(end);
  }

  if (flush && rest.trim()) {
    ready.push(rest.trim());
    rest = "";
  }
  return { ready, rest };
}

/** Says things out loud. Injected in tests so nothing actually speaks. */
export type Speaker = (text: string) => void;

export interface SpeakerHandle {
  speak: Speaker;
  stop: () => void;
  /** Resolve once everything queued has actually been said. */
  drain?: (timeoutMs?: number) => Promise<void>;
}

export interface Voice {
  /** Feed streamed text; whole sentences are spoken as they complete. */
  push: (chunk: string) => void;
  /** End of turn — say whatever is left. */
  flush: () => void;
  /** Say something immediately, on its own (an unprompted interjection). */
  say: (text: string) => void;
  stop: () => void;
}

/**
 * One long-lived PowerShell holding a speech synthesiser. Spawning one per
 * utterance costs ~300ms of process start before a word is heard.
 */
export function windowsSpeaker(voiceName?: string, rate = 1): SpeakerHandle {
  let ps: ChildProcess | null = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "-"],
    { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] },
  );
  ps.on("error", () => (ps = null));

  ps.stdin?.write(
    "Add-Type -AssemblyName System.Speech; " +
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
      `$s.Rate = ${Math.max(-10, Math.min(10, Math.round(rate)))}; ` +
      (voiceName ? `try { $s.SelectVoice(${q(voiceName)}) } catch {}; ` : "") +
      "\n",
  );

  return {
    speak(text: string) {
      if (!ps?.stdin?.writable) return;
      ps.stdin.write(`$s.Speak(${q(text)})\n`);
    },
    stop() {
      try {
        ps?.stdin?.end("$s.Dispose()\nexit\n");
      } catch {
        /* already gone */
      }
      ps = null;
    },
  };
}

/**
 * Microsoft's neural voices through edge-tts. Free, no key, and a different
 * generation from SAPI — David and Zira are concatenative and sound it.
 *
 * The cost is a network round trip per sentence, which is why speech is
 * queued: sentence two is being fetched while sentence one is still playing.
 */
export function neuralSpeaker(
  voiceName = "en-GB-LibbyNeural",
  rate = 12,
  pitch = -8,
  bin = { tts: "edge-tts", play: "ffplay" },
): SpeakerHandle {
  const dir = mkdtempSync(join(tmpdir(), "vela-speech-"));
  let queue: Promise<void> = Promise.resolve();
  let playing: ChildProcess | null = null;
  let stopped = false;
  let n = 0;

  // Speech failing silently is indistinguishable from speech being off, which
  // is exactly how the first version wasted an evening. Say it once.
  let complained = false;
  const complain = (why: string) => {
    if (complained) return;
    complained = true;
    process.stderr.write(`\n  \x1b[33mVoice off:\x1b[0m ${why}\n`);
  };

  const utter = async (text: string, index: number) => {
    if (stopped) return;
    const file = join(dir, `${index}.mp3`);
    const args = ["--voice", voiceName, "--text", text, "--write-media", file];
    // edge-tts wants signed values: +12% and -8Hz.
    const signed = (n: number) => `${n > 0 ? "+" : ""}${Math.round(n)}`;
    if (rate) args.push("--rate", `${signed(rate)}%`);
    if (pitch) args.push("--pitch", `${signed(pitch)}Hz`);

    await new Promise<void>((done) => {
      const gen = spawn(bin.tts, args, { windowsHide: true, stdio: "ignore" });
      gen.on("close", () => done());
      gen.on("error", (err) => {
        complain(`couldn't run ${bin.tts}: ${err.message}`);
        done();
      });
    });
    if (stopped) return;
    if (!existsSync(file)) {
      complain(`${bin.tts} produced no audio — is there a network connection?`);
      return;
    }

    await new Promise<void>((done) => {
      playing = spawn(bin.play, ["-nodisp", "-autoexit", "-loglevel", "quiet", file], {
        windowsHide: true,
        stdio: "ignore",
      });
      playing.on("close", () => done());
      playing.on("error", () => done());
    });
    try {
      rmSync(file, { force: true, maxRetries: 2, retryDelay: 50 });
    } catch {
      /* still held; the directory goes on stop() */
    }
  };

  return {
    speak(text: string) {
      if (stopped) return;
      const index = n++;
      // Chained, not parallel — otherwise sentences talk over each other.
      queue = queue.then(() => utter(text, index)).catch(() => {});
    },
    /**
     * Wait for everything queued to actually be said. Without this, exiting
     * after a reply cuts the speech off before it starts — the queue is the
     * whole point, and it makes stopping asynchronous.
     */
    async drain(timeoutMs = 30_000) {
      await Promise.race([
        queue,
        new Promise((r) => setTimeout(r, timeoutMs).unref?.()),
      ]);
    },
    stop() {
      stopped = true;
      playing?.kill();
      try {
        // Windows won't unlink a file ffplay still has open, and a failure to
        // tidy up is not worth crashing the exit path over. Temp is temp.
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* the OS will get it */
      }
    },
  };
}

/**
 * Kokoro, running locally. Offline, no per-sentence network call, and it
 * doesn't have the over-articulated cadence that gives the cloud voices away.
 *
 * The model costs ~1.2s to load and ~1.5s per sentence, so the worker stays
 * warm — about 1GB resident while speech is on, and nothing when it isn't.
 */
export function kokoroSpeaker(opts: {
  python: string;
  worker: string;
  voice?: string;
  speed?: number;
  play?: string;
  onProblem?: (why: string) => void;
}): SpeakerHandle {
  const dir = mkdtempSync(join(tmpdir(), "vela-kokoro-"));
  const play = opts.play ?? "ffplay";
  let queue: Promise<void> = Promise.resolve();
  let playing: ChildProcess | null = null;
  let stopped = false;
  let n = 0;

  let complained = false;
  const complain = (why: string) => {
    if (complained) return;
    complained = true;
    opts.onProblem?.(why);
  };

  const worker = spawn(
    opts.python,
    [opts.worker, opts.voice ?? "bf_emma", String(opts.speed ?? 1.1)],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      // Kokoro shells out to uv for its G2P assets and needs to find the venv.
      env: { ...process.env, VIRTUAL_ENV: join(opts.python, "..", "..") },
    },
  );
  worker.on("error", (err) => complain(`couldn't start Kokoro: ${err.message}`));

  // One status line per request, in the order they were sent.
  const waiting: ((line: string) => void)[] = [];
  let buffered = "";
  worker.stdout?.setEncoding("utf8");
  worker.stdout?.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const cut = buffered.indexOf("\n");
      if (cut < 0) break;
      const line = buffered.slice(0, cut).trim();
      buffered = buffered.slice(cut + 1);
      // Kokoro's loader prints its own warnings to stdout, so only lines in
      // the protocol count. Anything else is noise sharing the channel.
      if (!line.startsWith("ok ") && !line.startsWith("err ")) continue;
      waiting.shift()?.(line);
    }
  });

  const utter = async (text: string, index: number) => {
    if (stopped || !worker.stdin?.writable) return;
    const file = join(dir, `${index}.wav`);

    const status = await new Promise<string>((done) => {
      waiting.push(done);
      worker.stdin!.write(`${JSON.stringify({ text, out: file })}\n`);
      // A wedged worker must not wedge the conversation.
      setTimeout(() => done("err timed out"), 30_000).unref?.();
    });

    if (stopped) return;
    if (!status.startsWith("ok ") || !existsSync(file)) {
      complain(`Kokoro failed: ${status.replace(/^err /, "")}`);
      return;
    }

    await new Promise<void>((done) => {
      playing = spawn(play, ["-nodisp", "-autoexit", "-loglevel", "quiet", file], {
        windowsHide: true,
        stdio: "ignore",
      });
      playing.on("close", () => done());
      playing.on("error", () => done());
    });
    try {
      rmSync(file, { force: true, maxRetries: 2, retryDelay: 50 });
    } catch {
      /* still held; the directory goes on stop() */
    }
  };

  return {
    speak(text: string) {
      if (stopped) return;
      const index = n++;
      queue = queue.then(() => utter(text, index)).catch(() => {});
    },
    async drain(timeoutMs = 30_000) {
      await Promise.race([queue, new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
    },
    stop() {
      stopped = true;
      playing?.kill();
      worker.stdin?.end();
      worker.kill();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* the OS will get it */
      }
    },
  };
}

export function createVoice(
  speak: Speaker,
  pronounce: [RegExp, string][] = PRONOUNCE_RESPELL,
): Voice {
  let buffer = "";

  const emit = (text: string) => {
    const words = speakable(text, pronounce);
    if (words) speak(words);
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      const { ready, rest } = sentences(buffer);
      buffer = rest;
      for (const s of ready) emit(s);
    },
    flush() {
      const { ready } = sentences(buffer, true);
      buffer = "";
      for (const s of ready) emit(s);
    },
    say(text: string) {
      emit(text);
    },
    stop() {
      buffer = "";
    },
  };
}
