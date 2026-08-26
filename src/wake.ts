import { levelDb, openMic, SAMPLE_RATE, type Mic } from "./listen.js";
import type { Spawner } from "./proc.js";

/**
 * The wake word.
 *
 * listen.ts said push-to-talk was deliberately not this, because "Hey Vela"
 * normally means training a small model on synthetic speech. It still isn't
 * that: the microphone stays open, an energy gate cuts the room into
 * utterances, and the whisper worker that already exists reads each one. Only
 * the ones that start with her name become turns.
 *
 * The trade that buys is worth being explicit about. A dedicated wake model
 * runs on a 30ms frame for almost no CPU and never looks at anything else. A
 * whisper pass costs about 0.4s per utterance and runs on everything said near
 * the machine — locally, on this machine, and nothing leaves it, but on
 * everything. In exchange there is no model to train, no new dependency, and
 * the decoder that already knows his voice is the one doing the recognising.
 * If the CPU cost ever matters, the gate below is the seam: put a real wake
 * model in front of it and whisper only sees what it passes.
 */

/**
 * What whisper writes down when he says "Vela".
 *
 * base.en has never heard the name, so it reaches for the nearest English word
 * and reaches for a different one depending on how the vowel lands. Too narrow
 * means she ignores him, which is the failure he notices immediately; too wide
 * means she answers to a word in a sentence about something else, which he can
 * watch happen and correct with VELA_WAKE_WORDS.
 */
export const WAKE_WORDS = [
  "vela",
  "vella",
  "veyla",
  "vayla",
  "velar",
];

/**
 * Spellings whisper offers that are also ordinary English words: villa, bella,
 * wella. They were on the list until one of them fired during a phone call and
 * every sentence after it became a turn. A name she answers to has to be a word
 * he would not otherwise say in front of her, so they are gone — put one back
 * with VELA_WAKE_WORDS if this microphone needs it.
 */

/**
 * Words allowed in front of the name. "Hey Vela" and "okay Vela" are the same
 * address, and a filler he did not mean to say should not cost him the turn.
 */
const LEAD_INS = new Set([
  "hey",
  "hi",
  "hello",
  "ok",
  "okay",
  "yo",
  "um",
  "uh",
  "so",
  "and",
]);

/**
 * Ways he ends a conversation.
 *
 * A session that only ever closes on a timer leaves her listening through the
 * thirty seconds after he has plainly finished, which is the window a mis-fire
 * needs. Being able to say "thanks, we're done" and have her let go is worth
 * more than the timer being right.
 */
export const DISMISSALS = [
  "thanks",
  "thank you",
  "thanks a lot",
  "thank you very much",
  "that's all",
  "that's it",
  "that'll be all",
  "we're done",
  "we are done",
  "i'm done",
  "done",
  "never mind",
  "nevermind",
  "forget it",
  "cancel",
  "stop",
  "goodbye",
  "bye",
  "good night",
  "goodnight",
  "nothing",
  "no thanks",
  "no thank you",
];

