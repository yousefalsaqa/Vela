/**
 * The real server and the real hub, with a scripted core in place of the
 * model, plus a control port so a test can push any core event on demand.
 * Every state the page enters is one the real core can actually produce.
 */
import { createServer } from "node:http";
import { writeFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../src/server.ts";
import { present, clear } from "../src/screen.ts";
import type { CoreEvent } from "../src/core.ts";

const here = dirname(fileURLToPath(import.meta.url));
const turns = join(here, "turns.log");
writeFileSync(turns, "", "utf8");
writeFileSync(join(here, "spoken.log"), "", "utf8");

const listeners = new Set<(e: CoreEvent) => void>();
const emit = (e: CoreEvent) => listeners.forEach((l) => l(e));

const core = {
  send: (text: string) => appendFileSync(turns, text + "\n", "utf8"),
  subscribe: (l: (e: CoreEvent) => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  isBusy: () => false,
};

// A page with two hotspots, for the stage.
const demo = join(here, "sensors.html");
writeFileSync(
  demo,
  `<!doctype html><meta charset="utf-8">
<style>
 body{margin:0;background:#05090d;color:#e9f2f6;font:14px/1.5 ui-monospace,monospace;
      display:grid;place-items:center;min-height:100vh}
 .hot{cursor:pointer} .hot circle{fill:rgba(79,209,219,.12);stroke:#4fd1db;stroke-width:1.4}
 .hot:hover circle{fill:rgba(245,185,95,.22);stroke:#f5b95f}
 text{fill:#7a929e;font:10px ui-monospace,monospace}
</style>
<figure style="margin:0;text-align:center">
<svg width="460" height="210" viewBox="0 0 460 210">
  <path d="M40 70 L160 92 L160 118 L40 140 Z" fill="none" stroke="#4fd1db" stroke-width="1.3"/>
  <rect x="180" y="86" width="130" height="38" fill="none" stroke="#4fd1db" stroke-width="1.3"/>
  <path d="M330 92 L420 62 L420 148 L330 118 Z" fill="none" stroke="#4fd1db" stroke-width="1.3"/>
  <g id="s9" class="hot"><circle cx="245" cy="105" r="13"/><text x="245" y="145" text-anchor="middle">s9</text></g>
  <g id="s14" class="hot"><circle cx="375" cy="105" r="13"/><text x="375" y="155" text-anchor="middle">s14</text></g>
</svg>
<figcaption style="color:#7a929e">HPC outlet · bypass</figcaption>
</figure>
<script>
 document.getElementById("s9").onclick = () =>
   parent.postMessage({ vela: "he clicked sensor 9, HPC outlet temperature" }, "*");
 document.getElementById("s14").onclick = () =>
   parent.postMessage({ vela: "he clicked sensor 14, bypass ratio" }, "*");
</script>`,
  "utf8",
);

const running = await serve({
  core,
  endpointFile: join(here, "server.json"),
  hear: async () => "what he said out loud",
  // What actually reaches Kokoro, written down so a test can read it back.
  render: async (said: string) => {
    appendFileSync(join(here, "spoken.log"), said + "\n", "utf8");
    return Buffer.from("RIFF....WAVEfmt ");
  },
  warm: () => {},
});

// The control port. Anything posted here is emitted as a core event.
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const msg = JSON.parse(body || "{}");
      if (msg.screen === "on") console.log(present({ title: "The high-pressure turbine", path: demo, note: "two live sensors" }));
      else if (msg.screen === "off") console.log(clear());
      else emit(msg as CoreEvent);
    } catch { /* ignore */ }
    res.writeHead(204);
    res.end();
  });
}).listen(4899, "127.0.0.1");

// The screen module talks to faces through the core in production; here the
// harness bridges it the same way createCore does.
const { onScreen } = await import("../src/screen.ts");
onScreen((screen) => emit({ type: "show", screen }));

console.log(`harness ${running.endpoint.port}`);
