import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createSocket } from "node:dgram";
import { request } from "node:http";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { run as realRun, type Runner } from "./proc.js";
import { ADB, TV_HOST, TV_MAC, TV_NAME } from "./config.js";
import { DATA_DIR } from "./paths.js";

/**
 * Hands on the living-room TV.
 *
 * It is a Fire TV Edition set (Fire OS 8, which is Android 11) wired to the
 * router, and she drives it the way a developer would: adb over the network,
 * with this laptop's key approved once on the TV. That gives her everything
 * the remote does and more, with nothing to buy and no cloud in the middle.
 *
 * What she cannot do is see it. Netflix refuses screenshots and draws its
 * whole interface on one canvas that the accessibility tree reports as empty,
 * and the first attempt at choosing a profile by pressing Up and OK blind
 * landed on the show's page and rated it instead. So everything here is
 * either a key whose meaning does not depend on what is focused (power,
 * volume, play/pause, back, home), or something addressed by name (an app's
 * package, a show's link), and every action reads back what the TV reports
 * rather than assuming the press worked.
 *
 * Every answer is a sentence for the model, never a throw: a TV that is
 * unplugged or a key that was never approved is something to say out loud.
 */

export const ADB_PORT = 5555;
export const NETFLIX = "com.netflix.ninja";

/** Android key codes. The keys whose meaning does not depend on the screen. */
export const KEYS = {
  wakeup: 224,
  sleep: 223,
  volumeUp: 24,
  volumeDown: 25,
  mute: 164,
  ok: 23,
} as const;

/**
 * The remote buttons the model may press. There is deliberately no Up, Down
 * or OK: a blind press lands on whatever happens to be focused, which is how
 * a show got rated. Netflix's own OK is pressed only inside `netflix()`, at a
 * moment when Resume is the thing focused.
 */
export const REMOTE = {
  play_pause: 85,
  play: 126,
  pause: 127,
  back: 4,
  home: 3,
  rewind: 89,
  fast_forward: 90,
} as const;
export type Button = keyof typeof REMOTE;

/** What he calls them, to what the TV has installed. Read off his TV on 2026-10-02. */
export const TV_APPS: Record<string, string> = {
  netflix: NETFLIX,
  youtube: "com.amazon.firetv.youtube",
  "disney+": "com.disney.disneyplus",
  disney: "com.disney.disneyplus",
  "disney plus": "com.disney.disneyplus",
  crave: "ca.bellmedia.cravetv",
  spotify: "com.spotify.tv.android",
  twitch: "tv.twitch.android.viewer",
  prime: "com.amazon.firebat",
  "prime video": "com.amazon.firebat",
  "amazon prime": "com.amazon.firebat",
};

/**
 * After the show's link, how long before pressing OK.
 *
 * Measured on his TV from a fresh start: Netflix shows the show's page by
 * about 10 seconds, and starts the episode by itself at about 25. OK on that
 * page is Resume, so pressing it at 12 starts the episode sooner and is
 * harmless if it already started: OK over a playing episode brings up the
 * controls and did not pause it.
 */
export const NETFLIX_OK_AFTER_MS = 12_000;
/** Past this with nothing playing, something is wrong and pressing more won't fix it. */
export const NETFLIX_GIVE_UP_MS = 45_000;
/**
 * How far before the saved spot a resume may start and still count as one.
 * Netflix backs up a few seconds on resume, and the saved spot she knows can
 * be a sync old. A trailer starts at zero, which is what this tells it from.
 */
export const RESUME_SLACK_MS = 30_000;
/**
 * How long a TV woken over the network gets to come back onto it. His came
 * back 0.7 seconds after the packet, screen and all.
 */
export const WOL_WAIT_MS = 15_000;
/** Android's PlaybackState.STATE_PLAYING. */
export const PLAYING = 3;

