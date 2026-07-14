// Runtime feature detection (design/architecture.md §4).
// Documented verbs are assumed when wslc is present; API-implied verbs
// (start/rm/pull/image rm) are enabled ONLY when --help output proves them.

import { exec } from "./exec.ts";
import { parseHelpFlags, parseHelpVerbs, parseVersionBlock } from "./parsers.ts";

export interface WslcCan {
  run: boolean;
  stop: boolean;
  logs: boolean;
  inspect: boolean;
  execIn: boolean;
  stats: boolean;
  listAll: boolean;
  pruneContainers: boolean;
  imageList: boolean;
  imageInspect: boolean;
  imagePrune: boolean;
  build: boolean;
  // API-implied — help-detected only:
  start: boolean;
  rmContainer: boolean;
  pull: boolean;
  rmImage: boolean;
  // r9 — every volume verb and --entrypoint are help-detected, so a wslc build without
  // them can never have one emitted at it (the route answers 409 verb_unavailable).
  volumes: boolean;
  volumeCreate: boolean;
  volumeRemove: boolean;
  volumePrune: boolean;
  volumeInspect: boolean;
  entrypoint: boolean;
}

export interface Capabilities {
  wsl: { present: boolean; version: string | null };
  wslc: {
    present: boolean;
    version: string | null;
    topVerbs: string[];
    containerVerbs: string[];
    imageVerbs: string[];
    volumeVerbs: string[];
    runFlags: string[];
    can: WslcCan;
  };
  windows: { build: number; win11: boolean };
  wslSettingsApp: { present: boolean; path: string | null };
  probedAt: string;
}

const NONE: WslcCan = {
  run: false, stop: false, logs: false, inspect: false, execIn: false,
  stats: false, listAll: false, pruneContainers: false, imageList: false,
  imageInspect: false, imagePrune: false, build: false,
  start: false, rmContainer: false, pull: false, rmImage: false,
  volumes: false, volumeCreate: false, volumeRemove: false, volumePrune: false,
  volumeInspect: false, entrypoint: false,
};

export interface WslcHelpInputs {
  versionLine: string;
  topHelp: string;
  containerHelp: string;
  imageHelp: string;
  runHelp: string;
  volumeHelp: string;
}

/** Pure capability mapping from CLI help output (unit-tested against the
 * real wslc 2.9.3.0 fixtures). Documented verbs are assumed with presence;
 * API-implied verbs require proof in the parsed help. */
export function buildWslcCapabilities(h: WslcHelpInputs): Capabilities["wslc"] {
  const topVerbs = parseHelpVerbs(h.topHelp);
  const containerVerbs = parseHelpVerbs(h.containerHelp);
  const imageVerbs = parseHelpVerbs(h.imageHelp);
  const volumeVerbs = parseHelpVerbs(h.volumeHelp);
  const runFlags = parseHelpFlags(h.runHelp);
  const hasAny = (set: Set<string>, names: string[]) => names.some((n) => set.has(n));
  // `volume` itself must be a top-level verb before any sub-verb of it means anything:
  // a build whose `volume --help` fails prints nothing, and an empty set already gates
  // every flag off, but this keeps the intent explicit.
  const volume = topVerbs.has("volume");
  return {
    present: true,
    // "wslc 2.9.3.0" → "2.9.3.0" (the UI labels the pill itself)
    version: h.versionLine.replace(/^wslc\s+/i, "") || null,
    topVerbs: [...topVerbs].sort(),
    containerVerbs: [...containerVerbs].sort(),
    imageVerbs: [...imageVerbs].sort(),
    volumeVerbs: [...volumeVerbs].sort(),
    runFlags: [...runFlags].sort(),
    can: {
      run: true, stop: true, logs: true, inspect: true, execIn: true,
      stats: true, listAll: true, pruneContainers: true,
      imageList: true, imageInspect: true, imagePrune: true, build: true,
      start: hasAny(containerVerbs, ["start"]),
      rmContainer: hasAny(containerVerbs, ["rm", "remove", "delete"]),
      pull: hasAny(topVerbs, ["pull"]) || hasAny(imageVerbs, ["pull"]),
      rmImage: hasAny(imageVerbs, ["rm", "remove", "delete"]),
      // Gate on the verb we actually call (`volume list`) — not the `ls` alias — so the
      // capability can never report "supported" for a build whose list call would fail.
      volumes: volume && hasAny(volumeVerbs, ["list"]),
      volumeCreate: volume && hasAny(volumeVerbs, ["create"]),
      volumeRemove: volume && hasAny(volumeVerbs, ["remove", "rm", "delete"]),
      volumePrune: volume && hasAny(volumeVerbs, ["prune"]),
      volumeInspect: volume && hasAny(volumeVerbs, ["inspect"]),
      // parseHelpFlags keeps the leading dashes ("--entrypoint"), so match on the flag itself.
      entrypoint: runFlags.has("--entrypoint"),
    },
  };
}

