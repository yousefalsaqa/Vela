import {
  spawn as nodeSpawn,
  execFile,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { promisify } from "node:util";

/**
 * The seam where Vela touches the operating system.
 *
 * Everything that speaks, listens or drives the desktop ends up spawning
 * something, and none of that can run for real in a unit test — it would make
 * noise, open the microphone, and only prove something about this machine.
 *
 * Injecting the spawn leaves the interesting half testable: the line protocol
 * she talks to her workers over, the queueing that stops two sentences playing
 * at once, and what happens when a child dies mid-word. Only the last inch —
 * the call itself — goes untested, and `tests/live` covers that end to end.
 */
export type Spawner = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * One OpenBLAS thread per child, unless something asked for more.
 *
 * numpy's OpenBLAS commits a buffer for every core it might use, and this
 * machine has 24. Measured on 2026-10-01 with each worker loaded and idle:
 * the voice worker committed 828MB and needed 89; whisper 1820 and needed 1080;
 * Kokoro 1965 and needed 1227; and the wake word's the same as the voice
 * worker. About 2.9GB of commit charge for nothing, on a machine running at 25
 * of its 29GB. None of them does its real work in OpenBLAS — CTranslate2,
 * torch and onnxruntime have their own threads — and whisper and Kokoro timed
 * the same either way (589 against 622ms, 583 against 585ms). OMP is left
 * alone, because torch's real work is in it.
 */
export const spawn: Spawner = (command, args, options) =>
  nodeSpawn(command, args, {
    ...options,
    env: { OPENBLAS_NUM_THREADS: "1", ...(options.env ?? process.env) },
  });

/** Runs a command to completion and hands back what it wrote. */
export type Runner = (
  command: string,
  args: string[],
  options: object,
) => Promise<{ stdout: string; stderr: string }>;

export const run = promisify(execFile) as Runner;
