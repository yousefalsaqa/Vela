import { levelDb, openMic, SAMPLE_RATE, type Mic } from "./listen.js";
import type { Spawner } from "./proc.js";
import type { WakeDetector } from "./detect.js";
import type { Identity } from "./voices.js";

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
  "you can go now",
  /**
   * What base.en writes for "you can go now". The "w" at the end of the phrase
   * is quiet, and it heard "go on" twice running — and then the model answered
   * "Alright" to what was him leaving. Like the name's spellings, the phrase
   * has to be listed the way she hears it, not the way he says it.
   */
  "you can go on",
  /**
   * The same phrase with "you can" swallowed into one word. "Gone on" on its
   * own is not listed: "what's gone on" is a question, and "go on" is him
   * telling her to continue.
   */
  "even gone on",
  "goodbye",
  "bye",
  "good night",
  "goodnight",
  "nothing",
  "no thanks",
  "no thank you",
];

/**
 * Goodbyes that still mean goodbye at the end of a longer sentence.
 *
 * isDismissal only takes a short utterance, so that "stop" ending a sentence
 * about something else does not close anything. That also meant "Ah, don't
 * worry about that, you can go now" was nine words and went to the model as a
 * question; she said "Okay" and stayed. These are the ones distinctive enough
 * to end a long sentence and still be him leaving.
 *
 * Not "thanks": at the end of a request it is manners, and "set a timer for
 * ten minutes, thanks" is a timer. Not "you can go on": in a sentence, "go on"
 * is him asking her to continue. Not "stop", "done", "cancel" or "nothing",
 * which end sentences about other things all the time.
 */
