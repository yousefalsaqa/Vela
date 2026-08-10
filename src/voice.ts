import { type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { q } from "./desktop.js";
import { spawn as realSpawn, type Spawner } from "./proc.js";

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

/** A sentence that has landed: a word, then its punctuation, then nothing. */
const COMPLETE = /\w[.!?]+["')\]]?$/;

/**
 * A full stop that something is going to follow — a decimal point, a list
 * marker, an abbreviation. Only "." is ambiguous this way; "!" and "?" aren't.
 */
const KEEPS_GOING = /(?:\d|\b(?:mr|mrs|ms|dr|st|vs|etc|e\.g|i\.e))\.$/i;

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

  // The last sentence of a reply has no space after its full stop, so the rule
  // above never fires on it and it waits for flush() at the end of the turn.
  // When she's being listened to the reply is usually one sentence long, which
  // made that the whole reply: nothing was said out loud until the turn was
  // completely finished, and then synthesis started from cold. Take a trailing
  // sentence as done — unless it's mid-code-fence, where a line ending in a
  // full stop is not a sentence at all.
  const tail = rest.trim();
  const insideFence = ((rest.match(/```/g)?.length ?? 0) % 2) === 1;
  if (!flush && !insideFence && COMPLETE.test(tail) && !KEEPS_GOING.test(tail)) {
    ready.push(tail);
    rest = "";
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
export function windowsSpeaker(
  voiceName?: string,
  rate = 1,
  spawn: Spawner = realSpawn,
): SpeakerHandle {
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
  spawn: Spawner = realSpawn,
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
 * The audio payload of a RIFF wav.
 *
 * The header is very nearly always 44 bytes, and slicing that off blindly
 * works right up until the writer emits a LIST chunk first — at which point
 * its own metadata gets played as a burst of noise. Walk the chunks instead.
 */
export function pcmFromWav(buffer: Buffer): Buffer | null {
  const ascii = (at: number) => buffer.toString("ascii", at, at + 4);
  if (buffer.length < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") return null;

  let at = 12;
  while (at + 8 <= buffer.length) {
    const size = buffer.readUInt32LE(at + 4);
    const body = at + 8;
    if (ascii(at) === "data") {
      return buffer.subarray(body, Math.min(body + size, buffer.length));
    }
    // Chunks are word-aligned; an odd size is followed by a pad byte.
    at = body + size + (size % 2);
  }
  return null;
}

export interface PcmPlayer {
  /** Queue raw signed 16-bit mono samples. Returns as soon as they're handed over. */
  write: (pcm: Buffer) => void;
  /** Close the stream and wait for the tail to finish playing. */
  drain: (timeoutMs?: number) => Promise<void>;
  stop: () => void;
}

/**
 * One player for the whole conversation, fed raw samples down a pipe.
 *
 * Spawning a player per sentence costs about 450ms each time — process start,
 * then opening the audio device — and that lands as a gap of silence between
 * every sentence she says. Measured over a four-sentence reply: ~1.9s of dead
 * air with a player per sentence, ~0.6s with one player, nearly all of it the
 * single startup.
 *
 * The second benefit is pipelining. Writing samples returns immediately, so
 * the next sentence is being synthesised while this one is still being played
 * out of the player's own buffer, instead of after it.
 */
export function pcmPlayer(opts: {
  play?: string;
  sampleRate?: number;
  onProblem?: (why: string) => void;
  spawn?: Spawner;
}): PcmPlayer {
  const spawn = opts.spawn ?? realSpawn;
  const bin = opts.play ?? "ffplay";
  const rate = opts.sampleRate ?? 24_000;
  let proc: ChildProcess | null = null;
  let closed: Promise<void> = Promise.resolve();
  let stopped = false;

  const start = (): ChildProcess => {
    const p = spawn(
      bin,
      [
        "-nodisp",
        "-autoexit",
        "-loglevel", "quiet",
        "-f", "s16le",
        "-ar", String(rate),
        // ffplay 9 dropped -ac in favour of -ch_layout.
        "-ch_layout", "mono",
        "-i", "pipe:0",
      ],
      { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] },
    );
    p.on("error", (err) => {
      proc = null;
      opts.onProblem?.(`couldn't run ${bin}: ${err.message}`);
    });
    // A player that dies mid-sentence must not take the assistant with it.
    p.stdin?.on("error", () => {});
    closed = new Promise<void>((done) => p.on("close", () => done()));
    proc = p;
    return p;
  };

  return {
    write(pcm: Buffer) {
      if (stopped || !pcm.length) return;
      (proc ?? start()).stdin?.write(pcm);
    },

    async drain(timeoutMs = 30_000) {
      const p = proc;
      if (!p) return;
      // Closing the pipe is what tells the player it has reached the end, so
      // the next thing said gets a fresh one.
      proc = null;
      p.stdin?.end();
      await Promise.race([
        closed,
        new Promise((r) => setTimeout(r, timeoutMs).unref?.()),
      ]);
    },

    stop() {
      stopped = true;
      proc?.kill();
      proc = null;
    },
  };
}

/**
 * Kokoro, running locally. Offline, no per-sentence network call, and it
 * doesn't have the over-articulated cadence that gives the cloud voices away.
 *
 * The model costs ~1.2s to load and ~0.5s per sentence, so the worker stays
 * warm — about 1GB resident while speech is on, and nothing when it isn't.
 */
export function kokoroSpeaker(opts: {
  python: string;
  worker: string;
  voice?: string;
  speed?: number;
  play?: string;
  onProblem?: (why: string) => void;
  /** Fires when a sentence's samples reach the player, i.e. when she starts. */
  onSpoke?: () => void;
  spawn?: Spawner;
}): SpeakerHandle {
  const spawn = opts.spawn ?? realSpawn;
  const dir = mkdtempSync(join(tmpdir(), "vela-kokoro-"));
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;
  let n = 0;

  let complained = false;
  const complain = (why: string) => {
    if (complained) return;
    complained = true;
    opts.onProblem?.(why);
  };

  // Kokoro's own rate, and the one the samples below are written at.
  const player = pcmPlayer({
    play: opts.play,
    sampleRate: 24_000,
    onProblem: complain,
    spawn,
  });

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

    // Hand the samples over and move straight on to the next sentence — the
    // player holds them, so synthesis runs ahead of what's being heard.
    const pcm = pcmFromWav(readFileSync(file));
    if (pcm) {
      player.write(pcm);
      opts.onSpoke?.();
    } else complain("Kokoro wrote a file that isn't a wav");

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
      // Both halves: everything synthesised, then everything played out.
      await Promise.race([queue, new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
      await player.drain(timeoutMs);
    },
    stop() {
      stopped = true;
      player.stop();
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
