// wslc.exe operations — documented surface only (research map §1–2).
// API-implied verbs take the concrete verb chosen by the capability layer;
// this module never guesses verbs on its own.

import { exec, type ExecResult } from "./exec.ts";
import {
  mergeVolumeRows,
  parsePruneOutput,
  parseSessionList,
  parseTable,
  parseVolumeInspectJson,
  parseVolumeListJson,
  type SessionInfo,
  type Table,
  type VolumeRow,
} from "./parsers.ts";
import * as v from "./validate.ts";

const PULL_MS = 300_000;

export type { VolumeRow };

export interface RunSpec {
  image: string;
  name?: string;
  ports?: string[]; // "HOST:CONTAINER"
  detach?: boolean; // default true (GUI-launched containers must not block)
  rm?: boolean;
  interactive?: boolean;
  command?: string[];
  volumes?: string[]; // -v HOST:CONTAINER
  tmpfs?: string; // --tmpfs /path
  env?: string[]; // -e KEY=value
  envFile?: string; // --env-file (Windows path)
  memory?: string; // -m 512M | 1G
  cpus?: string; // --cpus 0.5 | 2
  shmSize?: string; // --shm-size 64M | 1G
  gpus?: string; // --gpus all
  workdir?: string; // -w /path
  user?: string; // -u name|uid|uid:gid
  network?: string; // --network NAME
  hostname?: string; // -h NAME
  entrypoint?: string; // --entrypoint /bin/sh (replaces the image ENTRYPOINT)
}

/** Pure arg builder for `wslc run` using ONLY flags verified against the live
 * 2.9.3.0 help (research map §9 + probe 2026-07-13). */
export function buildRunArgs(spec: RunSpec): string[] {
  const image = v.imageRef(spec.image);
  const args = ["run"];
  if (spec.detach ?? true) args.push("-d");
  if (spec.rm) args.push("--rm");
  if (spec.interactive) args.push("-it");
  for (const p of spec.ports ?? []) args.push("-p", v.portPair(p));
  for (const m of spec.volumes ?? []) args.push("-v", v.mountSpec(m));
  if (spec.tmpfs) args.push("--tmpfs", v.containerPath(spec.tmpfs, "tmpfs"));
  for (const e of spec.env ?? []) args.push("-e", v.envPair(e));
  if (spec.envFile) args.push("--env-file", v.winPath(spec.envFile, "env-file"));
  if (spec.memory) args.push("-m", v.memValue(spec.memory));
  if (spec.cpus) args.push("--cpus", v.cpusValue(spec.cpus));
  // Appended after --cpus so every pre-existing flag keeps its position (the client
  // preview mirrors this order — Package B is told when it changes).
  if (spec.shmSize) args.push("--shm-size", v.shmSize(spec.shmSize));
  if (spec.gpus) args.push("--gpus", v.gpusValue(spec.gpus));
  if (spec.workdir) args.push("-w", v.containerPath(spec.workdir, "workdir"));
  if (spec.user) args.push("-u", v.userSpec(spec.user));
  if (spec.network) args.push("--network", v.name(spec.network, "network"));
  if (spec.hostname) args.push("-h", v.name(spec.hostname, "hostname"));
  // r9 D1: --entrypoint sits immediately before --name (pinned in the build brief so the
  // client's previewRun mirrors this byte-for-byte). Its ARGUMENTS are not part of it —
  // they stay positional, after the image, in `command`.
  if (spec.entrypoint) args.push("--entrypoint", v.entrypointValue(spec.entrypoint));
  if (spec.name !== undefined && spec.name !== "") args.push("--name", v.name(spec.name));
  args.push(image);
  args.push(...v.commandTokens(spec.command));
  return args;
}

export function runContainer(spec: RunSpec): Promise<ExecResult> {
  // Image may be auto-pulled on first run (documented) — allow pull time.
  return exec("wslc", buildRunArgs(spec), { timeoutMs: PULL_MS });
}

export async function listContainers(all = false): Promise<Table> {
  const args = ["container", "list"];
  if (all) args.push("--all");
  const res = await exec("wslc", args);
  return res.code === 0 ? parseTable(res.stdout) : { headers: [], rows: [], raw: [res.stderr.trim()] };
}

