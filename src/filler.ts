/**
 * "One sec", only when she is actually slow.
 *
 * The filler was his idea, from when every spoken turn took three or four
 * seconds on Opus and the silence after a question read as her not having
 * heard. It was said the moment he stopped, on every turn. Once talking moved
 * to Sonnet her answer usually starts within a second, and a "Hang on." in
 * front of every reply became the noise he asked to be rid of: "the filler
 * words should be used only when necessary."
 *
 * So it waits. If her reply has started by the time it would be said, it is
 * never said. If she goes to work with nothing said at all, the wait is over
 * and it is said at once, because a tool call is seconds of silence that has
 * already begun.
 */
/**
 * Whether what he asked is something to do or something to find out.
 *
 * "Let me see" before turning on Netflix sounds like she isn't sure she can,
 * and he noticed. A filler should say what she is doing: an instruction gets
 * "On it", a question gets "Let me see". Read off the first word that isn't
 * politeness, which in English is the verb of a request.
 */
export type FillerKind = "doing" | "finding";

const POLITE = /^(?:(?:hey|vela|okay|ok|so|um+|uh+|and|also|just|please|now|right|can you|could you|would you|will you|i want you to|i need you to|go ahead and)\s+)+/;

/** Verbs that ask her to do something, rather than to tell him something. */
export const DOING = new Set([
  "turn", "switch", "open", "close", "put", "play", "pause", "resume", "start", "stop", "set",
  "change", "make", "send", "add", "remind", "remember", "save", "note", "write", "create", "delete",
  "remove", "move", "book", "order", "call", "text", "email", "schedule", "launch", "run", "mute",
  "unmute", "raise", "lower", "increase", "decrease", "skip", "go", "take", "clear", "cancel",
  "install", "update", "forget", "watch",
]);

export function fillerKind(asked: string): FillerKind {
  const t = asked.toLowerCase().replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();
  if (DOING.has(t.replace(POLITE, "").split(" ")[0] ?? "")) return "doing";
  // Whisper garbles the front of a sentence often enough that the request is
  // somewhere inside it: "what question can you also can you turn on Netflix".
  // Word by word, because a match would swallow the "can" of the second "can
  // you" in that.
  const words = t.split(" ");
  for (let i = 0; i + 2 < words.length; i++) {
    if (!["can", "could", "would", "will"].includes(words[i]) || words[i + 1] !== "you") continue;
    let j = i + 2;
    while (["also", "just", "please"].includes(words[j])) j++;
    if (DOING.has(words[j] ?? "")) return "doing";
  }
  return "finding";
}

export interface Filler {
  /**
   * A question is on its way to her. `since` is when the gate closed on it,
   * which is the moment the silence he is sitting in started counting. Said
   * at most once per turn however many times it is called.
   */
  expect: (since: number) => void;
  /** Her reply has begun. Nothing to fill. */
  started: () => void;
  /** She has gone to a tool. If nothing of hers has been heard, fill now. */
  working: () => void;
  /** The turn is over, or was never one: a goodbye, her name alone. */
  reset: () => void;
}

export function createFiller(opts: {
  /** Say the filler. Choosing which one is the caller's business. */
  say: () => void;
  /** How long after the gate closed before silence needs filling. */
  afterMs: number;
  now?: () => number;
}): Filler {
  const now = opts.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Something of hers has been heard this turn: the filler, or the reply. */
  let heard = false;

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const fill = () => {
    stop();
    if (heard) return;
    heard = true;
    opts.say();
  };

  return {
    expect(since) {
      if (timer || heard) return;
      timer = setTimeout(fill, Math.max(0, opts.afterMs - (now() - since)));
      timer.unref?.();
    },
    started() {
      stop();
      heard = true;
    },
    working() {
      fill();
    },
    reset() {
      stop();
      heard = false;
    },
  };
}
