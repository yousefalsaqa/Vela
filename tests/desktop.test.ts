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
  captureCommand,
  captureScreen,
  CAPTURE_SIZES,
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
    assert.deepEqual(resolveTarget("spotify"), {
      key: "spotify",
      resolved: "spotify:",
    });
  });

  test("netflix goes straight to the web, because the Store app fails silently", () => {
    assert.equal(resolveTarget("netflix").resolved, "https://www.netflix.com");
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
      if (cmd.includes("spotify:")) throw new Error("no handler");
      return "";
    });
    const out = await launchApp("spotify", exec);
    assert.match(out, /opened the web version instead/);
    assert.deepEqual(calls, [
      "Start-Process 'spotify:'",
      "Start-Process 'https://open.spotify.com'",
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
  for (const [action, vk] of Object.entries(MEDIA_KEYS)) {
    test(`sends ${action} as a full press, down then up`, async () => {
      const { calls, exec } = spy();
      assert.equal(await mediaKey(action as "playpause", exec), `Sent ${action}.`);
      assert.match(
        calls[0],
        new RegExp(`keybd_event\\(${vk}, 0, 0,`),
        "the key must go down",
      );
      assert.match(
        calls[0],
        new RegExp(`keybd_event\\(${vk}, 0, 2,`),
        "without the up, Windows believes the key is held forever",
      );
    });
  }

  test("never goes near SendKeys, which has no tokens for media keys", async () => {
    // The original implementation used SendKeys('{MEDIA_PLAY_PAUSE}'), which
    // throws at runtime: those brace names were never in its vocabulary. The
    // old test asserted that exact string, went green, and certified a media
    // control that had never once worked.
    const { calls, exec } = spy();
    await mediaKey("playpause", exec);
    assert.doesNotMatch(calls[0], /SendKeys/);
  });

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

describe("captureCommand", () => {
  const cmd = (over: Record<string, unknown> = {}) =>
    captureCommand({ path: "C:/data/screen/shot.png", ...over } as never);

  test("writes the png where it was told to", () => {
    assert.match(cmd(), /\.Save\('C:\/data\/screen\/shot\.png'/);
  });

  test("a path he never typed is still quoted, because a filename is not code", () => {
    // The label reaching captureFile comes from the model quoting him, so the
    // path is not attacker-controlled — but it is not a literal either, and
    // one apostrophe would end the string and start a statement.
    assert.match(
      captureCommand({ path: "C:/it's/shot.png" }),
      /\.Save\('C:\/it''s\/shot\.png'/,
      "an unescaped quote here would run whatever follows it",
    );
  });

  test("a window title he half-remembers matches the way list_windows shows it", () => {
    // He reads a title there and says part of it back, so a substring match is
    // what he means by "the Fusion window".
    assert.match(cmd({ window: "Fusion" }), /MainWindowTitle -like '\*Fusion\*'/);
  });

  test("a window title with a quote in it cannot break out of the pattern", () => {
    assert.match(cmd({ window: "Yousef's" }), /-like '\*Yousef''s\*'/);
  });

  test("naming a window beats naming a monitor, because it is the more specific ask", () => {
    const both = cmd({ window: "Fusion", monitor: 2 });
    assert.match(both, /MainWindowTitle/);
    assert.doesNotMatch(both, /AllScreens/);
  });

  test("his monitors are numbered from one, since nobody calls it monitor zero", () => {
    assert.match(cmd({ monitor: 1 }), /\$i = 0;/);
    assert.match(cmd({ monitor: 2 }), /\$i = 1;/);
    assert.match(cmd(), /\$i = 0;/, "no monitor named means the primary");
  });

  test("a monitor he does not have falls back to the primary rather than failing", () => {
    // He miscounted. A picture of the wrong screen is answerable in one line;
    // an error is a round trip that tells him nothing he wanted.
    assert.match(cmd({ monitor: 9 }), /PrimaryScreen/);
  });

  test("scales to the long edge the detail level asks for", () => {
    assert.ok(cmd().includes(`${CAPTURE_SIZES.normal} / [Math]::Max`), cmd());
    assert.ok(cmd({ detail: "detail" }).includes(`${CAPTURE_SIZES.detail} / [Math]::Max`));
  });

  test("never blows a small window up, because upscaling costs tokens and adds nothing", () => {
    assert.match(cmd(), /\[Math\]::Min\(1\.0,/);
  });

  test("detail is worth about twice the pixels, which is what makes it a choice", () => {
    assert.ok(
      CAPTURE_SIZES.detail > CAPTURE_SIZES.normal * 1.5,
      "if these were close there would be no reason to have two",
    );
  });
});

describe("captureScreen", () => {
  test("hands back where it wrote and how big it came out", async () => {
    const { exec } = spy(async () => "ok 800x450");
    const shot = await captureScreen({ path: "C:/shot.png" }, exec);
    assert.deepEqual(shot, { ok: true, path: "C:/shot.png", size: "800x450" });
  });

  test("a window that isn't open says which one and where to look", async () => {
    const { exec } = spy(async () => "no-window");
    const shot = await captureScreen({ path: "C:/shot.png", window: "Fusion" }, exec);
    assert.equal(shot.ok, false);
    assert.match((shot as { reason: string }).reason, /Fusion/);
    assert.match((shot as { reason: string }).reason, /list_windows/, "the message should be the fix");
  });

  test("a minimised window is named as minimised, not as missing", async () => {
    // The two need opposite things from him: restore it, or check the title.
    const { exec } = spy(async () => "no-pixels");
    const shot = await captureScreen({ path: "C:/shot.png", window: "Fusion" }, exec);
    assert.match((shot as { reason: string }).reason, /minimised/);
  });

  test("anything that is not a clear ok is a failure", async () => {
    // PowerShell writes warnings to stdout and desktop.ts returns stdout||stderr,
    // so a half-worked capture comes back as prose. Treating that as success
    // would send the model to read a png that was never written.
    const { exec } = spy(async () => "WARNING: could not find the display");
    assert.equal((await captureScreen({ path: "C:/shot.png" }, exec)).ok, false);
    const { exec: silent } = spy(async () => "");
    assert.equal((await captureScreen({ path: "C:/shot.png" }, silent)).ok, false);
  });

  test("a PowerShell that throws is reported, not thrown on", async () => {
    const { exec } = spy(async () => { throw new Error("powershell is gone"); });
    const shot = await captureScreen({ path: "C:/shot.png" }, exec);
    assert.equal(shot.ok, false);
    assert.match((shot as { reason: string }).reason, /powershell is gone/);
  });
});
