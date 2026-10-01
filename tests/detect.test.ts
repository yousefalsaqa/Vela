import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDetector, openSpotter } from "../src/detect.js";
import { fakeSpawner, settle } from "./helpers/proc.js";

/**
 * The wake word as one model answering one question.
 *
 * These pin the wire to the worker and the thing the wire exists for: an
 * answer that arrives before the transcript it belongs to, and keeps until
 * that transcript catches up.
 */
describe("openDetector", () => {
  const harness = (over: Record<string, unknown> = {}) => {
    const fake = fakeSpawner();
    const woke: number[] = [];
    const problems: string[] = [];
    let clock = 1_000;
    const detector = openDetector({
      python: "python.exe",
      worker: "wake_worker.py",
      model: "hey_jarvis",
      spawn: fake.spawn,
      onWake: (s) => woke.push(s),
      onProblem: (why) => problems.push(why),
      now: () => clock,
      ...over,
    });
    return { fake, woke, problems, detector, tick: (ms: number) => (clock += ms) };
  };

  test("hands the worker its model and thresholds, because they are the whole configuration", () => {
    const fake = fakeSpawner();
    openDetector({
      python: "python.exe",
      worker: "wake_worker.py",
      model: "C:/models/hey_vela.onnx",
      threshold: 0.6,
      vad: 0.4,
      spawn: fake.spawn,
    });
    assert.deepEqual(fake.last().args, [
      "wake_worker.py",
      "C:/models/hey_vela.onnx",
      "0.6",
      "0.4",
    ]);
  });

  test("waits for the model to load before saying it is ready", async () => {
    // 1.2s of onnxruntime start-up. Reporting ready before it has loaded would
    // have her listening on a model that is not scoring yet.
    const h = harness();
    let up = false;
    void h.detector.ready.then(() => (up = true));
    await settle();
    assert.equal(up, false, "nothing has said the model is loaded");
    h.fake.last().proc.say("ready");
    await settle();
    assert.equal(up, true);
  });

  test("feeds the microphone straight through, since the worker wants the same bytes", () => {
    const h = harness();
    const pcm = Buffer.alloc(2560, 7);
    h.detector.push(pcm);
    assert.deepEqual(h.fake.last().proc.written, pcm);
  });

  test("a detection keeps, because it lands before the transcript it belongs to", async () => {
    // "hey vella" is over before the sentence after it is, so the model fires
    // while whisper is still being handed the audio. An answer that only held
    // for the instant it arrived would always have expired by the time there
    // was a transcript to attach it to.
    const h = harness();
    h.fake.last().proc.say("wake 0.930");
    await settle();
    h.tick(1_500);
    assert.equal(h.detector.firedSince(3_000), true);
    assert.equal(h.detector.lastScore(), 0.93);
  });

  test("and expires, so a wake from a minute ago cannot claim this sentence", async () => {
    const h = harness();
    h.fake.last().proc.say("wake 0.930");
    await settle();
    h.tick(60_000);
    assert.equal(h.detector.firedSince(3_000), false);
  });

  test("never having fired is not a stale detection at time zero", () => {
    // firedAt starts at 0 and so does a clock in a test. Without the guard the
    // detector reports a wake before anything has been said to it.
    const h = harness({ now: () => 0 });
    assert.equal(h.detector.firedSince(3_000), false);
  });

  test("a line split across two reads is still one detection", async () => {
    // The pipe breaks where it likes. Parsing what has arrived so far would
    // read "wake 0.9" as a score of 0.9 and then "30" as another.
    const h = harness();
    h.fake.last().proc.stdout.write("wake 0.9");
    await settle();
    assert.equal(h.detector.firedSince(1_000), false, "half a line is not a detection");
    h.fake.last().proc.stdout.write("30\n");
    await settle();
    assert.equal(h.detector.lastScore(), 0.93);
  });

  test("a worker that cannot start reports it rather than leaving her waiting", async () => {
    const h = harness();
    let up = false;
    void h.detector.ready.then(() => (up = true));
    h.fake.last().proc.fail("ENOENT");
    await settle();
    assert.equal(up, true, "she must find out the wake word is off, not hang on it");
    assert.match(h.problems[0] ?? "", /couldn't run the wake model/);
  });

  test("says nothing more once stopped, so shutdown does not write to a dead pipe", () => {
    const h = harness();
    h.detector.stop();
    h.detector.push(Buffer.alloc(2560, 7));
    assert.equal(h.fake.last().proc.killed, true);
    assert.equal(h.fake.last().proc.written.length, 0);
  });

  test("stopping is not reported as the model dying on its own", async () => {
    // close fires either way. Without the guard, every shutdown logs a fault.
    const h = harness();
    h.detector.stop();
    h.fake.last().proc.close();
    await settle();
    assert.deepEqual(h.problems, []);
  });
});

describe("the fire, the spotter, and knowing it loaded", () => {
  test("everyone listening hears a detection the moment it arrives", async () => {
    // The chime is the worker's, but the window, the models paging in and the
    // filler all hang off this — none of them can wait for a transcript.
    const fake = fakeSpawner();
    const detector = openDetector({ python: "python.exe", worker: "wake_worker.py", model: "m", spawn: fake.spawn });
    const a: number[] = [];
    const b: number[] = [];
    detector.onFire((s) => a.push(s));
    detector.onFire((s) => b.push(s));
    fake.last().proc.say("wake 0.810");
    await settle();
    assert.deepEqual([a, b], [[0.81], [0.81]]);
  });

  test("the spotter's line carries the phrase after the number, and the number still reads", async () => {
    // A spotter has no score, so it says "wake 1 HEY_VELA". Number() of that
    // whole tail is NaN; the detection must still count.
    const fake = fakeSpawner();
    const detector = openSpotter({ python: "python.exe", worker: "kws_worker.py", model: "dir", phrases: ["hey vela"], spawn: fake.spawn });
    const heard: number[] = [];
    detector.onFire((s) => heard.push(s));
    fake.last().proc.say("wake 1 HEY_VELA");
    await settle();
    assert.deepEqual(heard, [1]);
  });

  test("the spotter is started with exactly what it was configured with", () => {
    const fake = fakeSpawner();
    openSpotter({
      python: "python.exe",
      worker: "kws_worker.py",
      model: "C:/kws",
      phrases: ["hey vela", "hey vella"],
      boost: 3,
      trigger: 0.15,
      gainDb: 20,
      chime: "off",
      spawn: fake.spawn,
    });
    assert.deepEqual(fake.last().args, ["kws_worker.py", "C:/kws", "hey vela,hey vella", "3", "0.15", "20", "off"]);
  });

  test("ready says whether the model came up, because a dead one kept would deafen her", async () => {
    // A detector that is present switches the transcript path off. One that
    // never loaded and was kept anyway is an assistant that cannot hear her
    // name at all, so the caller has to be told which it got.
    const up = fakeSpawner();
    const good = openDetector({ python: "p", worker: "w", model: "m", spawn: up.spawn });
    up.last().proc.say("ready");
    assert.equal(await good.ready, true);

    const down = fakeSpawner();
    const bad = openDetector({ python: "p", worker: "w", model: "m", spawn: down.spawn });
    down.last().proc.say("err no module named sherpa_onnx");
    down.last().proc.close(1);
    assert.equal(await bad.ready, false);
  });
});
