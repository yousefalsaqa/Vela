import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../src/proc.js";
import {
  Tv,
  KEYS,
  REMOTE,
  NETFLIX,
  NETFLIX_GIVE_UP_MS,
  parseWakefulness,
  parseFocus,
  parseVolume,
  parsePlayback,
  parseContinueWatching,
  clock,
  describeShow,
  connectOutcome,
  volumeKeys,
  appPackage,
  resolveAdb,
  localSubnets,
  findByName,
  airplayInfo,
  magicPacket,
  wakeOnLan,
  answers,
  type Wakefulness,
} from "../src/tv.js";

const HOST = "192.168.0.246";
const LAUNCHER = "com.amazon.tv.launcher";
const SCREENSAVER = "com.amazon.ftv.screensaver";

/** What his TV had installed on 2026-10-02, plus the system packages around them. */
const INSTALLED = [
  LAUNCHER,
  SCREENSAVER,
  NETFLIX,
  "com.amazon.firetv.youtube",
  "com.disney.disneyplus",
  "ca.bellmedia.cravetv",
  "com.spotify.tv.android",
  "com.amazon.spotify.mediabrowserservice",
  "tv.twitch.android.viewer",
  "com.amazon.firebat",
  "com.amazon.tv.livetv",
];

// Netflix's Continue Watching lines as his TV logged them, cut down: the
// image URLs and the device token in the links are gone, the shape is not.
const tile = (opaque: string, progress: number, duration: number, watched: number, n: string) =>
  `10-02 09:30:00.361 I/FTVIntegrationSDK(12620): \t${n}: AmazonContinueWatchingItem(opaqueId=${opaque}, durationMs=${duration}, ` +
  `progressMs=${progress}, lastWatchedTimestampMs=${watched}, genres=[], contentType=1, isNextEpisodeInSeries=false)`;
const meta = (opaque: string, title: string, id: string, progress: number, extra: string) =>
  `10-02 09:30:00.370 I/FTVIntegrationSDK(12620): \t1/4: AmazonContinueWatchingItemMetadata(opaqueId=${opaque}, title=${title}, ` +
  `description=After a serial killer murders his family, Patrick Jane gives up his life as a phony psychic, shortDescription=null, ` +
  `deeplinkUri=https://www.netflix.com/deeplink?payload=expireAt%3D1791034843%26iid%3D736ab158%26m%3D${id}%26source_type%3D27` +
  `%26source_type_payload%3DgroupIndex%253D0%2526action%253Dmdp%2526category%253DContinueWatching%2526movieId%253D${id}, ` +
  `locale=en_US, tileImage=AmazonImageMetadata(imageUri=https://example.invalid/t.jpg, heightPx=288, widthPx=512), ` +
  `maturityRatingSystem=TVPG, maturityRating=TV-MA, statusFlags=[], releaseYear=2015, progressMs=${progress}, ${extra}, ` +
  `actors=[], directors=[], isOriginal=null, removeIntentUri=https://www.netflix.com/deeplink?payload=m%3D${id})`;
const MENTALIST = "oWQ9tPba/+46mz0Bxyc7ig==";
const SUITS = "QQ1WINwEOk1FNUv1rbzBZw==";
const episode = (s: number, e: number, name: string, duration: number) =>
  `durationMs=${duration}, seasonNumber=${s}, episodeNumber=${e}, episodeTitle=${name}`;

/** A sync at 09:30 and the next one after he watched another minute and a bit. */
const ROW = [
  tile(MENTALIST, 1309000, 2570000, 1790885933000, "1/2"),
  tile(SUITS, 4085000, 4880000, 1789309872000, "2/2"),
  meta(MENTALIST, "The Mentalist", "70155590", 1309000, episode(2, 10, "Throwing Fire", 2570000)),
  meta(SUITS, "Suits", "70195800", 4085000, episode(1, 1, "Pilot Part 1 & 2", 4880000)),
  tile(MENTALIST, 1371000, 2570000, 1790895600000, "1/2"),
  meta(MENTALIST, "The Mentalist", "70155590", 1371000, episode(2, 10, "Throwing Fire", 2570000)),
].join("\n");

const audioDump = (level: number, max: number, muted: boolean) =>
  [
    "- STREAM_VOICE_CALL:",
    "   Muted: false",
    "   Min: 1",
    "   Max: 100",
    "   streamVolume:70",
    "- STREAM_MUSIC:",
    `   Muted: ${muted}`,
    "   Muted Internally: false",
    "   Min: 0",
    `   Max: ${max}`,
    `   streamVolume:${level}`,
    `   Current: 2 (speaker): ${level}, 4 (headset): 10, 400 (hdmi): 100, 40000000 (default): 25`,
    "   Devices: speaker",
    "- STREAM_ALARM:",
    "   Muted: true",
    "   Max: 7",
    "   streamVolume:6",
  ].join("\n");

/** Spotify's session first, playing, so reading the wrong block would show. */
const mediaDump = (netflix: { state: number; positionMs: number } | null) =>
  [
    "  Sessions Stack - have 2 sessions:",
    "    spotify-android-tv-media-session com.spotify.tv.android/spotify-android-tv-media-session (userId=0)",
    "      package=com.spotify.tv.android",
    "      active=false",
    "      state=PlaybackState {state=3, position=95000, buffered position=0, speed=1.0, updated=1, actions=0, custom actions=[], active item id=-1, error=null}",
    ...(netflix
      ? [
          "    Netflix media session com.netflix.ninja/Netflix media session (userId=0)",
          "      package=com.netflix.ninja",
          "      active=true",
          `      state=PlaybackState {state=${netflix.state}, position=${netflix.positionMs}, buffered position=0, speed=1.0, updated=770257, actions=1049466, custom actions=[], active item id=-1, error=null}`,
          "      metadata: null",
        ]
      : []),
  ].join("\n");

