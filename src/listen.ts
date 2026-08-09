import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, rmSync, mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

/**
 * Push-to-talk. ffmpeg captures the microphone, whisper turns it into text,
 * and the text goes into the same turn queue a typed line would.
 *
 * Deliberately not a wake word. "Hey Vela" means training a model on synthetic
 * speech, and it's worth proving the loop feels good before paying for that.
 */

const run = promisify(execFile);

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
}

/**
 * Find ffmpeg. winget installs it and adds a PATH entry, but existing shells —
 * and anything launched from them — don't see it until they restart, which
 * turns "push-to-talk does nothing" into a mystery. Look where winget puts it.
 */
export function resolveFfmpeg(explicit?: string): string | null {
  if (explicit) return existsSync(explicit) || !explicit.includes("\\") ? explicit : null;

  const local = process.env.LOCALAPPDATA ?? "";
  const link = join(local, "Microsoft", "WinGet", "Links", "ffmpeg.exe");
  if (existsSync(link)) return link;

  const packages = join(local, "Microsoft", "WinGet", "Packages");
  try {
    for (const entry of readdirSync(packages)) {
      if (!/ffmpeg/i.test(entry)) continue;
      const root = join(packages, entry);
      for (const build of readdirSync(root)) {
        const exe = join(root, build, "bin", "ffmpeg.exe");
        if (existsSync(exe)) return exe;
      }
    }
  } catch {
    /* no winget packages directory */
  }
  return null;
}

export async function audioDevices(ffmpeg = "ffmpeg"): Promise<string[]> {
  // The device list always goes to stderr, but whether ffmpeg then exits zero
  // depends on the version — 9.0 succeeds, older ones fail on the dummy input.
  // Read stderr either way.
  const args = ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"];
  try {
    const { stderr } = await run(ffmpeg, args);
    return parseAudioDevices(stderr);
  } catch (err) {
    return parseAudioDevices((err as { stderr?: string }).stderr ?? "");
  }
}

export interface Recorder {
  /** Stop capturing and hand back what was said. Empty string if nothing was. */
  stop: () => Promise<string>;
}

/**
 * Start recording now. The caller stops it — in the REPL, by pressing Enter
 * again — which is why this returns immediately with a stop handle.
 */
export function startRecording(device: string, opts: ListenOptions = {}): Recorder {
  const dir = mkdtempSync(join(tmpdir(), "vela-listen-"));
  const wav = join(dir, "take.wav");
  const ffmpeg = opts.ffmpeg ?? "ffmpeg";

  const proc: ChildProcess = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "dshow",
      "-i", `audio=${device}`,
      "-ac", "1",        // whisper wants mono
      "-ar", "16000",    // at 16 kHz
      "-y", wav,
    ],
    { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] },
  );

  const finished = new Promise<void>((resolve) => proc.on("close", () => resolve()));

  return {
    async stop() {
      try {
        // 'q' is ffmpeg's graceful quit; killing it truncates the file header.
        proc.stdin?.write("q");
        proc.stdin?.end();
        await Promise.race([
          finished,
          new Promise((r) => setTimeout(r, 3000).unref?.()),
        ]);
        if (!existsSync(wav)) return "";
        return await transcribe(wav, opts);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export async function transcribe(wav: string, opts: ListenOptions = {}): Promise<string> {
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
