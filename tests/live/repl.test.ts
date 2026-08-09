import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Drives the real REPL as a subprocess — `npm run test:live`.
 *
 * This is the one thing unit tests can't reach: that a conversation survives
 * more than one turn. It has broken twice, silently, because every other check
 * only ever sent a single line.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const enabled = Boolean(process.env.VELA_LIVE);

function converse(lines: string[], timeoutMs = 180_000): Promise<string> {
  return new Promise((fulfil, fail) => {
    const child = spawn("npx", ["tsx", "src/index.ts"], {
      cwd: root,
      shell: true,
      env: { ...process.env, VELA_HEARTBEAT: "off" }, // no ambient noise mid-test
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));

    const timer = setTimeout(() => {
      child.kill();
      fail(new Error(`timed out; output so far:\n${out}`));
    }, timeoutMs);

    child.on("close", () => {
      clearTimeout(timer);
      fulfil(out);
    });
    child.stdin.end(lines.join("\n") + "\n");
  });
}

describe("the real REPL", { skip: !enabled && "set VELA_LIVE=1 to run" }, () => {
  test("holds one conversation across several turns", async () => {
    const out = await converse([
      "reply with just: one",
      "reply with just: two",
      "reply with just: three",
      "what number did I ask for first? one word",
    ]);

    const turns = [...out.matchAll(/\((\d+\.\d+)s\)/g)];
    assert.equal(turns.length, 4, `expected 4 turns, got ${turns.length}:\n${out}`);

    // The fourth answer proves the session kept its history without `resume`.
    assert.match(
      out.split(/\(\d+\.\d+s\)/).at(-2) ?? "",
      /one/i,
      "the session lost its earlier turns",
    );

    // Per-turn cost must not climb; a fresh query() per turn used to double it.
    const secs = turns.map((m) => Number(m[1]));
    assert.ok(
      secs[3] < secs[0] * 2.5,
      `turn cost is growing: ${secs.join("s, ")}s — is it resuming per turn again?`,
    );
  });

  test("leaves no escape codes in piped output", async () => {
    const out = await converse(["reply with just: ok"]);
    assert.doesNotMatch(
      out,
      /\x1b\[2K/,
      "the status line must stay off a non-terminal stream",
    );
  });
});