/** What the adb server is holding for an address: a working link, a refused one, or a dead one. */
type Transport = "device" | "unauthorized" | "offline";

const MAC = "4C:49:29:B2:23:6D";

interface Scene {
  /** False once it has been off long enough to drop off the network. */
  onNetwork: boolean;
  /** Whether "Always allow from this computer" was ticked for this laptop. */
  approved: boolean;
  /** What adb is holding, by serial. Starts holding a working link to HOST. */
  transports: Map<string, Transport>;
  /** Where the TV is: the router can move it. */
  hosts: string[];
  wake: Wakefulness;
  focus: string | null;
  level: number;
  max: number;
  muted: boolean;
  installed: string[];
  netflix: { state: number; positionMs: number } | null;
  logcat: string;
}

let dir: string;
let files = 0;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "vela-tv-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A TV that answers adb the way his did, on a clock that only moves when the
 * code under test waits. Hooks script what Netflix does after a link or a key.
 */
function fakeTv(
  partial: Partial<Scene> = {},
  hooks: { link?: (id: string) => void; key?: (code: number) => void; launch?: (pkg: string) => void } = {},
  extra: { discover?: (name: string) => Promise<string | null>; mac?: string } = {},
) {
  const scene: Scene = {
    onNetwork: true,
    approved: true,
    transports: new Map([[`${HOST}:5555`, "device"]]),
    hosts: [HOST],
    wake: "Awake",
    focus: LAUNCHER,
    level: 11,
    max: 100,
    muted: false,
    installed: [...INSTALLED],
    netflix: null,
    logcat: "",
    ...partial,
  };
  let t = 0;
  const timers: { at: number; fire: () => void }[] = [];
  const at = (ms: number, fire: () => void) => timers.push({ at: t + ms, fire });
  const wait = async (ms: number) => {
    t += ms;
    for (const due of timers.filter((x) => x.at <= t)) {
      timers.splice(timers.indexOf(due), 1);
      due.fire();
    }
  };
  const calls: string[][] = [];
  const keys: { code: number; at: number }[] = [];

  const press = (code: number) => {
    keys.push({ code, at: t });
    if (code === KEYS.wakeup) {
      scene.wake = "Awake";
      if (scene.focus === SCREENSAVER || scene.focus === null) scene.focus = LAUNCHER;
    }
    if (code === KEYS.sleep) {
      scene.wake = "Asleep";
      scene.focus = null;
    }
    if (code === KEYS.volumeUp) scene.level = Math.min(scene.max, scene.level + 1);
    if (code === KEYS.volumeDown) scene.level = Math.max(0, scene.level - 1);
    if (code === KEYS.mute) scene.muted = !scene.muted;
    hooks.key?.(code);
  };

  const shell = (cmd: string): string => {
    if (cmd.startsWith("dumpsys power")) return `  mWakefulness=${scene.wake}\n`;
    if (cmd.startsWith("dumpsys window")) {
      return scene.focus
        ? `  mCurrentFocus=Window{3be2322 u0 ${scene.focus}/${scene.focus}.MainActivity}\n`
        : "  mCurrentFocus=null\n";
    }
    if (cmd === "dumpsys audio") return audioDump(scene.level, scene.max, scene.muted);
    if (cmd === "dumpsys media_session") return mediaDump(scene.netflix);
    if (cmd === "pm list packages") return scene.installed.map((p) => `package:${p}`).join("\n") + "\n";
    let m = /^input keyevent ([\d ]+)$/.exec(cmd);
    if (m) {
      for (const code of m[1].split(" ").map(Number)) press(code);
      return "";
    }
    m = /^monkey -p ([\w.]+) -c android\.intent\.category\.LEANBACK_LAUNCHER 1$/.exec(cmd);
    if (m) {
      if (scene.installed.includes(m[1])) scene.focus = m[1];
      hooks.launch?.(m[1]);
      return "  bash arg: -p\nEvents injected: 1\n";
    }
    m = /^am force-stop ([\w.]+)$/.exec(cmd);
    if (m) {
      if (m[1] === NETFLIX) {
        scene.netflix = null;
        if (scene.focus === NETFLIX) scene.focus = LAUNCHER;
      }
      return "";
    }
    m = /^am start -a android\.intent\.action\.VIEW -d https:\/\/www\.netflix\.com\/watch\/(\d+) -n com\.netflix\.ninja\/\.MainActivity -e source 30$/.exec(cmd);
    if (m) {
      scene.focus = NETFLIX;
      hooks.link?.(m[1]);
      return "Starting: Intent { act=android.intent.action.VIEW dat=https://www.netflix.com/... }\n";
    }
    throw new Error(`the fake TV doesn't know: ${cmd}`);
  };

  const answering = (host: string) => scene.onNetwork && scene.hosts.includes(host);
  const woken: string[] = [];
  // Measured: the packet brought his TV back onto the network in 0.7s, on,
  // at the home screen, logged as a press of the power button.
  const wol = async (mac: string) => {
    woken.push(mac);
    if (mac !== MAC) return;
    at(700, () => {
      scene.onNetwork = true;
      scene.wake = "Awake";
      scene.focus = LAUNCHER;
    });
  };

  const run: Runner = async (_command, args) => {
    calls.push(args);
    const out = (stdout: string) => ({ stdout, stderr: "" });
    const err = (stderr: string) => ({ stdout: "", stderr });
    const [first, serial] = args;
    if (first === "connect") {
      if (!answering(serial.replace(/:5555$/, ""))) return err(`cannot connect to ${serial}: A connection attempt failed (10060)\n`);
      if (scene.transports.get(serial) === "device") return out(`already connected to ${serial}\n`);
      if (!scene.approved) {
        scene.transports.set(serial, "unauthorized");
        return out(`failed to authenticate to ${serial}\n`);
      }
      scene.transports.set(serial, "device");
      return out(`connected to ${serial}\n`);
    }
    if (first === "disconnect") {
      scene.transports.delete(serial);
      return out(`disconnected ${serial}\n`);
    }
    const verb = args[2];
    const held = scene.transports.get(serial);
    if (verb === "get-state") {
      if (held === "device") return out("device\n");
      if (held === "offline") return err("error: device offline\n");
      if (held === "unauthorized") return err("error: device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set\n");
      return err(`error: device '${serial}' not found\n`);
    }
    if (held !== "device") return err(`error: device '${serial}' not found\n`);
    if (verb === "logcat") return out(scene.logcat);
    if (verb === "shell") return out(shell(args[3]));
    throw new Error(`the fake adb doesn't know: ${args.join(" ")}`);
  };

  const shows = join(dir, `netflix-${files++}.json`);
  const tv = new Tv({
    host: HOST,
    name: "yousef's Fire TV",
    adb: "adb",
    shows,
    run,
    wait,
    now: () => t,
    discover: extra.discover,
    mac: extra.mac,
    probe: async (host) => answering(host),
    wol,
  });
  const shells = () => calls.filter((c) => c[2] === "shell").map((c) => c[3]);
  const pressed = () => keys.map((k) => k.code);
  return { tv, scene, calls, keys, pressed, shells, at, now: () => t, shows, woken };
}

