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
  // The netflix:// protocol activates and dies silently when the Store app is
  // broken, which reads as success. The site always opens.
  netflix: "https://www.netflix.com",
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
  spotify: "https://open.spotify.com",
};

/**
 * Virtual key codes for the media keys, sent via keybd_event. SendKeys has no
 * tokens for these — the hardware media keys exist only as VK codes.
 */
export const MEDIA_KEYS: Record<string, number> = {
  playpause: 0xb3,
  next: 0xb0,
  previous: 0xb1,
  mute: 0xad,
  volumeup: 0xaf,
  volumedown: 0xae,
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
  const vk = MEDIA_KEYS[action];
  if (!vk) return `Unknown media action: ${action}`;

  // A press is a down and an up; flag 2 is KEYEVENTF_KEYUP. Sending only the
  // down leaves Windows believing the key is held.
  await exec(
    `if (-not ('Vela.Media' -as [type])) { Add-Type -Namespace Vela -Name Media -MemberDefinition ` +
      `'[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);' }; ` +
      `[Vela.Media]::keybd_event(${vk}, 0, 0, [UIntPtr]::Zero); ` +
      `[Vela.Media]::keybd_event(${vk}, 0, 2, [UIntPtr]::Zero)`,
  );
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

/**
 * Eyes. What is actually on his monitors right now.
 *
 * Deliberately pull-only. This reads whatever happens to be on screen, which
 * will sometimes be a password manager or his mail, so it is never wired to
 * the heartbeat and never reached for by a watch: it happens because he asked
 * in this turn. Every capture also lands as a file under data/screen/, so
 * there is a record on disk of exactly what was seen rather than it being
 * invisible.
 */

/** The long edge, in pixels, that a capture is scaled down to before sending. */
export const CAPTURE_SIZES = { normal: 800, detail: 1568 } as const;
export type CaptureDetail = keyof typeof CAPTURE_SIZES;

/**
 * Build the PowerShell that grabs a bitmap and writes it as a PNG.
 *
 * Separate from the running of it so the interesting decisions — which
 * monitor, which window, what it scales to — can be asserted on without a
 * screen existing. `window` wins over `monitor` when both are given: naming a
 * window is more specific than naming the glass it sits on.
 *
 * The scale-down happens here rather than after the fact because the whole
 * cost of this feature is pixels: past about 1568 on the long edge an image
 * stops buying any more readable detail and only costs more, and at the
 * default 800 a schematic's labels are gone but "which app is that" survives.
 */
export function captureCommand(opts: {
  path: string;
  window?: string;
  monitor?: number;
  detail?: CaptureDetail;
}): string {
  const long = CAPTURE_SIZES[opts.detail ?? "normal"];
  const target = opts.window
    ? // Match the way list_windows presents things: he says part of a title
      // he saw there, so a substring match is what he means. -like with a
      // wildcard, on a quoted string, keeps the pattern inside the quotes.
      `$w = Get-Process | Where-Object { $_.MainWindowTitle -like ${q(`*${opts.window}*`)} } | ` +
      `Select-Object -First 1; ` +
      `if (-not $w) { Write-Output 'no-window'; exit }; ` +
      `$r = New-Object Vela.Win32+RECT; ` +
      `[void][Vela.Win32]::GetWindowRect($w.MainWindowHandle, [ref]$r); ` +
      `$x = $r.Left; $y = $r.Top; ` +
      `$sw = $r.Right - $r.Left; $sh = $r.Bottom - $r.Top; `
    : // Monitor index is 1-based for him, because "my second monitor" is not
      // "monitor 1". Out of range falls back to primary rather than throwing:
      // he miscounted, and a picture of the wrong screen beats an error.
      `$screens = [System.Windows.Forms.Screen]::AllScreens; ` +
      `$i = ${Math.trunc(opts.monitor ?? 1) - 1}; ` +
      `if ($i -lt 0 -or $i -ge $screens.Count) { ` +
      `$s = [System.Windows.Forms.Screen]::PrimaryScreen } else { $s = $screens[$i] }; ` +
      `$x = $s.Bounds.X; $y = $s.Bounds.Y; ` +
      `$sw = $s.Bounds.Width; $sh = $s.Bounds.Height; `;

  return (
    `Add-Type -AssemblyName System.Windows.Forms, System.Drawing; ` +
    // GetWindowRect is only needed for the window case, but defining the type
    // unconditionally keeps the two branches from having to agree on setup.
    `if (-not ('Vela.Win32' -as [type])) { Add-Type -Namespace Vela -Name Win32 -MemberDefinition ` +
    `'[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); ` +
    `public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }' }; ` +
    target +
    `if ($sw -le 0 -or $sh -le 0) { Write-Output 'no-pixels'; exit }; ` +
    `$bmp = New-Object System.Drawing.Bitmap $sw, $sh; ` +
    `$g = [System.Drawing.Graphics]::FromImage($bmp); ` +
    `$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size); ` +
    // Scale on the way out. Ratio is capped at 1 so a small window is never
    // blown up: upscaling costs tokens and adds nothing to read.
    `$ratio = [Math]::Min(1.0, ${long} / [Math]::Max($sw, $sh)); ` +
    `$out = New-Object System.Drawing.Bitmap ([int]($sw * $ratio)), ([int]($sh * $ratio)); ` +
    `$g2 = [System.Drawing.Graphics]::FromImage($out); ` +
    `$g2.InterpolationMode = 'HighQualityBicubic'; ` +
    `$g2.DrawImage($bmp, 0, 0, $out.Width, $out.Height); ` +
    `$out.Save(${q(opts.path)}, [System.Drawing.Imaging.ImageFormat]::Png); ` +
    `$g.Dispose(); $g2.Dispose(); $bmp.Dispose(); $out.Dispose(); ` +
    `Write-Output ('ok ' + $out.Width + 'x' + $out.Height)`
  );
}

/** What a capture came back as: an image to send, or a sentence saying why not. */
export type Capture =
  | { ok: true; path: string; size: string }
  | { ok: false; reason: string };

/**
 * Take the shot. Failures come back as sentences rather than throws, the same
 * way screen.ts refuses, because the reader is the model and the message is
 * the fix.
 */
export async function captureScreen(
  opts: { path: string; window?: string; monitor?: number; detail?: CaptureDetail },
  exec: PsRunner = ps,
): Promise<Capture> {
  let out: string;
  try {
    out = await exec(captureCommand(opts));
  } catch (err) {
    return { ok: false, reason: `Could not capture the screen: ${(err as Error).message}` };
  }

  if (out.startsWith("no-window")) {
    return {
      ok: false,
      reason:
        `No open window matches "${opts.window}". ` +
        `Use list_windows to see the exact titles.`,
    };
  }
  if (out.startsWith("no-pixels")) {
    // A minimised window reports a zero or negative rect. Worth saying which,
    // because "restore it and ask again" is the fix and nothing else is.
    return { ok: false, reason: "That window is minimised, so there is nothing to capture." };
  }
  if (!out.startsWith("ok ")) {
    return { ok: false, reason: `Could not capture the screen: ${out || "no output"}` };
  }
  return { ok: true, path: opts.path, size: out.slice(3).trim() };
}
