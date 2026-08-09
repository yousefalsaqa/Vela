import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Runs a PowerShell command and resolves with its output. */
export type PsRunner = (command: string) => Promise<string>;

/**
 * Run a PowerShell command. Arguments are passed as a single -Command string,
 * so callers must never interpolate untrusted text directly — use `q`, which
 * quotes its input.
 */
const ps: PsRunner = async (command) => {
  const { stdout, stderr } = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { timeout: 20_000, windowsHide: true },
  );
  return (stdout || stderr || "").trim();
};

/**
 * Single-quote a string for safe embedding in PowerShell. Inside single quotes
 * PowerShell expands nothing, so doubling the quote character is the whole job.
 */
export function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Known shortcuts so the model doesn't have to guess launch strings. */
export const APP_ALIASES: Record<string, string> = {
  netflix: "netflix://",
  spotify: "spotify:",
  youtube: "https://www.youtube.com",
  chrome: "chrome.exe",
  code: "code",
  vscode: "code",
  explorer: "explorer.exe",
  terminal: "wt.exe",
  calculator: "calc.exe",
  notepad: "notepad.exe",
};

/** Web versions to fall back on when a protocol handler isn't registered. */
export const WEB_FALLBACKS: Record<string, string> = {
  netflix: "https://www.netflix.com",
  spotify: "https://open.spotify.com",
};

/** Virtual key codes for the media keys, sent via the WScript shell. */
export const MEDIA_KEYS: Record<string, string> = {
  playpause: "{MEDIA_PLAY_PAUSE}",
  next: "{MEDIA_NEXT_TRACK}",
  previous: "{MEDIA_PREV_TRACK}",
  mute: "{VOLUME_MUTE}",
  volumeup: "{VOLUME_UP}",
  volumedown: "{VOLUME_DOWN}",
};

export function resolveTarget(target: string): { key: string; resolved: string } {
  const key = target.trim().toLowerCase();
  return { key, resolved: APP_ALIASES[key] ?? target.trim() };
}

export async function launchApp(
  target: string,
  exec: PsRunner = ps,
): Promise<string> {
  const { key, resolved } = resolveTarget(target);

  try {
    await exec(`Start-Process ${q(resolved)}`);
    return `Launched ${target}.`;
  } catch (err) {
    // A URL/protocol handler that isn't registered is the common failure.
    // Fall back to the web version when we know one.
    if (WEB_FALLBACKS[key]) {
      await exec(`Start-Process ${q(WEB_FALLBACKS[key])}`);
      return `Native app for ${target} unavailable; opened the web version instead.`;
    }
    return `Could not launch ${target}: ${(err as Error).message}`;
  }
}

export async function mediaKey(
  action: "playpause" | "next" | "previous" | "mute" | "volumeup" | "volumedown",
  exec: PsRunner = ps,
): Promise<string> {
  const key = MEDIA_KEYS[action];
  if (!key) return `Unknown media action: ${action}`;

  await exec(`$w = New-Object -ComObject WScript.Shell; $w.SendKeys(${q(key)})`);
  return `Sent ${action}.`;
}

/** Whether a process is running now. Used by process-triggered watches. */
export async function isProcessRunning(
  name: string,
  exec: PsRunner = ps,
): Promise<boolean> {
  // Get-Process wants the base name, so `node.exe` has to become `node`.
  const base = name.trim().replace(/\.exe$/i, "");
  const out = await exec(
    `if (Get-Process -Name ${q(base)} -ErrorAction SilentlyContinue) ` +
      `{ 'running' } else { 'gone' }`,
  );
  return out.trim() === "running";
}

export async function listRunningApps(exec: PsRunner = ps): Promise<string> {
  const out = await exec(
    "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } " +
      "| Select-Object -ExpandProperty MainWindowTitle",
  );
  return out || "No windowed applications running.";
}