export function stopContainer(name: string): Promise<ExecResult> {
  return exec("wslc", ["container", "stop", v.name(name, "container")], { timeoutMs: 60_000 });
}

/** Capability-gated: `verb` comes from detected containerVerbs (e.g. "start"). */
export function startContainer(name: string, verb: string): Promise<ExecResult> {
  if (verb !== "start") throw new v.ValidationError("start verb not detected");
  return exec("wslc", ["container", verb, v.name(name, "container")], { timeoutMs: 60_000 });
}

/** Capability-gated: verb ∈ detected {rm|remove|delete}. */
export function removeContainer(name: string, verb: string): Promise<ExecResult> {
  if (!["rm", "remove", "delete"].includes(verb)) throw new v.ValidationError("remove verb not detected");
  return exec("wslc", ["container", verb, v.name(name, "container")], { timeoutMs: 60_000 });
}

export function pruneContainers(): Promise<ExecResult> {
  return exec("wslc", ["container", "prune"], { timeoutMs: 120_000 });
}

export function containerLogs(name: string): Promise<ExecResult> {
  return exec("wslc", ["container", "logs", v.name(name, "container")], { timeoutMs: 30_000 });
}

export function inspectContainer(name: string): Promise<ExecResult> {
  return exec("wslc", ["container", "inspect", v.name(name, "container")], { timeoutMs: 30_000 });
}

export function execInContainer(name: string, command: string[]): Promise<ExecResult> {
  const tokens = v.commandTokens(command);
  if (tokens.length === 0) throw new v.ValidationError("command: required");
  return exec("wslc", ["exec", v.name(name, "container"), ...tokens], { timeoutMs: 60_000 });
}

export function stats(): Promise<ExecResult> {
  return exec("wslc", ["stats"], { timeoutMs: 30_000 });
}

/** `wslc system session list` — the sessions that actually host containers
 * (live-probed 2026-07-13: "ID   Creator PID   Display Name"). */
export async function listSessions(): Promise<SessionInfo[]> {
  const res = await exec("wslc", ["system", "session", "list"], { timeoutMs: 30_000 });
  return res.code === 0 ? parseSessionList(res.stdout) : [];
}

export async function listImages(): Promise<Table> {
  const res = await exec("wslc", ["image", "list"]);
  return res.code === 0 ? parseTable(res.stdout) : { headers: [], rows: [], raw: [res.stderr.trim()] };
}

export function inspectImage(ref: string): Promise<ExecResult> {
  return exec("wslc", ["image", "inspect", v.imageRef(ref)], { timeoutMs: 30_000 });
}

export function pruneImages(): Promise<ExecResult> {
  return exec("wslc", ["image", "prune"], { timeoutMs: 120_000 });
}

/** Capability-gated explicit pull. verbPath is ["pull"] or ["image","pull"]
 * exactly as detected by the capability layer. */
export function pullImage(ref: string, verbPath: string[]): Promise<ExecResult> {
  const ok = (verbPath.length === 1 && verbPath[0] === "pull") ||
    (verbPath.length === 2 && verbPath[0] === "image" && verbPath[1] === "pull");
  if (!ok) throw new v.ValidationError("pull verb not detected");
  return exec("wslc", [...verbPath, v.imageRef(ref)], { timeoutMs: PULL_MS });
}

/** Documented fallback when no explicit pull verb exists: `wslc run` auto-pulls
 * a missing image; a throwaway `--rm ... true` run forces the fetch. */
export function pullViaThrowawayRun(ref: string): Promise<ExecResult> {
  return exec("wslc", ["run", "--rm", v.imageRef(ref), "true"], { timeoutMs: PULL_MS });
}

/** Capability-gated: verb ∈ detected {rm|remove|delete} on `image`. */
export function removeImage(ref: string, verb: string): Promise<ExecResult> {
  if (!["rm", "remove", "delete"].includes(verb)) throw new v.ValidationError("remove verb not detected");
  return exec("wslc", ["image", verb, v.imageRef(ref)], { timeoutMs: 60_000 });
}

