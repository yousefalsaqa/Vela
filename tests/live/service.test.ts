import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

/**
 * The split, end to end — `npm run test:live`.
 *
 * One background service, two separate REPL processes attaching to it. Nothing
 * else proves that Vela outlives the window she was started from, which is the
 * whole point of the split.
 *
 * Every wait here is bounded. An unbounded one turns a hang into a hang.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const endpointFile = join(root, "data", "server.json");
const enabled = Boolean(process.env.VELA_LIVE);

/** Run the REPL with piped input, failing loudly if it doesn't exit. */
function repl(line: string, timeoutMs = 90_000): Promise<string> {
  return new Promise((fulfil, fail) => {
    const child = spawn("npx", ["tsx", "src/index.ts"], {
      cwd: root,
      shell: true,
      env: { ...process.env, VELA_HEARTBEAT: "off" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`the REPL never exited — it hung after:\n${out}`));
    }, timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      fulfil(out);
    });
    child.stdin.end(line + "\n");
  });
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("the service", { skip: !enabled && "set VELA_LIVE=1 to run" }, () => {
  let service: ChildProcess;

  before(async () => {
    rmSync(endpointFile, { force: true });
    service = spawn("npx", ["tsx", "src/serve.ts"], {
      cwd: root,
      shell: true,
      env: { ...process.env, VELA_HEARTBEAT: "off" },
    });
    service.stdout?.resume();
    service.stderr?.resume();
    await waitFor(() => existsSync(endpointFile), "the service to advertise itself");
  });

  after(() => {
    service?.kill("SIGKILL");
    rmSync(endpointFile, { force: true });
  });

  test("a REPL attaches to it rather than starting its own core", async () => {
    const out = await repl("reply with just: attached");
    assert.match(out, /attached to the running service/, "should have found the service");
    assert.match(out, /Goodbye/, "and it must exit, not sit on the event stream");
  });

  test("two separate REPL processes share one conversation", async () => {
    await repl("the codeword is albatross. reply with just: noted");
    const second = await repl("what is the codeword? one word");
    assert.match(
      second,
      /albatross/i,
      "the second process should inherit the first one's conversation",
    );
  });
});
