import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { buildContextBlock, close } from "./memory.js";
import { createCore } from "./core.js";
import { connectIfRunning } from "./client.js";
import { createStatus, interjection, isExit } from "./repl.js";
import { createVoice, windowsSpeaker, type Voice } from "./voice.js";
import {
  audioDevices,
  pickDevice,
  resolveFfmpeg,
  startRecording,
  type Recorder,
} from "./listen.js";
import {
  NAME,
  PERSONA,
  PROMPT,
  HEARTBEAT_MS,
  HEARTBEAT_MODEL,
  THINKING_ON,
  VOICE_ON,
  VOICE_NAME,
  VOICE_RATE,
  LISTEN_ON,
  MIC,
  WHISPER_MODEL,
  WHISPER_DEVICE,
  FFMPEG,
} from "./config.js";

/**
 * The terminal face. If a background Vela is already running it attaches to
 * her; otherwise it runs its own core in-process, exactly as it always has.
 */
async function main() {
  // Attach to a running service if there is one — she keeps her session and
  // her watches whether or not this window is open.
  //
  // This happens before readline exists on purpose. Attached to stdin, readline
  // consumes lines as they arrive and closes at EOF; if that happens during
  // this await, a piped line is read and dropped before anything can iterate.
  // Left on the stream, it waits.
  const remote = await connectIfRunning();

  const rl = readline.createInterface({ input: stdin, output: stdout });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });
  const prompt = () => {
    if (!closed) rl.prompt();
  };
  const core =
    remote ??
    (() => {
      const context = buildContextBlock();
      return createCore({
        systemPrompt: context ? `${PERSONA}\n\n${context}` : PERSONA,
        heartbeatMs: HEARTBEAT_MS,
        heartbeatModel: HEARTBEAT_MODEL,
        thinking: THINKING_ON,
      });
    })();

  console.log(
    `\n  ${NAME} online${remote ? " — attached to the running service" : ""}. Ctrl+C to exit.` +
      (!remote && HEARTBEAT_MS ? ` Checking in every ${HEARTBEAT_MS / 60_000}m.` : "") +
      "\n",
  );

  const status = createStatus({
    write: (s) => stdout.write(s),
    isTty: Boolean(stdout.isTTY),
  });

  // A second face on the same event stream. The core doesn't know it's there.
  const speaker = VOICE_ON ? windowsSpeaker(VOICE_NAME, VOICE_RATE) : null;
  const voice: Voice | null = speaker ? createVoice(speaker.speak) : null;

  // Everything below is rendering. The core has no idea a terminal exists.
  let turnDone: (() => void) | null = null;
  // The "Vela ›" prefix is written lazily, by whichever of tool activity or
  // text arrives first — printing it eagerly leaves it dangling on screen for
  // however long the first tool call takes.
  let atLineStart = true;

  const prefix = () => {
    status.stop();
    stdout.write(`\x1b[35m${NAME} ›\x1b[0m `);
    atLineStart = false;
  };

  core.subscribe((event) => {
    switch (event.type) {
      case "activity":
        for (const line of event.lines) {
          status.clear();
          if (!atLineStart) stdout.write("\n");
          stdout.write(`\x1b[90m  · ${line}\x1b[0m\n`);
          atLineStart = true;
        }
        status.set(event.lines[event.lines.length - 1]);
        break;

      case "delta":
        if (atLineStart && event.text.trim()) prefix();
        stdout.write(event.text);
        voice?.push(event.text);
        break;

      case "result": {
        status.stop();
        if (event.text) {
          if (atLineStart) prefix();
          stdout.write(event.text);
          voice?.push(event.text);
        }
        stdout.write(`\n\x1b[90m  (${(event.ms / 1000).toFixed(1)}s)\x1b[0m\n\n`);
        voice?.flush(); // say the trailing fragment, if any
        turnDone?.();
        break;
      }

      case "say":
        // Unprompted. Don't eat whatever he's half-typed.
        status.clear();
        stdout.write(interjection(NAME, event.text, Boolean(stdout.isTTY)));
        if (stdout.isTTY && !core.isBusy()) rl.prompt(true);
        voice?.say(event.text);
        break;

      case "error":
        status.stop();
        console.error(`\n\x1b[31m  error:\x1b[0m ${event.message}\n`);
        turnDone?.();
        break;
    }
  });

  // Iterating the interface (rather than awaiting question()) keeps lines that
  // arrived while a turn was running — type-ahead in a terminal, and every line
  // of a piped script, which question() drops at EOF.
  rl.setPrompt(PROMPT);
  prompt();

  // Push-to-talk: Enter on an empty line starts recording, Enter again stops.
  // Using the input he already has beats a global hotkey dependency.
  let recorder: Recorder | null = null;
  let mic: string | null = null;
  const ffmpeg = LISTEN_ON ? resolveFfmpeg(process.env.VELA_FFMPEG) : null;

  if (LISTEN_ON) {
    // Say exactly which part is missing. "Push-to-talk is off" on its own sent
    // Yousef hunting, and pressing Enter looked like an empty message.
    if (!ffmpeg) {
      console.log(
        "  \x1b[33mPush-to-talk off:\x1b[0m ffmpeg not found. Install it with" +
          " `winget install Gyan.FFmpeg`, or set VELA_FFMPEG to its full path.\n",
      );
    } else {
      mic = pickDevice(await audioDevices(ffmpeg), MIC);
      if (!mic) {
        console.log(
          "  \x1b[33mPush-to-talk off:\x1b[0m ffmpeg found no microphone." +
            " Check Windows sound settings, or set VELA_MIC.\n",
        );
      } else {
        console.log(`  Push-to-talk on (${mic}). Enter on an empty line to talk.\n`);
      }
    }
  }

  for await (const line of rl) {
    let input = line.trim();

    if (recorder) {
      const heard = await recorder.stop().catch(() => "");
      recorder = null;
      if (!heard) {
        stdout.write("  Didn't catch that.\n");
        prompt();
        continue;
      }
      stdout.write(`\x1b[36myou ›\x1b[0m ${heard}\n`);
      input = heard;
    } else if (!input) {
      if (mic) {
        recorder = startRecording(mic, {
          model: WHISPER_MODEL,
          ffmpeg: ffmpeg ?? FFMPEG,
          computeDevice: WHISPER_DEVICE,
        });
        stdout.write("  \x1b[90mlistening — Enter to stop\x1b[0m\n");
      }
      prompt();
      continue;
    }

    if (isExit(input)) break;

    atLineStart = true;
    status.set("thinking");

    await new Promise<void>((resolve) => {
      turnDone = resolve;
      core.send(input);
    });
    turnDone = null;

    prompt();
  }

  core.stop();
  status.stop();
  voice?.stop();
  speaker?.stop();
  rl.close();
  close();

  // Attached to a service, the open event stream keeps the event loop alive
  // long after there's anything to do — the REPL would print Goodbye and then
  // just sit there. Leave once the last write has actually flushed.
  stdout.write("\n  Goodbye.\n", () => process.exit(0));
}

main().catch((err) => {
  console.error(err);
  close();
  process.exit(1);
});