/** Compare on letters only, so "Vela," and "Vela." and "vela" are one word. */
const bare = (word: string): string =>
  word.toLowerCase().replace(/[^a-z']/g, "").replace(/'s$/, "");

const trimLead = (text: string): string => text.replace(/^[\s,.:;!?-]+/, "");
const trimTail = (text: string): string => text.replace(/[\s,]+$/, "");

export interface Wake {
  /** Was she addressed at all? */
  heard: boolean;
  /** What he wanted, with the name taken off. Empty means he only called her. */
  rest: string;
  /** The alias whisper actually wrote down. Empty when she was not addressed. */
  word: string;
}

/**
 * Did that utterance address her, and what was left of it?
 *
 * The name has to be at the front or at the very end — "Vela, what time is it"
 * or "what time is it, Vela". A name in the middle is him talking *about* her
 * to someone else, and answering that is worse than missing it.
 */
export function matchWake(text: string, words: string[] = WAKE_WORDS): Wake {
  const missed: Wake = { heard: false, rest: "", word: "" };
  const aliases = new Set(words.map(bare));

  const tokens = [...text.matchAll(/\S+/g)].map((m) => ({
    word: bare(m[0]),
    at: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
  if (!tokens.length) return missed;

  const at = tokens.findIndex((t) => aliases.has(t.word));
  if (at < 0) return missed;

  // Fillers in front of the name do not push it out of the front position.
  let lead = 0;
  while (lead < tokens.length && LEAD_INS.has(tokens[lead].word)) lead++;

  const word = tokens[at].word;
  if (at === lead) {
    return { heard: true, rest: trimLead(text.slice(tokens[at].end)).trim(), word };
  }
  if (at === tokens.length - 1) {
    return { heard: true, rest: trimTail(text.slice(0, tokens[at].at)).trim(), word };
  }
  return missed;
}

/**
 * Was that him letting her go?
 *
 * Matched on the *end* of the utterance rather than anywhere in it, and only
 * on a short one. "Okay thank you, we're done" ends in a dismissal and is him
 * finishing; "tell me when the timer is done" ends in one word of it and is
 * not. The length cap is what keeps a sentence that merely happens to end in
 * "stop" from closing the session.
 */
export function isDismissal(text: string, phrases: string[] = DISMISSALS): boolean {
  const words = [...text.matchAll(/\S+/g)].map((m) => bare(m[0])).filter(Boolean);
  let from = 0;
  while (from < words.length && LEAD_INS.has(words[from])) from++;
  const core = words.slice(from);
  if (!core.length || core.length > 6) return false;
  const said = core.join(" ");
  return phrases.some((phrase) => {
    const want = phrase.split(/\s+/).map(bare).filter(Boolean).join(" ");
    return want.length > 0 && (said === want || said.endsWith(` ${want}`));
  });
}

/** How the room is cut into utterances. Every number here is milliseconds. */
export interface SegmentOptions {
  /** How much louder than the room a frame must be to count as speech. */
  marginDb?: number;
  /** Quiet this long ends the utterance. */
  hangoverMs?: number;
  /** Kept in front of the opening frame, so the first syllable survives. */
  preRollMs?: number;
  /** Shorter than this is a door closing, not a sentence. */
  minMs?: number;
  /** Longer than this is cut, so one long noise cannot hold the gate open. */
  maxMs?: number;
  frameMs?: number;
  rate?: number;
}

/**
 * The quietest and loudest the room is allowed to be taken for.
 *
 * Without the ceiling, a fan starting up drags the floor with it until the bar
 * sits above his voice and she goes deaf. Measured on this machine speech runs
 * about -49 dBFS, so the ceiling is set where the bar it implies still sits
 * under that. Without the base, digital silence — a muted device, which reads
 * as -Infinity — would put the bar below anything at all and every chunk of
 * nothing would be an utterance.
 */
const FLOOR_MIN = -85;
const FLOOR_MAX = -55;

export interface Segmenter {
  /** Feed it whatever came off the microphone. */
  push: (pcm: Buffer) => void;
  /** Throw away what is in flight, without emitting it. */
  reset: () => void;
  /** What it currently thinks the room sounds like, in dBFS. Diagnostics. */
  floor: () => number;
}

/**
 * Cut a continuous capture into things that were said.
 *
 * The bar is relative, not fixed. His microphone puts speech at about -49
 * dBFS, far below where a fixed threshold would sensibly sit, and a different
 * room or a different microphone moves that number again. So the gate learns
 * what quiet sounds like here and asks only that speech be louder than it.
 *
 * The floor only learns while nothing is being said. Adapting during an
 * utterance would mean a long sentence teaching it that his voice is the room,
 * and the gate closing in the middle of him talking.
 */
export function createSegmenter(
  onUtterance: (pcm: Buffer, level: number) => void,
  opts: SegmentOptions = {},
): Segmenter {
  const rate = opts.rate ?? SAMPLE_RATE;
  const frameMs = opts.frameMs ?? 100;
  const marginDb = opts.marginDb ?? 8;
  const hangoverMs = opts.hangoverMs ?? 700;
  const preRollMs = opts.preRollMs ?? 600;
  const minMs = opts.minMs ?? 400;
  const maxMs = opts.maxMs ?? 15_000;

  const frameBytes = Math.max(2, Math.round((rate * frameMs) / 1000) * 2);
  const preRollFrames = Math.max(1, Math.round(preRollMs / frameMs));
  const hangoverFrames = Math.max(1, Math.round(hangoverMs / frameMs));
  const minFrames = Math.max(1, Math.round(minMs / frameMs));
  const maxFrames = Math.max(minFrames + 1, Math.round(maxMs / frameMs));
  // Two frames, so a keyboard click or a chair is not the start of a sentence.
  const openFrames = 2;

  let spare = Buffer.alloc(0);
  let floor = NaN;
  let preRoll: Buffer[] = [];
  let speech: Buffer[] = [];
  let loud = 0;
  let quiet = 0;
  let peak = -Infinity;

  const close = () => {
    const frames = speech;
    const level = peak;
    speech = [];
    quiet = 0;
    loud = 0;
    peak = -Infinity;
    // The pre-roll rode in with it, so the length it has to clear includes
    // the pre-roll: the test is how much of this was actually him.
    if (frames.length >= minFrames + preRollFrames) {
      onUtterance(Buffer.concat(frames), level);
    }
  };

  const frame = (chunk: Buffer) => {
    const raw = levelDb(chunk);
    // -Infinity is a real reading — a muted or dead device — and it has to
    // take part in the average rather than poison it.
    const level = Number.isFinite(raw) ? raw : FLOOR_MIN;

    if (!speech.length) {
      // Falls to a quiet room quickly, rises to a noisy one slowly. The
      // asymmetry is what stops one loud moment from raising the bar.
      floor = Number.isNaN(floor)
        ? level
        : level < floor
          ? floor + 0.4 * (level - floor)
          : floor + 0.02 * (level - floor);
      floor = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, floor));
    }

    const speaking = level > floor + marginDb;

    if (speech.length) {
      speech.push(chunk);
      peak = Math.max(peak, level);
      quiet = speaking ? 0 : quiet + 1;
      if (quiet >= hangoverFrames || speech.length >= maxFrames) close();
      return;
    }

    preRoll.push(chunk);
    if (preRoll.length > preRollFrames) preRoll.shift();

    loud = speaking ? loud + 1 : 0;
    if (loud < openFrames) return;

    // The pre-roll already contains these loud frames — it is the last
    // preRollFrames of everything, including now.
    speech = preRoll;
    preRoll = [];
    peak = level;
    quiet = 0;
  };

  return {
    push(pcm: Buffer) {
      const buffer = spare.length ? Buffer.concat([spare, pcm]) : pcm;
      let at = 0;
      while (buffer.length - at >= frameBytes) {
        frame(buffer.subarray(at, at + frameBytes));
        at += frameBytes;
      }
      spare = Buffer.from(buffer.subarray(at));
    },
    reset() {
      spare = Buffer.alloc(0);
      preRoll = [];
      speech = [];
      loud = 0;
      quiet = 0;
      peak = -Infinity;
    },
    floor: () => (Number.isNaN(floor) ? FLOOR_MIN : floor),
  };
}

export interface WakeListener {
  /** Resolves once the microphone is actually capturing. */
  ready: Promise<void>;
  /**
   * Stop hearing. Called while she is speaking: the microphone is in the same
   * room as the speakers, so without this she transcribes herself, hears her
   * own name in it, and answers it.
   */
  hold: () => void;
  /** Hear again, and restart the follow-up window from now. */
  resume: () => void;
  stop: () => void;
}

/**
 * What let an utterance through, so a mis-fire can be read off the log rather
 * than guessed at. The two ways she goes wrong — answering the room, and never
 * answering him — are the same silence from the outside.
 */
export interface WakeTrigger {
  /** The alias whisper wrote down. Empty on a follow-up. */
  word: string;
  /** True when the window let it through rather than her name. */
  followUp: boolean;
}

export interface WakeOptions {
  device: string;
  /** Raw samples in, what was said out. The service's warm whisper worker. */
  hear: (pcm: Buffer) => Promise<string>;
  /** He asked her something. */
  onCommand: (text: string, woke: WakeTrigger) => void;
  /** He said only her name, and is waiting to be acknowledged. */
  onName?: (word: string) => void;
  /** He said they were finished, so the session is over. */
  onDismiss?: () => void;
  /** Every utterance that got as far as a transcript. Diagnostics only. */
  onHeard?: (heard: { text: string; woke: boolean; level: number }) => void;
  /**
   * Every utterance the gate cut out of the room, before whisper sees it.
   *
   * The two silences look identical from the transcript alone: a gate that
   * never opens and a gate that opens onto audio whisper reads as nothing.
   * Diagnostics only.
   */
  onCaptured?: (captured: { ms: number; level: number }) => void;
  /** The microphone went away. */
  onProblem?: (why: string) => void;
  words?: string[];
  /**
   * How long after a turn she keeps answering without her name.
   *
   * Saying "Vela" before every sentence of a conversation is what makes a wake
   * word feel like a command line. 0 turns it off.
   */
  followUpMs?: number;
  /**
   * Nameless turns one address is worth. See `arm` for why this is bounded.
   */
  followUps?: number;
  /** Phrases that end the session outright. See DISMISSALS. */
  dismissals?: string[];
  segment?: SegmentOptions;
  ffmpeg?: string;
  spawn?: Spawner;
  now?: () => number;
  /** Backoff before reopening a capture that died. Tests shorten it. */
  reopenMs?: number[];
}

/**
 * Listen to the room until told to stop.
 *
 * Everything above is a pure function or a state machine over bytes. This is
 * the part that owns a microphone, so it is the part that has to survive the
 * microphone going away.
 */
export function startWakeListener(opts: WakeOptions): WakeListener {
  const now = opts.now ?? Date.now;
  const followUpMs = opts.followUpMs ?? 8_000;
  const followUps = opts.followUps ?? 6;
  const reopenMs = opts.reopenMs ?? [1_000, 2_000, 5_000, 15_000, 30_000];

  let stopped = false;
  let held = false;
  let followUntil = 0;
  /** Nameless turns left on the window that is open. */
  let followLeft = 0;
  /** Set while held, so the window is measured from when she stops talking. */
  let followOwed = false;

  /**
   * Open a session. Her name does this, and so does answering him inside one.
   *
   * A session runs on silence: it lasts until nothing has been said *to her*
   * for `followUpMs`, or until he says they are finished. That is what makes
   * her feel spoken to rather than commanded — he says her name once and then
   * talks. The cost is real: a mis-fire opens a session too, and every nameless
   * turn inside one pushes the deadline out again, so on a timer alone a single
   * bad wake in a talking room never closes.
   *
   * It was unbounded once, and that is exactly what happened — eleven turns of
   * transcribed noise off one hallucinated name. So an address is worth a fixed
   * number of nameless turns as well as a stretch of time, and the number is
   * small enough that a mis-fire is an annoyance rather than an open mic.
   *
   * Be honest about what the cap costs, because it is not free: only saying her
   * name re-arms the count, so a real conversation he never names her in dies
   * at the same limit the noise does. Six is chosen for that side of it rather
   * than this one — long enough to be a conversation, short enough that a room
   * talking to itself runs out.
   */
  const arm = () => {
    followUntil = now() + followUpMs;
    followLeft = followUps;
  };
  let deaths = 0;
  let mic: Mic | null = null;

  /**
   * One utterance through whisper at a time, and never more than one waiting.
   *
   * Speech arrives faster than it transcribes when there are two people in the
   * room. A queue would have her answering a question from a minute ago;
   * dropping keeps her answering the thing he just said.
   */
  let working = false;
  let pending: Buffer | null = null;
  let pendingLevel = 0;

  const consider = (text: string, level: number) => {
    const woken = matchWake(text, opts.words);
    const following = followUpMs > 0 && followLeft > 0 && now() < followUntil;
    opts.onHeard?.({ text, woke: (woken.heard || following) && Boolean(text), level });
    if (!text) return;

    if (woken.heard && !woken.rest) {
      // Just her name. She answers, and the window means the next thing he
      // says needs no name at all.
      arm();
      opts.onName?.(woken.word);
      return;
    }

    const said = woken.heard ? woken.rest : following ? text : "";
    if (!said) return;

    // Him letting her go ends it now, rather than leaving her listening
    // through the timer he has just made unnecessary.
    if (isDismissal(said, opts.dismissals)) {
      followUntil = 0;
      followLeft = 0;
      opts.onDismiss?.();
      return;
    }

    if (woken.heard) arm();
    else {
      // Measured from the last thing said to her, so a conversation stays
      // open for as long as it is still a conversation.
      followLeft--;
      followUntil = now() + followUpMs;
    }
    opts.onCommand(said, { word: woken.word, followUp: !woken.heard });
  };

  const drain = async () => {
    if (working) return;
    working = true;
    try {
      while (pending && !stopped) {
        const pcm = pending;
        const level = pendingLevel;
        pending = null;
        // Held between being captured and being read means she started
        // talking over it, and it is very likely her own voice.
        if (held) continue;
        const text = await opts.hear(pcm).catch(() => "");
        if (!stopped && !held) consider(text, level);
      }
    } finally {
      working = false;
    }
  };

  const segmenter = createSegmenter((pcm, level) => {
    if (stopped || held) return;
    opts.onCaptured?.({ ms: Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000), level });
    pending = pcm;
    pendingLevel = level;
    void drain();
  }, opts.segment);

  const open = () => {
    if (stopped) return;
    mic = openMic(opts.device, {
      ffmpeg: opts.ffmpeg,
      spawn: opts.spawn,
      onAudio: (chunk) => {
        if (!held) segmenter.push(chunk);
      },
      onEnd: (why) => {
        if (stopped) return;
        opts.onProblem?.(`the microphone stopped (${why}); reopening`);
        const wait = reopenMs[Math.min(deaths, reopenMs.length - 1)];
        deaths++;
        segmenter.reset();
        const timer = setTimeout(open, wait);
        timer.unref?.();
      },
    });
    void mic.ready.then(() => {
      deaths = 0;
    });
  };

  open();

  return {
    // Reopening replaces the microphone, so the promise handed out is the
    // first one's: it answers "did this ever start", which is what the caller
    // is waiting on.
    ready: mic ? (mic as Mic).ready : Promise.resolve(),

    hold() {
      held = true;
      followOwed = followUntil > 0 && followLeft > 0;
      segmenter.reset();
      pending = null;
    },

    resume() {
      held = false;
      segmenter.reset();
      // She has been talking for however long that took. The window he has to
      // reply in starts when she stops, not when she started.
      if (followOwed) followUntil = now() + followUpMs;
      followOwed = false;
    },

    stop() {
      stopped = true;
      pending = null;
      mic?.close();
    },
  };
}