export const GOODBYES = [
  "you can go now",
  "that's all",
  "that'll be all",
  "that's it",
  "we're done",
  "we are done",
  "i'm done",
  "never mind",
  "nevermind",
  "forget it",
  "goodbye",
  "bye",
  "good night",
  "goodnight",
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
export function matchWake(
  text: string,
  words: string[] = WAKE_WORDS,
  requireLead = false,
): Wake {
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
    // With a lead-in required, the name arriving with nothing in front of it is
    // the shape whisper produces out of room tone, so it is not an address.
    if (requireLead && lead === 0) return missed;
    return { heard: true, rest: trimLead(text.slice(tokens[at].end)).trim(), word };
  }
  // "what time is it, Vela" is the other shape a mishearing lands in, and it
  // cannot carry a lead-in, so requiring one rules it out too.
  if (!requireLead && at === tokens.length - 1) {
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
export function isDismissal(
  text: string,
  phrases: string[] = DISMISSALS,
  names: string[] = WAKE_WORDS,
): boolean {
  const words = [...text.matchAll(/\S+/g)].map((m) => bare(m[0])).filter(Boolean);
  let from = 0;
  while (from < words.length && LEAD_INS.has(words[from])) from++;
  let core = words.slice(from);
  /**
   * Her name is not part of the phrase, at either end.
   *
   * "You can go now, Vela" is the same dismissal as "you can go now", and in a
   * follow-up she is handed the whole sentence with the name still on it —
   * matched on the end, that name is what stops the phrase from matching.
   */
  const aliases = new Set(names.map(bare));
  while (core.length && aliases.has(core[0])) core = core.slice(1);
  while (core.length && aliases.has(core[core.length - 1])) core = core.slice(0, -1);
  if (!core.length || core.length > 6) return false;
  const said = core.join(" ");
  return phrases.some((phrase) => {
    const want = phrase.split(/\s+/).map(bare).filter(Boolean).join(" ");
    return want.length > 0 && (said === want || said.endsWith(` ${want}`));
  });
}

/**
 * Does a longer sentence end with him leaving?
 *
 * Asked only of what isDismissal turned down. A yes is not an instant
 * goodbye: the sentence may carry a request ("add milk to the list, that's
 * all"), so it still goes to her, and the conversation closes once she has
 * answered it.
 *
 * A one-word goodbye has to start its own clause. "Okay, great. Bye." is him
 * leaving; "how do I say goodbye" is a question about a word.
 */
export function endsInGoodbye(
  text: string,
  phrases: string[] = GOODBYES,
  names: string[] = WAKE_WORDS,
): boolean {
  const tokens = [...text.matchAll(/\S+/g)].map((m) => ({ word: bare(m[0]), raw: m[0] })).filter((t) => t.word);
  const aliases = new Set(names.map(bare));
  while (tokens.length && aliases.has(tokens[tokens.length - 1].word)) tokens.pop();
  return phrases.some((phrase) => {
    const want = phrase.split(/\s+/).map(bare).filter(Boolean);
    if (!want.length || tokens.length <= want.length) return false;
    const tail = tokens.slice(-want.length);
    if (tail.some((t, i) => t.word !== want[i])) return false;
    if (want.length > 1) return true;
    // One word: the word before it has to end a clause.
    return /[.,!?;:]$/.test(tokens[tokens.length - want.length - 1].raw);
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
  /**
   * Quiet this long inside an utterance is a pause worth acting on: onPause
   * is called with everything so far. 0, or anything not shorter than the
   * hangover, never calls it. See WAKE_EARLY_MS.
   */
  pauseMs?: number;
  /**
   * The loudest the room is allowed to be taken for.
   *
   * Calibrated against a microphone that put speech at -49 dBFS. Turn the input
   * gain up and everything moves with it: the room rises past this ceiling, the
   * bar stops rising with it, and every noise in the room clears a threshold
   * that can no longer get out of its way. It belongs a few dB under the
   * quietest speech worth catching, which is a property of the microphone and
   * not of this file.
   */
  floorMax?: number;
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
export const FLOOR_MAX = -55;

export interface Segmenter {
  /** Feed it whatever came off the microphone. */
  push: (pcm: Buffer) => void;
  /** Throw away what is in flight, without emitting it. */
  reset: () => void;
  /** Is an utterance open right now? */
  speaking: () => boolean;
  /**
   * How much audio it has been given, in milliseconds. The clock that measures
   * what was said, which the wall clock only agrees with while the audio
   * arrives in real time.
   */
  heard: () => number;
  /** What it currently thinks the room sounds like, in dBFS. Diagnostics. */
  floor: () => number;
  /**
   * When it last heard a frame over the bar, on the heard() clock: the end of
   * that frame. -Infinity before anything has been. Unlike speaking(), this
   * does not wait for an utterance to open or close, which is what lets the
   * wake word ask "has he stopped?" a third of a second after her name, long
   * before the gate's own hangover would answer it.
   */
  lastLoud: () => number;
  /**
   * How many utterances have opened so far. An utterance's number is this
   * read while it is open, and it is how something taken from the middle of
   * one is matched to the one that closes, across a reset in between.
   */
  opened: () => number;
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
  /** He has gone quiet for pauseMs mid-utterance, and this is all of it so far. */
  onPause?: (pcm: Buffer) => void,
): Segmenter {
  const rate = opts.rate ?? SAMPLE_RATE;
  const frameMs = opts.frameMs ?? 100;
  const marginDb = opts.marginDb ?? 8;
  const floorMax = opts.floorMax ?? FLOOR_MAX;
  const hangoverMs = opts.hangoverMs ?? 700;
  const preRollMs = opts.preRollMs ?? 600;
  const minMs = opts.minMs ?? 400;
  const maxMs = opts.maxMs ?? 15_000;

  const frameBytes = Math.max(2, Math.round((rate * frameMs) / 1000) * 2);
  const preRollFrames = Math.max(1, Math.round(preRollMs / frameMs));
  const hangoverFrames = Math.max(1, Math.round(hangoverMs / frameMs));
  const minFrames = Math.max(1, Math.round(minMs / frameMs));
  const maxFrames = Math.max(minFrames + 1, Math.round(maxMs / frameMs));
  // Rounded up, so a pause is never taken for one shorter than asked for.
  const pauseFrames = opts.pauseMs ? Math.ceil(opts.pauseMs / frameMs) : 0;
  // Two frames, so a keyboard click or a chair is not the start of a sentence.
  const openFrames = 2;

  let spare = Buffer.alloc(0);
  /** Frames seen since it was made, for heard(). Not cleared by reset(). */
  let frames = 0;
  let floor = NaN;
  let preRoll: Buffer[] = [];
  let speech: Buffer[] = [];
  let loud = 0;
  let quiet = 0;
  let peak = -Infinity;
  let lastLoud = -Infinity;
  let opened = 0;

  /**
   * An utterance that ran to the limit without a single pause is the room.
   *
   * The floor only learns while nothing is being said, and rises slowly when
   * it does. Started below the room — a capture can open on a moment of
   * digital silence, and his microphone's own hiss sits at -53 dBFS once
   * Acer's processing is off — every frame clears the bar, the gate never
   * closes long enough to learn, and his replayed tape showed four minutes of
   * fifteen-second "sentences" of hiss going to whisper. Nobody talks that
   * long without a breath, so a cut is evidence: the floor moves up to the
   * quieter part of what it just heard, still under the ceiling.
   */
  const relearn = (frames: Buffer[]) => {
    const levels = frames
      .map((f) => {
        const db = levelDb(f);
        return Number.isFinite(db) ? db : FLOOR_MIN;
      })
      .sort((a, b) => a - b);
    // The fifth-quietest part: a real monologue's pauses between words land
    // here, so it moves the bar far less than a room does.
    const quiet = levels[Math.floor(levels.length * 0.2)] ?? FLOOR_MIN;
    floor = Math.min(floorMax, Math.max(Number.isNaN(floor) ? FLOOR_MIN : floor, quiet));
  };

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
    frames++;
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
      floor = Math.min(floorMax, Math.max(FLOOR_MIN, floor));
    }

    const speaking = level > floor + marginDb;
    if (speaking) lastLoud = frames * frameMs;

    if (speech.length) {
      speech.push(chunk);
      peak = Math.max(peak, level);
      quiet = speaking ? 0 : quiet + 1;
      // Only for an utterance that would be handed over if it closed now, so
      // a cough the gate is about to throw away is not sent to be read.
      if (
        onPause &&
        pauseFrames > 0 &&
        quiet === pauseFrames &&
        pauseFrames < hangoverFrames &&
        speech.length >= minFrames + preRollFrames
      ) {
        onPause(Buffer.concat(speech));
      }
      if (quiet >= hangoverFrames) close();
      else if (speech.length >= maxFrames) {
        relearn(speech);
        close();
      }
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
    opened++;
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
    speaking: () => speech.length > 0,
    opened: () => opened,
    heard: () => frames * frameMs,
    floor: () => (Number.isNaN(floor) ? FLOOR_MIN : floor),
    lastLoud: () => lastLoud,
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
  /**
   * Open a conversation without her name: the next thing he says is hers, as
   * if he had said "Hey Vela" and stopped. For him pressing her on screen.
   */
  open: () => void;
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
  /**
   * The sentence ended with him leaving (see endsInGoodbye). She still answers
   * it, and nothing after it is taken without her name: the conversation is
   * already closed by the time this is called.
   */
  leaving: boolean;
  /**
   * Whose voice it was. Started when the gate cut the utterance, so by the
   * time whisper has read it this has long since settled. Null without `who`.
   */
  who: Promise<Identity | null>;
}

export interface WakeOptions {
  device: string;
  /** Raw samples in, what was said out. The service's warm whisper worker. */
  hear: (pcm: Buffer) => Promise<string>;
  /** He asked her something. */
  onCommand: (text: string, woke: WakeTrigger) => void;
  /**
   * He said only her name, and is waiting to be acknowledged.
   *
   * `paused` says how that was known. True: the model fired and the room went
   * quiet straight after her name, so this is a third of a second after he
   * stopped, nothing he said is still being read, and an answer out loud lands
   * in the gap he left for it. False: the utterance closed and whisper read
   * it, a second and more later, by which time he may be talking again.
   */
  onName?: (word: string, how: { paused: boolean }) => void;
  /**
   * The model just heard her name, and in the ten seconds before it there were
   * things the gate cut out of the room that it did not hear her name in.
   *
   * "I have to say it twice" is the miss this exists to catch. The second
   * "Hey Vela" is the one that woke her; the first is in here, as the raw
   * audio the model was given, so the next tuning is done on his voice rather
   * than on synthetic speech. Most of these will be nothing — him talking to
   * someone else — which is fine for diagnostics and why it is only that.
   */
  onMissed?: (clips: { pcm: Buffer; level: number; agoMs: number }[]) => void;
  /**
   * The model heard the phrase. Fires the moment it does, before whisper has
   * seen a sample of the sentence around it — so this is where anything that
   * should feel instant belongs. Only with a detector.
   */
  onWake?: () => void;
  /**
   * A question addressed to her has just finished, and whisper is only now
   * starting to read it. Fired at the close, before the transcript, when the
   * model fired inside the utterance and more than her name followed — so
   * she can answer "one sec" in the half second whisper takes. Only with a
   * detector; nameless follow-ups wait for onCommand, since they could be a
   * goodbye.
   */
  onAsked?: () => void;
  /** He said they were finished, so the session is over. */
  onDismiss?: () => void;
  /**
   * Whose voice an utterance is. Called with every utterance the gate cuts,
   * whether or not it turns out to be said to her, because which ones are is
   * not known until whisper is done. See src/voices.ts.
   */
  who?: (pcm: Buffer) => Promise<Identity | null>;
  /** Every utterance that got as far as a transcript. Diagnostics only. */
  onHeard?: (heard: { text: string; woke: boolean; level: number }) => void;
  /**
   * He said something without her name shortly after a conversation ran out,
   * so it was ignored. `lateMs` is how long after the window closed he
   * started; `spent` says the window had time left and the nameless-turn cap
   * closed it instead.
   *
   * Diagnostics, and always on, because this is the miss that looks exactly
   * like her breaking: she was talking to him a moment ago and now is not. It
   * was invisible once, and an afternoon went on guessing whether she had gone
   * deaf or he had only paused longer than the window.
   */
  onLapsed?: (lapsed: { text: string; lateMs: number; spent: boolean }) => void;
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
  /**
   * Every chunk she hears, exactly as the model and the gate get it.
   *
   * Diagnostics. The spotter scored 98% of synthetic "Hey Vela"s and none of
   * his first two real ones, and a second capture of this microphone reads as
   * silence, so a recording of what *she* heard is the only one that answers
   * why.
   */
  onAudio?: (pcm: Buffer) => void;
  words?: string[];
  /**
   * Whether the name has to arrive with a word in front of it.
   *
   * "Hey Vela" rather than "Vela". The name on its own is what base.en writes
   * when it is guessing at silence, and each of those costs him a turn he did
   * not ask for.
   */
  requireLead?: boolean;
  /**
   * How long after a turn she keeps answering without her name.
   *
   * Saying "Vela" before every sentence of a conversation is what makes a wake
   * word feel like a command line. 0 turns it off.
   */
  followUpMs?: number;
  /**
   * The wake word model, when there is one. Absent means the old path: her
   * name looked for in whatever whisper wrote down.
   */
  detector?: WakeDetector | null;
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
  /** How long the microphone may send nothing at all before she says so. */
  deadMs?: number;
  /**
   * The quiet that has to have followed her name for it to count as all he
   * said, measured at the moment the model fires and then for `nameWatchMs`
   * after. 0 turns the early answer off and leaves it to the transcript.
   * See NAME_QUIET_MS.
   */
  nameQuietMs?: number;
  nameWatchMs?: number;
}

/**
 * How quiet the room has to stay around her name for him to have stopped there.
 *
 * The model fires a median 330ms after "Vela" ends. Quiet that long already,
 * and then for NAME_WATCH_MS more, is half a second of nothing after an
 * address, which is a man waiting to be answered; "Hey Vela, what time is it"
 * in one breath has the next word inside 200ms.
 *
 * The watch is short for a measured reason. The chime is played the instant
 * the model fires, and its echo reaches the microphone 300ms later at -39
 * dBFS, which is speech as far as the gate can tell. The decision has to be
 * made before that arrives, and then the hold puts the echo where it belongs.
 */
export const NAME_QUIET_MS = 200;
export const NAME_WATCH_MS = 200;

/** How far back a missed "Hey Vela" can be, and how long one can last. */
const MISSED_WITHIN_MS = 10_000;
const MISSED_LONGEST_MS = 3_000;

/**
 * How long after a conversation runs out something nameless is still worth
 * reporting as him having carried on. Past this it is the room, and saying so
 * would only be a transcript of the room in the log.
 */
export const LAPSED_WITHIN_MS = 120_000;

/**
 * Quieter than any room: digital silence, give or take a bit of dither.
 *
 * A muted or wedged device does not end the capture — it keeps delivering
 * samples, and every one of them is zero. His microphone did exactly that on
 * 2026-09-30 and read -104 to -110 dBFS through every Windows audio API, where
 * the quietest real room it has ever measured sits around -75.
 */
export const DEAD_DB = -95;

/**
 * Listen to the room until told to stop.
 *
 * Everything above is a pure function or a state machine over bytes. This is
 * the part that owns a microphone, so it is the part that has to survive the
 * microphone going away.
 */
/**
 * The utterance with the address taken off the front.
 *
 * matchWake first, because when whisper did write the name down that is the
 * exact cut. When it did not — which is the normal case for a name it has
 * never seen — the model still heard the phrase, so something at the front of
 * this sentence is it. "Hey <something>," is that shape, and taking it is
 * better than handing the model's own trigger back to her as the question.
 */
export function afterAddress(text: string, words: string[], requireLead = false): string {
  const woken = matchWake(text, words, requireLead);
  if (woken.heard) return woken.rest;
  // The separator after the name is optional at the very end: "Hey fellow"
  // with nothing after it is the address and only the address. "Hello" is not
  // a lead-in here, because it is what whisper makes of the whole address —
  // "Hello, are you there?" — and the word after it belongs to the question.
  const lead = /^\s*(hey|hi|ok|okay)[\s,]+[a-z']+(?:[\s,.!?-]+|$)/i.exec(text);
  return (lead ? text.slice(lead[0].length) : text).trim();
}

/**
 * How long after an utterance closes a detection can still land in it.
 *
 * Measured, the spotter fires a median 330ms and at most 560ms after the end
 * of "Vela", and the gate waits 700ms of quiet before it closes — so the fire
 * is nearly always inside the utterance already. This covers the rest, and a
 * gate told to close sooner than that.
 */
export const FIRE_LATE_MS = 600;

/** When an utterance began and ended, by the listener's clock. */
interface Span {
  from: number;
  to: number;
  /** Where it closed in the audio itself. See Segmenter.heard. */
  heard: number;
}

/** One thing the gate cut out of the room. */
interface Heard {
  pcm: Buffer;
  level: number;
  span: Span;
  ms: number;
  /** It turned out to be something she acted on. See `recent`. */
  used: boolean;
  /** Whose voice, asked the moment it was cut. See WakeTrigger.who. */
  who: Promise<Identity | null>;
  /** Whisper's read of it, already started during the pause before the close. */
  early: Promise<string> | null;
}

export function startWakeListener(opts: WakeOptions): WakeListener {
  const now = opts.now ?? Date.now;
  const detector = opts.detector ?? null;
  const followUpMs = opts.followUpMs ?? 8_000;
  const followUps = opts.followUps ?? 6;
  const reopenMs = opts.reopenMs ?? [1_000, 2_000, 5_000, 15_000, 30_000];
  const nameQuietMs = opts.nameQuietMs ?? NAME_QUIET_MS;
  const nameWatchMs = opts.nameWatchMs ?? NAME_WATCH_MS;

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
  let pending: Heard | null = null;

  /**
   * What the gate cut out of the room lately, for onMissed. `used` once it
   * turned out to be something — a turn, a goodbye, her name — so that only
   * what she ignored can be reported as something she should not have.
   */
  let recent: Heard[] = [];
  const sessionOpen = () => followUpMs > 0 && followLeft > 0 && now() < followUntil;

  const reportMissed = () => {
    if (!opts.onMissed) return;
    const t = now();
    recent = recent.filter((e) => t - e.span.to <= MISSED_WITHIN_MS);
    // Anything that closed inside the firing window is this address, not an
    // earlier attempt at it.
    const missed = recent.filter(
      (e) => !e.used && e.ms <= MISSED_LONGEST_MS && fireAt > e.span.to + FIRE_LATE_MS,
    );
    // Reported once. The next address must not find the same miss again.
    for (const e of missed) e.used = true;
    if (missed.length) {
      opts.onMissed(missed.map((e) => ({ pcm: e.pcm, level: e.level, agoMs: t - e.span.to })));
    }
  };

  /**
   * When the model last fired, and the last firing an utterance claimed.
   *
   * A detection belongs to one utterance, the one it landed in, and is spent
   * by it. It used to be good for six seconds instead, and that was two bugs:
   * a command longer than six seconds lost its address, and the sentence after
   * "Hey Vela" was taken as addressed too — so "okay, what time is it" had
   * "okay, what" cut off the front as though it were her name.
   */
  let fireAt = -Infinity;
  let claimedAt = -Infinity;
  let lastCloseAt = -Infinity;
  /** The same two moments, measured in the audio rather than on the clock. */
  let fireHeard = -Infinity;
  let claimedHeard = -Infinity;
  /** The detection her name was answered for early. See nameAlone. */
  let answeredAt = -Infinity;
  const hangoverMs = opts.segment?.hangoverMs ?? 700;

  /** An unclaimed detection landed inside this utterance. */
  const firedIn = (span: Span) =>
    fireAt > claimedAt && fireAt >= span.from && fireAt <= span.to + FIRE_LATE_MS;

  const claim = (span: Span): boolean => {
    const hit = firedIn(span);
    if (hit) {
      claimedAt = fireAt;
      claimedHeard = fireHeard;
    }
    return hit;
  };

  /**
   * Did anything come after her name, or was it only the address?
   *
   * Whisper's spelling cannot answer this: "Hey Vela" on its own came back as
   * "Hey fellow", which reads like an address followed by a word, and went to
   * the model as a question. When it fired can. The model fires a third of a
   * second after "Vela" ends and the gate closes 0.7s after the last sound, so
   * if the utterance closed less than the gate's own wait after the detection,
   * nothing followed the name at all.
   */
  const onlyTheName = (span: Span) => span.heard - claimedHeard < hangoverMs;
  /** The same test at the close, before any claim has been made. */
  const moreThanTheName = (span: Span) => span.heard - fireHeard >= hangoverMs;

  const consider = (text: string, heard: Heard) => {
    const { level, span } = heard;
    // Her name, already answered the moment he stopped. If the gate closed
    // around it before then, it is still on its way through whisper, and it is
    // only the name: spent, not a nameless sentence in the window it opened.
    if (detector && answeredAt >= span.from && answeredAt <= span.to + FIRE_LATE_MS) {
      heard.used = true;
      return;
    }
    const woken = matchWake(text, opts.words, opts.requireLead);
    /**
     * Was this said to her?
     *
     * With a model, that is the model's answer and nothing else — what whisper
     * wrote down has no say in it, which is the entire point: the transcript
     * was never able to carry a name it could not spell. Without one, the old
     * path, unchanged.
     */
    const wasOpen = sessionOpen();
    const addressed = detector ? claim(span) : woken.heard;
    if (addressed) {
      heard.used = true;
      if (!wasOpen) reportMissed();
    }
    // What is left once the address is off the front. The model heard "hey
    // vela"; whisper may have written something else down for it.
    const rest = detector
      ? addressed && onlyTheName(span)
        ? ""
        : afterAddress(text, opts.words ?? [], opts.requireLead)
      : woken.rest;
    // Judged on when he started, not on when whisper finished reading it. A
    // sentence begun inside the window is a reply, however long it ran and
    // however long it took to transcribe; asked at the end instead, a reply
    // that started with a second to spare arrived after the deadline.
    const following = followUpMs > 0 && followLeft > 0 && span.from < followUntil;
    opts.onHeard?.({ text, woke: (addressed || following) && Boolean(text), level });

    if (addressed && !rest) {
      // Just her name. She answers, and the window means the next thing he
      // says needs no name at all.
      //
      // Before the empty-transcript check, not after it. With a model, whisper
      // throwing the audio away is not evidence against the model: "Hey Vela"
      // on its own is short, scores as doubtful, and was being dropped by the
      // silence bar — which left him with a model that heard him and an
      // assistant that did not answer.
      arm();
      opts.onName?.(woken.word || (detector ? "model" : ""), { paused: false });
      return;
    }
    if (!text) return;

    const said = addressed ? rest : following ? text : "";
    if (!said) {
      // Nameless, and the conversation it would have belonged to has just
      // run out. followUntil is zeroed by a goodbye, so a session he ended
      // himself is never reported as one that lapsed on him.
      const lateMs = span.from - followUntil;
      const spent = followLeft <= 0 && lateMs < 0;
      const opened = followUpMs > 0 && followUntil > 0;
      if (opened && lateMs <= LAPSED_WITHIN_MS && (lateMs >= 0 || spent)) {
        opts.onLapsed?.({ text, lateMs: Math.max(0, lateMs), spent });
      }
      return;
    }
    heard.used = true;

    // Him letting her go ends it now, rather than leaving her listening
    // through the timer he has just made unnecessary.
    //
    // Judged on the sentence whole, not on `rest`. isDismissal already knows
    // to step over a lead-in and her name, whereas afterAddress is guessing at
    // where a name it cannot see was — and inside the detection window "okay,
    // you can go now" carries no name, so the guess takes "you" and the phrase
    // no longer matches.
    if (isDismissal(text, opts.dismissals, opts.words)) {
      followUntil = 0;
      followLeft = 0;
      opts.onDismiss?.();
      return;
    }

    if (addressed) arm();
    else {
      // Measured from the last thing said to her, so a conversation stays
      // open for as long as it is still a conversation.
      followLeft--;
      followUntil = now() + followUpMs;
    }
    // A long sentence that ends with him leaving: answered, then over. Closed
    // here rather than after her reply, so nothing he says while she answers
    // is taken as a follow-up he never meant.
    const leaving = endsInGoodbye(text, GOODBYES, opts.words);
    if (leaving) {
      followUntil = 0;
      followLeft = 0;
    }
    opts.onCommand(said, {
      word: woken.word || (detector ? "model" : ""),
      followUp: !addressed,
      who: heard.who,
      leaving,
    });
  };

  const drain = async () => {
    if (working) return;
    working = true;
    try {
      while (pending && !stopped) {
        const heard = pending;
        pending = null;
        // Held between being captured and being read means she started
        // talking over it, and it is very likely her own voice.
        if (held) continue;
        const text = await (heard.early ?? opts.hear(heard.pcm)).catch(() => "");
        if (!stopped && !held) consider(text, heard);
      }
    } finally {
      working = false;
    }
  };

  /**
   * Whisper's read of the utterance that is still open, started in a pause.
   *
   * The gate waits a whole second of quiet before it closes, because he
   * pauses mid-thought and being cut off costs the question. Whisper used to
   * start only after that second, and took half a second more. Now it starts
   * a third of the way in, on what has been said so far: if nothing more is
   * said before the close, that read is the transcript and it is already done.
   * If he carries on, it is thrown away and the whole sentence is read as
   * before, so starting early can cost a read but never a word.
   */
  let early: { utterance: number; at: number; text: Promise<string> } | null = null;

  const segmenter = createSegmenter((pcm, level) => {
    // Taken whatever happens next, so an early read can never be handed to a
    // later sentence than the one it was made from.
    const read = early;
    early = null;
    if (stopped || held) return;
    const ms = Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000);
    opts.onCaptured?.({ ms, level });
    lastCloseAt = now();
    const span = { from: lastCloseAt - ms, to: lastCloseAt, heard: segmenter.heard() };
    // Asked now rather than once it is known to be a turn, so the voice is
    // worked out in the time whisper is already taking.
    const who = opts.who ? opts.who(pcm).catch(() => null) : Promise.resolve(null);
    // Good only if this is the utterance it was read from, and nothing loud
    // has been heard since it was taken.
    const usable =
      read && read.utterance === segmenter.opened() && segmenter.lastLoud() <= read.at ? read.text : null;
    pending = { pcm, level, span, ms, used: false, who, early: usable };
    recent.push(pending);
    if (recent.length > 20) recent.shift();
    if (detector && firedIn(span) && moreThanTheName(span)) opts.onAsked?.();
    void drain();
  }, opts.segment, (pcm) => {
    if (stopped || held) return;
    early = { utterance: segmenter.opened(), at: segmenter.heard(), text: opts.hear(pcm).catch(() => "") };
  });

  /**
   * A detection that may turn out to be her name and nothing else, watched
   * until the room says which. See NAME_QUIET_MS.
   */
  let watching: { from: number; until: number } | null = null;

  /**
   * Her name was all he said, and he has stopped: answer it now.
   *
   * The utterance holding the name is still open — the gate waits a second of
   * quiet before it closes — and it is thrown away here rather than left to
   * close. Spent, it would reach whisper as a nameless sentence inside the
   * window this has just opened, and "Hey fellow" would go to the model as a
   * question, which is the exact thing answering early is for.
   */
  const nameAlone = () => {
    const wasOpen = sessionOpen();
    claimedAt = fireAt;
    claimedHeard = fireHeard;
    answeredAt = fireAt;
    segmenter.reset();
    arm();
    if (!wasOpen) reportMissed();
    opts.onName?.("model", { paused: true });
  };

  /** Called with every chunk while a detection is being watched. */
  const watch = () => {
    if (!watching) return;
    // Anything over the bar after the detection is him carrying on, so it
    // was an address with a question behind it and the transcript decides.
    if (segmenter.lastLoud() > watching.from) watching = null;
    else if (segmenter.heard() >= watching.until) {
      watching = null;
      nameAlone();
    }
  };

  detector?.onFire(() => {
    if (stopped || held) return;
    fireAt = now();
    fireHeard = segmenter.heard();
    watching = null;
    opts.onWake?.();
    // Nothing open, and nothing that just closed: the phrase never got loud
    // enough to open the gate, so no transcript is coming to claim it. The
    // model still heard her name said to her, and he is waiting on an answer.
    if (!segmenter.speaking() && fireAt - lastCloseAt > FIRE_LATE_MS) {
      nameAlone();
      return;
    }
    if (nameQuietMs > 0 && fireHeard - segmenter.lastLoud() >= nameQuietMs) {
      watching = { from: fireHeard, until: fireHeard + nameWatchMs };
      watch();
    }
  });

  /**
   * A microphone sending pure silence, said out loud rather than left to look
   * like her ignoring him. It is invisible otherwise: no utterance ever
   * closes, nothing reaches whisper, the wake word never fires, and every
   * part of her is working exactly as designed on an input of zeros.
   *
   * Only before the room has been heard at all. His microphone gates itself —
   * Acer PurifiedVoice cuts a quiet room to digital zero between sentences —
   * so once a capture has carried any sound, zeros are that gate closing and
   * not a fault. Taking them for one printed a warning every time he stopped
   * talking, and it misled the diagnosis of the thing it was built to find.
   */
  const deadMs = opts.deadMs ?? 10_000;
  let silentMs = 0;
  let dead = false;
  /** This capture has carried real sound, so its silences are the gate's. */
  let proven = false;
  const listenForDeath = (chunk: Buffer) => {
    if (levelDb(chunk) >= DEAD_DB) {
      if (dead) opts.onProblem?.("the microphone is hearing the room again.");
      dead = false;
      proven = true;
      return;
    }
    if (proven || dead) return;
    silentMs += (chunk.length / 2 / SAMPLE_RATE) * 1000;
    if (silentMs >= deadMs) {
      dead = true;
      // Both causes named, because the gate is indistinguishable from a dead
      // microphone until someone speaks, and this line should not cry wolf.
      opts.onProblem?.(
        "the microphone has sent only digital silence since it opened: a quiet room behind a" +
          " noise gate like Acer PurifiedVoice, or a muted mic. If she misses him once he speaks," +
          " check the mute key and Windows sound settings.",
      );
    }
  };

  const open = () => {
    if (stopped) return;
    // A capture reopened after dying has to prove itself again.
    proven = false;
    silentMs = 0;
    mic = openMic(opts.device, {
      ffmpeg: opts.ffmpeg,
      spawn: opts.spawn,
      onAudio: (chunk) => {
        listenForDeath(chunk);
        if (held) return;
        opts.onAudio?.(chunk);
        segmenter.push(chunk);
        watch();
        // The same bytes, scored in parallel. The model needs the whole
        // stream, not the pieces the loudness gate decided were utterances —
        // it is the thing that decides what was speech.
        detector?.push(chunk);
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
      watching = null;
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

    open() {
      if (stopped) return;
      arm();
      // Pressed while she is talking: the window he gets is measured from
      // when she stops, the same as one her name opened.
      if (held) followOwed = true;
    },

    stop() {
      stopped = true;
      pending = null;
      mic?.close();
    },
  };
}
