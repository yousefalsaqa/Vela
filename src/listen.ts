import { type ChildProcess } from "node:child_process";
import {
  spawn as realSpawn,
  run as realRun,
  type Spawner,
  type Runner,
} from "./proc.js";
import {
  readFileSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

/**
 * Push-to-talk. ffmpeg captures the microphone, whisper turns it into text,
 * and the text goes into the same turn queue a typed line would.
 *
 * The wake word is built on the same two pieces rather than on a model of its
 * own — see wake.ts. What that decision cost is written down there.
 */


/**
 * ffmpeg lists DirectShow devices on stderr, in the form
 *   [dshow @ ...] "Microphone (Realtek Audio)" (audio)
 * Video devices are listed the same way, so the (audio) tag is the filter.
 */
export function parseAudioDevices(stderr: string): string[] {
  const devices: string[] = [];
  const lines = stderr.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const name = lines[i].match(/"([^"]+)"/)?.[1];
    if (!name) continue;
    // The (audio) marker sits on the same line or the alternative-name line.
    const isAudio = /\(audio\)/.test(lines[i]);
    if (isAudio && !devices.includes(name)) devices.push(name);
  }
  return devices;
}

/** Prefer a device the user named, else anything that sounds like a mic. */
export function pickDevice(devices: string[], preferred?: string): string | null {
  if (!devices.length) return null;
  if (preferred) {
    const exact = devices.find((d) => d === preferred);
    if (exact) return exact;
    const loose = devices.find((d) => d.toLowerCase().includes(preferred.toLowerCase()));
    if (loose) return loose;
  }
  const mic = devices.find((d) => /microphone|mic\b|input/i.test(d));
  return mic ?? devices[0];
}

/** Whisper marks silence rather than returning nothing; that isn't a turn. */
export function cleanTranscript(raw: string): string {
  const text = raw
    .replace(/\[(BLANK_AUDIO|INAUDIBLE|NOISE|MUSIC|SILENCE)\]/gi, " ")
    .replace(/^\s*\(.*?\)\s*$/gm, " ") // (upbeat music)
    .replace(/\s+/g, " ")
    .trim();
  // A lone "You.", "Thank you." or "." is what whisper hallucinates out of a
  // second of room tone. Punctuation is stripped first because it always
  // punctuates them.
  const bare = text.replace(/[.!?,]+$/, "").trim().toLowerCase();
  if (["", "you", "thank you", "thanks", "thank", "bye", "okay", "ok"].includes(bare)) {
    return "";
  }
  return text;
}

export interface ListenOptions {
  /** DirectShow device name; otherwise the first microphone found. */
  device?: string;
  /** Whisper model: tiny.en, base.en, small.en… bigger is slower and better. */
  model?: string;
  ffmpeg?: string;
  whisper?: string;
  /**
   * Where whisper runs: "cpu" or "cuda". CPU by default — faster-whisper picks
   * CUDA when it sees an NVIDIA card and then dies on a missing
   * cublas64_12.dll unless the CUDA runtime is installed. A few seconds of
   * speech transcribes fine on CPU.
   */
  computeDevice?: string;
  /** Injected in tests, so nothing actually opens the microphone. */
  spawn?: Spawner;
  run?: Runner;
}

/**
 * Find ffmpeg. winget installs it and adds a PATH entry, but existing shells —
 * and anything launched from them — don't see it until they restart, which
 * turns "push-to-talk does nothing" into a mystery. Look where winget puts it.
 */
export function resolveWinGetBinary(name: string, explicit?: string): string | null {
  if (explicit) return existsSync(explicit) || !explicit.includes("\\") ? explicit : null;

  const local = process.env.LOCALAPPDATA ?? "";
  const link = join(local, "Microsoft", "WinGet", "Links", `${name}.exe`);
  if (existsSync(link)) return link;

  const packages = join(local, "Microsoft", "WinGet", "Packages");
  try {
    for (const entry of readdirSync(packages)) {
      if (!/ffmpeg/i.test(entry)) continue;
      const root = join(packages, entry);
      for (const build of readdirSync(root)) {
        const exe = join(root, build, "bin", `${name}.exe`);
        if (existsSync(exe)) return exe;
      }
    }
  } catch {
    /* no winget packages directory */
  }
  return null;
}

