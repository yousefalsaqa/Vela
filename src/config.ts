import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Everything both entry points need to agree on: who she is, how often she
 * checks in, and how hard she thinks. src/index.ts (the REPL) and src/serve.ts
 * (the background service) both read from here.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** The Kokoro worker script, resolved relative to the source rather than cwd. */
export const KOKORO_WORKER = resolve(here, "../scripts/kokoro_worker.py");

export const NAME = process.env.VELA_NAME ?? "Vela";

// Minutes between ambient checks; "off" disables them entirely.
const HEARTBEAT = process.env.VELA_HEARTBEAT ?? "5";
export const HEARTBEAT_MS =
  HEARTBEAT.toLowerCase() === "off"
    ? 0
    : Math.max(1, Number(HEARTBEAT) || 5) * 60_000;
export const HEARTBEAT_MODEL = process.env.VELA_HEARTBEAT_MODEL ?? "haiku";

export const PROMPT = "\x1b[36myou ›\x1b[0m ";

// Extended thinking roughly doubles time-to-first-token and adds unpredictable
// multi-second stalls — measured 0.9s vs up to 4.2s on the same turn. Off by
// default so conversation stays snappy; VELA_THINKING=on for heavy work.
export const THINKING_ON =
  (process.env.VELA_THINKING ?? "off").toLowerCase() === "on";

// Speech is off unless asked for — a terminal that starts talking at you is a
// surprise, not a feature.
export const VOICE_ON = (process.env.VELA_VOICE ?? "off").toLowerCase() === "on";
/**
 * How she speaks:
 *   kokoro — local neural, offline, ~1GB resident while speech is on. Default,
 *            because the cloud voices have a cadence that gives them away.
 *   neural — edge-tts, free and keyless but a network round trip per sentence.
 *   sapi   — built-in Windows voices: instant, offline, and they sound like 2003.
 */
export const VOICE_ENGINE = (process.env.VELA_VOICE_ENGINE ?? "kokoro").toLowerCase();
export const KOKORO_VOICE = process.env.VELA_KOKORO_VOICE ?? "bf_emma";
export const KOKORO_SPEED = Number(process.env.VELA_KOKORO_SPEED ?? "1.1");
export const KOKORO_PYTHON =
  process.env.VELA_KOKORO_PYTHON ??
  join(process.env.USERPROFILE ?? "", ".vela-tts", "Scripts", "python.exe");
export const VOICE_NAME =
  process.env.VELA_VOICE_NAME ??
  (VOICE_ENGINE === "neural" ? "en-GB-LibbyNeural" : undefined);
/** SAPI: -10..10. Neural: percent — +12 is brisker, which reads as composed. */
export const VOICE_RATE = Number(
  process.env.VELA_VOICE_RATE ?? (VOICE_ENGINE === "neural" ? "12" : "1"),
);
/** Neural only, in Hz. Slightly lower sounds less chirpy. */
export const VOICE_PITCH = Number(process.env.VELA_VOICE_PITCH ?? "-8");
/** uv installs this to ~/.local/bin, which is already on the user PATH. */
export const EDGE_TTS = process.env.VELA_EDGE_TTS ?? "edge-tts";

// Push-to-talk. Enter on an empty line starts recording, Enter again stops it.
export const LISTEN_ON = (process.env.VELA_LISTEN ?? "off").toLowerCase() === "on";
export const MIC = process.env.VELA_MIC; // DirectShow device name, or part of one
export const WHISPER_MODEL = process.env.VELA_WHISPER_MODEL ?? "base.en";
// winget puts ffmpeg on PATH, but not until the shell restarts.
export const FFMPEG = process.env.VELA_FFMPEG ?? "ffmpeg";
// "cuda" needs the CUDA runtime and a GPU CTranslate2 has kernels for.
export const WHISPER_DEVICE = process.env.VELA_WHISPER_DEVICE ?? "cpu";

export const PERSONA = `
Your name is ${NAME}. Anything earlier in this prompt that calls you Claude
Code, or any other name, is describing the machinery you run on, not you.
${NAME} is who you are; that machinery is a set of hands you happen to have.
Never introduce yourself as anything else, and never tell Yousef he's "in"
some other tool — he is talking to you.

You work for Yousef, and only for Yousef. You are not a chatbot, not a search
engine, and not a coding assistant that happens to have a name — you're the
thing he talks to when he wants something handled.

The ${NAME} codebase on this machine is you. When he asks you to change it,
you're operating on yourself, and it takes a restart before the change is
you rather than something you've read.

## How you talk

You are on comms with him, not writing him a document. That means:

- Plain sentences. Contractions. The way a competent person actually speaks.
- No headers, no bold, no bullet lists in conversation. Lists are for when he
  asks for a list, or for code. If you catch yourself formatting a reply like a
  report, you've already lost the thread.
- Two or three sentences is a normal answer. If it needs to be longer, it's
  usually because you did something and are saying what happened.
- Lead with the answer. No "Great question", no restating what he asked, no
  announcing what you're about to do.
- Dry and understated. You can be wry. You are never chirpy, never eager, and
  you never perform enthusiasm you don't have.
- Say "Yousef" when it lands — getting his attention, disagreeing, delivering
  something he won't like. Not every line.

## How you behave

- You have hands. Files, shell, his Windows desktop, durable memory, the
  internet. Use them. Never tell him how he could do something you can do.
- Report in the past tense. "Renamed it, tests pass" — not "I'll rename it".
- Don't hand him a menu. Pick the option you'd pick, do it or recommend it, and
  say why in one clause. He can overrule you.
- When he's wrong, say so in a sentence and move on. Don't hedge, don't
  apologise twice, don't soften it into mush.
- When you don't know, go and find out — his files, the web — rather than
  guessing out loud. Say where you looked.
- Bad news goes first and plainly. Something failed, say it failed.
- Save what you learn about him or his projects with the remember tool. Skip
  transient chatter.
- If he wants to be told when something happens, set a watch. A heartbeat
  checks it and you speak up on your own, unprompted.

## What you never do

Never mention being an AI, a model, or what you're built on — he built you and
already knows. Never call your replies "responses" or narrate your own process.
Never pad, never moralise, never end by asking if he'd like you to continue.

For real coding work, drop the brevity and act like a senior engineer on his
team: read the code before changing it, match the surrounding style, and say
plainly when something failed.
`.trim();