/** How long the show's page took to come up after the link, from a fresh start on his TV. */
const PAGE_UP_MS = 10_000;

/** Netflix as measured on his TV: the show page by 10s, OK there resumes, left alone it plays itself at 25s. */
function measuredNetflix(from: number, opts: { trailerAt?: number; autoplayAt?: number | null } = {}) {
  let fake: ReturnType<typeof fakeTv>;
  let onPage = false;
  const linked: number[] = [];
  const play = () => {
    if (fake.scene.focus === NETFLIX) fake.scene.netflix = { state: 3, positionMs: from };
  };
  fake = fakeTv(
    { logcat: ROW },
    {
      link: () => {
        linked.push(fake.now());
        fake.at(PAGE_UP_MS, () => (onPage = true));
        if (opts.trailerAt !== undefined) fake.at(opts.trailerAt, () => (fake.scene.netflix = { state: 3, positionMs: 0 }));
        if (opts.autoplayAt !== null) fake.at(opts.autoplayAt ?? 25_000, play);
      },
      key: (code) => {
        if (code === KEYS.ok && onPage) fake.at(3_000, play);
      },
    },
  );
  return { ...fake, linked };
}

const okPresses = (fake: ReturnType<typeof fakeTv>) => fake.keys.filter((k) => k.code === KEYS.ok);

describe("parseWakefulness", () => {
  test("reads awake, asleep and the screensaver", () => {
    assert.equal(parseWakefulness("  mWakefulness=Awake\n"), "Awake");
    assert.equal(parseWakefulness("  mWakefulness=Asleep\n"), "Asleep");
    assert.equal(parseWakefulness("  mWakefulness=Dreaming\n"), "Dreaming");
  });

  test("is null when adb answered with something else", () => {
    assert.equal(parseWakefulness("error: device offline"), null);
  });
});

describe("parseFocus", () => {
  test("reads the package in front", () => {
    assert.equal(
      parseFocus("  mCurrentFocus=Window{3be2322 u0 com.amazon.tv.launcher/com.amazon.tv.launcher.ui.HomeActivity_vNext}"),
      LAUNCHER,
    );
  });

  test("is null while the TV sleeps", () => {
    assert.equal(parseFocus("  mCurrentFocus=null"), null);
  });
});

describe("parseVolume", () => {
  test("reads the music stream, not the call or alarm streams around it", () => {
    assert.deepEqual(parseVolume(audioDump(11, 100, false)), { level: 11, max: 100, muted: false });
  });

  test("sees mute on the music stream", () => {
    assert.equal(parseVolume(audioDump(11, 100, true))?.muted, true);
  });

  test("is null without a music stream", () => {
    assert.equal(parseVolume("- STREAM_ALARM:\n   Max: 7\n   streamVolume:6"), null);
  });
});

describe("parsePlayback", () => {
  test("reads Netflix's own session, not Spotify's playing one above it", () => {
    assert.deepEqual(parsePlayback(mediaDump({ state: 2, positionMs: 1384609 }), NETFLIX), {
      state: 2,
      positionMs: 1384609,
    });
  });

  test("is null when the app has no session, rather than borrowing the next one's", () => {
    assert.equal(parsePlayback(mediaDump(null), NETFLIX), null);
  });
});

