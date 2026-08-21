import readline from "node:readline/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stdin, stdout } from "node:process";
import { buildContextBlock, close, dbPath } from "./memory.js";
import { BUILD } from "./version.js";
import { createCore } from "./core.js";
import { connectIfRunning } from "./client.js";
import { createStatus, interjection, isExit } from "./repl.js";
import {
  createVoice,
  windowsSpeaker,
  neuralSpeaker,
  kokoroSpeaker,
  PRONOUNCE_PHONEMES,
  PRONOUNCE_RESPELL,
  type Voice,
} from "./voice.js";
import {
  audioDevices,
  cliTranscriber,
  createTranscriber,
  pickDevice,
  resolveFfmpeg,
  resolveFfplay,
  startRecording,
  wavFromPcm,
  SAMPLE_RATE,
  type Recorder,
  type Transcriber,
} from "./listen.js";
import {
  NAME,
  PERSONA,
  VOICE_PERSONA,
  PROMPT,
  HEARTBEAT_MS,
  HEARTBEAT_MODEL,
  HEARTBEAT_SKILLS,
  ensureClaudeOnPath,
  THINKING_ON,
  MODEL,
  SKILLS,
  VOICE_ON,
  VOICE_ENGINE,
  VOICE_NAME,
  VOICE_RATE,
  VOICE_PITCH,
  EDGE_TTS,
  KOKORO_VOICE,
  KOKORO_SPEED,
  VOICE_GAP_MS,
  KOKORO_PYTHON,
  KOKORO_WORKER,
  LISTEN_ON,
  MIC,
  WHISPER_MODEL,
  WHISPER_DEVICE,
  WHISPER_PYTHON,
  WHISPER_WORKER,
  WHISPER_VOCABULARY,
  KEEP_AUDIO,
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
      // Before any tool opens a shell: skill-creator's eval modes shell out to
      // `claude`, which ships inside the SDK but not anywhere PATH looks.
      ensureClaudeOnPath();
      const context = buildContextBlock();
      // Spoken replies want to be much shorter than written ones, and she has
      // no way to know she's being listened to unless she's told.
      const persona = VOICE_ON ? `${PERSONA}\n\n${VOICE_PERSONA}` : PERSONA;
      return createCore({
        systemPrompt: context ? `${persona}\n\n${context}` : persona,
        heartbeatMs: HEARTBEAT_MS,
        heartbeatModel: HEARTBEAT_MODEL,
        model: MODEL,
        thinking: THINKING_ON,
        skills: SKILLS,
        heartbeatSkills: HEARTBEAT_SKILLS,
      });
    })();

  console.log(
    `\n  ${NAME} ${BUILD} online${remote ? " — attached to the running service" : ""}. Ctrl+C to exit.` +
      (!remote && HEARTBEAT_MS ? ` Checking in every ${HEARTBEAT_MS / 60_000}m.` : "") +
      "\n",
  );

  const status = createStatus({
    write: (s) => stdout.write(s),
    isTty: Boolean(stdout.isTTY),
  });

  /**
   * Where a turn's seconds went. "It takes too long" has four suspects — the
   * microphone, whisper, the model, and Kokoro — and they are not close to
   * equal. Timing each one turns the next round of this into arithmetic.
   */
  const clock = { startedAt: 0, captured: 0, transcribed: 0, firstToken: 0, firstWord: 0 };
  /** Seconds from the moment he stopped talking, so the four read as a timeline. */
  const at = (stamp: number) => ((stamp - clock.startedAt) / 1000).toFixed(1);

  // Resolved the moment the first samples of a reply reach the player.
  let wordIsOut: (() => void) | null = null;
  const firstWord = () => new Promise<void>((r) => (wordIsOut = r));
  const startedTalking = () => {
    if (clock.firstWord) return;
    clock.firstWord = Date.now();
    wordIsOut?.();
    wordIsOut = null;
  };

  // A second face on the same event stream. The core doesn't know it's there.
  const speaker = !VOICE_ON
    ? null
    : VOICE_ENGINE === "kokoro"
      ? kokoroSpeaker({
          python: KOKORO_PYTHON,
          worker: KOKORO_WORKER,
          voice: KOKORO_VOICE,
          speed: KOKORO_SPEED,
          gapMs: VOICE_GAP_MS,
          play: resolveFfplay() ?? "ffplay",
          onSpoke: startedTalking,
          onProblem: (why) =>
            process.stderr.write(
              `\n  \x1b[33mVoice off:\x1b[0m ${why}\n` +
                `  Fall back with VELA_VOICE_ENGINE=neural\n`,
            ),
        })
      : VOICE_ENGINE === "neural"
        ? neuralSpeaker(VOICE_NAME, VOICE_RATE, VOICE_PITCH, {
            tts: EDGE_TTS,
            play: resolveFfplay() ?? "ffplay",
          })
        : windowsSpeaker(VOICE_NAME, VOICE_RATE);
  // Kokoro takes inline phonemes; the other two need a respelling.
  const voice: Voice | null = speaker
    ? createVoice(
        speaker.speak,
        VOICE_ENGINE === "kokoro" ? PRONOUNCE_PHONEMES : PRONOUNCE_RESPELL,
      )
    : null;

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
        if (!clock.firstToken) clock.firstToken = Date.now();
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
        voice?.flush(); // say the trailing fragment, if any

        const report = () => {
          // Only the stages that actually ran get a number: samples in hand,
          // transcript in hand, first token, first sound.
          const parts = [
            clock.captured ? `mic ${at(clock.captured)}` : "",
            clock.transcribed ? `heard ${at(clock.transcribed)}` : "",
            clock.firstToken ? `thought ${at(clock.firstToken)}` : "",
            clock.firstWord ? `spoke ${at(clock.firstWord)}` : "",
          ].filter(Boolean);
          const breakdown = parts.length > 1 ? `${parts.join(" · ")} · ` : "";
          stdout.write(
            `\n\x1b[90m  (${breakdown}${(event.ms / 1000).toFixed(1)}s)\x1b[0m\n\n`,
          );
          turnDone?.();
        };

        // Synthesis of the last sentence usually finishes after the turn does,
        // so wait a beat for her to start talking — otherwise the one number
        // that decides whether this feels live is the one missing from the
        // line. Bounded, because a silent turn must still hand the prompt back.
        if (voice && !clock.firstWord) {
          void Promise.race([
            firstWord(),
            new Promise((r) => setTimeout(r, 2000).unref?.()),
          ]).then(report);
        } else report();
        break;
      }

      case "show":
        // The screen lives on the hub; the terminal just shouldn't be blind
        // to it changing.
        status.clear();
        if (!atLineStart) stdout.write("\n");
        stdout.write(
          `\x1b[90m  · ${event.screen ? `on screen: ${event.screen.title}` : "screen cleared"}\x1b[0m\n`,
        );
        atLineStart = true;
        break;

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
  let ears: Transcriber | null = null;
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
        // Kept warm from here on. Loading the model per utterance put about a
        // second of silence between him finishing and her starting.
        ears = existsSync(WHISPER_PYTHON)
          ? createTranscriber({
              python: WHISPER_PYTHON,
              worker: WHISPER_WORKER,
              model: WHISPER_MODEL,
              computeDevice: WHISPER_DEVICE,
              vocabulary: WHISPER_VOCABULARY,
              onProblem: (why) =>
                process.stderr.write(`\n  \x1b[33mTranscription:\x1b[0m ${why}\n`),
            })
          : cliTranscriber({
              model: WHISPER_MODEL,
              computeDevice: WHISPER_DEVICE,
            });
        console.log(`  Push-to-talk on (${mic}). Enter on an empty line to talk.\n`);
      }
    }
  }

  for await (const line of rl) {
    let input = line.trim();

    // This Enter is the moment he stops and starts waiting, whether he typed
    // the line or said it. Everything the turn is timed against hangs off it.
    clock.startedAt = Date.now();
    clock.captured = clock.transcribed = clock.firstToken = clock.firstWord = 0;

    if (recorder) {
      const pcm = await recorder.stop().catch(() => Buffer.alloc(0));
      recorder = null;
      clock.captured = Date.now();
      status.set("transcribing");
      const heard = await (ears?.hear(pcm) ?? Promise.resolve("")).catch(() => "");
      status.stop();
      clock.transcribed = Date.now();

      if (KEEP_AUDIO && pcm.length) {
        // Written next to the transcript it produced, so the two can be
        // compared instead of argued about.
        const dir = join(dirname(dbPath()), "heard");
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        writeFileSync(join(dir, `${stamp}.wav`), wavFromPcm(pcm));
        writeFileSync(join(dir, `${stamp}.txt`), heard || "(nothing heard)", "utf8");
        stdout.write(
          `  \x1b[90mkept ${(pcm.length / (SAMPLE_RATE * 2)).toFixed(1)}s of audio in ${dir}\x1b[0m\n`,
        );
      }
      if (!heard) {
        stdout.write("  Didn't catch that.\n");
        prompt();
        continue;
      }
      stdout.write(`\x1b[36myou ›\x1b[0m ${heard}\n`);
      input = heard;
    } else if (!input) {
      if (mic) {
        recorder = startRecording(mic, { ffmpeg: ffmpeg ?? FFMPEG });
        // Only say so once the device is actually capturing. Windows takes
        // about 1.3s to open it, and anything said before that is gone.
        status.set("opening the mic");
        await recorder.ready;
        status.stop();
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
  ears?.stop();
  voice?.flush();
  // Let her finish the sentence before the process dies.
  await speaker?.drain?.();
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
