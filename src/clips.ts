import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { spawn as realSpawn, type Spawner } from "./proc.js";

/**
 * Her short lines, ready before anyone asks for them.
 *
 * What she says to her name used to go the way a reply goes: Kokoro renders
 * it, ffplay starts, the audio device opens. Each step is fine for a sentence
 * he is waiting on anyway, and all of them together put over a second between
 * the chime and her first word — which is the gap he heard, and the reason the
 * spoken acknowledgement was switched off in favour of the chime alone.
 *
 * So these are rendered once, kept as files under data/, and played by a
 * worker that does nothing else (scripts/clip_worker.py) through winsound, the
 * same way the chime is. A line that has a file plays in tens of milliseconds;
 * one that does not yet is reported as missing and the caller says it the
 * slow way, which only ever happens on the first start.
 */
export interface Clips {
  /** Resolves true once the worker is up and can play. */
  ready: Promise<boolean>;
  /**
   * Render whichever of these have no file yet, one at a time, in order. Lines
   * already on disk cost a stat. Resolves to how many it had to render.
   */
  prepare: (lines: string[]) => Promise<number>;
  /** Can this line be played right now, without rendering anything? */
  has: (line: string) => boolean;
  /**
   * Play it now. Returns how long it lasts in milliseconds, which is how long
   * the caller has to hold the microphone; null when it cannot be played.
   */
  play: (line: string) => number | null;
  /** Cut off whatever is playing. */
  stop: () => void;
  close: () => void;
}

/**
 * How long a wav lasts, from its header. Null for anything that is not one.
 *
 * Read from the format chunk rather than assumed, because the files outlive
 * the code that wrote them: a voice rendered at a different rate must not
 * hold the microphone for the wrong length of time.
 */
export function wavMs(wav: Buffer): number | null {
  if (wav.length < 12) return null;
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return null;
  let at = 12;
  let byteRate = 0;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "fmt " && at + 20 <= wav.length) byteRate = wav.readUInt32LE(at + 16);
    if (id === "data") {
      if (!byteRate) return null;
      // A header written before the length was known says more than is there.
      const bytes = Math.min(size, wav.length - at - 8);
      return Math.round((bytes / byteRate) * 1000);
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/**
 * The same wav with the silence cut off both ends.
 *
 * Kokoro pads every render: measured over all 27 of her lines, the first
 * sound is 211 to 261ms in. On a reply that hardly matters. On these it is a
 * quarter of a second of nothing between the chime and "Afternoon", on the
 * one path that exists to be instant, and the tail pads the time she holds
 * the microphone. A little of each end is kept, so a soft first consonant and
 * the decay of the last word are not clipped. 16-bit PCM only; anything else
 * comes back unchanged.
 */
export function trimSilence(wav: Buffer, keepHeadMs = 15, keepTailMs = 60, floor = 0.01): Buffer {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF") return wav;
  let at = 12;
  let fmt = -1;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    if (id === "fmt ") fmt = at;
    if (id === "data" && fmt >= 0) {
      const bits = wav.readUInt16LE(fmt + 22);
      const block = wav.readUInt16LE(fmt + 20);
      const rate = wav.readUInt32LE(fmt + 12);
      if (bits !== 16 || !block) return wav;
      const start = at + 8;
      const end = Math.min(start + size, wav.length);
      const frames = Math.floor((end - start) / block);
      const bar = floor * 32768;
      const loud = (i: number) => Math.abs(wav.readInt16LE(start + i * block)) > bar;
      let first = 0;
      while (first < frames && !loud(first)) first++;
      if (first === frames) return wav;
      let last = frames - 1;
      while (last > first && !loud(last)) last--;
      const from = Math.max(0, first - Math.round((keepHeadMs * rate) / 1000));
      const to = Math.min(frames, last + 1 + Math.round((keepTailMs * rate) / 1000));
      const body = wav.subarray(start + from * block, start + to * block);
      const head = Buffer.from(wav.subarray(0, start));
      head.writeUInt32LE(body.length, at + 4);
      head.writeUInt32LE(head.length - 8 + body.length, 4);
      return Buffer.concat([head, body]);
    }
    at += 8 + size + (size % 2);
  }
  return wav;
}

