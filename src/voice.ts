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
/**
 * The shortest opening worth breaking a clause for.
 *
 * Below this a fragment is a stutter rather than a phrase, and Kokoro renders
 * three words with no run-up to them.
 */
export const EAGER_MIN = 18;

/**
 * The shortest clause worth speaking on its own, in words.
 *
 * Below this a cut is a stutter rather than a breath: "No," on its own is a
 * hole in the middle of a phrase a person says without stopping.
 */
export const CLAUSE_MIN_WORDS = 3;

/**
 * How long a sentence has to be before its commas are worth breaking at.
 *
 * "Renamed it, tests pass." is one breath and splitting it invents a pause
 * nobody would make. A sentence three times that length is where the ear
 * starts needing somewhere to rest, and where running it together is what
 * makes a reply sound like one unbroken line.
 */
export const CLAUSE_MIN_CHARS = 70;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * Break a long sentence at its clause boundaries.
 *
 * Kokoro synthesises each piece separately and `gapFor` gives each one a pause
 * sized to how it ends, so a sentence handed over whole gets no internal pause
 * at all — whatever prosody the model invents, which is nearly none. Three
 * clauses then arrive as one continuous run. Splitting here is what lets a
 * comma actually sound like a comma.
 *
 * Short sentences and code are returned untouched.
 */
export function clauses(text: string): string[] {
  const whole = text.trim();
  if (whole.length < CLAUSE_MIN_CHARS) return [whole];
  // A fence anywhere in the piece means the commas inside it are code.
  if (whole.includes("```")) return [whole];

  const pieces: string[] = [];
  let rest = whole;
  for (;;) {
    // A comma, semicolon or colon followed by a space. Not a decimal point,
    // which has no space after it, and not a comma inside a number.
    const cut = /[,;:]\s/.exec(rest);
    if (!cut) break;
    const head = rest.slice(0, cut.index + 1);
    const tail = rest.slice(cut.index + cut[0].length);
    // Both halves have to be worth saying: too short on either side and the
    // pause lands mid-phrase instead of between phrases.
    if (words(head) < CLAUSE_MIN_WORDS || words(tail) < CLAUSE_MIN_WORDS) break;
    pieces.push(head);
    rest = tail;
  }
  if (rest) pieces.push(rest);
  return pieces.length ? pieces : [whole];
}