/** A show from Netflix's Continue Watching row, as Netflix reports it to Fire TV. */
export interface Show {
  title: string;
  /** The Netflix id: the number in netflix.com/title/<id>. */
  id: string;
  progressMs: number;
  durationMs?: number;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  /** Epoch ms. What orders the row. */
  watchedAt?: number;
}

export type Wakefulness = "Awake" | "Asleep" | "Dreaming" | "Dozing";

/** `mWakefulness=` from `dumpsys power`. Dreaming is the screensaver. */
export function parseWakefulness(dump: string): Wakefulness | null {
  const m = /mWakefulness=(\w+)/.exec(dump);
  return m ? (m[1] as Wakefulness) : null;
}

/** The package in front, from `mCurrentFocus` in `dumpsys window`. Null while it sleeps. */
export function parseFocus(dump: string): string | null {
  const m = /mCurrentFocus=Window\{\S+ \S+ ([\w.]+)\//.exec(dump);
  return m ? m[1] : null;
}

/**
 * The music stream's volume from `dumpsys audio`. That is the stream the TV's
 * speakers and the remote's volume keys move; the others are alarms and calls.
 */
export function parseVolume(dump: string): { level: number; max: number; muted: boolean } | null {
  const at = dump.indexOf("- STREAM_MUSIC:");
  if (at < 0) return null;
  const end = dump.indexOf("\n- ", at + 1);
  const block = dump.slice(at, end < 0 ? undefined : end);
  const level = /streamVolume:(\d+)/.exec(block);
  const max = /Max: (\d+)/.exec(block);
  if (!level || !max) return null;
  return { level: Number(level[1]), max: Number(max[1]), muted: /Muted: true/.test(block) };
}

/**
 * An app's playback state and position from `dumpsys media_session`, read
 * only from that app's own session: Spotify's sits in the same dump.
 */
export function parsePlayback(dump: string, pkg: string): { state: number; positionMs: number } | null {
  const at = dump.indexOf(`package=${pkg}`);
  if (at < 0) return null;
  const next = dump.indexOf("package=", at + 1);
  const block = dump.slice(at, next < 0 ? undefined : next);
  const m = /state=PlaybackState \{state=(\d+), position=(\d+)/.exec(block);
  return m ? { state: Number(m[1]), positionMs: Number(m[2]) } : null;
}

/** A whole number field, or nothing when Netflix wrote `null` or left it out. */
function int(line: string, name: string): number | undefined {
  const m = new RegExp(`\\b${name}=(\\d+)`).exec(line);
  return m ? Number(m[1]) : undefined;
}

/**
 * Netflix's Continue Watching row, from the lines it logs when it hands the
 * row to Fire TV's home screen (every time it starts, about 15 seconds in).
 *
 * This is the only place outside Netflix that says what he was watching,
 * where he got to, and the show's id, which is what the resume link needs. A
 * later sync replaces an earlier one for the same show, and the row is
 * ordered by when each was last watched, most recent first.
 *
 * Each show comes as two lines: a short one with the position and when it was
 * watched, and a long one with the title and the link. Android cuts a log
 * line at about 4KB, and the long one's description comes before its
 * position, so the short line's position is the one that survives a long
 * description.
 */
export function parseContinueWatching(log: string): Show[] {
  const tiles = new Map<string, { progressMs?: number; durationMs?: number; watchedAt?: number }>();
  const shows = new Map<string, Show>();
  for (const line of log.split("\n")) {
    const item = /AmazonContinueWatchingItem\(opaqueId=([^,]+),/.exec(line);
    if (item) {
      tiles.set(item[1], {
        progressMs: int(line, "progressMs"),
        durationMs: int(line, "durationMs"),
        watchedAt: int(line, "lastWatchedTimestampMs"),
      });
      continue;
    }
    if (!line.includes("AmazonContinueWatchingItemMetadata(")) continue;
    const tile = tiles.get(/opaqueId=([^,]+),/.exec(line)?.[1] ?? "") ?? {};
    // Titles carry commas ("Love, Death & Robots"), so a title runs to the
    // field after it rather than to the first comma.
    const title = /, title=(.*?), description=/.exec(line)?.[1];
    const id = /movieId%253D(\d+)|m%3D(\d+)/.exec(line);
    const progressMs = tile.progressMs ?? int(line, "progressMs");
    if (!title || !id || progressMs === undefined) continue;
    const key = id[1] ?? id[2];
    shows.delete(key);
    shows.set(key, {
      title,
      id: key,
      progressMs,
      durationMs: tile.durationMs ?? int(line, "durationMs"),
      season: int(line, "seasonNumber"),
      episode: int(line, "episodeNumber"),
      episodeTitle: /episodeTitle=(.*?), actors=/.exec(line)?.[1],
      watchedAt: tile.watchedAt,
    });
  }
  return [...shows.values()].sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0));
}

/** 21:49, or 1:08:05 past the hour. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "The Mentalist, S2 E10 "Throwing Fire"", or just the title for a film. */
export function describeShow(show: Show): string {
  const ep = show.season && show.episode ? `, S${show.season} E${show.episode}` : "";
  const name = show.episodeTitle && show.episodeTitle !== "null" ? ` "${show.episodeTitle}"` : "";
  return `${show.title}${ep}${name}`;
}

export type Reach = "ok" | "unauthorized" | "unreachable";

/** What `adb connect` said, as one of the three things it can mean. */
export function connectOutcome(out: string): Reach {
  if (/failed to authenticate|unauthorized/i.test(out)) return "unauthorized";
  if (/\bconnected to\b/i.test(out) && !/failed|cannot|unable/i.test(out)) return "ok";
  return "unreachable";
}

/** The key presses that move the volume from one level to another. */
export function volumeKeys(from: number, to: number): number[] {
  return Array<number>(Math.abs(to - from)).fill(to > from ? KEYS.volumeUp : KEYS.volumeDown);
}

/**
 * The package for an app he named: his name for it, a package name, or a
 * word from one ("plex" finds com.plexapp.android). Only what is installed
 * counts, so a known alias for an app the TV lacks is still no.
 */
export function appPackage(name: string, installed: string[]): string | null {
  const key = name.trim().toLowerCase().replace(/\s+/g, " ");
  const known = TV_APPS[key];
  if (known) return installed.includes(known) ? known : null;
  if (installed.includes(key)) return key;
  const word = key.replace(/[^a-z0-9]/g, "");
  // Short words match half the system: "tv" is in a hundred packages.
  if (word.length < 4) return null;
  return installed.find((p) => p.toLowerCase().includes(word)) ?? null;
}

/** His name for a package, for saying back. */
function appName(pkg: string): string {
  const named: Record<string, string> = {
    [NETFLIX]: "Netflix",
    "com.amazon.firetv.youtube": "YouTube",
    "com.disney.disneyplus": "Disney+",
    "ca.bellmedia.cravetv": "Crave",
    "com.spotify.tv.android": "Spotify",
    "tv.twitch.android.viewer": "Twitch",
    "com.amazon.firebat": "Prime Video",
    "com.amazon.tv.launcher": "the home screen",
    "com.amazon.ftv.screensaver": "the screensaver",
  };
  return named[pkg] ?? pkg;
}

/** Package names off the TV are passed to its shell, so only ever these characters. */
const SAFE_PACKAGE = /^[\w.]+$/;

/**
 * Where adb is. winget's Google.PlatformTools adds a command alias, but the
 * alias isn't always written and the PATH entry doesn't reach a service that
 * started before the install, so look where winget unpacks it.
 */
export function resolveAdb(
  explicit?: string,
  local = process.env.LOCALAPPDATA ?? "",
  exists: (path: string) => boolean = existsSync,
  list: (dir: string) => string[] = (dir) => readdirSync(dir),
): string {
  if (explicit) return explicit;
  const link = join(local, "Microsoft", "WinGet", "Links", "adb.exe");
  if (exists(link)) return link;
  const packages = join(local, "Microsoft", "WinGet", "Packages");
  try {
    for (const entry of list(packages)) {
      if (!/^Google\.PlatformTools/i.test(entry)) continue;
      const exe = join(packages, entry, "platform-tools", "adb.exe");
      if (exists(exe)) return exe;
    }
  } catch {
    /* no winget packages directory */
  }
  return "adb";
}

/** The /24s this laptop sits on, leaving out WSL's and other virtual switches. */
export function localSubnets(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (/vEthernet|WSL|VirtualBox|VMware|Hyper-V/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      out.add(a.address.split(".").slice(0, 3).join("."));
    }
  }
  return [...out];
}

