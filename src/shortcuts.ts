/**
 * TV commands she does without asking the model.
 *
 * Measured in his first session with the TV tools: "can you pause it?" took
 * 4.0s of model before she said a word, because a tool turn is the model
 * deciding to use the tool, the TV doing it, and the model again to talk
 * about it. Pause, play, louder, mute and off don't need thinking about, and
 * he said as much: do it, don't tell me you did it. So a short, whole command
 * is recognised from whisper's text and done directly, and she stays quiet
 * when it works, because the TV doing it is the answer.
 *
 * Deliberately narrow. Only the whole utterance counts, after the politeness
 * around it is taken off; anything with more in it ("pause it, I want to ask
 * you something") goes to the model as before. A missed shortcut costs the
 * old four seconds. A wrong one does something to his TV he didn't ask for.
 */

export type TvIntent =
  | { kind: "remote"; button: "play" | "pause" }
  | { kind: "volume"; by?: number; to?: number; mute?: boolean }
  | { kind: "power"; on: boolean }
  /** "Resume my show": Netflix's last Continue Watching, by its link. */
  | { kind: "resume" }
  /** "Turn on Netflix": open an app on the TV, nothing more. */
  | { kind: "open"; app: string };

/** A step for "louder", the same sizes the tool tells the model to use. */
export const STEP = { little: 3, plain: 5, lot: 10 } as const;

/** What people put around a command that isn't the command. Taken off both ends. */
const LEAD = /^(?:(?:okay|ok|alright|right|um+|uh+|so|hey|vela|please|yeah|and|now|just|go ahead and|can you|could you|would you|will you|can u)\s+)+/;
const TAIL = /(?:\s+(?:please|for me|now|thanks|thank you|real quick|quickly|vela))+$/;

/** Lower case, words only, politeness off. "Okay, can you pause it please?" -> "pause it". */
export function bare(text: string): string {
  let t = text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  for (let last = ""; last !== t; ) {
    last = t;
    t = t.replace(LEAD, "").replace(TAIL, "").trim();
  }
  return t;
}

/** "it", "the tv", "netflix", "the show": what a transport command may be about. */
const THING = "(?:it|that|this|the tv|tv|the telly|netflix|the show|the episode|the movie|the film)";
const TV = "(?:the tv|tv|the telly|the television)";

/** His apps, as he says them. Opening one is only ever about the TV: it is where he watches them. */
const APP = "(netflix|youtube|disney plus|disney|crave|spotify|twitch|prime video|prime)";

const RULES: { pattern: RegExp; intent: (m: RegExpMatchArray) => TvIntent }[] = [
  {
    pattern: new RegExp(`^(?:(?:turn on|put on|open|start|launch|bring up|go to) ${APP}|put ${APP} on)(?: on ${TV})?$`),
    intent: (m) => ({ kind: "open", app: m[1] ?? m[2] }),
  },
  { pattern: new RegExp(`^pause(?: ${THING})?$`), intent: () => ({ kind: "remote", button: "pause" }) },
  // "Stop" alone could be him telling her to stop talking; with the show named it can't.
  { pattern: /^stop (?:the show|netflix|the episode|the movie|the film|the tv)$/, intent: () => ({ kind: "remote", button: "pause" }) },
  { pattern: new RegExp(`^(?:un ?pause|play|resume|keep playing|carry on playing)(?: ${THING})?$`), intent: () => ({ kind: "remote", button: "play" }) },
  {
    pattern: new RegExp(
      `^(?:(?:resume|continue|put on|play) (?:my show|my series|what i was watching|where i left off)|put (?:my show|my series|what i was watching) (?:back )?on)(?: on ${TV})?$`,
    ),
    intent: () => ({ kind: "resume" }),
  },
  { pattern: new RegExp(`^(?:(?:turn|switch|shut) (?:off ${TV}|${TV} off)|shut down ${TV}|${TV} off)$`), intent: () => ({ kind: "power", on: false }) },
  { pattern: new RegExp(`^(?:turn (?:on ${TV}|${TV} on)|${TV} on|switch (?:on ${TV}|${TV} on))$`), intent: () => ({ kind: "power", on: true }) },
  { pattern: new RegExp(`^(?:mute|mute ${THING})$`), intent: () => ({ kind: "volume", mute: true }) },
  { pattern: new RegExp(`^(?:unmute|unmute ${THING})$`), intent: () => ({ kind: "volume", mute: false }) },
  {
    pattern: /^(?:(?:set )?(?:the )?volume (?:to |on |at )?|(?:turn|put|set) (?:it|the volume) (?:to|on|at) )(\d{1,3})$/,
    intent: (m) => ({ kind: "volume", to: Number(m[1]) }),
  },
  {
    pattern: new RegExp(
      `^(?:(?:make (?:it|the tv) )?(a (?:little |tiny )?bit |a little |slightly )?(louder|quieter|softer)|turn (?:${THING}|the volume) (up|down)(?: (a (?:little |tiny )?bit|a little|slightly|a lot|loads))?|turn (up|down) (?:${THING}|the volume)(?: (a (?:little |tiny )?bit|a little|slightly|a lot))?|volume (up|down)|(way|much|a lot) (louder|quieter)|(raise|increase|lower|decrease) (?:the volume|the tv|it)(?: (a (?:little |tiny )?bit|a little|slightly|a lot))?)$`,
    ),
    intent: (m) => {
      const word = m[2] ?? m[3] ?? m[5] ?? m[7] ?? m[9] ?? m[10];
      const size = m[1] ?? m[4] ?? m[6] ?? m[8] ?? m[11];
      const up = word === "louder" || word === "up" || word === "raise" || word === "increase";
      const step = !size ? STEP.plain : /lot|loads|way|much/.test(size) ? STEP.lot : STEP.little;
      return { kind: "volume", by: up ? step : -step };
    },
  },
];

