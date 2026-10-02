import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createCanceller } from "../src/echo.js";
import { fakeSpawner, settle } from "./helpers/proc.js";

function canceller() {
  const cleaned: { clean: Buffer; raw: Buffer }[] = [];
  const problems: string[] = [];
  let ready = 0;
  const fake = fakeSpawner();
  const c = createCanceller({
    python: "python.exe",
    worker: "aec_worker.py",
    onClean: (clean, raw) => cleaned.push({ clean, raw }),
    onReady: () => ready++,
    onProblem: (why) => problems.push(why),
    spawn: fake.spawn,
  });
  return { c, fake, cleaned, problems, ready: () => ready };
}

describe("createCanceller", () => {
  test("each cleaned chunk comes with the raw audio it was made from, however the worker splits it", async () => {
    // The barge watcher reads what the canceller took off, so a cleaned chunk
    // paired with the wrong raw one would make her own echo look like him.
    const { c, fake, cleaned } = canceller();
    c.push(Buffer.from([1, 0, 2, 0]));
    c.push(Buffer.from([3, 0, 4, 0, 5, 0]));
    fake.last().proc.stdout.write(Buffer.from([10, 0, 20, 0, 30, 0]));
    await settle();
    fake.last().proc.stdout.write(Buffer.from([40, 0, 50, 0]));
    await settle();
    assert.deepEqual(
      cleaned.map((c) => [...c.raw]),
      [
        [1, 0, 2, 0, 3, 0],
        [4, 0, 5, 0],
      ],
    );
    c.stop();
  });

  test("the microphone goes in as it is and comes back as the worker cleaned it", async () => {
    const { c, fake, cleaned } = canceller();
    const mic = Buffer.from([1, 0, 2, 0]);
    c.push(mic);
    assert.deepEqual(fake.last().proc.written, mic);
    fake.last().proc.stdout.write(Buffer.from([9, 0, 9, 0]));
    await settle();
    assert.deepEqual(cleaned, [{ clean: Buffer.from([9, 0, 9, 0]), raw: mic }]);
    c.stop();
  });

  test("ready is said once both streams are open", async () => {
    const { c, fake, ready } = canceller();
    fake.last().proc.stderr.write("ready\n");
    await settle();
    assert.equal(ready(), 1);
    c.stop();
  });

  test("the loopback's gap warnings are its normal state, not a problem to report", async () => {
    // soundcard warns on every gap in what the speakers play, which is any
    // moment nothing is playing.
    const { c, fake, problems } = canceller();
    fake.last().proc.stderr.write("SoundcardRuntimeWarning: data discontinuity in recording\n");
    await settle();
    assert.deepEqual(problems, []);
    c.stop();
  });

  test("a Python failure is said by the line that names it, once", async () => {
    const { c, fake, problems } = canceller();
    fake.last().proc.stderr.write("Traceback (most recent call last):\n  File \"aec_worker.py\", line 28\nModuleNotFoundError: No module named 'livekit'\n");
    fake.last().proc.stderr.write("ValueError: again\n");
    await settle();
    assert.deepEqual(problems, ["echo canceller: ModuleNotFoundError: No module named 'livekit'"]);
    c.stop();
  });

  test("a worker that dies is said, and nothing more is written to it", async () => {
    const { c, fake, problems } = canceller();
    fake.last().proc.close(1);
    c.push(Buffer.from([1, 0]));
    assert.equal(fake.last().proc.written.length, 0);
    assert.match(problems[0], /can't hear him over her/);
  });

  test("stopping it on purpose is not a problem", () => {
    const { c, problems } = canceller();
    c.stop();
    assert.deepEqual(problems, []);
  });
});
