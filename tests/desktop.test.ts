import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  q,
  resolveTarget,
  launchApp,
  mediaKey,
  listRunningApps,
  isProcessRunning,
  MEDIA_KEYS,
  type PsRunner,
} from "../src/desktop.js";

/** A fake PowerShell that records what it was asked to run. */
function spy(behaviour: (cmd: string) => Promise<string> = async () => "") {
  const calls: string[] = [];
  const exec: PsRunner = (cmd) => {
    calls.push(cmd);
    return behaviour(cmd);
  };
  return { calls, exec };
}

describe("q", () => {
  test("wraps a plain value in single quotes", () => {
    assert.equal(q("notepad.exe"), "'notepad.exe'");
  });

  test("doubles embedded single quotes", () => {
    assert.equal(q("it's"), "'it''s'");
  });

  test("leaves PowerShell metacharacters inert rather than escaping them", () => {
    // Inside single quotes PowerShell expands nothing, so $ and ` are literal.
    assert.equal(q("$env:PATH `whoami`"), "'$env:PATH `whoami`'");
  });
});

describe("resolveTarget", () => {
  test("maps a known alias", () => {
    assert.deepEqual(resolveTarget("netflix"), {
      key: "netflix",
      resolved: "netflix://",
    });
  });

  test("is case and whitespace insensitive", () => {
    assert.equal(resolveTarget("  VSCode ").resolved, "code");
  });

  test("passes an unknown target through, trimmed", () => {
    assert.equal(resolveTarget("  C:/tmp/a.txt ").resolved, "C:/tmp/a.txt");
  });
});

describe("launchApp", () => {
  test("launches the resolved alias", async () => {
    const { calls, exec } = spy();
    assert.equal(await launchApp("notepad", exec), "Launched notepad.");
    assert.deepEqual(calls, ["Start-Process 'notepad.exe'"]);
  });

  test("cannot be talked into running a second command", async () => {
    // The model picks this string; it must land inside quotes, not beside them.
    const { calls, exec } = spy();
    await launchApp("a'; Remove-Item C:\\ -Recurse; '", exec);
    assert.deepEqual(calls, [
      "Start-Process 'a''; Remove-Item C:\\ -Recurse; '''",
    ]);
    assert.doesNotMatch(
      calls[0],
      /^Start-Process 'a'; Remove-Item/,
      "the injected quote must be escaped, not closing the string",
    );
  });

  test("falls back to the web version when the protocol handler is missing", async () => {
    const { calls, exec } = spy(async (cmd) => {
      if (cmd.includes("netflix://")) throw new Error("no handler");
      return "";
    });
    const out = await launchApp("netflix", exec);
    assert.match(out, /opened the web version instead/);
    assert.deepEqual(calls, [
      "Start-Process 'netflix://'",
      "Start-Process 'https://www.netflix.com'",
    ]);
  });

  test("reports the failure when there is no fallback", async () => {
    const { exec } = spy(async () => {
      throw new Error("file not found");
    });
    assert.equal(
      await launchApp("nope.exe", exec),
      "Could not launch nope.exe: file not found",
    );
  });
});

describe("mediaKey", () => {
  for (const [action, code] of Object.entries(MEDIA_KEYS)) {
    test(`sends ${action}`, async () => {
      const { calls, exec } = spy();
      assert.equal(await mediaKey(action as "playpause", exec), `Sent ${action}.`);
      assert.match(calls[0], new RegExp(`SendKeys\\('${code.replace(/[{}]/g, "\\$&")}'\\)$`));
    });
  }

  test("refuses an unknown action without touching the shell", async () => {
    const { calls, exec } = spy();
    const out = await mediaKey("eject" as "playpause", exec);
    assert.equal(out, "Unknown media action: eject");
    assert.deepEqual(calls, []);
  });
});

describe("isProcessRunning", () => {
  test("reports a running process", async () => {
    const { calls, exec } = spy(async () => "running");
    assert.equal(await isProcessRunning("node", exec), true);
    assert.match(calls[0], /Get-Process -Name 'node' -ErrorAction SilentlyContinue/);
  });

  test("reports one that isn't", async () => {
    const { exec } = spy(async () => "gone");
    assert.equal(await isProcessRunning("node", exec), false);
  });

  test("strips .exe, which Get-Process won't accept", async () => {
    const { calls, exec } = spy(async () => "gone");
    await isProcessRunning("  Node.EXE ", exec);
    assert.match(calls[0], /-Name 'Node'/);
  });

  test("quotes the name it was handed", async () => {
    const { calls, exec } = spy(async () => "gone");
    await isProcessRunning("a'; whoami; '", exec);
    assert.match(calls[0], /-Name 'a''; whoami; '''/);
  });

  test("treats any other output as not running", async () => {
    const { exec } = spy(async () => "Get-Process : some error");
    assert.equal(await isProcessRunning("node", exec), false);
  });
});

describe("listRunningApps", () => {
  test("returns the window titles", async () => {
    const { exec } = spy(async () => "Code\nChrome");
    assert.equal(await listRunningApps(exec), "Code\nChrome");
  });

  test("says so plainly when nothing is open", async () => {
    const { exec } = spy(async () => "");
    assert.equal(await listRunningApps(exec), "No windowed applications running.");
  });
});