/**
 * The TV command this whole utterance is, or null if it is anything more.
 *
 * `pause` and `play` on their own could mean Spotify on the laptop; the
 * caller asks whether the TV is on before taking them, and gives them to the
 * model if it isn't. Everything else names the TV, or is only about the TV.
 */
export function tvIntent(text: string): TvIntent | null {
  const t = bare(text);
  if (!t || t.split(" ").length > 9) return null;
  for (const rule of RULES) {
    const m = t.match(rule.pattern);
    if (m) return rule.intent(m);
  }
  return null;
}

/**
 * The TV command to do directly for this turn, or null to give it to the model.
 *
 * Only when it was said with her name. A follow-up (the seconds after she
 * answers, when she listens without it) can be him talking to someone else in
 * the room, and "pause" said to a friend should not stop the TV, silently and
 * at once. He asked for this. A follow-up goes to the model, which is slower
 * but can tell who he was talking to. A sentence that ends with him leaving
 * goes there too, so the goodbye is answered.
 */
export function shortcutFor(text: string, how: { followUp: boolean; leaving: boolean }): TvIntent | null {
  if (how.followUp || how.leaving) return null;
  return tvIntent(text);
}

/** Whether this intent is a bare transport word that could be about the laptop as easily as the TV. */
export function couldBeLaptop(text: string, intent: TvIntent): boolean {
  if (intent.kind !== "remote") return false;
  return !/\b(?:tv|telly|television|netflix|show|episode|movie|film)\b/.test(bare(text));
}

/**
 * Whether what the TV said means it did this. She stays quiet when it worked
 * and says the sentence when it didn't, so this has to know how each action
 * reports success, and success depends on what was asked: "The TV is off." is
 * a turn-off done, and a pause that never happened. "Already" counts: he
 * wanted it muted, and it is.
 */
export function worked(intent: TvIntent, said: string): boolean {
  switch (intent.kind) {
    case "remote":
      return said.startsWith("Pressed ");
    case "volume":
      return /^(?:Volume \d|Muted\.|Unmuted|It's already|It isn't muted)/.test(said);
    case "power":
      return intent.on ? said === "The TV is on." : /^The TV is (?:off\.|already off)/.test(said);
    case "resume":
      return said.startsWith("Playing ");
    case "open":
      return said.endsWith(" is open on the TV.");
  }
}

/** What she did, for the model to be told on his next turn, so it isn't a secret from her. */
export function didLine(intent: TvIntent): string {
  switch (intent.kind) {
    case "remote":
      return `${intent.button === "pause" ? "paused" : "played"} the TV`;
    case "power":
      return `turned the TV ${intent.on ? "on" : "off"}`;
    case "resume":
      return "resumed his show on Netflix";
    case "open":
      return `opened ${intent.app} on the TV`;
    case "volume":
      if (intent.mute !== undefined) return intent.mute ? "muted the TV" : "unmuted the TV";
      return intent.to !== undefined ? `set the TV volume to ${intent.to}` : `turned the TV ${intent.by! > 0 ? "up" : "down"}`;
  }
}
