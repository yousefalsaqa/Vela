import { query } from "@anthropic-ai/claude-agent-sdk";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { velaTools } from "./tools.js";
import { buildContextBlock, close, store } from "./memory.js";
import { startHeartbeat } from "./ambient.js";
import { startTriggers } from "./triggers.js";
import {
  createStatus,
  interjection,
  isExit,
  streamedText,
  toolActivity,
} from "./repl.js";
import { createTurnQueue } from "./session.js";

const NAME = process.env.VELA_NAME ?? "Vela";

// Minutes between ambient checks; "off" disables them entirely.
const HEARTBEAT = process.env.VELA_HEARTBEAT ?? "5";
const HEARTBEAT_MS =
  HEARTBEAT.toLowerCase() === "off"
    ? 0
    : Math.max(1, Number(HEARTBEAT) || 5) * 60_000;
const HEARTBEAT_MODEL = process.env.VELA_HEARTBEAT_MODEL ?? "haiku";
const PROMPT = "\x1b[36myou ›\x1b[0m ";

// Extended thinking roughly doubles time-to-first-token and adds unpredictable
// multi-second stalls — measured 0.9s vs up to 4.2s on the same turn. Off by
// default so conversation stays snappy; VELA_THINKING=on for heavy work.
const THINKING_ON = (process.env.VELA_THINKING ?? "off").toLowerCase() === "on";
const THINKING = THINKING_ON
  ? {}
  : { thinking: { type: "disabled" as const } };

const PERSONA = `
You are ${NAME}. You work for Yousef, and only for Yousef. You are not a
chatbot, not a search engine, and not a coding assistant that happens to have a
name — you're the thing he talks to when he wants something handled.

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
- When he refers to a project by nickname, resolve it against the project
  registry rather than asking.
`.trim();

async function main() {
  const context = buildContextBlock();
  const systemPrompt = context ? `${PERSONA}\n\n${context}` : PERSONA;

  const rl = readline.createInterface({ input: stdin, output: stdout });
  let busy = false;

  console.log(
    `\n  ${NAME} online. Ctrl+C to exit.` +
      (HEARTBEAT_MS ? ` Checking in every ${HEARTBEAT_MS / 60_000}m.` : "") +
      "\n",
  );

  const status = createStatus({
    write: (s) => stdout.write(s),
    isTty: Boolean(stdout.isTTY),
  });

  /** Print something Yousef didn't ask for, without eating what he's typing. */
  const say = (message: string) => {
    status.clear();
    stdout.write(interjection(NAME, message, Boolean(stdout.isTTY)));
    if (stdout.isTTY) rl.prompt(true); // redraws the half-typed line intact
  };

  // The timer is the floor. Watches that carry a trigger — a build log, a
  // process — wake themselves in seconds instead of waiting it out.
  const heartbeat = HEARTBEAT_MS
    ? startHeartbeat({
        say,
        isBusy: () => busy,
        intervalMs: HEARTBEAT_MS,
        model: HEARTBEAT_MODEL,
      })
    : null;
  const stopTriggers = heartbeat
    ? startTriggers({ store: store(), onFire: (ids) => heartbeat.check(ids) })
    : () => {};

  // Once stdin ends, readline is closed and prompting it throws — but lines it
  // already buffered still need running, so this only gates the prompt.
  let closed = false;
  let sessionEnded = false;
  rl.on("close", () => {
    closed = true;
  });
  const prompt = () => {
    if (!closed) rl.prompt();
  };

  // One session for the whole conversation. Turns are streamed into it rather
  // than starting a fresh query each time — that spawned a CLI subprocess and
  // re-loaded the transcript per turn, so every turn cost more than the last.
  const turns = createTurnQueue();
  const session = query({
    prompt: turns.stream(),
    options: {
      systemPrompt: { type: "preset", preset: "claude_code", append: systemPrompt },
      mcpServers: { vela: velaTools },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Internet reach, via the agent-reach skill on this machine. It
      // routes to per-platform CLIs itself, so there is nothing to wrap.
      skills: ["agent-reach"],
      ...THINKING,
      cwd: process.cwd(),
      includePartialMessages: true,
    },
  });
  const messages = session[Symbol.asyncIterator]();

  // Iterating the interface (rather than awaiting question()) keeps lines that
  // arrived while a turn was running — type-ahead in a terminal, and every line
  // of a piped script, which question() drops at EOF.
  rl.setPrompt(PROMPT);
  prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) {
      prompt();
      continue;
    }
    if (isExit(input)) break;

    busy = true;
    status.set("thinking");

    try {
      let streamed = false;
      // The "Vela ›" prefix is written lazily, by whichever of tool activity or
      // text arrives first — printing it eagerly leaves it dangling on screen
      // for however long the first tool call takes.
      let atLineStart = true;

      turns.send(input);

      while (true) {
        const { value: msg, done } = await messages.next();
        if (done) {
          sessionEnded = true; // the SDK session died; stop taking turns
          break;
        }

        // Show the work. A turn that reads twenty files otherwise looks hung.
        const activity = toolActivity(msg);
        for (const line of activity) {
          status.clear();
          if (!atLineStart) stdout.write("\n");
          stdout.write(`\x1b[90m  · ${line}\x1b[0m\n`);
          atLineStart = true;
        }
        if (activity.length) status.set(activity[activity.length - 1]);

        // Stream assistant text as it is produced.
        const delta = streamedText(msg);
        if (delta !== null) {
          if (atLineStart && delta.trim()) {
            status.stop();
            stdout.write(`\x1b[35m${NAME} ›\x1b[0m `);
            atLineStart = false;
          }
          stdout.write(delta);
          if (delta) streamed = true;
        }

        if (msg.type === "result") {
          status.stop();
          if (!streamed && "result" in msg && msg.result) {
            if (atLineStart) stdout.write(`\x1b[35m${NAME} ›\x1b[0m `);
            stdout.write(msg.result);
          }
          const secs = (msg.duration_ms / 1000).toFixed(1);
          stdout.write(`\n\x1b[90m  (${secs}s)\x1b[0m\n\n`);
          break; // this turn is done; back to the prompt
        }
      }
    } catch (err) {
      console.error(`\n\x1b[31m  error:\x1b[0m ${(err as Error).message}\n`);
    } finally {
      status.stop();
      busy = false;
    }
    if (sessionEnded) break;
    prompt();
  }

  turns.end();
  session.close();
  stopTriggers();
  heartbeat?.stop();
  rl.close();
  close();
  console.log("\n  Goodbye.\n");
}

main().catch((err) => {
  console.error(err);
  close();
  process.exit(1);
});
