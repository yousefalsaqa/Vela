import { levelDb, SAMPLE_RATE } from "./listen.js";
import type { Identity } from "./voices.js";

/**
 * Him talking over her, heard while she talks.
 *
 * She has always shut her ears while she speaks, because her own voice comes
 * back into the microphone as loud as his. With the echo taken out (see
 * src/echo.ts) what is left of her is under the room's hiss, so speech that
 * stands clear of it while she talks is someone else. That alone is not
 * enough: the TV talks, and the canceller's first half-second leaves a burst
 * of her behind. So a voice is checked against the prints she knows before it
 * is allowed to stop her, the way voices.ts already tells people apart.
 *
 * Everything said from just before he started is kept and handed over with
 * the stop, so the sentence he interrupted her with keeps its first words.
 */
export interface BargeWatcher {
  /** She has started talking: listen for him. */
  arm: () => void;
  /** She has stopped, or been stopped. */
  disarm: () => void;
  /** Cleaned microphone audio, all of it, armed or not: the room is learned from it. */
  push: (pcm: Buffer) => void;
  armed: () => boolean;
}

/**
 * Whether a voice is one that may stop her.
 *
 * Someone she knows, or a voice leaning towards someone she knows by at least
 * `threshold`. Looser than voices.ts's "known" on purpose: half a second of
 * speech is a short print, and his own scored "unsure, nearest Yousef" at
 * 0.34 to 0.46 on clips that short. Her own voice and the TV lean towards no
 * one in particular.
 */
export function mayStopHer(who: Identity | null, threshold: number): boolean {
  if (!who) return false;
  if (who.kind === "known") return true;
  return who.kind === "unsure" && Boolean(who.nearest) && who.score >= threshold;
}

export function createBargeWatcher(opts: {
  who: (pcm: Buffer) => Promise<Identity | null>;
  /** See mayStopHer. */
  threshold: number;
  /** He talked over her. `lead` is everything from just before he started to now. */
  onBarge: (lead: Buffer, who: Identity) => void;
  /** Every voice checked, and whether it stopped her. Diagnostics, for tuning the threshold. */
  onChecked?: (who: Identity | null, stopped: boolean) => void;
  /** How far over the room speech must be. */
  marginDb?: number;
  /** How much speech before it is worth checking whose. */
  onsetMs?: number;
  /** Kept from before the speech crossed the bar, for his first syllable. */
  preRollMs?: number;
  /** A break this long ends a burst that hadn't been checked yet. */
  gapMs?: number;
  /** After a voice that wasn't his, quiet this long before another is checked. */
  quietMs?: number;
  frameMs?: number;
  rate?: number;
}): BargeWatcher {
  const frameMs = opts.frameMs ?? 50;
  const rate = opts.rate ?? SAMPLE_RATE;
  const frameBytes = Math.round((rate * frameMs) / 1000) * 2;
  const margin = opts.marginDb ?? 12;
  const onsetFrames = Math.max(1, Math.round((opts.onsetMs ?? 300) / frameMs));
  const preRollFrames = Math.max(0, Math.round((opts.preRollMs ?? 300) / frameMs));
  const gapFrames = Math.max(1, Math.round((opts.gapMs ?? 150) / frameMs));
  const quietFrames = Math.max(1, Math.round((opts.quietMs ?? 300) / frameMs));

  let spare = Buffer.alloc(0);
  let floor = NaN;
  let armed = false;
  /** Bumped on arm and disarm, so a check that comes back late lands nowhere. */
  let generation = 0;
  let ring: Buffer[] = [];
  /** The burst being considered, pre-roll first. Null when there isn't one. */
  let burst: Buffer[] | null = null;
  let loud = 0;
  let gap = 0;
  let checking = false;
  /** A voice that wasn't his is still talking: wait for it to stop. */
  let refused = false;
  let quiet = 0;

  const drop = () => {
    burst = null;
    loud = 0;
    gap = 0;
  };

  const check = () => {
    checking = true;
    const asked = generation;
    void opts
      .who(Buffer.concat(burst!))
      .catch(() => null)
      .then((who) => {
        checking = false;
        if (asked !== generation || !armed) return;
        const stops = mayStopHer(who, opts.threshold);
        opts.onChecked?.(who, stops);
        if (stops) {
          const lead = Buffer.concat(burst ?? []);
          armed = false;
          generation++;
          drop();
          ring = [];
          opts.onBarge(lead, who!);
          return;
        }
        drop();
        refused = true;
        quiet = 0;
      });
  };

  const frame = (chunk: Buffer) => {
    const raw = levelDb(chunk);
    const level = Number.isFinite(raw) ? raw : -100;
    const speech = !Number.isNaN(floor) && level > floor + margin;
    // The room is learned only between bursts, the way the gate learns it:
    // a sentence must not teach it that his voice is the room.
    if (!burst) {
      floor = Number.isNaN(floor) ? level : level < floor ? floor + 0.4 * (level - floor) : floor + 0.02 * (level - floor);
    }
    if (!armed) return;

    if (refused) {
      quiet = speech ? 0 : quiet + 1;
      if (quiet >= quietFrames) refused = false;
      return;
    }
    if (!burst) {
      ring.push(chunk);
      if (ring.length > preRollFrames + 1) ring.shift();
      if (speech) {
        burst = [...ring];
        ring = [];
        loud = 1;
        gap = 0;
        if (loud >= onsetFrames) check();
      }
      return;
    }
    burst.push(chunk);
    if (speech) {
      loud++;
      gap = 0;
    } else if (!checking && ++gap >= gapFrames) {
      drop();
      return;
    }
    if (!checking && loud >= onsetFrames) check();
  };

  return {
    arm() {
      armed = true;
      generation++;
      drop();
      checking = false;
      refused = false;
      ring = [];
    },
    disarm() {
      armed = false;
      generation++;
      drop();
      checking = false;
      refused = false;
    },
    push(pcm) {
      const buffer = spare.length ? Buffer.concat([spare, pcm]) : pcm;
      let at = 0;
      while (buffer.length - at >= frameBytes) {
        frame(buffer.subarray(at, at + frameBytes));
        at += frameBytes;
      }
      spare = Buffer.from(buffer.subarray(at));
    },
    armed: () => armed,
  };
}
