import { buildContextBlock, close } from "./memory.js";
import { createCore } from "./core.js";
import { serve, readEndpoint, type Endpoint } from "./server.js";
import { reachable } from "./client.js";
import { spawn } from "./proc.js";
import {
  createTranscriber,
  cliTranscriber,
  pcmFromAudio,
  resolveFfmpeg,
  resolveFfplay,
  audioDevices,
  pickDevice,
  HEARD_ANYTHING,
} from "./listen.js";
import { kokoroSynth, synthSpeaker, createVoice, PRONOUNCE_PHONEMES } from "./voice.js";
import { startWakeListener, type WakeListener } from "./wake.js";
import { existsSync } from "node:fs";
import { BUILD } from "./version.js";
import {
  PERSONA,
  VOICE_PERSONA,
  VOICE_ON,
  HEARTBEAT_MS,
  HEARTBEAT_MODEL,
  HEARTBEAT_SKILLS,
  ensureClaudeOnPath,
  THINKING_ON,
  MODEL,
  EFFORT,
  SKILLS,
  NAME,
  OPEN_HUB,
  PORT,
  KEEP_TOKEN,
  LAZY_WORKERS,
  WHISPER_PYTHON,
  WHISPER_WORKER,
  WHISPER_MODEL,
  WHISPER_DEVICE,
  WHISPER_VOCABULARY,
  WHISPER_MAX_SILENCE,
  WHISPER_MIN_LOGPROB,
  KOKORO_PYTHON,
  KOKORO_WORKER,
  KOKORO_VOICE,
  KOKORO_SPEED,
  FFMPEG,
  MIC,
  VOICE_GAP_MS,
  WAKE_ON,
  WAKE_WORDS,
  WAKE_ACK,
  WAKE_DEBUG,
  WAKE_MARGIN_DB,
  WAKE_MAX_MS,
  WAKE_FOLLOWUP_MS,
  WAKE_FOLLOWUPS,
  WAKE_BYE,
} from "./config.js";

/** Where her second face lives. The token rides in the URL; see server.ts. */
const hubUrl = (e: Endpoint) => `http://127.0.0.1:${e.port}/?k=${e.token}`;

/**
 * Hand the URL to whatever the machine uses for links.
 *
 * `start` is a cmd builtin rather than a program, and its first quoted
 * argument is taken as the window title, hence the empty one.
 */
function openInBrowser(url: string) {
  try {
    spawn("cmd.exe", ["/c", "start", "", url], { windowsHide: true, stdio: "ignore" });
  } catch {
    /* she is still running; he can click the printed link */
  }
}

/** Released on shutdown. A no-op until the wake word actually starts. */
let stopListening: () => void = () => {};

/**
 * Vela as a background service. Clients — the REPL, the hub, and the wake word
 * — attach and detach; she keeps her session, her watches and her memory
 * throughout.
 */