const WSLSETTINGS_CANDIDATES = [
  "C:\\Program Files\\WSL\\wslsettings.exe",
  "C:\\Program Files\\WSL\\wslsettings\\wslsettings.exe",
];

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

function windowsBuild(): { build: number; win11: boolean } {
  let build = 0;
  try {
    const rel = Deno.osRelease(); // e.g. "10.0.19045"
    build = Number(rel.split(".")[2] ?? 0) || 0;
  } catch {
    build = 0;
  }
  return { build, win11: build >= 22000 };
}

async function probe(): Promise<Capabilities> {
  const [wslVer, wslcVer] = await Promise.all([
    exec("wsl", ["--version"], { timeoutMs: 8_000 }),
    exec("wslc", ["version"], { timeoutMs: 8_000 }),
  ]);

  const wslPresent = !wslVer.notFound && wslVer.code === 0;
  const wslVersion = wslPresent
    ? parseVersionBlock(wslVer.stdout)["wsl"] ?? null
    : null;

  let wslc: Capabilities["wslc"] = {
    present: false, version: null,
    topVerbs: [], containerVerbs: [], imageVerbs: [], volumeVerbs: [], runFlags: [],
    can: { ...NONE },
  };

  if (!wslcVer.notFound && wslcVer.code === 0) {
    const [top, container, image, run, volume] = await Promise.all([
      exec("wslc", ["--help"], { timeoutMs: 8_000 }),
      exec("wslc", ["container", "--help"], { timeoutMs: 8_000 }),
      exec("wslc", ["image", "--help"], { timeoutMs: 8_000 }),
      exec("wslc", ["run", "--help"], { timeoutMs: 8_000 }),
      // A build without `volume` fails here; the empty help gates every volume flag off.
      exec("wslc", ["volume", "--help"], { timeoutMs: 8_000 }),
    ]);
    wslc = buildWslcCapabilities({
      versionLine: wslcVer.stdout.trim().split(/\r?\n/)[0] ?? "",
      topHelp: top.stdout + "\n" + top.stderr,
      containerHelp: container.stdout + "\n" + container.stderr,
      imageHelp: image.stdout + "\n" + image.stderr,
      runHelp: run.stdout + "\n" + run.stderr,
      volumeHelp: volume.code === 0 ? volume.stdout + "\n" + volume.stderr : "",
    });
  }

  let settingsPath: string | null = null;
  for (const p of WSLSETTINGS_CANDIDATES) {
    if (await fileExists(p)) {
      settingsPath = p;
      break;
    }
  }

  return {
    wsl: { present: wslPresent, version: wslVersion },
    wslc,
    windows: windowsBuild(),
    wslSettingsApp: { present: settingsPath !== null, path: settingsPath },
    probedAt: new Date().toISOString(),
  };
}

let cache: { caps: Capabilities; at: number } | null = null;
const TTL_MS = 60_000;

export async function getCapabilities(force = false): Promise<Capabilities> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.caps;
  const caps = await probe();
  cache = { caps, at: Date.now() };
  return caps;
}
