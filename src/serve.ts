import { buildContextBlock, close } from "./memory.js";
import { createCore } from "./core.js";
import { serve } from "./server.js";
import { PERSONA, HEARTBEAT_MS, HEARTBEAT_MODEL, THINKING_ON, NAME } from "./config.js";

/**
 * Vela as a background service. Clients — the REPL, and voice later — attach
 * and detach; she keeps her session, her watches and her memory throughout.
 */
async function main() {
  const context = buildContextBlock();
  const core = createCore({
    systemPrompt: context ? `${PERSONA}\n\n${context}` : PERSONA,
    heartbeatMs: HEARTBEAT_MS,
    heartbeatModel: HEARTBEAT_MODEL,
    thinking: THINKING_ON,
  });

  const server = await serve({ core, name: NAME });
  console.log(
    `\n  ${NAME} listening on 127.0.0.1:${server.endpoint.port} (pid ${process.pid}).` +
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