export function sentences(
  buffer: string,
  flush = false,
  /**
   * Let the first thing she says break at a clause instead of a sentence.
   *
   * Nothing is spoken until a boundary arrives, so the whole opening sentence
   * is silence he sits through: measured at 1.2s after her first token on a
   * short opener and 2.7s on a long one. A comma is already a breath, so
   * cutting there costs almost nothing in prosody and returns most of that
   * wait. Only the opening does this; once she is talking, the player is fed
   * ahead of the ear and whole sentences are free.
   */
  eager = false,
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
    if (piece) ready.push(...clauses(piece));
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

  // The opening clause, when nothing whole has arrived yet and she is still
  // writing. Never inside a fence, and never a three-word stub.
  if (eager && !flush && !ready.length && !insideFence) {
    const clause = new RegExp(String.raw`^([^\n]{${EAGER_MIN},}?[,;:])\s`).exec(rest);
    if (clause) {
      ready.push(clause[1].trim());
      return { ready, rest: rest.slice(clause[0].length) };
    }
  }

  if (!flush && !insideFence && COMPLETE.test(tail) && !KEEPS_GOING.test(tail)) {
    ready.push(...clauses(tail));
    rest = "";
  }

  if (flush && rest.trim()) {
    ready.push(...clauses(rest.trim()));
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
  write: (pcm: Buffer, gapMs?: number) => void;
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
/**
 * How long to wait after a piece, from the mark it ended on.
 *
 * One fixed gap between every sentence is worse than none: an even pause is
 * as much a tell as an even sentence length, and it lands as a machine reading
 * a list. A person's pauses are graded, so these are too. A clause is barely a
 * beat; a question hangs; a paragraph is a proper stop. The jitter is small and
 * deterministic per piece, enough to break the metronome without wandering.
 */
export function gapFor(text: string, base = 150): number {
  const end = text.trimEnd().slice(-1);
  const scale =
    text.slice(-2).includes("\n") ? 2.6 :
    end === "?" || end === "!" ? 1.6 :
    end === "." ? 1.15 :
    // A clause break used to be 0.45, which at the default base is ~65ms and
    // below the threshold where a pause registers as a pause at all. It has to
    // be short enough to stay a breath and long enough to be heard as one.
    end === "," || end === ";" || end === ":" ? 0.7 :
    0.75;

  // A hash of the words, so the same sentence always pauses the same way and a
  // reply does not shimmer differently every time it is replayed.
  let n = 0;
  for (let i = 0; i < text.length; i++) n = (n * 31 + text.charCodeAt(i)) >>> 0;
  const jitter = 0.85 + ((n % 30) / 100);

  return Math.round(base * scale * jitter);
}

/** Silence, as signed 16-bit mono samples. Two bytes each, so always even. */
export function silence(ms: number, rate = 24_000): Buffer {
  return Buffer.alloc(Math.max(0, Math.round((rate * ms) / 1000)) * 2);
}

export function pcmPlayer(opts: {
  play?: string;
  sampleRate?: number;
  /**
   * A beat between her sentences, in milliseconds.
   *
   * Each sentence is synthesised on its own and the samples are written
   * straight after the last lot, so without this they butt together with no
   * pause at all and a reply comes out as one long breath. Kokoro's own
   * trailing silence is only a few tens of milliseconds, which is not a beat.
   * Never added before the first sentence of a turn, because that is the one
   * he is waiting on.
   */
  gapMs?: number;
  onProblem?: (why: string) => void;
  spawn?: Spawner;
}): PcmPlayer {
  const spawn = opts.spawn ?? realSpawn;
  const bin = opts.play ?? "ffplay";
  const rate = opts.sampleRate ?? 24_000;
  const gapMs = opts.gapMs ?? 0;
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
    write(pcm: Buffer, thisGap?: number) {
      if (stopped || !pcm.length) return;
      // The player runs for the length of a turn, so a pipe that is already
      // open means this is not her first sentence and the one before it ended
      // flush against this one.
      const midTurn = proc !== null;
      const pause = thisGap ?? gapMs;
      const stdin = (proc ?? start()).stdin;
      if (midTurn && pause > 0) stdin?.write(silence(pause, rate));
      stdin?.write(pcm);
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
  /** Silence inserted between her sentences. See pcmPlayer. */
  gapMs?: number;
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
    gapMs: opts.gapMs,
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
      player.write(pcm, gapFor(text, opts.gapMs ?? 0));
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
  /**
   * True until something has actually been spoken this turn. Only the opening
   * is allowed to break at a clause: once the player has samples the ear is
   * behind the stream, and whole sentences cost nothing.
   */
  let opening = true;

  const emit = (text: string): boolean => {
    const words = speakable(text, pronounce);
    if (!words) return false;
    speak(words);
    return true;
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      const { ready, rest } = sentences(buffer, false, opening);
      buffer = rest;
      // A piece that turned out to be nothing but markup was never spoken, so
      // the turn has not opened yet and the next piece still gets to be eager.
      for (const s of ready) if (emit(s)) opening = false;
    },
    flush() {
      const { ready } = sentences(buffer, true);
      buffer = "";
      for (const s of ready) emit(s);
      // The turn is over, so the next one opens from silence and is eager again.
      opening = true;
    },
    say(text: string) {
      emit(text);
    },
    stop() {
      buffer = "";
      opening = true;
    },
  };
}

/**
 * Kokoro as a function: text in, a wav out.
 *
 * `kokoroSpeaker` renders and plays in one move, which is right for the
 * terminal and useless to the hub, where the samples have to travel over HTTP
 * and be played by a browser. Same worker, same protocol, but the bytes come
 * back instead of going to ffplay.
 *
 * Only one of the two should exist in a process. The service uses this one and
 * never plays anything locally; the REPL uses the speaker and never serves.
 */
export function kokoroSynth(opts: {
  python: string;
  worker: string;
  voice?: string;
  speed?: number;
  onProblem?: (why: string) => void;
  spawn?: Spawner;
}): { render: (text: string) => Promise<Buffer | null>; stop: () => void } {
  const spawn = opts.spawn ?? realSpawn;
  const dir = mkdtempSync(join(tmpdir(), "vela-synth-"));
  let stopped = false;
  let n = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const worker = spawn(
    opts.python,
    [opts.worker, opts.voice ?? "bf_emma", String(opts.speed ?? 1.1)],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, VIRTUAL_ENV: join(opts.python, "..", "..") },
    },
  );
  worker.on("error", (err) => opts.onProblem?.(`couldn't start Kokoro: ${err.message}`));

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
      if (!line.startsWith("ok ") && !line.startsWith("err ")) continue;
      waiting.shift()?.(line);
    }
  });

  const one = async (text: string): Promise<Buffer | null> => {
    if (stopped || !worker.stdin?.writable) return null;
    const file = join(dir, `${n++}.wav`);
    const status = await new Promise<string>((done) => {
      waiting.push(done);
      worker.stdin!.write(`${JSON.stringify({ text, out: file })}\n`);
      setTimeout(() => done("err timed out"), 30_000).unref?.();
    });
    if (!status.startsWith("ok ") || !existsSync(file)) {
      opts.onProblem?.(`Kokoro failed: ${status.replace(/^err /, "")}`);
      return null;
    }
    const wav = readFileSync(file);
    try {
      rmSync(file, { force: true, maxRetries: 2, retryDelay: 50 });
    } catch {
      /* the directory goes on stop() */
    }
    return wav;
  };

  return {
    // Requests are serialised because the worker answers in the order it was
    // asked, and two callers interleaving would each get the other's audio.
    render(text: string) {
      const mine = queue.then(() => one(text));
      queue = mine.catch(() => {});
      return mine;
    },
    stop() {
      stopped = true;
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