async function main() {
  // Double-clicking the shortcut twice should show her, not fail to bind a
  // port. If she is already up, this process has nothing to add: point the
  // browser at the one that is running and get out of the way.
  const running = readEndpoint();
  if (running && (await reachable(running))) {
    console.log(`\n  ${NAME} is already running (pid ${running.pid}). Opening the hub.\n`);
    openInBrowser(hubUrl(running));
    close();
    return;
  }

  // Same reason as the REPL: the bundled `claude` is not on PATH by itself.
  ensureClaudeOnPath();
  const context = buildContextBlock();
  // The prompt lives here, but the speaking happens in whichever client
  // attached — so the service has to be told that its replies will be heard.
  const persona = VOICE_ON ? `${PERSONA}\n\n${VOICE_PERSONA}` : PERSONA;
  const core = createCore({
    systemPrompt: context ? `${persona}\n\n${context}` : persona,
    heartbeatMs: HEARTBEAT_MS,
    heartbeatModel: HEARTBEAT_MODEL,
    model: MODEL,
    thinking: THINKING_ON,
    effort: EFFORT,
    skills: SKILLS,
    heartbeatSkills: HEARTBEAT_SKILLS,
  });

  // The service grows ears and a voice of its own, for the hub. The terminal
  // client keeps its own pair; these never play or record anything locally,
  // they only turn bytes into words and back for whoever is holding the page.
  const ffmpeg = resolveFfmpeg(process.env.VELA_FFMPEG) ?? FFMPEG;
  const ears = existsSync(WHISPER_PYTHON)
    ? createTranscriber({
        python: WHISPER_PYTHON,
        worker: WHISPER_WORKER,
        model: WHISPER_MODEL,
        computeDevice: WHISPER_DEVICE,
        vocabulary: WHISPER_VOCABULARY,
        // She sits idle most of the day; the model can wait until he speaks.
        lazy: LAZY_WORKERS,
        // One transcriber serves both the hub's button and the open microphone.
        // The gate matters for the second — a hallucinated sentence there is a
        // session nobody started — and costs the first nothing, because a press
        // whisper scores as silence is a press that recorded silence.
        maxSilence: WHISPER_MAX_SILENCE,
        minLogprob: WHISPER_MIN_LOGPROB,
        onDropped: ({ text, silence, logprob }) => {
          if (WAKE_DEBUG) {
            console.log(
              `  [90m× silence ${silence?.toFixed(2)} logprob ${logprob?.toFixed(2)}  ${text}[0m`,
            );
          }
        },
        onProblem: (why) => console.log(`  Transcription: ${why}`),
      })
    : cliTranscriber({ model: WHISPER_MODEL, computeDevice: WHISPER_DEVICE });

  const mouth = existsSync(KOKORO_PYTHON)
    ? kokoroSynth({
        python: KOKORO_PYTHON,
        worker: KOKORO_WORKER,
        voice: KOKORO_VOICE,
        speed: KOKORO_SPEED,
        // 1.1GB she only needs if he presses the speaker button.
        lazy: LAZY_WORKERS,
        onProblem: (why) => console.log(`  Voice: ${why}`),
      })
    : null;

  const server = await serve({
    core,
    name: NAME,
    // A fixed port and a kept token are what make her hub pinnable.
    port: PORT,
    keepToken: KEEP_TOKEN,
    // He pressed record and spoke, so the confidence bar the wake word needs
    // would only lose him a quiet real sentence here. See HEARD_ANYTHING.
    hear: async (audio) =>
      ears.hear(await pcmFromAudio(audio, { ffmpeg }), HEARD_ANYTHING),
    ...(mouth ? { render: (text: string) => mouth.render(text) } : {}),
    // The hub says so the moment he presses record or switches sound on, so a
    // deferred model loads in that gap instead of after it.
    warm: (what) => (what === "ears" ? ears.warm() : mouth?.warm()),
  });
  /**
   * Her ears, always open.
   *
   * The hub's microphone button and the terminal's push-to-talk both say when
   * a turn starts. This has to work that out from the room, so it has a mouth
   * of its own as well: a reply that only appears in a browser tab is no use
   * to someone who never opened one.
   */
  async function startListening(): Promise<WakeListener | null> {
    const off = (why: string) => {
      console.log(`  \x1b[33mWake word off:\x1b[0m ${why}`);
      return null;
    };
    if (!mouth) {
      return off(
        "Kokoro isn't installed, so she'd have no way to answer out loud." +
          " Set VELA_KOKORO_PYTHON, or VELA_WAKE=off to stop saying this.",
      );
    }
    const device = pickDevice(await audioDevices(ffmpeg), MIC);
    if (!device) return off("ffmpeg found no microphone. Check sound settings, or set VELA_MIC.");

    const speaker = synthSpeaker({
      render: (text) => mouth.render(text),
      play: resolveFfplay() ?? "ffplay",
      gapMs: VOICE_GAP_MS,
      onProblem: (why) => console.log(`  Voice: ${why}`),
      // A turn that renders nothing reports nothing, which is what silence
      // looked like from the outside. This says a sentence reached the player.
      onSpoke: () => console.log(`  \x1b[90m(speaking)\x1b[0m`),
    });
    // Kokoro takes inline phonemes rather than a respelling; see voice.ts.
    const voice = createVoice(speaker.speak, PRONOUNCE_PHONEMES);

    /**
     * True only for a turn the wake word started.
     *
     * Everything the core does is broadcast to everyone attached, so without
     * this a sentence typed into the hub would be played twice: once by the
     * browser that asked for it and once out of the speakers here.
     */
    let answering = false;

    /**
     * The end of a spoken turn: say the last fragment, wait for the room to
     * go quiet, and only then start listening again. Without the wait she
     * hears the tail of her own sentence and takes it for his.
     *
     * Draining closes the player, so the next reply starts a new one and pays
     * ffplay's ~450ms startup before its first word. The terminal keeps one
     * player for a whole conversation and pays that once, but it has a key
     * press telling it when a turn begins and can afford to. Nothing here
     * says when she has finished being heard except the player closing. The
     * alternative is timing the tail from the samples written, which is exact
     * arithmetic over an inexact start, and getting it wrong means she
     * answers herself.
     */
    const finish = async () => {
      if (!answering) return;
      answering = false;
      server.announce({ type: "aloud", value: false });
      voice.flush();
      await speaker.drain?.().catch(() => {});
      listener.resume();
    };

    core.subscribe((event) => {
      if (!answering) return;
      if (event.type === "delta") voice.push(event.text);
      else if (event.type === "result") {
        if (event.text) voice.push(event.text);
        void finish();
      } else if (event.type === "error") void finish();
    });

    const listener = startWakeListener({
      device,
      ffmpeg,
      words: WAKE_WORDS,
      followUpMs: WAKE_FOLLOWUP_MS,
      followUps: WAKE_FOLLOWUPS,
      segment: { marginDb: WAKE_MARGIN_DB, maxMs: WAKE_MAX_MS },
      hear: (pcm) => ears.hear(pcm),

      onCommand: (text, woke) => {
        const how = woke.followUp ? "follow-up" : woke.word;
        console.log(`  \x1b[36myou ›\x1b[0m \x1b[90m(${how})\x1b[0m ${text}`);
        listener.hold();
        answering = true;
        // The hub plays what the core says. This reply is already going to be
        // said out loud in the room, so tell it to stay quiet for this one.
        server.announce({ type: "aloud", value: true });
        core.send(text);
      },

      // He said her name and nothing else. Answering that with a model turn
      // would put a second and a half between the name and the reply.
      onDismiss: () => {
        console.log(`  \x1b[90m(session closed)\x1b[0m`);
        listener.hold();
        voice.say(WAKE_BYE);
        void Promise.resolve(speaker.drain?.())
          .catch(() => {})
          .then(() => listener.resume());
      },

      onName: (word) => {
        console.log(`  \x1b[36myou ›\x1b[0m \x1b[90m(${word})\x1b[0m`);
        listener.hold();
        voice.say(WAKE_ACK);
        void Promise.resolve(speaker.drain?.())
          .catch(() => {})
          .then(() => listener.resume());
      },

      onCaptured: ({ ms, level }) => {
        if (WAKE_DEBUG) {
          console.log(`  \x1b[90m~ ${level.toFixed(0)}dB  ${ms}ms of room\x1b[0m`);
        }
      },

      onHeard: ({ text, woke, level }) => {
        if (WAKE_DEBUG) {
          console.log(`  \x1b[90m${woke ? "→" : "·"} ${level.toFixed(0)}dB  ${text || "(whisper heard nothing)"}\x1b[0m`);
        }
      },
      onProblem: (why) => console.log(`  \x1b[33mWake word:\x1b[0m ${why}`),
    });

    await listener.ready;
    /**
     * Both speech models, loaded now rather than inside his first sentence.
     *
     * LAZY_WORKERS defers 1.1GB of Kokoro and 226MB of whisper until something
     * asks for them, and the hub can afford that because pressing record warms
     * them in the gap before he speaks. The wake word has no such gap: the
     * first thing he says *is* the trigger, so both loads land inside the turn
     * he is already waiting on and she looks broken rather than slow. Holding
     * the microphone open all day is the commitment; the memory saved by not
     * being able to answer is not worth having.
     */
    ears.warm();
    mouth.warm();

    console.log(`  Wake word on (${device}). Say "${NAME}".`);
    stopListening = () => {
      listener.stop();
      voice.stop();
      speaker.stop();
    };
    return listener;
  }

  const hub = hubUrl(server.endpoint);
  console.log(
    `\n  ${NAME} ${BUILD} listening on 127.0.0.1:${server.endpoint.port} (pid ${process.pid}).` +
      `\n  Hub:    ${hub}` +
      `\n  Attach: npm run dev` +
      `\n  Ctrl+C to stop.\n`,
  );
  if (OPEN_HUB) openInBrowser(hub);

  // After the banner: opening the microphone takes about 1.3s, and the address
  // is the thing worth reading first.
  if (WAKE_ON) await startListening();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n  Shutting down.");
    await server.close();
    stopListening();
    core.stop();
    ears.stop();
    mouth?.stop();
    close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  close();
  process.exit(1);
});