export const resolveFfmpeg = (explicit?: string) => resolveWinGetBinary("ffmpeg", explicit);
/** ffplay ships with ffmpeg and is what plays the neural speech back. */
export const resolveFfplay = (explicit?: string) => resolveWinGetBinary("ffplay", explicit);

export async function audioDevices(
  ffmpeg = "ffmpeg",
  run: Runner = realRun,
): Promise<string[]> {
  // The device list always goes to stderr, but whether ffmpeg then exits zero
  // depends on the version — 9.0 succeeds, older ones fail on the dummy input.
  // Read stderr either way.
  const args = ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"];
  try {
    const { stderr } = await run(ffmpeg, args, {});
    return parseAudioDevices(stderr);
  } catch (err) {
    return parseAudioDevices((err as { stderr?: string }).stderr ?? "");
  }
}

/** What both the mic and whisper agree the audio is: mono, 16 kHz, signed 16-bit. */
export const SAMPLE_RATE = 16_000;

export interface Recorder {
  /**
   * Resolves once samples are actually arriving.
   *
   * dshow takes about 1.3s to open the device, and everything said before that
   * is not recorded at all — it isn't quiet, it doesn't exist. Telling him to
   * talk before this resolves is how the first word or two of a sentence goes
   * missing and whisper is left guessing at a fragment.
   */
  ready: Promise<void>;
  /** Stop capturing and hand back the raw samples. Empty if nothing was heard. */
  stop: () => Promise<Buffer>;
}

/**
 * What ffmpeg is asked for, in both directions the microphone is used: a
 * push-to-talk capture that ends, and the open stream the wake word listens
 * to. They must agree on the format, because the same whisper worker reads
 * both, so there is one place that says what the format is.
 */
export function captureArgs(device: string, rate = SAMPLE_RATE): string[] {
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "dshow",
    "-i", `audio=${device}`,
    "-ac", "1",                 // whisper wants mono
    "-ar", String(rate),        // at 16 kHz
    "-f", "s16le", "pipe:1",    // raw, straight down stdout
  ];
}

/**
 * Start recording now. The caller stops it — in the REPL, by pressing Enter
 * again — which is why this returns immediately with a stop handle.
 *
 * The samples come down a pipe rather than into a wav on disk. There is no
 * header to finalise, so stopping doesn't have to wait for the capture device
 * to shut down politely, which measured at 1.2s on this machine — 1.2s that
 * sat between Yousef finishing a sentence and anything happening at all.
 */
export function startRecording(device: string, opts: ListenOptions = {}): Recorder {
  const spawn = opts.spawn ?? realSpawn;
  const ffmpeg = opts.ffmpeg ?? "ffmpeg";
  const chunks: Buffer[] = [];

  const proc: ChildProcess = spawn(ffmpeg, captureArgs(device), {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let listening: () => void;
  const ready = new Promise<void>((resolve) => (listening = resolve));

  proc.stdout?.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    listening();
  });
  // A mic that won't open is the caller's problem to report, not a crash. It
  // must not leave the caller waiting on a device that is never going to open.
  proc.on("error", () => listening());
  proc.on("close", () => listening());

  // The pipe closing means every sample has arrived. Waiting on the process
  // instead would mean waiting out the device teardown too, which is the 1.2s
  // this whole arrangement exists to avoid.
  const drained = new Promise<void>((resolve) => {
    if (proc.stdout) proc.stdout.on("end", () => resolve());
    else resolve();
  });

  return {
    ready,
    async stop() {
      // 'q' asks ffmpeg to flush what it's holding, and it gets a short window
      // to do it. Then it's killed rather than waited on.
      //
      // The window is short because node is draining the pipe the whole time
      // it's recording, so what's still in flight at this point is a few
      // milliseconds of audio, not a buffer's worth. This used to be 250ms and
      // it was 250ms of nothing happening on every single utterance.
      proc.stdin?.write("q");
      proc.stdin?.end();
      await Promise.race([
        drained,
        new Promise((r) => setTimeout(r, 80).unref?.()),
      ]);
      proc.kill();
      return Buffer.concat(chunks);
    },
  };
}

export interface Mic {
  /** Resolves once samples are actually arriving. See Recorder.ready. */
  ready: Promise<void>;
  close: () => void;
}

/**
 * Hold the microphone open and hand every chunk to `onAudio` as it lands.
 *
 * The push-to-talk recorder above collects the whole utterance and gives it
 * back at the end, because it knows when the end is: he pressed Enter. Nothing
 * tells the wake word when he stopped talking, so it has to hear the room as
 * it happens and work that out itself.
 *
 * Chunks arrive at whatever size the pipe hands over — this does no framing.
 * The segmenter in wake.ts does, because it is the thing that cares.
 */
