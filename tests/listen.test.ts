import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseAudioDevices, pickDevice, cleanTranscript } from "../src/listen.js";

// Real ffmpeg output, trimmed. Video devices are listed the same way, which is
// the whole reason this needs parsing rather than a regex over quotes.
const FFMPEG_DEVICES = `
[dshow @ 000001] "HD Webcam" (video)
[dshow @ 000001]   Alternative name "@device_pnp_\\\\?\\usb#vid_1234"
[dshow @ 000001] "Microphone Array (Intel® Smart Sound Technology for Digital Microphones)" (audio)
[dshow @ 000001]   Alternative name "@device_cm_{33D9A762}\\wave_{9B365890}"
[dshow @ 000001] "Line In (Realtek Audio)" (audio)
dummy: Immediate exit requested
`;

describe("parseAudioDevices", () => {
  test("returns audio devices only, not the webcam", () => {
    assert.deepEqual(parseAudioDevices(FFMPEG_DEVICES), [
      "Microphone Array (Intel® Smart Sound Technology for Digital Microphones)",
      "Line In (Realtek Audio)",
    ]);
  });

  test("keeps non-ASCII in the name, which has to match exactly", () => {
    assert.ok(parseAudioDevices(FFMPEG_DEVICES)[0].includes("®"));
  });

  test("ignores the alternative-name lines", () => {
    assert.equal(
      parseAudioDevices(FFMPEG_DEVICES).filter((d) => d.startsWith("@device")).length,
      0,
    );
  });

  test("returns nothing when there are no devices", () => {
    assert.deepEqual(parseAudioDevices("no devices found"), []);
  });

  test("survives empty output", () => {
    assert.deepEqual(parseAudioDevices(""), []);
  });
});

describe("pickDevice", () => {
  const devices = ["Line In (Realtek Audio)", "Microphone Array (Intel)", "Stereo Mix"];

  test("takes an exact match first", () => {
    assert.equal(pickDevice(devices, "Stereo Mix"), "Stereo Mix");
  });

  test("falls back to a partial match, case insensitively", () => {
    assert.equal(pickDevice(devices, "microphone array"), "Microphone Array (Intel)");
  });

  test("prefers something that sounds like a microphone", () => {
    assert.equal(pickDevice(devices), "Microphone Array (Intel)");
  });

  test("takes the first device when nothing looks like a mic", () => {
    assert.equal(pickDevice(["Stereo Mix", "What U Hear"]), "Stereo Mix");
  });

  test("returns null when there is nothing to pick", () => {
    assert.equal(pickDevice([]), null);
  });

  test("ignores a preference that matches nothing", () => {
    assert.equal(pickDevice(devices, "usb headset"), "Microphone Array (Intel)");
  });
});

describe("cleanTranscript", () => {
  test("keeps real speech", () => {
    assert.equal(cleanTranscript(" open netflix please \n"), "open netflix please");
  });

  test("drops whisper's silence markers", () => {
    assert.equal(cleanTranscript("[BLANK_AUDIO]"), "");
    assert.equal(cleanTranscript("[INAUDIBLE]"), "");
  });

  test("strips a marker embedded in real speech", () => {
    assert.equal(cleanTranscript("open [NOISE] netflix"), "open netflix");
  });

  test("drops a sound description on its own line", () => {
    assert.equal(cleanTranscript("(upbeat music)"), "");
  });

  test("treats whisper's near-silence hallucinations as nothing said", () => {
    // These are what it emits for a second of room tone.
    for (const noise of ["you", "You.", "Thank you.", "thanks", "Bye.", ".", ""]) {
      assert.equal(cleanTranscript(noise), "", `should have ignored ${JSON.stringify(noise)}`);
    }
  });

  test("does not swallow a real sentence that starts with thanks", () => {
    assert.equal(cleanTranscript("thanks for that, now open chrome"), "thanks for that, now open chrome");
  });

  test("collapses whisper's line wrapping", () => {
    assert.equal(cleanTranscript("open the\nfantasy project"), "open the fantasy project");
  });
});
