import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Which build of herself she's running.
 *
 * package.json said 1.0.0 through three releases because nothing read it and
 * nothing bumped it, which made it a decoration rather than a fact. Two halves
 * fix that: the version is the number a human bumps when she gains a sense,
 * and the commit under it pins down exactly which code that number was.
 */

/** Enough of a sha to be unambiguous, short enough to read in a banner. */
const SHORT = 7;

export function readVersion(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * HEAD's commit, read straight out of .git. Shelling out to git would put a
 * process launch in front of every start; this is at most three small reads,
 * and she already has a Kokoro model to load.
 */
export function readCommit(gitDir: string): string | null {
  const read = (relative: string): string | null => {
    try {
      return readFileSync(join(gitDir, relative), "utf8").trim();
    } catch {
      return null;
    }
  };

  const head = read("HEAD");
  if (!head) return null;
  // Detached: HEAD holds the sha itself rather than pointing at a branch.
  if (/^[0-9a-f]{40}$/i.test(head)) return head.slice(0, SHORT);

  const ref = head.match(/^ref:\s*(\S+)/)?.[1];
  if (!ref) return null;

  const loose = read(ref);
  if (loose && /^[0-9a-f]{40}$/i.test(loose)) return loose.slice(0, SHORT);

  // After a gc the branch has no file of its own; it's a line in packed-refs.
  for (const line of (read("packed-refs") ?? "").split(/\r?\n/)) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && /^[0-9a-f]{40}$/i.test(sha)) return sha.slice(0, SHORT);
  }
  return null;
}

/** "1.3.0 (c5e439d)", degrading to whichever half could be found. */
export function describe(version: string | null, commit: string | null): string {
  if (!version) return commit ? `(${commit})` : "";
  return commit ? `${version} (${commit})` : version;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The released number, and what she says when he asks what version she is. */
export const VERSION = readVersion(root) ?? "0.0.0";
/** The same, with the commit — for the banner, where it settles arguments. */
export const BUILD = describe(readVersion(root), readCommit(join(root, ".git")));