/**
 * The file a line lives in. Named for the words, so the folder is readable,
 * and for a hash of the voice and the words, so a change of either renders it
 * again instead of playing the old one.
 */
export function clipName(spoken: string, voice: string): string {
  const slug = spoken
    .toLowerCase()
    .replace(/\[[^\]]*\]\([^)]*\)/g, (m) => m.slice(1, m.indexOf("]")))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = createHash("sha1").update(`${voice}\n${spoken}`).digest("hex").slice(0, 8);
  return `${slug || "line"}-${hash}.wav`;
}

export function createClips(opts: {
  /** Where the rendered lines are kept. */
  dir: string;
  /** Her mouth: the words in, a wav out. */
  render: (spoken: string) => Promise<Buffer | null>;
  /**
   * What a line becomes before it is rendered: his name as phonemes, for
   * Kokoro. The files are keyed on this, not on the line as written.
   */
  speak?: (line: string) => string;
  /** Her voice and speed, as one string. Part of every file's name. */
  voice: string;
  python: string;
  worker: string;
  spawn?: Spawner;
  onProblem?: (why: string) => void;
}): Clips {
  const spawn = opts.spawn ?? realSpawn;
  const speak = opts.speak ?? ((line: string) => line);
  /** What is known to be on disk: the line as written, to its file and length. */
  const known = new Map<string, { path: string; ms: number }>();
  let stopped = false;

  const fileFor = (line: string) => join(opts.dir, clipName(speak(line), opts.voice));

  /** Learn about a file that is already there. False if it is not, or is not a wav. */
  const index = (line: string): boolean => {
    if (known.has(line)) return true;
    const path = fileFor(line);
    if (!existsSync(path)) return false;
    const ms = wavMs(readFileSync(path));
    if (ms === null) return false;
    known.set(line, { path, ms });
    return true;
  };

  let proc: ChildProcess | null = null;
  let settle: ((up: boolean) => void) | null = null;
  const ready = new Promise<boolean>((resolve) => (settle = resolve));
  const up = (ok: boolean) => {
    settle?.(ok);
    settle = null;
  };

  const child = spawn(opts.python, [opts.worker], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let rest = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    rest += chunk.toString("utf8");
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() ?? "";
    for (const line of lines) {
      const text = line.trim();
      if (text === "ready") up(true);
      else if (text.startsWith("err ")) opts.onProblem?.(text.slice(4));
    }
  });
  child.on("error", (err) => {
    proc = null;
    up(false);
    opts.onProblem?.(`couldn't start the clip player: ${err.message}`);
  });
  child.on("close", () => {
    proc = null;
    up(false);
    if (!stopped) opts.onProblem?.("the clip player stopped; her lines will be said the slow way");
  });
  child.stdin?.on("error", () => {});
  proc = child;

  return {
    ready,

    async prepare(lines) {
      mkdirSync(opts.dir, { recursive: true });
      let rendered = 0;
      for (const line of lines) {
        if (stopped) break;
        if (index(line)) continue;
        const wav = await opts.render(speak(line)).catch(() => null);
        if (!wav || wavMs(wav) === null) continue;
        writeFileSync(fileFor(line), trimSilence(wav));
        rendered++;
        index(line);
      }
      return rendered;
    },

    has: (line) => !stopped && proc !== null && index(line),

    play(line) {
      if (stopped || !proc?.stdin?.writable || !index(line)) return null;
      const clip = known.get(line)!;
      proc.stdin.write(`play ${clip.path}\n`);
      return clip.ms;
    },

    stop() {
      if (proc?.stdin?.writable) proc.stdin.write("stop\n");
    },

    close() {
      stopped = true;
      proc?.stdin?.end();
      proc?.kill();
      proc = null;
    },
  };
}
