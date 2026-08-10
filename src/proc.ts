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

export const spawn: Spawner = (command, args, options) =>
  nodeSpawn(command, args, options);

/** Runs a command to completion and hands back what it wrote. */
export type Runner = (
  command: string,
  args: string[],
  options: object,
) => Promise<{ stdout: string; stderr: string }>;

export const run = promisify(execFile) as Runner;