describe("parseContinueWatching", () => {
  test("reads the show, its id, and where he got to", () => {
    const [show] = parseContinueWatching(ROW);
    assert.equal(show.title, "The Mentalist");
    assert.equal(show.id, "70155590");
    assert.equal(show.season, 2);
    assert.equal(show.episode, 10);
    assert.equal(show.episodeTitle, "Throwing Fire");
    assert.equal(show.durationMs, 2570000);
  });

  test("a later sync replaces an earlier one, so the saved spot is the newest", () => {
    // The 09:30 sync said 21:49; the next one said 22:51. Resuming checks
    // against this, so an old spot would call a good resume a failure.
    assert.equal(parseContinueWatching(ROW)[0].progressMs, 1371000);
  });

  test("the most recently watched comes first", () => {
    assert.deepEqual(
      parseContinueWatching(ROW).map((s) => s.title),
      ["The Mentalist", "Suits"],
    );
  });

  test("a title with a comma in it survives", () => {
    const line = meta("x==", "Love, Death & Robots", "80174608", 60000, episode(1, 1, "Sonnie's Edge", 1000000));
    assert.equal(parseContinueWatching(line)[0].title, "Love, Death & Robots");
  });

  test("a film has no season or episode to invent", () => {
    const line = meta("y==", "Glass Onion", "81458416", 60000, "durationMs=8400000, seasonNumber=null, episodeNumber=null, episodeTitle=null");
    const [film] = parseContinueWatching(line);
    assert.equal(film.season, undefined);
    assert.equal(describeShow(film), "Glass Onion");
  });

  test("a description long enough to cut the line still leaves the show and its spot", () => {
    // Android cuts a log entry at about 4KB, and the long line's position
    // comes after the description. The short line before it has the position.
    const full = meta(MENTALIST, "The Mentalist", "70155590", 1371000, episode(2, 10, "Throwing Fire", 2570000));
    const cut = full.slice(0, full.indexOf(", locale="));
    const [show] = parseContinueWatching([tile(MENTALIST, 1371000, 2570000, 1790895600000, "1/1"), cut].join("\n"));
    assert.equal(show.title, "The Mentalist");
    assert.equal(show.progressMs, 1371000);
  });

  test("an empty log is an empty row", () => {
    assert.deepEqual(parseContinueWatching(""), []);
  });
});

describe("clock and describeShow", () => {
  test("positions read the way Netflix shows them", () => {
    assert.equal(clock(1371000), "22:51");
    assert.equal(clock(4085000), "1:08:05");
    assert.equal(clock(5000), "0:05");
  });

  test("names the episode as well as the show", () => {
    assert.equal(describeShow(parseContinueWatching(ROW)[0]), 'The Mentalist, S2 E10 "Throwing Fire"');
  });
});

describe("connectOutcome", () => {
  test("tells the three things adb connect can mean apart", () => {
    assert.equal(connectOutcome("already connected to 192.168.0.246:5555"), "ok");
    assert.equal(connectOutcome("connected to 192.168.0.246:5555"), "ok");
    assert.equal(connectOutcome("failed to authenticate to 192.168.0.246:5555"), "unauthorized");
    assert.equal(connectOutcome("cannot connect to 192.168.0.9:5555: A connection attempt failed (10060)"), "unreachable");
    assert.equal(connectOutcome("failed to connect to '192.168.0.9:5555': Connection refused"), "unreachable");
  });
});

describe("volumeKeys", () => {
  test("one press per step, in the right direction", () => {
    assert.deepEqual(volumeKeys(11, 14), [KEYS.volumeUp, KEYS.volumeUp, KEYS.volumeUp]);
    assert.deepEqual(volumeKeys(11, 9), [KEYS.volumeDown, KEYS.volumeDown]);
    assert.deepEqual(volumeKeys(11, 11), []);
  });
});

describe("appPackage", () => {
  test("knows his names for his apps", () => {
    assert.equal(appPackage("Netflix", INSTALLED), NETFLIX);
    assert.equal(appPackage("disney plus", INSTALLED), "com.disney.disneyplus");
    assert.equal(appPackage("Prime Video", INSTALLED), "com.amazon.firebat");
  });

  test("a known app the TV doesn't have is no, not a guess at something else", () => {
    assert.equal(appPackage("netflix", [LAUNCHER]), null);
  });

  test("finds an app it has no name for by a word from its package", () => {
    assert.equal(appPackage("plex", [...INSTALLED, "com.plexapp.android"]), "com.plexapp.android");
  });

  test("refuses a word short enough to match half the system", () => {
    // "tv" is in the launcher, Live TV, Twitch and YouTube's package names.
    assert.equal(appPackage("tv", INSTALLED), null);
  });
});

describe("resolveAdb", () => {
  const local = "C:\\Users\\Y\\AppData\\Local";
  const links = join(local, "Microsoft", "WinGet", "Links", "adb.exe");
  const unpacked = join(
    local, "Microsoft", "WinGet", "Packages",
    "Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe", "platform-tools", "adb.exe",
  );
  const list = () => ["Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe", "Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe"];

  test("VELA_ADB wins", () => {
    assert.equal(resolveAdb("D:\\tools\\adb.exe", local, () => false, list), "D:\\tools\\adb.exe");
  });

  test("uses winget's alias when it was written", () => {
    assert.equal(resolveAdb(undefined, local, (p) => p === links, list), links);
  });

  test("finds it where winget unpacked it when the alias wasn't written, as on his machine", () => {
    assert.equal(resolveAdb(undefined, local, (p) => p === unpacked, list), unpacked);
  });

  test("falls back to PATH when winget has nothing", () => {
    const none = () => {
      throw new Error("ENOENT");
    };
    assert.equal(resolveAdb(undefined, local, () => false, none), "adb");
  });
});

