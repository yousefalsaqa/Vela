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
 * Deliberately not a wake word. "Hey Vela" means training a model on synthetic
 * speech, and it's worth proving the loop feels good before paying for that.
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

  const proc: ChildProcess = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "dshow",
      "-i", `audio=${device}`,
      "-ac", "1",                    // whisper wants mono
      "-ar", String(SAMPLE_RATE),    // at 16 kHz
      "-f", "s16le", "pipe:1",       // raw, straight down stdout
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );

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

export interface Transcriber {
  /** Raw 16 kHz mono samples in, what was said out. */
  hear: (pcm: Buffer) => Promise<string>;
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

  const worker = spawn(
    opts.python,
    [
      opts.worker,
      opts.model ?? "base.en",
      opts.computeDevice ?? "cpu",
      opts.vocabulary ?? "",
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  worker.on("error", (err) => complain(`couldn't start whisper: ${err.message}`));

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
      // The loader prints its own warnings to stdout; only the protocol counts.
      if (!line.startsWith("ok ") && !line.startsWith("err ")) continue;
      waiting.shift()?.(line);
    }
  });

  return {
    async hear(pcm: Buffer) {
      if (stopped || !pcm.length || !worker.stdin?.writable) return "";
      const file = join(dir, `${n++}.pcm`);
      writeFileSync(file, normalise(pcm));

      const status = await new Promise<string>((done) => {
        waiting.push(done);
        worker.stdin!.write(`${JSON.stringify({ pcm: file, rate: SAMPLE_RATE })}\n`);
        setTimeout(() => done("err timed out"), 120_000).unref?.();
      });
      rmSync(file, { force: true });

      if (!status.startsWith("ok ")) {
        complain(`whisper failed: ${status.replace(/^err /, "")}`);
        return "";
      }
      try {
        // JSON, because speech has quotes and newlines in it.
        return cleanTranscript(JSON.parse(status.slice(3)).text ?? "");
      } catch {
        complain("whisper sent back something that isn't JSON");
        return "";
      }
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

/**
 * The same thing through the CLI — a process and a model load per utterance.
 * Kept as the fallback for when the worker's Python isn't on this machine.
 */
export function cliTranscriber(opts: ListenOptions = {}): Transcriber {
  const dir = mkdtempSync(join(tmpdir(), "vela-heard-"));
  let n = 0;
  return {
    async hear(pcm: Buffer) {
      if (!pcm.length) return "";
      const wav = join(dir, `${n++}.wav`);
      writeFileSync(wav, wavFromPcm(normalise(pcm)));
      try {
        return await transcribe(wav, opts);
      } finally {
        rmSync(wav, { force: true });
      }
    },
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