export function openMic(
  device: string,
  opts: {
    onAudio: (pcm: Buffer) => void;
    /** The capture ended on its own: device unplugged, ffmpeg died. */
    onEnd?: (why: string) => void;
    ffmpeg?: string;
    spawn?: Spawner;
  },
): Mic {
  const spawn = opts.spawn ?? realSpawn;
  const proc: ChildProcess = spawn(opts.ffmpeg ?? "ffmpeg", captureArgs(device), {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let listening: () => void;
  const ready = new Promise<void>((resolve) => (listening = resolve));

  let closed = false;
  /**
   * The end is reported once, whoever gets there first. A device that is
   * pulled out fires both 'error' and 'close', and a caller that reopens on
   * each of them opens two microphones.
   */
  const ended = (why: string) => {
    if (closed) return;
    closed = true;
    listening();
    opts.onEnd?.(why);
  };

  proc.stdout?.on("data", (chunk: Buffer) => {
    listening();
    opts.onAudio(chunk);
  });
  proc.on("error", (err: Error) => ended(err.message));
  proc.on("close", () => ended("the capture stopped"));

  return {
    ready,
    close() {
      // Deliberately not reported as an end: the caller asked for this, and a
      // wake listener that reopens on its own shutdown never shuts down.
      closed = true;
      listening?.();
      proc.stdin?.end();
      proc.kill();
    },
  };
}

/** Loudness of a capture, in dBFS. -Infinity for digital silence. */
export function levelDb(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (!n) return -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  return rms <= 0 ? -Infinity : 20 * Math.log10(rms / 32768);
}

/**
 * Lift a quiet capture towards full scale before whisper sees it.
 *
 * Measured on this machine, speech comes off the microphone array at about
 * -49 dBFS RMS and peaks around -28. That is roughly a hundredth of the level
 * whisper is trained on, and it leaves the decoder working near its floor,
 * which is exactly where a mishearing comes from.
 *
 * Only ever gains up, never attenuates, and the ceiling on the gain stops a
 * recording of an empty room being amplified into something that sounds like
 * speech.
 */
export function normalise(pcm: Buffer, targetPeakDb = -3, maxGain = 12): Buffer {
  const n = Math.floor(pcm.length / 2);
  if (!n) return pcm;

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i * 2)));
  if (peak === 0) return pcm;

  const target = 32768 * 10 ** (targetPeakDb / 20);
  const gain = Math.min(maxGain, target / peak);
  if (gain <= 1) return pcm;

  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const scaled = Math.round(pcm.readInt16LE(i * 2) * gain);
    // Clamp rather than wrap: a wrapped sample is a click, and enough of them
    // read as noise.
    out.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i * 2);
  }
  return out;
}

/**
 * Wrap raw samples in a RIFF header. Only the whisper CLI needs this — the
 * worker takes the samples as they are — but the CLI is the fallback when the
 * worker can't start, and it will only read a real file.
 */
export function wavFromPcm(pcm: Buffer, rate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);        // fmt chunk length
  header.writeUInt16LE(1, 20);         // PCM, uncompressed
  header.writeUInt16LE(1, 22);         // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);  // bytes per second
  header.writeUInt16LE(2, 32);         // bytes per frame
  header.writeUInt16LE(16, 34);        // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * How sure the decoder was that it was decoding speech.
 *
 * `silence` is whisper's own probability that the audio was nothing at all;
 * `logprob` is how likely it thought the words it picked were. Both are
 * absent on the CLI path, which does not report them.
 */
export interface Heard {
  text: string;
  silence?: number;
  logprob?: number;
}

/**
 * The bar an utterance has to clear to be treated as something he said.
 *
 * faster-whisper's own convention is that `no_speech_prob` over 0.6 is
 * silence. This sits tighter, because the two failures are not symmetric: a
 * dropped utterance costs him saying it again, and a hallucinated one costs a
 * wake word firing on a sentence nobody spoke. Move it with VELA_SILENCE.
 */
export const MAX_SILENCE = 0.5;