// ---------------------------------------------------------------- volumes (r9 D2)
//
// wslc 2.9.3.0 exposes a FULL volume lifecycle — create/remove/inspect/list/prune —
// and `run -v NAME:/path` auto-creates a named volume that survives the container
// (probe P2, re-verified 2026-07-13). r8's claim that "wslc documents no volume-create
// verb" was false and its warning is deleted, not softened.
//
// Every verb here is still feature-detected from `volume --help` by the capability layer:
// the route refuses with 409 before we ever emit a command this build cannot run.

const REMOVE_VERBS = ["remove", "rm", "delete"]; // wslc: `remove` (aliases delete, rm)

/** The concrete remove verb this wslc build advertises, or null when it advertises none.
 * Pure so the route's 409 branch is a tested predicate rather than an inline guess. */
export function volumeRemoveVerb(volumeVerbs: string[]): string | null {
  return REMOVE_VERBS.find((verb) => volumeVerbs.includes(verb)) ?? null;
}

/** `wslc volume list --format json` + one enriching `volume inspect` for the details the
 * list does NOT carry.
 *
 * Live shapes (2.9.3.0): the list reports ONLY `Driver` and `Name`; `CreatedAt`/`Labels`
 * (and therefore the anonymous flag) exist solely in `inspect`, which accepts every name
 * in a single call — so this is two commands, not N+1. The list stays the source of truth
 * for existence: if the inspect fails, rows survive with `createdAt: null` rather than
 * disappearing or acquiring an invented date. */
export async function listVolumes(): Promise<VolumeRow[]> {
  const res = await exec("wslc", ["volume", "list", "--format", "json"], { timeoutMs: 30_000 });
  if (res.code !== 0) return [];
  const listed = parseVolumeListJson(res.stdout);
  if (listed.length === 0) return [];

  // These names come FROM wslc, but they are about to go BACK INTO argv for the inspect
  // call, so they are re-validated at the sink like anything else. A name this validator
  // refuses is still SHOWN (it exists — the list is the truth about that) but is never
  // emitted as an argument: filtered, not thrown on. Throwing here would let one strange
  // name blank the user's entire volume list, which is a worse failure than a missing date.
  const argvSafe: string[] = [];
  for (const l of listed) {
    try {
      argvSafe.push(v.volumeName(l.name));
    } catch {
      // not argv-safe → no inspect for this row; it degrades to createdAt: null
    }
  }

  if (argvSafe.length === 0) return mergeVolumeRows(listed, new Map());

  const det = await exec("wslc", ["volume", "inspect", ...argvSafe], { timeoutMs: 30_000 });
  // A nonzero exit here means SOME name failed (e.g. the volume was removed between the
  // two calls — a benign race). The array still carries the ones that resolved, so parse
  // it either way and let the unresolved rows degrade rather than vanish.
  return mergeVolumeRows(listed, parseVolumeInspectJson(det.stdout));
}

export function createVolume(name: string): Promise<ExecResult> {
  return exec("wslc", ["volume", "create", v.volumeName(name)], { timeoutMs: 30_000 });
}

/** Capability-gated: verb ∈ detected {remove|rm|delete}. */
export function removeVolume(name: string, verb: string): Promise<ExecResult> {
  if (!REMOVE_VERBS.includes(verb)) throw new v.ValidationError("volume remove verb not detected");
  return exec("wslc", ["volume", verb, v.volumeName(name)], { timeoutMs: 60_000 });
}

export function inspectVolume(name: string): Promise<ExecResult> {
  return exec("wslc", ["volume", "inspect", v.volumeName(name)], { timeoutMs: 30_000 });
}

/** `wslc volume prune` — IRREVERSIBLE, and narrower than docker's reputation suggests.
 *
 * Live-proven 2026-07-13 (help: "Removes all unused anonymous local volumes"):
 *   · it deletes only ANONYMOUS volumes with no container referencing them;
 *   · an unused NAMED volume SURVIVES (that needs `--all`, which we do not emit);
 *   · a volume whose container still exists but has EXITED survives (it is still a reference).
 * The route states exactly this and requires {confirm:true}. `--all` is deliberately not
 * exposed: it is the more destructive semantics, the pinned contract does not ask for it,
 * and it is not something this build has executed. */
export function pruneVolumes(): Promise<ExecResult> {
  return exec("wslc", ["volume", "prune"], { timeoutMs: 120_000 });
}

/** wslc's own report of what prune destroyed — parsed from its output, never inferred. */
export { parsePruneOutput };
