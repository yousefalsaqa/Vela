import type { ChildProcess } from "node:child_process";
import { spawn as realSpawn, type Spawner } from "./proc.js";

/**
 * The microphone with her own voice taken out of it, for hearing him over her.
 *
 * Her voice comes back into the laptop's microphone at -34.5 dBFS, as loud as
 * his, which is why she has always shut her ears while she talks. The worker
 * (scripts/aec_worker.py) runs WebRTC's echo canceller against what the
 * speakers are playing, recorded by WASAPI loopback, and hands back the
 * microphone cleaned: measured live on this laptop, her voice down to about
 * -60 dBFS while she talks, against his at -35.
 *
 * Only the barge watcher listens to the cleaned stream. The wake word and
 * whisper keep the microphone as it is, which is what they were tuned on.
 */
export interface Canceller {
  /** Raw microphone audio in, exactly as the wake listener got it. */
  push: (pcm: Buffer) => void;
  stop: () => void;
}

export function createCanceller(opts: {
  python: string;
  worker: string;
  /** Cleaned audio, 10ms out for every 10ms in. */
  onClean: (pcm: Buffer) => void;
  /** Both of its streams are open, so what comes out from here is cleaned. */
  onReady?: () => void;
  onProblem?: (why: string) => void;
  spawn?: Spawner;
}): Canceller {
  const spawn = opts.spawn ?? realSpawn;
  let stopped = false;
  let gone = false;
  let complained = false;
  const complain = (why: string) => {
    if (complained) return;
    complained = true;
    opts.onProblem?.(why);
  };

  const worker: ChildProcess = spawn(opts.python, [opts.worker], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  worker.on("error", (err) => {
    gone = true;
    complain(`couldn't start the echo canceller: ${err.message}`);
  });
  worker.on("close", () => {
    gone = true;
    if (!stopped) complain("the echo canceller stopped, so she can't hear him over her until she restarts");
  });
  worker.stdout?.on("data", (pcm: Buffer) => opts.onClean(pcm));
  let said = "";
  worker.stderr?.setEncoding("utf8");
  worker.stderr?.on("data", (chunk: string) => {
    said += chunk;
    for (let cut = said.indexOf("\n"); cut >= 0; cut = said.indexOf("\n")) {
      const line = said.slice(0, cut).trim();
      said = said.slice(cut + 1);
      // soundcard warns on every gap in what the speakers play, which is any
      // moment nothing is playing. That is the normal state, not a problem.
      // A Python failure ends in the line that names it ("ModuleNotFoundError:
      // No module named 'livekit'"), which is the one worth saying.
      if (line === "ready") opts.onReady?.();
      else if (/^[\w.]*(?:Error|Exception)\b/.test(line)) complain(`echo canceller: ${line}`);
    }
  });

  return {
    push(pcm) {
      if (stopped || gone || !worker.stdin?.writable) return;
      worker.stdin.write(pcm);
    },
    stop() {
      stopped = true;
      worker.stdin?.end();
      worker.kill();
    },
  };
}