/** What an AirPlay receiver says about itself at /info: a plist with its name in it. */
export function airplayInfo(ip: string, port = 7000, timeoutMs = 600): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const req = request({ host: ip, port, path: "/info", timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

/**
 * Find the TV by the name it gives itself, for when the router has moved it.
 *
 * The TV answers AirPlay's /info with its name ("yousef's Fire TV") and
 * nothing else on the network does, which makes the name a better address
 * than any number the router hands out. Only asked when the remembered
 * address stops answering, so the cost of sweeping the subnet is only paid
 * then.
 */
export async function findByName(
  name: string,
  opts: { subnets?: string[]; info?: (ip: string) => Promise<Buffer | null>; batch?: number } = {},
): Promise<string | null> {
  const info = opts.info ?? ((ip: string) => airplayInfo(ip));
  const needle = Buffer.from(name, "utf8");
  const ips = (opts.subnets ?? localSubnets()).flatMap((s) =>
    Array.from({ length: 254 }, (_, i) => `${s}.${i + 1}`),
  );
  const size = opts.batch ?? 64;
  for (let i = 0; i < ips.length; i += size) {
    const hits = await Promise.all(
      ips.slice(i, i + size).map(async (ip) => ((await info(ip))?.includes(needle) ? ip : null)),
    );
    const hit = hits.find((h) => h !== null);
    if (hit) return hit;
  }
  return null;
}

/** Six 0xFF bytes, then the MAC sixteen times: the whole of Wake-on-LAN. */
export function magicPacket(mac: string): Buffer {
  const hex = mac.replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) throw new Error(`not a MAC address: ${mac}`);
  const addr = Buffer.from(hex, "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array<Buffer>(16).fill(addr)]);
}

/**
 * Wake the TV from deep standby. After a while off it drops off the network
 * entirely, adb included, and this is the one thing it still listens for:
 * the Ethernet port wakes on the packet and the set comes on as though its
 * power button were pressed. Broadcast, so it reaches the TV whatever address
 * the router has it on.
 */
export function wakeOnLan(
  mac: string,
  targets: string[] = [...localSubnets().map((s) => `${s}.255`), "255.255.255.255"],
  port = 9,
): Promise<void> {
  const packet = magicPacket(mac);
  return new Promise((resolve) => {
    const sock = createSocket("udp4");
    const done = () => {
      sock.close();
      resolve();
    };
    sock.on("error", done);
    sock.bind(() => {
      sock.setBroadcast(true);
      let left = targets.length;
      if (!left) return done();
      for (const target of targets) sock.send(packet, port, target, () => --left || done());
    });
  });
}

/**
 * Whether anything answers on the TV's adb port. Asked before adb is, because
 * adb dialling a TV that is off the network waits out Windows' 21 seconds
 * before it says so, and this says it in one and a half.
 */
export function answers(host: string, port = ADB_PORT, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (up: boolean) => {
      sock.destroy();
      resolve(up);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** What reach() says when the TV is off and that is simply the answer. */
const OFF = Symbol("off");

export interface TvOptions {
  host: string;
  /** What it calls itself over AirPlay, for finding it again. */
  name: string;
  adb: string;
  /** Where the last Continue Watching row is kept between runs. */
  shows: string;
  run?: Runner;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Its Ethernet MAC, for waking it. Left out, a TV off the network stays off. */
  mac?: string;
  /** Sweeps the network for the TV by name. Left out, a moved TV is just unreachable. */
  discover?: (name: string) => Promise<string | null>;
  /** Whether the TV's adb port answers at all. */
  probe?: (host: string) => Promise<boolean>;
  /** Sends the magic packet. */
  wol?: (mac: string) => Promise<void>;
}

export class Tv {
  private host: string;
  private readonly run: Runner;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly probe: (host: string) => Promise<boolean>;
  private readonly wol: (mac: string) => Promise<void>;
  /** One thing at a time: two tools racing would interleave their presses. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: TvOptions) {
    this.host = opts.host;
    this.run = opts.run ?? realRun;
    this.wait = opts.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
    this.probe = opts.probe ?? ((host) => answers(host));
    this.wol = opts.wol ?? ((mac) => wakeOnLan(mac));
  }

  /** Where it is now, which can differ from where it started if it moved. */
  get address(): string {
    return this.host;
  }

  private get serial(): string {
    return `${this.host}:${ADB_PORT}`;
  }

  /**
   * Run adb and read everything it said. adb puts its answers on either
   * stream and exits non-zero for some of them ("failed to authenticate"), so
   * the words decide, not the exit code. One cut off for taking too long said
   * nothing, which is what it is read as. Only adb itself failing to start
   * throws.
   */
  private async adb(args: string[], timeout = 15_000): Promise<string> {
    try {
      const { stdout, stderr } = await this.run(this.opts.adb, args, { timeout, windowsHide: true });
      return `${stdout}${stderr}`;
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: string; killed?: boolean };
      if (e.code === "ENOENT") throw new Error("adb isn't installed (winget install Google.PlatformTools)");
      if (e.killed) return "";
      const said = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      if (said) return said;
      throw err;
    }
  }

  private shell(command: string): Promise<string> {
    return this.adb(["-s", this.serial, "shell", command]);
  }

  private key(...codes: number[]): Promise<string> {
    return this.shell(`input keyevent ${codes.join(" ")}`);
  }

  private async wakefulness(): Promise<Wakefulness | null> {
    return parseWakefulness(await this.shell("dumpsys power | grep mWakefulness="));
  }

  private async focus(): Promise<string | null> {
    return parseFocus(await this.shell("dumpsys window | grep mCurrentFocus"));
  }

  private async volumeNow(): Promise<{ level: number; max: number; muted: boolean } | null> {
    return parseVolume(await this.shell("dumpsys audio"));
  }

  private async playback(pkg: string): Promise<{ state: number; positionMs: number } | null> {
    return parsePlayback(await this.shell("dumpsys media_session"), pkg);
  }

  /** Poll until `check` holds or `ms` runs out. */
  private async until(check: () => Promise<boolean>, ms: number, every = 500): Promise<boolean> {
    const end = this.now() + ms;
    for (;;) {
      if (await check()) return true;
      if (this.now() >= end) return false;
      await this.wait(every);
    }
  }

  /** Run one thing against the TV, after whatever is already running, and say how it went. */
  private serially(work: () => Promise<string>): Promise<string> {
    const next = this.queue.then(work, work).catch((err: Error) => `The TV didn't answer: ${err.message}`);
    this.queue = next;
    return next;
  }

  /**
   * Get adb onto the TV.
   *
   * `wake` is whether the ask needs the TV on: turning it on, opening
   * something, Netflix. For those, a TV that has dropped off the network gets
   * the Wake-on-LAN packet, and if it still isn't where it was, a search by
   * name in case the router moved it. For everything else, a TV off the
   * network is a TV that's off, and that is the answer, said without waking
   * it or sweeping the network for it.
   *
   * OFF for that; null when adb has it; otherwise the sentence saying why not.
   */
  private async reach(wake: boolean): Promise<string | null | typeof OFF> {
    let up = await this.probe(this.host);
    if (!up && !wake) return OFF;
    if (!up && this.opts.mac) {
      await this.wol(this.opts.mac);
      up = await this.until(() => this.probe(this.host), WOL_WAIT_MS);
    }
    if (!up && this.opts.discover) {
      const found = await this.opts.discover(this.opts.name);
      if (found) {
        this.host = found;
        up = true;
      }
    }
    if (!up) {
      return (
        `The TV isn't answering on the network (tried ${this.host}` +
        `${this.opts.mac ? ", and sent it the wake-up packet" : ""}). It may be unplugged; ` +
        "the power button on the remote brings it back."
      );
    }
    const reach = await this.link();
    if (reach === "unauthorized") {
      return (
        "The TV is refusing this laptop. Someone has to accept \"Allow USB debugging?\" " +
        "on the TV with the remote, ticking \"Always allow from this computer\"."
      );
    }
    if (reach === "unreachable") return `The TV is on the network, but adb can't get through to it (${this.host}).`;
    return null;
  }

  /**
   * Ask adb what it holds for the TV first, which is instant and is the
   * answer on almost every ask. Anything but a working connection (nothing
   * held, a dead one left from before the TV slept, one it refused) is
   * dropped and dialled afresh: dialling over a dead one is where adb hangs,
   * and a fresh dial is what puts the approval prompt back on the TV.
   */
  private async link(): Promise<Reach> {
    const state = async () => (await this.adb(["-s", this.serial, "get-state"], 5_000)).trim();
    if ((await state()) === "device") return "ok";
    await this.adb(["disconnect", this.serial], 5_000);
    const said = connectOutcome(await this.adb(["connect", this.serial], 5_000));
    if (said !== "ok") return said;
    const now = await state();
    if (now === "device") return "ok";
    return /unauthorized/i.test(now) ? "unauthorized" : "unreachable";
  }

  /**
   * Awake and off the screensaver. KEYCODE_WAKEUP does both and is a no-op on
   * a TV that is already up, and it counts as a press, so the five-minute
   * screensaver timer starts again from now rather than coming down over
   * Netflix while it loads.
   */
  private async awake(): Promise<string | null> {
    await this.key(KEYS.wakeup);
    const up = await this.until(async () => (await this.wakefulness()) === "Awake", 6_000);
    return up ? null : "The TV didn't wake up when asked.";
  }

  power(on: boolean): Promise<string> {
    return this.serially(async () => {
      const problem = await this.reach(on);
      if (problem === OFF) return "The TV is already off.";
      if (problem) return problem;
      if (on) return (await this.awake()) ?? "The TV is on.";
      if ((await this.wakefulness()) === "Asleep") return "The TV is already off.";
      await this.key(KEYS.sleep);
      const off = await this.until(async () => (await this.wakefulness()) === "Asleep", 6_000);
      return off ? "The TV is off." : "Asked the TV to turn off, but it still says it's on.";
    });
  }

  /** To a level, by a step, or mute. Reads the level back rather than trusting the presses. */
  volume(change: { to?: number; by?: number; mute?: boolean }): Promise<string> {
    return this.serially(async () => {
      const problem = await this.reach(false);
      if (problem === OFF || (!problem && (await this.wakefulness()) === "Asleep")) {
        return "The TV is off, so there's no volume to change.";
      }
      if (problem) return problem;
      if (change.mute !== undefined) {
        const before = await this.volumeNow();
        if (before && before.muted === change.mute) return change.mute ? "It's already muted." : "It isn't muted.";
        await this.key(KEYS.mute);
        const after = await this.volumeNow();
        return after?.muted ? "Muted." : `Unmuted, at ${after?.level ?? "its old level"}.`;
      }
      const now = await this.volumeNow();
      if (!now) return "Couldn't read the TV's volume.";
      const want = change.to ?? now.level + (change.by ?? 0);
      const target = Math.max(0, Math.min(now.max, Math.round(want)));
      const presses = volumeKeys(now.level, target);
      if (!presses.length) return `It's already at ${target}.`;
      await this.key(...presses);
      const after = await this.volumeNow();
      return `Volume ${after?.level ?? target} (was ${now.level}, out of ${now.max}).`;
    });
  }

  remote(button: Button): Promise<string> {
    return this.serially(async () => {
      const problem = await this.reach(false);
      if (problem === OFF || (!problem && (await this.wakefulness()) === "Asleep")) return "The TV is off.";
      if (problem) return problem;
      await this.key(REMOTE[button]);
      return `Pressed ${button === "play_pause" ? "play/pause" : button.replace("_", " ")}.`;
    });
  }

  /** Bring an app up as it is, and nothing more: no profile, no show. He does those. */
  open(app: string): Promise<string> {
    return this.serially(async () => {
      const problem = (await this.reach(true)) ?? (await this.awake());
      if (problem) return problem as string;
      const installed = (await this.shell("pm list packages"))
        .split("\n")
        .map((l) => l.replace(/^package:/, "").trim())
        .filter(Boolean);
      const pkg = appPackage(app, installed);
      if (!pkg || !SAFE_PACKAGE.test(pkg)) {
        const have = [...new Set(Object.values(TV_APPS))].filter((p) => installed.includes(p)).map(appName);
        return `There's no ${app} on the TV. It has ${have.join(", ")}.`;
      }
      await this.launch(pkg);
      const front = await this.until(async () => (await this.focus()) === pkg, 8_000);
      return front ? `${appName(pkg)} is open on the TV.` : `Asked the TV to open ${appName(pkg)}, but it isn't in front yet.`;
    });
  }

  private launch(pkg: string): Promise<string> {
    return this.shell(`monkey -p ${pkg} -c android.intent.category.LEANBACK_LAUNCHER 1`);
  }

  /**
   * The Continue Watching row: fresh from the TV's log when Netflix has
   * started recently, otherwise the copy kept from the last time it did. The
   * log turns over within minutes of playback, so the copy is what makes
   * "resume my show" fast on an evening's first ask.
   */
  private async shows(): Promise<Show[]> {
    const fresh = parseContinueWatching(await this.adb(["-s", this.serial, "logcat", "-d", "-s", "FTVIntegrationSDK:I"]));
    if (!fresh.length) return this.kept();
    try {
      mkdirSync(dirname(this.opts.shows), { recursive: true });
      writeFileSync(this.opts.shows, JSON.stringify(fresh, null, 2));
    } catch {
      /* a copy that can't be written only costs speed next time */
    }
    return fresh;
  }

  /** The row as last kept, which is all there is to go on while the TV is off. */
  private kept(): Show[] {
    try {
      return JSON.parse(readFileSync(this.opts.shows, "utf8")) as Show[];
    } catch {
      return [];
    }
  }

  /**
   * Resume what he was last watching, or play a title by its Netflix id.
   *
   * The link skips "Who's watching?" and plays on whichever profile Netflix
   * used last; tested with that screen left up, it went straight through. So
   * no profile is chosen here. Netflix is closed first so the timing is the
   * measured one from a fresh start rather than whatever the running copy is
   * in the middle of.
   */
  netflix(opts: { id?: string } = {}): Promise<string> {
    return this.serially(async () => {
      const problem = (await this.reach(true)) ?? (await this.awake());
      if (problem) return problem as string;

      let show: Show | undefined;
      let id = opts.id?.trim();
      if (id && !/^\d+$/.test(id)) {
        return "A Netflix id is only digits, like 70155590: the number in netflix.com/title/<id>.";
      }
      if (!id) {
        show = (await this.shows())[0];
        if (!show) {
          // Netflix hands Fire TV the row each time it starts, so start it and listen.
          await this.launch(NETFLIX);
          await this.until(async () => (await this.shows()).length > 0, 30_000, 1_000);
          show = (await this.shows())[0];
          if (!show) return "Netflix is open, but it didn't say what you were watching. Pick it from Continue Watching.";
        }
        id = show.id;
      }

      await this.shell(`am force-stop ${NETFLIX}`);
      await this.shell(
        `am start -a android.intent.action.VIEW -d https://www.netflix.com/watch/${id} -n ${NETFLIX}/.MainActivity -e source 30`,
      );
      const started = this.now();
      let pressed = false;
      let seen: { state: number; positionMs: number } | null = null;
      const playing = (): boolean =>
        seen?.state === PLAYING &&
        (show ? seen.positionMs >= show.progressMs - RESUME_SLACK_MS : pressed && seen.positionMs > 0);
      while (this.now() - started < NETFLIX_GIVE_UP_MS) {
        seen = await this.playback(NETFLIX);
        if (playing()) break;
        if (!pressed && this.now() - started >= NETFLIX_OK_AFTER_MS) {
          await this.key(KEYS.ok);
          pressed = true;
        }
        await this.wait(1_000);
      }

      // Netflix synced its row on the way up; keep it for next time.
      await this.shows();
      const name = show ? describeShow(show) : "it";
      if (playing()) return `Playing ${name} from ${clock(seen!.positionMs)}.`;
      if (seen?.state === PLAYING && show) {
        return (
          `Netflix is playing, but at ${clock(seen.positionMs)}, not where you left ${show.title} ` +
          `(${clock(show.progressMs)}). It may be on someone else's profile.`
        );
      }
      return "Netflix didn't start playing. It's up on the TV; OK on the remote should start it.";
    });
  }

  /**
   * Is it on, screensaver included? For a bare "pause" that could as easily
   * be about the laptop: only a TV that is on gets it. Never wakes it.
   */
  async isOn(): Promise<boolean> {
    const said = await this.serially(async () => {
      if (await this.reach(false)) return "off";
      const wake = await this.wakefulness();
      return wake === "Awake" || wake === "Dreaming" ? "on" : "off";
    });
    return said === "on";
  }

  /** On or off, what's in front, the volume, Netflix's position, and the last show. */
  status(): Promise<string> {
    return this.serially(async () => {
      const problem = await this.reach(false);
      if (problem && problem !== OFF) return problem;
      const lines: string[] = [];
      const wake = problem === OFF ? "Asleep" : await this.wakefulness();
      if (wake === "Asleep") lines.push("The TV is off.");
      else {
        const front = await this.focus();
        const showing = wake === "Dreaming" ? ", on its screensaver" : front ? `, showing ${appName(front)}` : "";
        lines.push(`The TV is on${showing}.`);
        const vol = await this.volumeNow();
        if (vol) lines.push(`Volume ${vol.level} of ${vol.max}${vol.muted ? ", muted" : ""}.`);
        const nf = await this.playback(NETFLIX);
        if (nf?.state === PLAYING) lines.push(`Netflix is playing, at ${clock(nf.positionMs)}.`);
      }
      const last = (problem === OFF ? this.kept() : await this.shows())[0];
      if (last) lines.push(`Last on Netflix: ${describeShow(last)}, ${clock(last.progressMs)} in.`);
      return lines.join(" ");
    });
  }
}

/**
 * The TV the tools reach. Module state, like voices.ts: made on first use, so
 * nothing touches adb until he asks for the TV, and a test hands in its own.
 */
let live: Tv | null = null;
export function useTv(next: Tv | null): void {
  live = next;
}
export function tv(): Tv {
  live ??= new Tv({
    host: TV_HOST,
    name: TV_NAME,
    adb: resolveAdb(ADB),
    mac: TV_MAC,
    shows: join(DATA_DIR, "netflix.json"),
    discover: (name) => findByName(name),
  });
  return live;
}
