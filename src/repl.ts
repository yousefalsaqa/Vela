/**
 * Terminal presentation for the REPL. Pulled out of the loop in index.ts so
 * the escape sequences — the part that breaks silently and is invisible in a
 * transcript — can be asserted on.
 */

const EXIT_WORDS = new Set(["exit", "quit", "bye"]);

export function isExit(input: string): boolean {
  return EXIT_WORDS.has(input.trim().toLowerCase());
}

/**
 * An unprompted line from Vela, written over whatever prompt is on screen.
 * The caller redraws the prompt afterwards, which restores a half-typed line.
 */
export function interjection(
  name: string,
  message: string,
  isTty: boolean,
): string {
  if (!isTty) return `${name} › ${message}\n`;
  // \r\x1b[2K returns to the start of the line and erases it, so the message
  // lands where the prompt was instead of after it.
  return `\r\x1b[2K\x1b[35m${name} ›\x1b[0m \x1b[2m${message}\x1b[0m\n`;
}

const MAX_ACTIVITY = 70;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_LABEL = 60;

/** The transient line shown while a turn is working: spinner, what, how long. */
export function formatStatus(
  label: string,
  elapsedMs: number,
  frame: number,
): string {
  const spin = SPINNER[((frame % SPINNER.length) + SPINNER.length) % SPINNER.length];
  const short =
    label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label;
  return `  ${spin} ${short} · ${Math.floor(elapsedMs / 1000)}s`;
}

export interface Status {
  /** Show the line, or change what it says. Elapsed keeps running. */
  set: (label: string) => void;
  /** Erase it, leaving the cursor at column 0 for someone else to write. */
  clear: () => void;
  /** Erase it and stop the clock. */
  stop: () => void;
}

/**
 * A status line that redraws in place. Silent when the output isn't a
 * terminal — escape codes would corrupt a pipe or a log.
 */
export function createStatus(opts: {
  write: (s: string) => void;
  isTty: boolean;
  now?: () => number;
  intervalMs?: number;
}): Status {
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs ?? 100;

  let timer: NodeJS.Timeout | null = null;
  let started = 0;
  let frame = 0;
  let label = "";
  let onScreen = false;

  const draw = () => {
    if (!opts.isTty) return;
    opts.write(`\r\x1b[2K\x1b[90m${formatStatus(label, now() - started, frame)}\x1b[0m`);
    onScreen = true;
  };

  const erase = () => {
    if (onScreen) opts.write("\r\x1b[2K");
    onScreen = false;
  };

  return {
    set(next: string) {
      label = next;
      if (!opts.isTty) return;
      if (!timer) {
        started = now();
        frame = 0;
        timer = setInterval(() => {
          frame++;
          draw();
        }, intervalMs);
        timer.unref?.();
      }
      draw();
    },
    clear: erase,
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      erase();
    },
  };
}

/** The most informative field per tool — what you'd want to see it doing. */
function detail(name: string, input: Record<string, unknown>): string {
  const first = (...keys: string[]): string => {
    for (const k of keys) {
      const v = input?.[k];
      if (typeof v === "string" && v) return v;
    }
    return "";
  };

  const path = first("file_path", "notebook_path");
  // A full Windows path buries the only part worth reading.
  if (path) return path.split(/[\\/]/).pop() ?? path;

  return first("command", "pattern", "query", "url", "prompt", "description", "target", "note");
}

/**
 * One line per tool the assistant is about to run, so a long turn shows its
 * work instead of looking hung. Returns [] for everything that isn't a tool
 * call.
 */
export function toolActivity(msg: unknown): string[] {
  const m = msg as {
    type?: string;
    message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] };
  };
  if (m?.type !== "assistant" || !Array.isArray(m.message?.content)) return [];

  return m.message.content
    .filter((block) => block?.type === "tool_use" && block.name)
    .map((block) => {
      // mcp__vela__list_windows reads better as just list_windows.
      const name = block.name!.replace(/^mcp__[^_]+__/, "");
      const shown = detail(block.name!, block.input ?? {}).replace(/\s+/g, " ").trim();
      const line = shown ? `${name} ${shown}` : name;
      return line.length > MAX_ACTIVITY
        ? `${line.slice(0, MAX_ACTIVITY - 1)}…`
        : line;
    });
}

/**
 * The assistant's text out of a streaming SDK message, or null for the many
 * message types that aren't text.
 */
export function streamedText(msg: unknown): string | null {
  const m = msg as { type?: string; event?: { type?: string; delta?: { type?: string; text?: string } } };
  if (m?.type !== "stream_event") return null;
  const ev = m.event;
  if (ev?.type !== "content_block_delta") return null;
  if (ev.delta?.type !== "text_delta") return null;
  return ev.delta.text ?? null;
}