/**
 * And how badly it was allowed to doubt the words themselves.
 *
 * Real close-mic speech through base.en sits around -0.3 to -0.5. Invented
 * text runs well below that, because there was never any audio agreeing with
 * it. -1.0 is loose on purpose: this is the second gate, not the first, and
 * accented or quiet real speech should still get through.
 */
export const MIN_LOGPROB = -1.0;

/**
 * Three of the same word and nothing else is a decoder, not a person.
 *
 * Two is a real thing to say — "no, no" — so the bar sits above it.
 */
export const MAX_REPEAT = 3;

/**
 * Was that speech, or was it whisper filling silence?
 *
 * cleanTranscript catches the hallucinations whisper repeats — "You.", "Thank
 * you.", "[BLANK_AUDIO]" — by name, and that list is exact-match by nature. It
 * cannot catch a novel one. These two numbers can, because they describe the
 * audio rather than the words, and room tone scores badly whatever sentence it
 * gets turned into.
 */
export interface Limits {
  maxSilence?: number;
  minLogprob?: number;
  /**
   * How many times one word may repeat before it stops being speech.
   *
   * The two numbers above describe the audio, which is what makes them work on
   * a sentence nobody has seen before. They do not catch the failure a *prompt*
   * causes: primed with a rare word, the decoder reaches for it when it is
   * guessing, and what comes back is that word several times over. "Vela. Vela.
   * Vela. Vela." came out of a film soundtrack this way and read as confident,
   * because the decoder was confident — it was repeating something it had been
   * handed rather than inventing it.
   *
   * Nobody says the same word four times in a row to a microphone. 0 is off.
   */
  maxRepeat?: number;
}

/** What may be decided for one utterance rather than for the whole worker. */
export interface HearOptions extends Limits {
  /**
   * The decoder's prior for this utterance. "" is no prior at all.
   *
   * Biasing towards his own vocabulary is worth 2.5 points of word error when
   * he has definitely spoken. It is the opposite when the caller is guessing
   * that anyone spoke: whisper handed room tone and primed with her name gives
   * back her name, and a sentence carrying it cannot be told from an address.
   */
  vocabulary?: string;
}

/**
 * Limits that let everything through.
 *
 * Push-to-talk is a promise that speech happened: he pressed a key and spoke
 * into it. The wake word has no such promise — it is guessing from loudness
 * alone, which is why it needs the bar at all. Judging a held key by the same
 * standard would throw away the quiet real sentence it exists to catch.
 */
export const HEARD_ANYTHING: Limits = { maxSilence: 1, minLogprob: -Infinity, maxRepeat: 0 };

/**
 * Decode with no prior, and hold what comes back to the strict bar.
 *
 * What an open microphone should ask for. It cannot promise anyone spoke, so it
 * gets neither the benefit of the doubt nor the words that would flatter it.
 */
export const UNPROMPTED: HearOptions = { vocabulary: "" };

/**
 * What an open microphone should ask for, given the prior it has been allowed.
 *
 * Empty is UNPROMPTED and stays the default, because priming a decoder with a
 * rare word makes it produce that word out of room tone. The exception is a
 * decoder that cannot produce the word at all: base.en never learned the name,
 * so it returns the nearest English it knows — panel, Madam, Zeno — while the
 * ordinary words around it decode cleanly. A prior of the name by itself is
 * the narrowest thing that fixes that, and the strict bar still judges what
 * comes back.
 */
export const wakePrior = (vocabulary: string): HearOptions =>
  vocabulary ? { vocabulary } : UNPROMPTED;

/**
 * Is this one word, said over and over, and nothing else?
 *
 * Only when the whole transcript is that word: "go, go, go" is a real thing to
 * say, and so is a sentence that happens to repeat one. What this catches is a
 * transcript with no other content, which is what a decoder produces when it
 * is echoing its own prior rather than reading audio.
 */
