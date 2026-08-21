import { buildContextBlock, close } from "./memory.js";
import { createCore } from "./core.js";
import { serve, readEndpoint, type Endpoint } from "./server.js";
import { reachable } from "./client.js";
import { spawn } from "./proc.js";
import { createTranscriber, cliTranscriber, pcmFromAudio, resolveFfmpeg } from "./listen.js";
import { kokoroSynth } from "./voice.js";
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
  KOKORO_PYTHON,
  KOKORO_WORKER,
  KOKORO_VOICE,
  KOKORO_SPEED,
  FFMPEG,
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

/**
 * Vela as a background service. Clients — the REPL, the hub, and voice later —
 * attach and detach; she keeps her session, her watches and her memory
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
    hear: async (audio) => ears.hear(await pcmFromAudio(audio, { ffmpeg })),
    ...(mouth ? { render: (text: string) => mouth.render(text) } : {}),
    // The hub says so the moment he presses record or switches sound on, so a
    // deferred model loads in that gap instead of after it.
    warm: (what) => (what === "ears" ? ears.warm() : mouth?.warm()),
  });
  const hub = hubUrl(server.endpoint);
  console.log(
    `\n  ${NAME} ${BUILD} listening on 127.0.0.1:${server.endpoint.port} (pid ${process.pid}).` +
      `\n  Hub:    ${hub}` +
      `\n  Attach: npm run dev` +
      `\n  Ctrl+C to stop.\n`,
  );
  if (OPEN_HUB) openInBrowser(hub);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n  Shutting down.");
    await server.close();
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
