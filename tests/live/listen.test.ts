import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  transcribe,
  audioDevices,
  pickDevice,
  resolveFfmpeg,
} from "../../src/listen.js";

/**
 * The speech chain for real — `npm run test:live`.
 *
 * Vela speaks a known sentence to a wav with the same synthesiser she talks
 * through, then transcribes it with the same whisper the microphone path uses.
 * No human required, and it catches the thing unit tests can't: whisper being
 * missing, on the wrong compute device, or newly unable to load its model.
 */

const enabled = Boolean(process.env.VELA_LIVE);
const SPOKEN = "open the fantasy project and check the build";

describe("speech", { skip: !enabled && "set VELA_LIVE=1 to run" }, () => {
  let dir: string;
  let wav: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "vela-speech-"));
    wav = join(dir, "take.wav");
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Add-Type -AssemblyName System.Speech; " +
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
        `$s.SetOutputToWaveFile('${wav.replace(/\\/g, "\\\\")}'); ` +
        `$s.Speak('${SPOKEN}'); $s.Dispose()`,
    ]);
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test("synthesises audio to transcribe", () => {
    assert.ok(existsSync(wav), "SAPI should have written a wav");
  });

  test("transcribes what was said", async () => {
    const heard = await transcribe(wav, {
      model: process.env.VELA_WHISPER_MODEL ?? "base.en",
      computeDevice: process.env.VELA_WHISPER_DEVICE ?? "cpu",
    });
    // Whisper punctuates and capitalises; compare on the words alone.
    const words = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, "").trim();
    assert.equal(words(heard), SPOKEN, `heard: ${JSON.stringify(heard)}`);
  });

  test("finds ffmpeg without needing it on PATH", () => {
    // The app resolves it out of winget's install directory; the test must go
    // through the same path or it only proves something about this shell.
    assert.ok(resolveFfmpeg(process.env.VELA_FFMPEG), "ffmpeg not found anywhere");
  });

  test("finds a microphone to record from", async () => {
    const ffmpeg = resolveFfmpeg(process.env.VELA_FFMPEG);
    assert.ok(ffmpeg);
    const devices = await audioDevices(ffmpeg);
    assert.ok(devices.length > 0, "ffmpeg reported no audio inputs");
    assert.ok(pickDevice(devices, process.env.VELA_MIC), "nothing looked like a microphone");
  });
});
