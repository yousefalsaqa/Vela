import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChildProcess } from "node:child_process";
import { spawn as realSpawn, type Spawner } from "./proc.js";
import type { VoiceRow } from "./memory.js";

/**
 * Who is talking, by the sound of them.
 *
 * Every utterance the wake word's gate cuts out of the room is turned into a
 * voiceprint (scripts/voice_worker.py) while whisper reads it, so knowing who
 * said it costs no wait. A print is a direction: one person's prints point
 * the same way, two people's do not, and the cosine between them is the whole
 * comparison. Everything that decides anything — what counts as the same
 * person, what counts as someone new, what gets saved — lives here, as plain
 * functions over numbers, so it can be tested without a model.
 *
 * The numbers below were measured, not chosen: TitaNet-small against a print
 * averaged from two clips, on real speech from five people. The right person
 * scored a median 0.56 on one second of speech and 0.73 on two and a half;
 * the best-scoring wrong person never passed 0.40. See README, "Voices".
 */
export type Print = number[];

export interface Limits {
  /** At least this close to a saved print, it is that person. */
  sure: number;
  /** And ahead of the next-closest person by this much, or it is a toss-up. */
  margin: number;
  /** Further than this from everyone, it is someone she has not met. */
  stranger: number;
  /**
   * Seconds of voice before she will call anyone a stranger. Below it the
   * print is too noisy to be sure of a negative: at one second of speech, one
   * in twenty-five of his own utterances fell under the stranger line.
   */
  minSpeech: number;
}

export const LIMITS: Limits = { sure: 0.45, margin: 0.08, stranger: 0.3, minSpeech: 1.5 };

/**
 * What she made of a voice.
 *
 *   known   — someone she has a print for, clearly.
 *   new     — enough voice to be sure it is nobody she knows.
 *   unsure  — too short, too far from everyone to be them, too close to call
 *             a stranger, or two people too close to tell apart. She says
 *             nothing about who it was, which is the same as before voices.
 */
export type Identity =
  | { kind: "known"; name: string; score: number; speech: number }
  | { kind: "new"; score: number; speech: number; print?: Print }
  | { kind: "unsure"; score: number; speech: number; nearest?: string };

/** Scaled to length one, so the cosine between two is a dot product. */
export function unit(v: Print): Print {
  const n = Math.hypot(...v);
  return n > 0 ? v.map((x) => x / n) : v.map(() => 0);
}

export function cosine(a: Print, b: Print): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / ((Math.hypot(...a) || 1) * (Math.hypot(...b) || 1));
}

/**
 * The average direction of several prints, each counted `weight` times.
 *
 * Averaged as unit vectors, so a loud utterance does not count for more than
 * a quiet one: loudness is the microphone, not the person.
 */
export function blend(prints: { print: Print; weight?: number }[]): Print {
  if (!prints.length) return [];
  const sum = new Array<number>(prints[0].print.length).fill(0);
  for (const { print, weight = 1 } of prints) {
    const u = unit(print);
    for (let i = 0; i < sum.length; i++) sum[i] += u[i] * weight;
  }
  return unit(sum);
}

