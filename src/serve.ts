import { buildContextBlock, close } from "./memory.js";
import { createCore } from "./core.js";
import { serve } from "./server.js";
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
  SKILLS,
  NAME,
} from "./config.js";

/**
 * Vela as a background service. Clients — the REPL, and voice later — attach
 * and detach; she keeps her session, her watches and her memory throughout.
 */
async function main() {
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
    skills: SKILLS,
    heartbeatSkills: HEARTBEAT_SKILLS,
  });

  const server = await serve({ core, name: NAME });
  console.log(
    `\n  ${NAME} ${BUILD} listening on 127.0.0.1:${server.endpoint.port} (pid ${process.pid}).` +
      `\n  Attach with: npm run dev\n  Ctrl+C to stop.\n`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n  Shutting down.");
    await server.close();
    core.stop();
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
