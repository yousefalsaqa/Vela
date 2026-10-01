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