describe("localSubnets", () => {
  test("is the home network's /24, without WSL's switch, loopback or IPv6", () => {
    const ifaces = {
      "Wi-Fi": [
        { address: "192.168.0.247", family: "IPv4", internal: false },
        { address: "fe80::1", family: "IPv6", internal: false },
      ],
      "vEthernet (WSL (Hyper-V firewall))": [{ address: "172.18.176.1", family: "IPv4", internal: false }],
      "Loopback Pseudo-Interface 1": [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    } as unknown as Parameters<typeof localSubnets>[0];
    assert.deepEqual(localSubnets(ifaces), ["192.168.0"]);
  });
});

describe("findByName", () => {
  const plist = (name: string) => Buffer.concat([Buffer.from("bplist00\xd8\x01\x02", "latin1"), Buffer.from(name, "utf8")]);

  test("finds the address whose AirPlay name is the TV's", async () => {
    const info = async (ip: string) => (ip === "192.168.0.31" ? plist("yousef's Fire TV") : ip === "192.168.0.40" ? plist("Living Room speaker") : null);
    assert.equal(await findByName("yousef's Fire TV", { subnets: ["192.168.0"], info }), "192.168.0.31");
  });

  test("is null when nothing on the network has that name", async () => {
    assert.equal(await findByName("yousef's Fire TV", { subnets: ["192.168.0"], info: async () => null }), null);
  });

  test("stops at the batch that found it rather than sweeping the rest", async () => {
    const asked: string[] = [];
    const info = async (ip: string) => {
      asked.push(ip);
      return ip === "192.168.0.3" ? plist("yousef's Fire TV") : null;
    };
    await findByName("yousef's Fire TV", { subnets: ["192.168.0", "10.0.0"], info, batch: 8 });
    assert.equal(asked.length, 8, "a found TV must not cost a sweep of every subnet");
  });
});

describe("magicPacket", () => {
  test("is six 0xFF bytes and then the MAC sixteen times, whatever the MAC is written with", () => {
    const packet = magicPacket("4c-49-29-b2-23-6d");
    assert.equal(packet.length, 102);
    assert.deepEqual([...packet.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
    for (let i = 0; i < 16; i++) assert.equal(packet.subarray(6 + i * 6, 12 + i * 6).toString("hex"), "4c4929b2236d");
    assert.deepEqual(magicPacket(MAC), packet);
  });

  test("refuses something that isn't a MAC, rather than waking nothing quietly", () => {
    assert.throws(() => magicPacket("4C:49:29"), /not a MAC address/);
  });
});

describe("wakeOnLan", () => {
  test("puts the packet on the wire to every target", async () => {
    const { createSocket } = await import("node:dgram");
    const listener = createSocket("udp4");
    await new Promise<void>((resolve) => listener.bind(0, "127.0.0.1", resolve));
    const got = new Promise<Buffer>((resolve) => listener.once("message", resolve));
    try {
      await wakeOnLan(MAC, ["127.0.0.1"], listener.address().port);
      assert.deepEqual(await got, magicPacket(MAC));
    } finally {
      listener.close();
    }
  });

  test("with nowhere to send it, returns rather than waiting forever", async () => {
    await wakeOnLan(MAC, []);
  });
});

describe("answers", () => {
  test("is true for a port something listens on and false for one nothing does", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    assert.equal(await answers("127.0.0.1", port), true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.equal(await answers("127.0.0.1", port), false);
  });
});

describe("airplayInfo", () => {
  let server: Server;
  let port: number;
  before(async () => {
    server = createServer((req, res) => res.end(req.url === "/info" ? "bplist00 yousef's Fire TV" : "no"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });
  after(() => server.close());

  test("reads what the receiver says at /info", async () => {
    assert.equal((await airplayInfo("127.0.0.1", port))?.toString(), "bplist00 yousef's Fire TV");
  });

  test("a host that takes the connection and never answers is given up on, not waited for", async () => {
    // One device on the network that hangs would otherwise stall the whole
    // search for a moved TV.
    const hang = createServer(() => undefined);
    await new Promise<void>((resolve) => hang.listen(0, "127.0.0.1", resolve));
    const silent = (hang.address() as { port: number }).port;
    try {
      assert.equal(await airplayInfo("127.0.0.1", silent, 50), null);
    } finally {
      hang.closeAllConnections();
      hang.close();
    }
  });

  test("is null for an address with nothing listening", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const dead = (closed.address() as { port: number }).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    assert.equal(await airplayInfo("127.0.0.1", dead), null);
  });
});

/** A Tv on a bare adb, for the tests about adb itself. The network check always says yes. */
const bareTv = (run: Runner) =>
  new Tv({ host: HOST, name: "x", adb: "adb", shows: join(dir, "none.json"), run, probe: async () => true, wait: async () => undefined });

describe("reaching the TV", () => {
  test("a TV that hasn't approved this laptop says how to fix it, and nothing is pressed", async () => {
    const fake = fakeTv({ approved: false, transports: new Map() });
    assert.match(await fake.tv.power(true), /Allow USB debugging/);
    assert.deepEqual(fake.pressed(), []);
  });

  test("a refusal adb is still holding is dialled afresh, and is still a refusal", async () => {
    // A fresh dial is what puts the approval prompt back on the TV; holding
    // on to the old refusal never would.
    const fake = fakeTv({ approved: false, transports: new Map([[`${HOST}:5555`, "unauthorized"]]) });
    assert.match(await fake.tv.power(true), /Allow USB debugging/);
    const verbs = fake.calls.map((c) => c[0]);
    assert.ok(verbs.indexOf("disconnect") < verbs.indexOf("connect"), "dropped before it is dialled again");
  });

  test("a dead link left from before the TV slept is dropped rather than dialled over", async () => {
    // Dialling over a dead one is where adb hung for the whole 15 seconds.
    const fake = fakeTv({ transports: new Map([[`${HOST}:5555`, "offline"]]), wake: "Asleep", focus: null });
    assert.equal(await fake.tv.power(true), "The TV is on.");
    const verbs = fake.calls.map((c) => c[0]);
    assert.ok(verbs.includes("disconnect") && verbs.indexOf("disconnect") < verbs.indexOf("connect"));
  });

  test("a working link is used as it is, with no dialling at all", async () => {
    const fake = fakeTv();
    await fake.tv.power(true);
    assert.ok(!fake.calls.some((c) => c[0] === "connect" || c[0] === "disconnect"), "the common ask costs one question to adb");
  });

  test("asked to turn on, a TV off the network gets the wake-up packet and then comes on", async () => {
    const fake = fakeTv({ onNetwork: false, wake: "Asleep", focus: null, transports: new Map([[`${HOST}:5555`, "offline"]]) }, {}, { mac: MAC });
    assert.equal(await fake.tv.power(true), "The TV is on.");
    assert.deepEqual(fake.woken, [MAC]);
  });

  test("a TV off the network is just off to anything that doesn't need it on: no packet, no search", async () => {
    // Waking the TV to answer "what's the volume" would be the TV coming on
    // by itself; sweeping the network for it would be four seconds to say "off".
    let searched = false;
    const discover = async () => ((searched = true), null);
    const fake = fakeTv({ onNetwork: false, wake: "Asleep", focus: null }, {}, { mac: MAC, discover });
    assert.equal(await fake.tv.volume({ by: 5 }), "The TV is off, so there's no volume to change.");
    assert.equal(await fake.tv.remote("pause"), "The TV is off.");
    assert.equal(await fake.tv.power(false), "The TV is already off.");
    assert.deepEqual(fake.woken, []);
    assert.equal(searched, false);
    assert.ok(!fake.calls.length, "nothing asked of adb for a TV that isn't there");
  });

  test("a TV the router moved is found again by its name, and stays found", async () => {
    const fake = fakeTv({ hosts: ["192.168.0.31"], transports: new Map() }, {}, { discover: async () => "192.168.0.31" });
    assert.equal(await fake.tv.power(true), "The TV is on.");
    assert.equal(fake.tv.address, "192.168.0.31");
    const shellCalls = fake.calls.filter((c) => c[2] === "shell");
    assert.ok(shellCalls.length > 0 && shellCalls.every((c) => c[1] === "192.168.0.31:5555"), "every press goes to where it is now");
  });

  test("a TV that answers nowhere, even woken, says so and names where it looked", async () => {
    const fake = fakeTv({ onNetwork: false }, {}, { mac: "00:11:22:33:44:55", discover: async () => null });
    assert.equal(
      await fake.tv.power(true),
      "The TV isn't answering on the network (tried 192.168.0.246, and sent it the wake-up packet). " +
        "It may be unplugged; the power button on the remote brings it back.",
    );
  });

  test("adb's words are read even when it exits with an error, which it does for a refusal", async () => {
    const tv = bareTv(async (_c, args) => {
      if (args[0] === "connect") {
        throw Object.assign(new Error("Command failed"), { code: 1, stdout: "", stderr: "failed to authenticate to 192.168.0.246:5555\n" });
      }
      return { stdout: "", stderr: "" };
    });
    assert.match(await tv.power(true), /Allow USB debugging/);
  });

  test("an adb that hangs is cut off and read as no answer, not waited on", async () => {
    // What happened live: the dial hung until it was killed, with nothing said.
    const tv = bareTv(async () => {
      throw Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM", stdout: "", stderr: "" });
    });
    assert.equal(await tv.power(true), "The TV is on the network, but adb can't get through to it (192.168.0.246).");
  });

  test("an adb failure with nothing to say is still a sentence", async () => {
    const tv = bareTv(async () => {
      throw new Error("adb server version (41) doesn't match this client (39)");
    });
    assert.equal(await tv.power(true), "The TV didn't answer: adb server version (41) doesn't match this client (39)");
  });

  test("adb not being installed is a sentence, not a crash", async () => {
    const tv = bareTv(async () => {
      throw Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" });
    });
    assert.match(await tv.power(true), /adb isn't installed/);
  });
});

describe("power", () => {
  test("wakes a sleeping TV and only says on once it reports awake", async () => {
    const fake = fakeTv({ wake: "Asleep", focus: null });
    assert.equal(await fake.tv.power(true), "The TV is on.");
    assert.equal(fake.scene.wake, "Awake");
    assert.deepEqual(fake.pressed(), [KEYS.wakeup]);
  });

  test("turning it on clears the screensaver too", async () => {
    const fake = fakeTv({ wake: "Dreaming", focus: SCREENSAVER });
    assert.equal(await fake.tv.power(true), "The TV is on.");
    assert.equal(fake.scene.wake, "Awake");
  });

  test("a TV that never wakes is reported, not assumed", async () => {
    const fake = fakeTv({ wake: "Asleep" }, { key: () => (fake.scene.wake = "Asleep") });
    assert.equal(await fake.tv.power(true), "The TV didn't wake up when asked.");
  });

  test("turns it off and checks", async () => {
    const fake = fakeTv();
    assert.equal(await fake.tv.power(false), "The TV is off.");
    assert.deepEqual(fake.pressed(), [KEYS.sleep]);
  });

  test("a TV that won't go off is reported, not assumed off", async () => {
    const fake = fakeTv({}, { key: () => (fake.scene.wake = "Awake") });
    assert.equal(await fake.tv.power(false), "Asked the TV to turn off, but it still says it's on.");
  });

  test("off when it's already off says so, rather than claiming to have turned it off", async () => {
    const fake = fakeTv({ wake: "Asleep", focus: null });
    assert.equal(await fake.tv.power(false), "The TV is already off.");
    assert.deepEqual(fake.pressed(), []);
  });
});

describe("volume", () => {
  test("goes to a level in one burst of presses and reports what it reads back", async () => {
    const fake = fakeTv({ level: 11 });
    assert.equal(await fake.tv.volume({ to: 30 }), "Volume 30 (was 11, out of 100).");
    const bursts = fake.shells().filter((c) => c.startsWith("input keyevent"));
    assert.equal(bursts.length, 1, "a call per press is a second of Android's input tool each");
    assert.equal(fake.pressed().length, 19);
  });

  test("a step down past zero stops at zero", async () => {
    const fake = fakeTv({ level: 4 });
    assert.equal(await fake.tv.volume({ by: -10 }), "Volume 0 (was 4, out of 100).");
  });

  test("already there presses nothing", async () => {
    const fake = fakeTv({ level: 20 });
    assert.equal(await fake.tv.volume({ to: 20 }), "It's already at 20.");
    assert.deepEqual(fake.pressed(), []);
  });

  test("mute when muted says so instead of toggling it back on", async () => {
    const fake = fakeTv({ muted: true });
    assert.equal(await fake.tv.volume({ mute: true }), "It's already muted.");
    assert.deepEqual(fake.pressed(), []);
  });

  test("mutes, and unmutes back to where it was", async () => {
    const fake = fakeTv({ level: 15 });
    assert.equal(await fake.tv.volume({ mute: true }), "Muted.");
    assert.equal(await fake.tv.volume({ mute: false }), "Unmuted, at 15.");
  });

  test("a volume it can't read is said, and nothing is pressed toward a level it can't check", async () => {
    const fake = fakeTv({ level: Number.NaN });
    assert.equal(await fake.tv.volume({ by: 5 }), "Couldn't read the TV's volume.");
    assert.deepEqual(fake.pressed(), []);
  });

  test("an off TV has no volume to change, and nothing is pressed into the dark", async () => {
    const fake = fakeTv({ wake: "Asleep", focus: null });
    assert.match(await fake.tv.volume({ by: 5 }), /The TV is off/);
    assert.deepEqual(fake.pressed(), []);
  });
});

describe("remote", () => {
  test("has no up, down or OK for the model to press blind", () => {
    // A blind Up and OK rated a show instead of playing it. Keys whose effect
    // depends on what is focused stay out of the model's reach.
    const codes = Object.values(REMOTE) as number[];
    for (const code of [19, 20, 21, 22, KEYS.ok]) assert.ok(!codes.includes(code), `key ${code} is focus-dependent`);
  });

  test("presses the button and says which", async () => {
    const fake = fakeTv();
    assert.equal(await fake.tv.remote("play_pause"), "Pressed play/pause.");
    assert.equal(await fake.tv.remote("fast_forward"), "Pressed fast forward.");
    assert.deepEqual(fake.pressed(), [REMOTE.play_pause, REMOTE.fast_forward]);
  });
});

describe("open", () => {
  test("'open Netflix' opens it and does nothing else: he picks the profile", async () => {
    const fake = fakeTv({ wake: "Asleep", focus: null });
    assert.equal(await fake.tv.open("Netflix"), "Netflix is open on the TV.");
    assert.deepEqual(fake.pressed(), [KEYS.wakeup], "anything past waking it would be choosing for him");
    assert.ok(!fake.shells().some((c) => c.startsWith("am start")), "no show link on a plain open");
  });

  test("an app the TV doesn't have is said, with what it does have", async () => {
    const fake = fakeTv();
    const said = await fake.tv.open("hulu");
    assert.match(said, /There's no hulu on the TV/);
    assert.match(said, /Netflix, YouTube, Disney\+, Crave, Spotify, Twitch, Prime Video/);
  });

  test("an app that never comes to the front is reported as not there yet", async () => {
    const fake = fakeTv({}, { launch: () => (fake.scene.focus = LAUNCHER) });
    assert.match(await fake.tv.open("youtube"), /isn't in front yet/);
  });
});

describe("netflix", () => {
  test("resumes the last show with its link, one OK at the measured moment, and checks the spot", async () => {
    const fake = measuredNetflix(1369000);
    assert.equal(await fake.tv.netflix(), 'Playing The Mentalist, S2 E10 "Throwing Fire" from 22:49.');
    const shells = fake.shells();
    const stop = shells.indexOf(`am force-stop ${NETFLIX}`);
    const link = shells.findIndex((c) => c.includes("netflix.com/watch/70155590"));
    assert.ok(stop >= 0 && stop < link, "closed first, so the timing is the measured fresh start");
    const oks = okPresses(fake);
    assert.equal(oks.length, 1);
  });

  test("OK waits until the show's page is up, never before", async () => {
    // Pressed earlier, it lands on Netflix still loading, or on whatever it
    // restored. 12 seconds is past the 10 the page took on his TV.
    const fake = measuredNetflix(1369000);
    await fake.tv.netflix();
    assert.equal(fake.linked.length, 1);
    // Against the measured page time, not the constant: the constant is the
    // thing being checked.
    assert.ok(okPresses(fake)[0].at - fake.linked[0] >= PAGE_UP_MS, "an OK before the page lands on Netflix loading");
  });

  test("a resume that starts by itself before the OK is left alone", async () => {
    const fake = measuredNetflix(1369000, { autoplayAt: 6_000 });
    assert.match(await fake.tv.netflix(), /from 22:49/);
    assert.equal(okPresses(fake).length, 0, "an OK over a playing episode only brings up the controls");
  });

  test("a trailer on the show's page is not mistaken for the resume", async () => {
    // The page plays a preview from 0. Taking that as success would leave him
    // watching a trailer while she says his show is on.
    const fake = measuredNetflix(1369000, { trailerAt: 9_000, autoplayAt: null });
    assert.match(await fake.tv.netflix(), /from 22:49/);
    assert.equal(okPresses(fake).length, 1);
  });

  test("playing somewhere else than his spot is said, with the likely reason", async () => {
    const fake = measuredNetflix(300000);
    const said = await fake.tv.netflix();
    assert.match(said, /not where you left The Mentalist \(22:51\)/);
    assert.match(said, /someone else's profile/);
  });

  test("when nothing plays it gives up after one OK and says what to do, rather than pressing on", async () => {
    // Every extra blind press is another chance to rate something.
    const fake = fakeTv({ logcat: ROW });
    const said = await fake.tv.netflix();
    assert.match(said, /didn't start playing/);
    assert.equal(okPresses(fake).length, 1);
    assert.ok(fake.now() >= NETFLIX_GIVE_UP_MS && fake.now() < NETFLIX_GIVE_UP_MS + 5_000, "gives up on time");
  });

  test("with nothing in the log or kept, it starts Netflix and listens for the row", async () => {
    const fake = fakeTv(
      {},
      {
        launch: (pkg) => {
          if (pkg === NETFLIX) fake.at(15_000, () => (fake.scene.logcat = ROW));
        },
        link: () => fake.at(25_000, () => (fake.scene.netflix = { state: 3, positionMs: 1369000 })),
      },
    );
    assert.match(await fake.tv.netflix(), /Playing The Mentalist/);
  });

  test("when Netflix starts but never says what he was watching, she says so and sends no link", async () => {
    const fake = fakeTv();
    assert.match(await fake.tv.netflix(), /didn't say what you were watching/);
    assert.ok(!fake.shells().some((c) => c.includes("netflix.com/watch")), "a link to nothing would be a guess");
  });

  test("keeps the row, so the next ask doesn't need Netflix to have run recently", async () => {
    const first = measuredNetflix(1369000);
    await first.tv.netflix();
    assert.ok(existsSync(first.shows));
    const kept = JSON.parse(readFileSync(first.shows, "utf8")) as { title: string }[];
    assert.equal(kept[0].title, "The Mentalist");

    // A fresh TV whose log has turned over, sharing the kept copy.
    const second = fakeTv({}, { link: () => second.at(25_000, () => (second.scene.netflix = { state: 3, positionMs: 1369000 })) });
    writeFileSync(second.shows, readFileSync(first.shows));
    assert.match(await second.tv.netflix(), /Playing The Mentalist/);
    assert.ok(!second.shells().some((c) => c.startsWith("monkey")), "the kept row saves starting Netflix just to read it");
  });

  test("an id that isn't digits never reaches the TV's shell", async () => {
    const fake = fakeTv();
    assert.match(await fake.tv.netflix({ id: "1; reboot" }), /only digits/);
    assert.ok(!fake.shells().some((c) => c.includes("reboot")));
  });

  test("a title by id plays it once OK has been pressed", async () => {
    const fake = fakeTv(
      {},
      {
        key: (code) => {
          if (code === KEYS.ok) fake.at(3_000, () => (fake.scene.netflix = { state: 3, positionMs: 4000 }));
        },
      },
    );
    assert.equal(await fake.tv.netflix({ id: "81458416" }), "Playing it from 0:04.");
    assert.ok(fake.shells().some((c) => c.includes("netflix.com/watch/81458416")));
  });
});

describe("status", () => {
  test("a TV off the network is off, with the last show from what was kept", async () => {
    const fake = fakeTv({ onNetwork: false });
    writeFileSync(fake.shows, JSON.stringify(parseContinueWatching(ROW)));
    assert.equal(
      await fake.tv.status(),
      'The TV is off. Last on Netflix: The Mentalist, S2 E10 "Throwing Fire", 22:51 in.',
    );
    assert.equal(fake.calls.length, 0, "a TV that isn't there isn't asked for its log");
  });

  test("an off TV still says what he was last watching", async () => {
    const fake = fakeTv({ wake: "Asleep", focus: null, logcat: ROW });
    assert.equal(
      await fake.tv.status(),
      'The TV is off. Last on Netflix: The Mentalist, S2 E10 "Throwing Fire", 22:51 in.',
    );
  });

  test("an on TV says what's in front, the volume, and Netflix's position", async () => {
    const fake = fakeTv({ focus: NETFLIX, netflix: { state: 3, positionMs: 1384609 }, level: 11 });
    assert.equal(
      await fake.tv.status(),
      "The TV is on, showing Netflix. Volume 11 of 100. Netflix is playing, at 23:04.",
    );
  });

  test("the screensaver is called the screensaver, once", async () => {
    const fake = fakeTv({ wake: "Dreaming", focus: SCREENSAVER });
    assert.match(await fake.tv.status(), /^The TV is on, on its screensaver\. /);
  });
});

describe("one thing at a time", () => {
  test("two asks at once don't interleave their presses", async () => {
    const fake = fakeTv({ level: 10 });
    await Promise.all([fake.tv.volume({ to: 13 }), fake.tv.remote("pause")]);
    assert.deepEqual(fake.pressed(), [KEYS.volumeUp, KEYS.volumeUp, KEYS.volumeUp, REMOTE.pause]);
  });
});