export function isStutter(text: string, most: number): boolean {
  if (most <= 0) return false;
  const words = [...text.toLowerCase().matchAll(/[a-z0-9']+/g)].map((m) => m[0]);
  if (words.length < most) return false;
  return new Set(words).size === 1;
}

export function saidSomething(heard: Heard, limits: Limits = {}): boolean {
  if (!heard.text) return false;
  const maxSilence = limits.maxSilence ?? MAX_SILENCE;
  const minLogprob = limits.minLogprob ?? MIN_LOGPROB;
  // Absent means the CLI path, which reports neither. Missing evidence is not
  // evidence of silence: let it through and leave it to cleanTranscript.
  if (heard.silence !== undefined && heard.silence > maxSilence) return false;
  if (heard.logprob !== undefined && heard.logprob < minLogprob) return false;
  // Last, because it judges the words rather than the audio, and a confident
  // repetition is exactly what the two numbers above cannot see.
  if (isStutter(heard.text, limits.maxRepeat ?? MAX_REPEAT)) return false;
  return true;
}

export interface Transcriber {
  /**
   * Raw 16 kHz mono samples in, what was said out.
   *
   * `limits` overrides the bar for this utterance alone, because one
   * transcriber serves both a held key and an open microphone and those two
   * deserve different answers. See HEARD_ANYTHING.
   */
  hear: (pcm: Buffer, over?: HearOptions) => Promise<string>;
  /**
   * Start loading the model now, if it isn't already.
   *
   * Only means anything to a lazy one. The hub calls it when recording
   * starts, so the load happens while he is still talking rather than after
   * he stops.
   */
  warm: () => void;
  stop: () => void;
}

/**
 * Whisper, kept warm.
 *
 * The CLI reloads the model on every utterance. Measured on this machine that
 * is 1.4s for a few seconds of speech against 0.4s once the model is resident,
 * and the second number doesn't drift with the size of the model.
 *
 * Same protocol as the Kokoro worker: one JSON request per line, one status
 * line back, in order.
 */
export function createTranscriber(opts: {
  python: string;
  worker: string;
  model?: string;
  computeDevice?: string;
  /** Words to bias the decoder towards; see WHISPER_VOCABULARY. */
  vocabulary?: string;
  /**
   * Hold the model load until the first utterance.
   *
   * The terminal wants it eager: he presses Enter and talks, and the 1.4s
   * would land in the middle of that. A service running from boot wants the
   * opposite, because most days nothing is ever said into the hub and an
   * idle 226MB is the whole cost of her being always-on. Warm either way
   * once it has started.
   */
  lazy?: boolean;
  /** How sure of silence whisper has to be before this is thrown away. */
  maxSilence?: number;
  /** How badly it may doubt its own words. See saidSomething. */
  minLogprob?: number;
  /**
   * An utterance thrown away for scoring as silence.
   *
   * A dropped transcript and an empty one are the same "" to the caller, and
   * the bar cannot be tuned against a decision nobody can see. Diagnostics.
   */
  onDropped?: (heard: Heard) => void;
  /**
   * An utterance that cleared the bar, with the numbers it cleared it by.
   *
   * The mirror of onDropped, and missing for longer than it should have been.
   * A rejection printed its score and an acceptance printed nothing, so the
   * only wakes anyone could reason about were the ones that did not happen —
   * and a false wake, the one failure that matters here, is by definition an
   * acceptance. Diagnostics.
   */
  onKept?: (heard: Heard) => void;
  onProblem?: (why: string) => void;
  spawn?: Spawner;
}): Transcriber {
  const spawn = opts.spawn ?? realSpawn;
  const dir = mkdtempSync(join(tmpdir(), "vela-heard-"));
  let stopped = false;
  let n = 0;

  let complained = false;
  const complain = (why: string) => {
    if (complained) return;
    complained = true;
    opts.onProblem?.(why);
  };

  const waiting: ((line: string) => void)[] = [];

  /** The worker, started at most once. */
  let worker: ChildProcess | null = null;
  const ensureWorker = (): ChildProcess => {
    if (worker) return worker;
    const started = spawn(
      opts.python,
      [
        opts.worker,
        opts.model ?? "base.en",
        opts.computeDevice ?? "cpu",
        opts.vocabulary ?? "",
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
    );
    started.on("error", (err) => complain(`couldn't start whisper: ${err.message}`));

    let buffered = "";
    started.stdout?.setEncoding("utf8");
    started.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const cut = buffered.indexOf("\n");
        if (cut < 0) break;
        const line = buffered.slice(0, cut).trim();
        buffered = buffered.slice(cut + 1);
        // The loader prints its own warnings to stdout; only the protocol counts.
        if (!line.startsWith("ok ") && !line.startsWith("err ")) continue;
        waiting.shift()?.(line);
      }
    });

    worker = started;
    return started;
  };

  if (!opts.lazy) ensureWorker();

  return {
    async hear(pcm: Buffer, over?: HearOptions) {
      // The worker's settings are the default and the caller's win, so a caller
      // that speaks to only one of them does not silently drop the others.
      const eff = { ...opts, ...over };
      if (stopped || !pcm.length) return "";
      const live = ensureWorker();
      if (!live.stdin?.writable) return "";
      const file = join(dir, `${n++}.pcm`);
      writeFileSync(file, normalise(pcm));

      const status = await new Promise<string>((done) => {
        waiting.push(done);
        live.stdin!.write(
          `${JSON.stringify({
            pcm: file,
            rate: SAMPLE_RATE,
            // Sent only when a caller decided it, so the worker keeps its own.
            ...(over?.vocabulary === undefined ? {} : { prompt: over.vocabulary }),
          })}\n`,
        );
        setTimeout(() => done("err timed out"), 120_000).unref?.();
      });
      rmSync(file, { force: true });

      if (!status.startsWith("ok ")) {
        complain(`whisper failed: ${status.replace(/^err /, "")}`);
        return "";
      }
      try {
        // JSON, because speech has quotes and newlines in it.
        const said = JSON.parse(status.slice(3)) as Heard;
        const text = cleanTranscript(said.text ?? "");
        // Weighed after cleaning, so the confidence numbers are judged against
        // the text that would actually have become a turn.
        const weighed: Heard = { ...said, text };
        if (!saidSomething(weighed, eff)) {
          if (text) opts.onDropped?.(weighed);
          return "";
        }
        if (text) opts.onKept?.(weighed);
        return text;
      } catch {
        complain("whisper sent back something that isn't JSON");
        return "";
      }
    },

    warm() {
      if (!stopped) ensureWorker();
    },

    stop() {
      stopped = true;
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

/**
 * The same thing through the CLI — a process and a model load per utterance.
 * Kept as the fallback for when the worker's Python isn't on this machine.
 */
export function cliTranscriber(opts: ListenOptions = {}): Transcriber {
  const dir = mkdtempSync(join(tmpdir(), "vela-heard-"));
  let n = 0;
  return {
    async hear(pcm: Buffer, _over?: HearOptions) {
      if (!pcm.length) return "";
      const wav = join(dir, `${n++}.wav`);
      writeFileSync(wav, wavFromPcm(normalise(pcm)));
      try {
        return await transcribe(wav, opts);
      } finally {
        rmSync(wav, { force: true });
      }
    },
    // Nothing to keep warm: this path loads the model per utterance, which is
    // the whole reason the worker above exists.
    warm() {},
    stop() {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    },
  };
}

export async function transcribe(wav: string, opts: ListenOptions = {}): Promise<string> {
  const run = opts.run ?? realRun;
  const whisper = opts.whisper ?? "whisper-ctranslate2";
  const dir = join(wav, "..");
  await run(
    whisper,
    [
      wav,
      "--model", opts.model ?? "base.en",
      "--device", opts.computeDevice ?? "cpu",
      "--language", "en",
      "--output_format", "txt",
      "--output_dir", dir,
      "--verbose", "False",
    ],
    { timeout: 120_000, windowsHide: true },
  );
  const txt = join(dir, `${basename(wav, ".wav")}.txt`);
  if (!existsSync(txt)) return "";
  return cleanTranscript(readFileSync(txt, "utf8"));
}

/**
 * Whatever the browser recorded, as the samples whisper wants.
 *
 * MediaRecorder hands back webm/opus, and the warm worker takes raw 16 kHz
 * mono. ffmpeg is already a dependency for capture, so it does the conversion
 * rather than pulling in a decoder.
 */
export function pcmFromAudio(
  audio: Buffer,
  opts: { ffmpeg?: string; spawn?: Spawner } = {},
): Promise<Buffer> {
  const run = opts.spawn ?? realSpawn;
  return new Promise((fulfil) => {
    const ff = run(
      opts.ffmpeg ?? "ffmpeg",
      [
        "-loglevel", "quiet",
        "-i", "pipe:0",
        "-f", "s16le",
        "-ar", String(SAMPLE_RATE),
        "-ac", "1",
        "pipe:1",
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
    );

    const chunks: Buffer[] = [];
    ff.stdout?.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
    // A conversion that fails is silence, which the caller reports as "didn't
    // catch that" rather than as a stack trace in the browser.
    ff.on("error", () => fulfil(Buffer.alloc(0)));
    ff.on("close", () => fulfil(Buffer.concat(chunks)));
    ff.stdin?.on("error", () => {});
    ff.stdin?.end(audio);
  });
}
