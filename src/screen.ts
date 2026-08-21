import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { extname } from "node:path";

/**
 * The screen: what she is currently showing on the hub's stage, if anything.
 *
 * Module state is the bus, the same way memory.ts holds the store. The tool
 * handlers, the core and the server all live in one process — tools run where
 * the core runs, and the server sits beside it in serve.ts — so a shared
 * module is the simplest thing that is actually true.
 *
 * Deliberately in-memory: a screen is conversational ephemera, and a service
 * restart clears it the same way it clears the session.
 */

export interface Screen {
  /**
   * Identity, not a timestamp. "Go back to the engine" and "compare these
   * two" need a name that survives being superseded; shownAt orders showings,
   * this names one. Random rather than a counter so a restarted service can't
   * mint an id that's already in the transcript meaning something else.
   */
  id: string;
  title: string;
  /** Absolute path of the file being shown. Never leaves this process. */
  path: string;
  note?: string;
  shownAt: number;
}

/** What a face is told. The path stays here — a browser has no use for his filesystem layout. */
export interface ScreenMeta {
  id: string;
  title: string;
  note?: string;
  shownAt: number;
}

/**
 * What the hub can be handed, by extension. HTML is the interactive case; the
 * rest exist so "show me the schematic" works when the schematic is a file
 * that already exists rather than a page she writes.
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
};

export function contentTypeFor(path: string): string | null {
  return TYPES[extname(path).toLowerCase()] ?? null;
}

export function publicScreen(screen: Screen | null): ScreenMeta | null {
  if (!screen) return null;
  return {
    id: screen.id,
    title: screen.title,
    shownAt: screen.shownAt,
    ...(screen.note !== undefined ? { note: screen.note } : {}),
  };
}

type ScreenListener = (screen: ScreenMeta | null) => void;

let shown: Screen | null = null;
const listeners = new Set<ScreenListener>();

const notify = () => {
  const meta = publicScreen(shown);
  for (const l of [...listeners]) l(meta);
};

/**
 * Put a file on the screen. Refusals come back as sentences rather than
 * throws, because the reader is the model and the message is the fix.
 * A refusal changes nothing: whatever was up stays up, and nobody is
 * notified, because the hub re-rendering on a failure would blank a good
 * screen over a typo.
 */
export function present(opts: { title: string; path: string; note?: string }): string {
  if (!existsSync(opts.path)) {
    return `Nothing at ${opts.path}. Write the file first, then show it.`;
  }
  if (!contentTypeFor(opts.path)) {
    const ext = extname(opts.path) || "no extension";
    return (
      `The screen can't render ${ext}. It takes .html (interactive pages), ` +
      `.svg, .png, .jpg, .webp, .gif, or .pdf.`
    );
  }
  shown = {
    id: randomBytes(4).toString("hex"),
    title: opts.title,
    path: opts.path,
    shownAt: Date.now(),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  };
  notify();
  return `On the screen: ${opts.title}.`;
}

/** Take it down. A no-op clear stays silent — nothing changed, so nobody re-renders. */
export function clear(): string {
  if (!shown) return "The screen is already empty.";
  shown = null;
  notify();
  return "Cleared the screen.";
}

/** What is up right now. The server reads this to serve the file and to restore a reloaded hub. */
export function current(): Screen | null {
  return shown;
}

/** Hear about every change. Returns an unsubscribe function, like core.subscribe. */
export function onScreen(listener: ScreenListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