/** Who this print is, against everyone she knows. */
export function identify(
  print: Print | null,
  speech: number,
  known: VoiceRow[],
  limits: Limits = LIMITS,
): Identity {
  if (!print) return { kind: "unsure", score: 0, speech };
  const scored = known
    .map((k) => ({ name: k.name, score: cosine(print, k.print) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const next = scored[1]?.score ?? -1;
  if (best && best.score >= limits.sure && best.score - next >= limits.margin) {
    return { kind: "known", name: best.name, score: best.score, speech };
  }
  const score = best?.score ?? 0;
  if (score < limits.stranger && speech >= limits.minSpeech) return { kind: "new", score, speech };
  return { kind: "unsure", score, speech, ...(best ? { nearest: best.name } : {}) };
}

/**
 * What a spoken turn is prefixed with, for her.
 *
 * Nothing when she is unsure. An "unsure" tag would have her hedging about
 * who she is talking to on every short sentence he says, and the default she
 * already has — it is him — is right far more often than not.
 */
export function voiceTag(who: Identity | null): string {
  if (!who) return "";
  if (who.kind === "known") return `[Voice: ${who.name}]`;
  if (who.kind === "new") return "[Voice: new, not one you know]";
  return "";
}

/** "Yousef 0.62", "new 0.18", "unsure 0.38, 0.9s": the log's half of it. */
export function describe(who: Identity | null): string {
  if (!who) return "voice unknown";
  const score = who.score.toFixed(2);
  if (who.kind === "known") return `${who.name} ${score}`;
  if (who.kind === "new") return `new voice ${score}`;
  return `voice unsure ${score}${who.nearest ? ` ~${who.nearest}` : ""}, ${who.speech.toFixed(1)}s`;
}

/** What the worker hands back for one utterance. */
export interface Heard {
  print: Print | null;
  speech: number;
}

/** Where saved prints live. The store in memory.ts, or a fake in a test. */
export interface VoiceStore {
  listVoices: () => VoiceRow[];
  saveVoice: (name: string, print: Print, samples: number) => void;
  forgetVoice: (name: string) => boolean;
}

/**
 * How many utterances a saved print stays the average of, at most.
 *
 * A print made from the two or three sentences of an introduction is a rough
 * one, and it gets better every time she is sure it is him: each confident
 * match is folded in. Capped, so the newest always counts for a thirtieth at
 * least — his microphone, his room and his cold all move, and a print that
 * had stopped listening would drift out from under him.
 */
export const MAX_SAMPLES = 30;
/** Folded in only when this sure, and on this much voice. */
const REFINE_AT = 0.55;
const REFINE_SPEECH = 2;
/** How long an unsaved stranger's voice is kept, waiting on a yes. */
const PENDING_MS = 10 * 60_000;

export interface Voices {
  /** Who said this. Never throws: a failure is "unsure", which is no change. */
  listen: (pcm: Buffer) => Promise<Identity>;
  /**
   * This stranger was speaking to her, so theirs is a voice she may be asked
   * to save. Only these: everything the microphone hears is listened to, and
   * the television is a stranger too.
   */
  met: (who: Identity | null) => void;
  /** Save the voice she has just been talking to under a name. A sentence for the model. */
  remember: (name: string) => string;
  /** Forget a saved voice. A sentence for the model. */
  forget: (name: string) => string;
  /** Everyone she knows by voice. */
  names: () => string[];
}

/**
 * The voices she knows, and the one she is about to.
 *
 * A stranger's prints are held, not saved, until they say yes. remember()
 * saves only what was heard as new, only what sounds like one person, and
 * refuses to put a voice under a name that already belongs to a different
 * one — so "I'm Yousef" from someone else cannot overwrite him.
 */
export function createVoices(opts: {
  print: (pcm: Buffer) => Promise<Heard | null>;
  store: VoiceStore;
  limits?: Limits;
  now?: () => number;
}): Voices {
  const limits = opts.limits ?? LIMITS;
  const now = opts.now ?? Date.now;
  let pending: { print: Print; speech: number; at: number }[] = [];

  const fresh = () => {
    const t = now();
    pending = pending.filter((p) => t - p.at <= PENDING_MS);
    return pending;
  };

  return {
    async listen(pcm) {
      const heard = await opts.print(pcm).catch(() => null);
      if (!heard) return { kind: "unsure", score: 0, speech: 0 };
      const known = opts.store.listVoices();
      const who = identify(heard.print, heard.speech, known, limits);
      if (heard.print && who.kind === "new") return { ...who, print: heard.print };
      if (heard.print && who.kind === "known" && who.score >= REFINE_AT && heard.speech >= REFINE_SPEECH) {
        const row = known.find((k) => k.name === who.name);
        if (row) {
          const samples = Math.min(row.samples, MAX_SAMPLES - 1);
          opts.store.saveVoice(
            row.name,
            blend([
              { print: row.print, weight: samples },
              { print: heard.print, weight: 1 },
            ]),
            samples + 1,
          );
        }
      }
      return who;
    },

    met(who) {
      if (who?.kind === "new" && who.print) fresh().push({ print: who.print, speech: who.speech, at: now() });
    },

    remember(name) {
      const clean = name.trim();
      if (!clean) return "No name given. Ask them what to call them.";
      const heard = fresh();
      if (!heard.length) {
        return (
          "There is no new voice from this conversation to save. Ask them to say a sentence " +
          "or two to you first, then save it."
        );
      }
      // The latest stranger is the one she is talking to; earlier ones that
      // sound like them are them too, and anyone else is someone else.
      const anchor = heard[heard.length - 1].print;
      const theirs = heard.filter((p) => cosine(p.print, anchor) >= limits.sure);
      const print = blend(theirs.map((p) => ({ print: p.print, weight: p.speech })));
      const known = opts.store.listVoices();

      // A name that is taken stays taken. Only a voice far from everyone she
      // knows is ever pending, so a pending voice under a saved name is by
      // definition not the voice saved there: someone else saying "I'm
      // Yousef", or him unrecognisable today. Neither should overwrite him.
      // His own print keeps up with him through refinement instead.
      const already = known.find((k) => k.name.toLowerCase() === clean.toLowerCase());
      if (already) {
        return (
          `Not saved: that voice does not match the ${already.name} I already know ` +
          `(${cosine(print, already.print).toFixed(2)}). Tell them you don't recognise it as ${already.name}.`
        );
      }

      const sameAs = known.find((k) => cosine(print, k.print) >= limits.sure);
      if (sameAs) {
        return `Not saved: that voice is already saved as ${sameAs.name}.`;
      }
      opts.store.saveVoice(clean, print, theirs.length);
      pending = heard.filter((p) => !theirs.includes(p));
      return `Saved ${clean}'s voiceprint. You will know them by voice from now on.`;
    },

    forget(name) {
      return opts.store.forgetVoice(name.trim())
        ? `Forgot ${name.trim()}'s voice.`
        : `No saved voice called ${name.trim()}.`;
    },

    names: () => opts.store.listVoices().map((v) => v.name),
  };
}

/**
 * The worker, resident. See scripts/voice_worker.py.
 *
 * Requests carry an id and replies echo it, so each reply finds its own
 * utterance whatever happened to the ones around it. A reply that never comes
 * costs that one utterance, after the timeout, and nothing else.
 */
export function openVoiceprinter(opts: {
  python: string;
  worker: string;
  model: string;
  onProblem?: (why: string) => void;
  spawn?: Spawner;
  timeoutMs?: number;
}): { ready: Promise<boolean>; print: (pcm: Buffer) => Promise<Heard | null>; stop: () => void } {
  const spawn = opts.spawn ?? realSpawn;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const dir = mkdtempSync(join(tmpdir(), "vela-voice-"));
  const waiting = new Map<number, (heard: Heard | null) => void>();
  let next = 0;
  let stopped = false;
  let settle: ((up: boolean) => void) | null = null;
  const ready = new Promise<boolean>((resolve) => (settle = resolve));
  const up = (ok: boolean) => {
    settle?.(ok);
    settle = null;
  };

  const child: ChildProcess = spawn(opts.python, [opts.worker, opts.model], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  let rest = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    rest += chunk.toString("utf8");
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (line === "ready") up(true);
      else if (line.startsWith("ok ") || line.startsWith("err ")) {
        let body: { id?: number; print?: Print | null; speech?: number; error?: string };
        try {
          body = JSON.parse(line.slice(line.indexOf(" ") + 1));
        } catch {
          // Startup noise ("err warm-up failed: ...") carries no id.
          opts.onProblem?.(line.slice(line.indexOf(" ") + 1));
          continue;
        }
        const done = typeof body.id === "number" ? waiting.get(body.id) : undefined;
        if (!done) continue;
        waiting.delete(body.id!);
        if (line.startsWith("err ")) {
          opts.onProblem?.(body.error ?? "the voice worker failed on an utterance");
          done(null);
        } else done({ print: body.print ?? null, speech: body.speech ?? 0 });
      }
    }
  });
  child.on("error", (err) => {
    up(false);
    opts.onProblem?.(`couldn't run the voice worker: ${err.message}`);
  });
  child.on("close", () => {
    up(false);
    for (const done of waiting.values()) done(null);
    waiting.clear();
    if (!stopped) opts.onProblem?.("the voice worker stopped");
  });
  child.stdin?.on("error", () => {});

  return {
    ready,
    print(pcm) {
      if (stopped || !pcm.length || !child.stdin?.writable) return Promise.resolve(null);
      const id = next++;
      const file = join(dir, `${id}.pcm`);
      writeFileSync(file, pcm);
      return new Promise<Heard | null>((resolve) => {
        const finish = (heard: Heard | null) => {
          clearTimeout(timer);
          rmSync(file, { force: true });
          resolve(heard);
        };
        const timer = setTimeout(() => {
          waiting.delete(id);
          finish(null);
        }, timeoutMs);
        timer.unref?.();
        waiting.set(id, finish);
        child.stdin!.write(`${JSON.stringify({ id, pcm: file })}\n`);
      });
    },
    stop() {
      stopped = true;
      for (const done of waiting.values()) done(null);
      waiting.clear();
      child.stdin?.end();
      child.kill();
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* the OS will get it */
      }
    },
  };
}

/**
 * The voices the tools reach. Module state as the bus, like screen.ts and
 * work.ts: the tool and the service that owns the microphone share a process.
 * Null until the service has a microphone and a model to hear voices with.
 */
let live: Voices | null = null;
export function useVoices(voices: Voices | null): void {
  live = voices;
}
export function voices(): Voices | null {
  return live;
}
