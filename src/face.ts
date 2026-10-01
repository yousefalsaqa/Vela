import { randomBytes } from "node:crypto";

/**
 * Her face: a reaction, pulled for a few seconds and gone.
 *
 * His request, in his words: "if I say something stupid she can just put the
 * face of -_-". A screen is the wrong tool for that. It is a page she has to
 * write, it replaces whatever she was showing, and it stays until something
 * takes it down — by which time the joke is a minute old. A face is drawn by
 * the hub from a fixed set, lands in the time a tool call takes, sits over the
 * conversation rather than in place of the stage, and leaves on its own.
 *
 * Module state as the bus, the same way screen.ts is: the tool, the core and
 * the server all run in one process.
 */
export const FACES = [
  "deadpan",
  "side-eye",
  "happy",
  "laugh",
  "surprised",
  "thinking",
  "wince",
  "smug",
] as const;

export type Face = (typeof FACES)[number];

export interface Expression {
  /** Identity, so a hub can tell a second deadpan from the first one again. */
  id: string;
  face: Face;
  /** A word or two under it. "bruh." */
  caption?: string;
}

/** Long enough to read a caption under it, short enough to stay a reaction. */
export const CAPTION_MAX = 40;

type FaceListener = (expression: Expression) => void;
const listeners = new Set<FaceListener>();

/**
 * Pull a face. Refusals come back as sentences, because the reader is the
 * model and the sentence is the fix.
 */
export function express(face: string, caption?: string): string {
  if (!(FACES as readonly string[]).includes(face)) {
    return `There is no "${face}" face. She has: ${FACES.join(", ")}.`;
  }
  const words = caption?.trim();
  if (words && words.length > CAPTION_MAX) {
    return `That caption is ${words.length} characters; a face takes ${CAPTION_MAX} at most. Cut it to a word or two.`;
  }
  const expression: Expression = {
    id: randomBytes(4).toString("hex"),
    face: face as Face,
    ...(words ? { caption: words } : {}),
  };
  for (const l of [...listeners]) l(expression);
  return `Pulled a ${face} face${words ? ` captioned "${words}"` : ""}. It goes by itself in a few seconds.`;
}

/** Hear every face she pulls. Returns an unsubscribe function, like onScreen. */
export function onFace(listener: FaceListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
