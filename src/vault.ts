import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Vela's memory as an Obsidian vault: one markdown note per thing she knows.
 *
 * A SQLite row is a fine place to put a fact and a terrible place to read one.
 * Notes are the opposite — Yousef can open the vault, see everything she
 * believes about him, fix what's wrong, and link notes together, and she picks
 * the edit up on the next read. The database still holds projects and watches,
 * which are operational state rather than things worth reading.
 *
 * There is no YAML parser here on purpose. The frontmatter this writes is a
 * handful of scalar keys and one inline list, and a dependency for that would
 * cost more than it's worth.
 */

export interface Note {
  /** The filename without .md, which is also how Obsidian links to it. */
  name: string;
  kind: string;
  tags: string[];
  created: string;
  updated: string;
  body: string;
  /** Frontmatter keys this code doesn't know about, kept so edits survive. */
  extra?: Map<string, string>;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Split a note into its frontmatter keys and its prose. Unknown keys are kept
 * in order: he may add his own, and a rewrite must not eat them.
 */
export function parseNote(text: string, name: string): Note {
  const match = FRONTMATTER.exec(text);
  const body = (match ? text.slice(match[0].length) : text).trim();

  const fields = new Map<string, string>();
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const at = line.indexOf(":");
      // Continuation lines and blanks aren't keys; skip rather than mangle.
      if (at <= 0 || /^\s/.test(line)) continue;
      fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  }

  const take = (key: string): string => {
    const value = fields.get(key) ?? "";
    fields.delete(key);
    return value;
  };

  const kind = take("kind") || "fact";
  const rawTags = take("tags");
  const created = take("created");
  const updated = take("updated");

  return {
    name,
    kind,
    tags: parseTags(rawTags),
    created,
    updated: updated || created,
    body,
    extra: fields.size ? fields : undefined,
  };
}

/** Accepts `[a, b]`, `a, b`, or nothing. Obsidian writes the first. */
export function parseTags(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

export function formatNote(note: Note): string {
  const lines = [`kind: ${note.kind}`, `tags: [${note.tags.join(", ")}]`];
  if (note.created) lines.push(`created: ${note.created}`);
  if (note.updated) lines.push(`updated: ${note.updated}`);
  for (const [key, value] of note.extra ?? []) lines.push(`${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n\n${note.body.trim()}\n`;
}

/** Words not worth spending a filename on, and worse to end one with. */
const STOPWORDS = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "is",
  "of", "on", "or", "that", "the", "to", "with",
]);

/**
 * A filename from the fact itself, so the vault reads as a list of statements
 * rather than a list of hashes. Obsidian links by filename, which is the other
 * reason this has to be words.
 *
 * Cutting at a fixed word count strands whatever it lands on, and a name
 * ending "...engineering-from-queen" reads worse than one ending
 * "...engineering". Trailing filler goes.
 */
export function slugify(content: string, words = 6): string {
  const kept = content
    .toLowerCase()
    // Keep the shape of a sentence; drop everything a filename can't hold.
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, words);

  while (kept.length > 1 && STOPWORDS.has(kept[kept.length - 1])) kept.pop();

  const slug = kept.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return slug || "note";
}

export interface Vault {
  remember: (kind: string, content: string, tags?: string[]) => string;
  recall: (query?: string, kind?: string) => Note[];
  forget: (name: string) => string;
  all: () => Note[];
  dir: string;
}

/**
 * `today` is injected because a note's date is written into a file the tests
 * then assert on, and a real clock makes that unassertable.
 */
export function createVault(dir: string, today = () => new Date().toISOString().slice(0, 10)): Vault {
  mkdirSync(dir, { recursive: true });

  const read = (): Note[] => {
    const notes: Note[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      const path = join(dir, file);
      // A directory called something.md, or a file that vanished between the
      // listing and the read, must not take the assistant down.
      try {
        if (!statSync(path).isFile()) continue;
        notes.push(parseNote(readFileSync(path, "utf8"), file.slice(0, -3)));
      } catch {
        continue;
      }
    }
    return notes;
  };

  return {
    dir,

    remember(kind: string, content: string, tags: string[] = []) {
      const base = slugify(content);
      // Same fact saved twice updates the note. A different fact that happens
      // to open with the same words gets its own, rather than overwriting his.
      let name = base;
      for (let n = 2; ; n++) {
        const path = join(dir, `${name}.md`);
        if (!existsSync(path)) break;
        if (parseNote(readFileSync(path, "utf8"), name).body === content.trim()) break;
        name = `${base}-${n}`;
      }

      const path = join(dir, `${name}.md`);
      const now = today();
      const existing = existsSync(path)
        ? parseNote(readFileSync(path, "utf8"), name)
        : null;

      writeFileSync(
        path,
        formatNote({
          name,
          kind,
          tags,
          created: existing?.created || now,
          updated: now,
          body: content,
          extra: existing?.extra,
        }),
        "utf8",
      );
      return `Saved [[${name}]].`;
    },

    recall(query?: string, kind?: string) {
      const needle = query?.toLowerCase();
      return read()
        .filter((n) => (kind ? n.kind === kind : true))
        .filter((n) =>
          needle
            ? n.body.toLowerCase().includes(needle) ||
              n.name.toLowerCase().includes(needle) ||
              n.tags.some((t) => t.toLowerCase().includes(needle))
            : true,
        )
        .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.name < b.name ? -1 : 1))
        .slice(0, 40);
    },

    forget(name: string) {
      const path = join(dir, `${name.replace(/\.md$/, "")}.md`);
      if (!existsSync(path)) return `No memory called ${name}.`;
      rmSync(path, { force: true });
      return `Deleted ${name}.`;
    },

    all: read,
  };
}
