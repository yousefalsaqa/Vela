import { spawn, type ChildProcess } from "node:child_process";
import { q } from "./desktop.js";

/**
 * Vela out loud — a second listener on the core, not a rewrite of it.
 *
 * Speech is spoken sentence by sentence as it streams, because waiting for the
 * whole reply before saying a word adds the length of the answer to a latency
 * budget that is already about a second and a half.
 */

/** Text that reads badly aloud, removed rather than pronounced. */
export function speakable(text: string): string {
  return (
    text
      // Code is not speech. Say that there was some and move on.
      .replace(/```[\s\S]*?```/g, " code block. ")
      .replace(/`([^`]+)`/g, "$1")
      // Links: keep any label, drop the URL.
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/g, " a link ")
      // Markdown emphasis and headers are punctuation to the eye only.
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/(^|\s)[*_]([^*_]+)[*_]/g, "$1$2")
      .replace(/^\s*[-*]\s+/gm, "")
      // Windows paths read as gibberish; the filename is the useful part.
      .replace(/[A-Za-z]:[\\/][\w.\-\\/ ]+[\\/]([\w.\-]+)/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Pull complete sentences off the front of a streaming buffer, leaving any
 * partial one behind. `flush` takes whatever is left, at end of turn.
 */
export function sentences(
  buffer: string,
  flush = false,
): { ready: string[]; rest: string } {
  const ready: string[] = [];
  let rest = buffer;

  // A sentence ends at . ! ? followed by space, or at a blank line. A single
  // newline is deliberately not an ending — it would cut a fenced code block
  // into pieces before speakable() ever sees it was one.
  const boundary = /([.!?]+\s|\n\n)/;
  for (;;) {
    const match = boundary.exec(rest);
    if (!match) break;
    const end = match.index + match[0].length;
    const piece = rest.slice(0, end).trim();
    if (piece) ready.push(piece);
    rest = rest.slice(end);
  }

  if (flush && rest.trim()) {
    ready.push(rest.trim());
    rest = "";
  }
  return { ready, rest };
}

/** Says things out loud. Injected in tests so nothing actually speaks. */
export type Speaker = (text: string) => void;

export interface Voice {
  /** Feed streamed text; whole sentences are spoken as they complete. */
  push: (chunk: string) => void;
  /** End of turn — say whatever is left. */
  flush: () => void;
  /** Say something immediately, on its own (an unprompted interjection). */
  say: (text: string) => void;
  stop: () => void;
}

/**
 * One long-lived PowerShell holding a speech synthesiser. Spawning one per
 * utterance costs ~300ms of process start before a word is heard.
 */
export function windowsSpeaker(voiceName?: string, rate = 1): {
  speak: Speaker;
  stop: () => void;
} {
  let ps: ChildProcess | null = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "-"],
    { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] },
  );
  ps.on("error", () => (ps = null));

  ps.stdin?.write(
    "Add-Type -AssemblyName System.Speech; " +
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
      `$s.Rate = ${Math.max(-10, Math.min(10, Math.round(rate)))}; ` +
      (voiceName ? `try { $s.SelectVoice(${q(voiceName)}) } catch {}; ` : "") +
      "\n",
  );

  return {
    speak(text: string) {
      if (!ps?.stdin?.writable) return;
      ps.stdin.write(`$s.Speak(${q(text)})\n`);
    },
    stop() {
      try {
        ps?.stdin?.end("$s.Dispose()\nexit\n");
      } catch {
        /* already gone */
      }
      ps = null;
    },
  };
}

export function createVoice(speak: Speaker): Voice {
  let buffer = "";

  const emit = (text: string) => {
    const words = speakable(text);
    if (words) speak(words);
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      const { ready, rest } = sentences(buffer);
      buffer = rest;
      for (const s of ready) emit(s);
    },
    flush() {
      const { ready } = sentences(buffer, true);
      buffer = "";
      for (const s of ready) emit(s);
    },
    say(text: string) {
      emit(text);
    },
    stop() {
      buffer = "";
    },
  };
}
