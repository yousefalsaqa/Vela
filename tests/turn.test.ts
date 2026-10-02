import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { soundsFinished, callTurn, createTurnJudge, TRAILING } from "../src/turn.js";
import { fakeSpawner, respondToRequests, settle } from "./helpers/proc.js";

describe("soundsFinished", () => {
  test("a sentence whisper closed with . ? or ! is finished", () => {
    assert.equal(soundsFinished("How are you?"), true);
    assert.equal(soundsFinished("Find me somewhere to eat."), true);
    assert.equal(soundsFinished("Turn the TV off!"), true);
  });

  test("an ellipsis is whisper hearing him trail off, not finish", () => {
    assert.equal(soundsFinished("Can you find me..."), false);
    assert.equal(soundsFinished("Can you find me…"), false);
  });

  test("a full stop after a word no sentence ends on is whisper being tidy, not him being done", () => {
    // "I'm trying to look for something to eat and." is a breath, not an end.
    assert.equal(soundsFinished("I'm trying to look for something to eat and."), false);
    assert.equal(soundsFinished("Put on the."), false);
    assert.equal(soundsFinished("Um."), false);
  });

  test("no closing punctuation is not finished, since whisper adds it when it hears an end", () => {
    assert.equal(soundsFinished("how are you"), false);
  });

  test("closing quotes or brackets after the stop don't hide it", () => {
    assert.equal(soundsFinished('She said "stop."'), true);
  });

  test("nothing read is nothing finished", () => {
    assert.equal(soundsFinished(""), false);
    assert.equal(soundsFinished("   "), false);
    assert.equal(soundsFinished("?"), false);
  });

  test("the trailing words are all lower case, since that's how they're looked up", () => {
    for (const word of TRAILING) assert.equal(word, word.toLowerCase());
  });
});

describe("callTurn", () => {
  test("done only when the words and the sound both say so", () => {
    assert.equal(callTurn(true, 0.9, 0.5), "done");
    assert.equal(callTurn(false, 0.9, 0.5), "wait");
    assert.equal(callTurn(true, 0.2, 0.5), "wait");
  });

  test("no answer from the model is a wait, never a guess", () => {
    assert.equal(callTurn(true, null, 0.5), "wait");
  });

  test("the threshold itself counts as done", () => {
    assert.equal(callTurn(true, 0.5, 0.5), "done");
  });
});

describe("createTurnJudge", () => {
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);

  function judgeWith(reply: (request: Record<string, string>) => string | undefined, extra: { timeoutMs?: number } = {}) {
    const seen: { request: Record<string, string>; audio: Buffer; existed: boolean }[] = [];
    const problems: string[] = [];
    const fake = fakeSpawner(({ proc }) =>
      respondToRequests(proc, (request) => {
        const existed = existsSync(request.pcm);
        seen.push({ request, audio: existed ? readFileSync(request.pcm) : Buffer.alloc(0), existed });
        return reply(request);
      }),
    );
    const judge = createTurnJudge({
      python: "python.exe",
      worker: "turn_worker.py",
      model: "smart-turn.onnx",
      lazy: true,
      spawn: fake.spawn,
      onProblem: (why) => problems.push(why),
      ...extra,
    });
    return { judge, fake, seen, problems };
  }

  test("hands the worker the audio as it was, and reads its probability back", async () => {
    const { judge, fake, seen } = judgeWith(() => `ok ${JSON.stringify({ done: 0.93, ms: 31 })}`);
    assert.equal(await judge.judge(pcm), 0.93);
    assert.deepEqual(fake.last().args, ["turn_worker.py", "smart-turn.onnx"]);
    assert.deepEqual(seen[0].audio, pcm, "the model normalises for itself, so the audio goes as heard");
    assert.equal(seen[0].request.rate, 16_000);
    judge.stop();
  });

  test("the audio file is gone once it has been answered", async () => {
    const { judge, seen } = judgeWith(() => `ok ${JSON.stringify({ done: 0.4 })}`);
    await judge.judge(pcm);
    assert.equal(existsSync(seen[0].request.pcm), false, "one file per pause would fill the temp dir in a day");
    judge.stop();
  });

  test("a worker error is no answer, said once rather than at every pause", async () => {
    const { judge, problems } = judgeWith(() => `err ${JSON.stringify({ error: "model file missing" })}`);
    assert.equal(await judge.judge(pcm), null);
    assert.equal(await judge.judge(pcm), null);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /model file missing/);
    judge.stop();
  });

  test("lazy means nothing starts until it is needed", async () => {
    const { judge, fake } = judgeWith(() => `ok ${JSON.stringify({ done: 0.5 })}`);
    assert.equal(fake.spawned.length, 0, "an idle service holds no model it hasn't been asked for");
    judge.warm();
    assert.equal(fake.spawned.length, 1);
    judge.warm();
    await judge.judge(pcm);
    assert.equal(fake.spawned.length, 1, "one worker, however often it is asked");
    judge.stop();
  });

  test("an answer slower than the pause it was asked in is given up on as no answer", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { judge } = judgeWith(() => undefined, { timeoutMs: 2_000 });
      const answer = judge.judge(pcm);
      await settle();
      mock.timers.tick(2_000);
      assert.equal(await answer, null);
      judge.stop();
    } finally {
      mock.timers.reset();
    }
  });

  test("stopping answers whatever was still waiting, so nothing hangs on a closed worker", async () => {
    const { judge } = judgeWith(() => undefined);
    const answer = judge.judge(pcm);
    await settle();
    judge.stop();
    assert.equal(await answer, null);
    assert.equal(await judge.judge(pcm), null, "and nothing new is sent to it");
  });

  test("an empty utterance is never sent", async () => {
    const { judge, fake } = judgeWith(() => `ok ${JSON.stringify({ done: 1 })}`);
    assert.equal(await judge.judge(Buffer.alloc(0)), null);
    assert.equal(fake.spawned.length, 0);
    judge.stop();
  });

  test("a worker that can't be started is said once, not crashed on", async () => {
    const { judge, fake, problems } = judgeWith(() => undefined, { timeoutMs: 10 });
    judge.warm();
    fake.last().proc.fail("spawn python.exe ENOENT");
    assert.match(problems[0], /couldn't start the turn worker: spawn python.exe ENOENT/);
    judge.stop();
  });
});
