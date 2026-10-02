import { levelDb, SAMPLE_RATE } from "./listen.js";

/**
 * Him talking over her, heard while she talks.
 *
 * She has always shut her ears while she speaks, because her own voice comes
 * back into the microphone as loud as his. The echo canceller (src/echo.ts)
 * takes her out of it, and what it did to each moment says whose sound that
 * moment was:
 *
 *   his voice    the canceller finds nothing of hers to remove, so the cleaned
 *                audio is within a few dB of the raw: measured over sixteen of
 *                his interruptions, 0 to 5dB down, at -28 to -38 dBFS
 *   her echo     it removes most of it: 6 to 9dB and more even in the
 *                half-second it is still adapting, and down to -63..-66 once
 *                it has
 *   the TV       not hers either, but across the room, so quieter at the
 *                laptop than he is
 *
 * So a stop is sound the canceller left alone (under 8dB taken off), loud
 * enough to be someone at the laptop (over -45 dBFS, the bar the wake gate
 * already uses), for 0.3s, allowing 0.3s breaths inside it. Replayed against
 * a recording of her talking with him quiet, no setting tried stopped her;
 * against one of him talking over her, these stopped her half a second
 * after he started, where requiring 6dB and -42 took a second and a half. It used to be a voiceprint, and
 * his own scored 0.00 to 0.30 on those same sixteen interruptions: talking
 * over someone is not the voice his print was taken from.
 *
 * Everything said from just before he started is kept and handed over with
 * the stop, so the sentence he interrupted her with keeps its first words.
 */
export interface BargeWatcher {
  /** She has started talking: listen for him. */
  arm: () => void;
  /** She has stopped, or been stopped. */
  disarm: () => void;
  /**
   * The cleaned microphone and the raw audio it was cleaned from, the same
   * length, all of it, armed or not: the room is learned from it.
   */
  push: (clean: Buffer, raw: Buffer) => void;
  armed: () => boolean;
}

/** What one 50ms moment was. Pulled out so the rule can be read and tested on its own. */
export function isHim(
  cleanDb: number,
  rawDb: number,
  floorDb: number,
  rule: { marginDb: number; minDb: number; cancelledDb: number },
): boolean {
  return cleanDb > floorDb + rule.marginDb && cleanDb > rule.minDb && rawDb - cleanDb < rule.cancelledDb;
}

/**
 * What one stretch of her talking sounded like to the watcher, from arm to
 * disarm or stop. Diagnostics: a stop that didn't happen is otherwise
 * invisible, and "he wasn't loud enough" and "it wasn't armed" look the same.
 */
export interface ArmedStretch {
  ms: number;
  /** The loudest moment of cleaned audio, and how much the canceller had taken off it. */
  loudestDb: number;
  tookOffDb: number;
  /** How long, all told, sounded like him. */
  himMs: number;
  stopped: boolean;
}

export function createBargeWatcher(opts: {
  /** He talked over her. `lead` is everything from just before he started to now, cleaned. */
  onBarge: (lead: Buffer, loudness: number) => void;
  /** Each stretch she was being listened over, once it ends. See ArmedStretch. */
  onStretch?: (stretch: ArmedStretch) => void;
  /** How far over the room the cleaned sound must be. */
  marginDb?: number;
  /** How loud it must be at all: someone at the laptop, not across the room. */
  minDb?: number;
  /** How much the canceller may have taken off before the sound counts as hers. */
  cancelledDb?: number;
  /** How much of it before she stops. */
  onsetMs?: number;
  /** Kept from before it started, for his first syllable. */
  preRollMs?: number;
  /** A break this long ends a burst. */
  gapMs?: number;
  frameMs?: number;
  rate?: number;
}): BargeWatcher {
  const frameMs = opts.frameMs ?? 50;
  const rate = opts.rate ?? SAMPLE_RATE;
  const frameBytes = Math.round((rate * frameMs) / 1000) * 2;
  const rule = { marginDb: opts.marginDb ?? 12, minDb: opts.minDb ?? -45, cancelledDb: opts.cancelledDb ?? 8 };
  const onsetFrames = Math.max(1, Math.round((opts.onsetMs ?? 300) / frameMs));
  const preRollFrames = Math.max(0, Math.round((opts.preRollMs ?? 300) / frameMs));
  const gapFrames = Math.max(1, Math.round((opts.gapMs ?? 300) / frameMs));

  let spareClean = Buffer.alloc(0);
  let spareRaw = Buffer.alloc(0);
  let floor = NaN;
  let armed = false;
  let ring: Buffer[] = [];
  /** The burst being considered, pre-roll first. Null when there isn't one. */
  let burst: Buffer[] | null = null;
  let loud = 0;
  let gap = 0;
  let peak = -Infinity;
  let stretch: ArmedStretch | null = null;
  const endStretch = (stopped: boolean) => {
    if (!stretch) return;
    const done = { ...stretch, stopped };
    stretch = null;
    opts.onStretch?.(done);
  };

  const drop = () => {
    burst = null;
    loud = 0;
    gap = 0;
    peak = -Infinity;
  };
  const db = (b: Buffer) => {
    const v = levelDb(b);
    return Number.isFinite(v) ? v : -100;
  };

  const frame = (clean: Buffer, raw: Buffer) => {
    const c = db(clean);
    const r = db(raw);
    const him = !Number.isNaN(floor) && isHim(c, r, floor, rule);
    if (armed && stretch) {
      stretch.ms += frameMs;
      if (c > stretch.loudestDb) {
        stretch.loudestDb = c;
        stretch.tookOffDb = r - c;
      }
      if (him) stretch.himMs += frameMs;
    }
    // The room is learned only between bursts, the way the gate learns it:
    // a sentence must not teach it that his voice is the room.
    if (!burst) floor = Number.isNaN(floor) ? c : c < floor ? floor + 0.4 * (c - floor) : floor + 0.02 * (c - floor);
    if (!armed) return;

    if (!burst) {
      ring.push(clean);
      if (ring.length > preRollFrames + 1) ring.shift();
      if (!him) return;
      burst = [...ring];
      ring = [];
      loud = 1;
      peak = c;
    } else {
      burst.push(clean);
      if (him) {
        loud++;
        gap = 0;
        peak = Math.max(peak, c);
      } else if (++gap >= gapFrames) {
        drop();
        return;
      }
    }
    if (loud >= onsetFrames) {
      const lead = Buffer.concat(burst);
      const loudness = peak;
      armed = false;
      drop();
      ring = [];
      endStretch(true);
      opts.onBarge(lead, loudness);
    }
  };

  return {
    arm() {
      if (!armed) stretch = { ms: 0, loudestDb: -Infinity, tookOffDb: 0, himMs: 0, stopped: false };
      armed = true;
      drop();
      ring = [];
    },
    disarm() {
      if (armed) endStretch(false);
      armed = false;
      drop();
    },
    push(clean, raw) {
      const c = spareClean.length ? Buffer.concat([spareClean, clean]) : clean;
      const r = spareRaw.length ? Buffer.concat([spareRaw, raw]) : raw;
      let at = 0;
      while (c.length - at >= frameBytes && r.length - at >= frameBytes) {
        frame(c.subarray(at, at + frameBytes), r.subarray(at, at + frameBytes));
        at += frameBytes;
      }
      spareClean = Buffer.from(c.subarray(at));
      spareRaw = Buffer.from(r.subarray(at));
    },
    armed: () => armed,
  };
}
