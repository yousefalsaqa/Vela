import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

/**
 * Where her own files go, resolved from the source rather than cwd, so a
 * capture taken from the service and one taken from the REPL land in the same
 * folder.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = resolve(here, "../data");
export const SCREEN_DIR = join(DATA_DIR, "screen");

/**
 * Name a capture file.
 *
 * Random rather than a timestamp, for the reason screen.ts already settled:
 * an id names one thing, a clock orders things, and two captures inside the
 * same second must not be the same file. The label is only there so the folder
 * is readable later, so it is squeezed down to letters and dashes and
 * anything else he typed is dropped rather than escaped.
 */
export function captureName(label: string, id = randomBytes(3).toString("hex")): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug ? `capture-${slug}-${id}.png` : `capture-${id}.png`;
}

/** The absolute path for a new capture, with the folder made if it isn't there. */
export function captureFile(label: string, dir = SCREEN_DIR): string {
  mkdirSync(dir, { recursive: true });
  return join(dir, captureName(label));
}
