// Lenient multi-format front end to validateStack (decisions r8: D3/D6/D7).
//
// Accepts our stack schema, docker-compose / podman-compose, and Kubernetes /
// `podman play kube` manifests, and normalizes them into the strict Stack that
// validateStack already guards. Keys we cannot honour are DROPPED WITH AN
// ITEMISED WARNING — never silently, never guessed. `warnings` is the only
// channel for "we could not honour this"; it is never summarised.
//
// Hard-reject (throw → HTTP 400) is reserved for what genuinely cannot run:
// a compose service with `build:` and no `image:`, and a file with no workload.

import { parseAll } from "@std/yaml";
import { cpusValue, envPair, mountSpec, portPair, ValidationError } from "../adapter/validate.ts";
import { validateStack, type Stack } from "./schema.ts";
import { containerNameFor } from "./compile.ts";

export type ConfigSource = "stack" | "compose" | "kubernetes";

export interface ImportResult {
  stack: Stack;
  warnings: string[];
  source: ConfigSource;
}

type Obj = Record<string, unknown>;

const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

// ---------------------------------------------------------------- sizes

const BINARY: Record<string, number> = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
const DECIMAL: Record<string, number> = { b: 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12 };

/** Size string → bytes. The same token means different things in each dialect:
 * k8s `512M` is 512e6 (decimal) while docker/compose `512M` is 512 MiB. `Mi`/`Gi`
 * are binary in both. Returns null when the value is not a size we can model. */
export function parseSizeBytes(raw: unknown, dialect: "k8s" | "docker"): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
  if (typeof raw !== "string") return null;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|B|KB|MB|GB|TB|K|M|G|T)?B?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const rawUnit = m[2] ?? ""; // original case matters: k8s `m` (milli) ≠ `M` (mega)
  // BE MINOR-3: in the k8s dialect a LOWERCASE `m` is the milli SI suffix (0.001), not
  // mega — so `<n>m` is a fraction of a byte, an unusable memory size. Return null and let
  // the caller warn + drop it, instead of folding it to megabytes (which read 100m as 100M).
  // CPU millicores are handled on a separate path in importKube and are unaffected.
  if (dialect === "k8s" && rawUnit === "m") return null;
  const unit = (rawUnit || "b").toLowerCase();
  if (unit.endsWith("i")) return Math.round(n * BINARY[unit[0]]); // Ki/Mi/Gi/Ti: binary everywhere
  const table = dialect === "k8s" && unit.length <= 1 ? DECIMAL : BINARY;
  const key = unit[0];
  if (!(key in table)) return null;
  return Math.round(n * table[key]);
}

/** Bytes → the docker-style size `wslc run -m/--shm-size` documents (`512M`, `1G`).
 * `exact` is false when the value had to be rounded to a whole MiB. */
export function toDockerSize(bytes: number): { value: string; exact: boolean } {
  const gi = 1024 ** 3, mi = 1024 ** 2;
  if (bytes % gi === 0) return { value: `${bytes / gi}G`, exact: true };
  if (bytes % mi === 0) return { value: `${bytes / mi}M`, exact: true };
  return { value: `${Math.max(1, Math.round(bytes / mi))}M`, exact: false };
}

// ---------------------------------------------------------------- names

/** Best-effort coercion of an arbitrary label (a filename stem, a k8s name) into
 * a name `validate.name()` accepts. Returns null when nothing usable is left. */
export function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 128);
  return /^[a-z0-9][a-z0-9_.-]*$/.test(s) ? s : null;
}

// ---------------------------------------------------------------- shlex

/** compose `command: "npm start"` is exec-form (shlex), not a shell line — split it
 * the way compose does. Returns null on unbalanced quotes (→ warn + drop). */
export function shlexSplit(line: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started || cur.length > 0) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += c;
  }
  if (quote) return null;
  if (started || cur.length > 0) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- compose

/** Keys we map onto a ServiceSpec. Everything else in a service is warned + dropped.
 * `detach`/`rm`/`interactive` are our own stack spellings and pass straight through. */
const COMPOSE_HONOURED = new Set([
  "image",
  "container_name",
  "ports",
  "command",
  "entrypoint", // r9 D1: `wslc run --entrypoint` is real — no longer an ignored key
  "environment",
  "env",
  "volumes",
  "mem_limit",
  "memory",
  "cpus",
  "cpu_count",
  "shm_size",
  "detach",
  "rm",
  "interactive",
  "build", // handled explicitly: hard-reject without image, warn with one
]);

const COMPOSE_TOP_HONOURED = new Set(["name", "services"]);

interface Ctx {
  warnings: string[];
}

/** Keep only the entries that pass `check` (a strict validator that throws); drop the rest
 * with a warning naming the value and the reason. This is how the compose path honours the
 * importer's drop-with-warning contract instead of letting one bad value 400 the whole file. */
function keepValid<T>(items: T[], check: (x: T) => unknown, path: string, w: string[]): T[] {
  const out: T[] = [];
  for (const it of items) {
    try {
      check(it);
      out.push(it);
    } catch (e) {
      w.push(`${path}: "${String(it)}" dropped — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

function envFromCompose(raw: unknown, path: string, w: string[]): string[] {
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (typeof e === "string") out.push(e.includes("=") ? e : `${e}=`);
      else w.push(`${path}: ignored — entry is not a KEY=value string`);
    }
  } else if (isObj(raw)) {
    for (const [k, val] of Object.entries(raw)) {
      // compose `KEY:` (null) means "take it from the host env" — we have no host
      // env to take it from and must never invent one.
      if (val === null || val === undefined) {
        w.push(`${path}.${k}: ignored — no value in the file (compose would inherit it from the shell; we never invent one)`);
        continue;
      }
      out.push(`${k}=${val}`);
    }
  } else if (raw !== undefined) {
    w.push(`${path}: ignored — must be a list of KEY=value or a map`);
  }
  return out;
}

function portsFromCompose(raw: unknown, path: string, w: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    w.push(`${path}: ignored — must be a list`);
    return [];
  }
  const out: string[] = [];
  for (const p of raw) {
    if (isObj(p)) {
      const published = p.published ?? p.host_port;
      const target = p.target;
      if (published !== undefined && target !== undefined) {
        if (typeof p.protocol === "string" && p.protocol.toLowerCase() !== "tcp") {
          w.push(`${path}: "${target}/${p.protocol}" dropped — wslc run -p publishes TCP only`);
          continue;
        }
        out.push(`${published}:${target}`);
      } else {
        w.push(`${path}: long-form entry without both target and published — nothing to publish, dropped`);
      }
      continue;
    }
    const s = String(p);
    const proto = s.match(/\/(\w+)$/);
    if (proto && proto[1].toLowerCase() !== "tcp") {
      w.push(`${path}: "${s}" dropped — wslc run -p publishes TCP only`);
      continue;
    }
    const bare = s.replace(/\/\w+$/, "");
    const parts = bare.split(":");
    if (parts.length === 2) out.push(bare);
    else if (parts.length === 1) {
      w.push(`${path}: "${s}" dropped — no host port, so nothing is published (compose would pick a random one; we never invent one)`);
    } else if (parts.length === 3) {
      w.push(`${path}: "${s}" dropped — a host IP binding is not a documented wslc run -p form`);
    } else {
      w.push(`${path}: "${s}" dropped — not HOST:CONTAINER`);
    }
  }
  return out;
}

/** compose mounts. The named-volume check lives in validateStack, so it fires for
 * every source format (and for the Stack builder) rather than only for compose. */
function volumesFromCompose(raw: unknown, path: string, w: string[]): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    w.push(`${path}: ignored — must be a list`);
    return [];
  }
  const out: string[] = [];
  for (const m of raw) {
    if (typeof m === "string") out.push(m);
    else w.push(`${path}: long-form entry ignored — use "HOST:CONTAINER"`);
  }
  return out;
}

function memFromCompose(raw: unknown, path: string, w: string[]): string | undefined {
  const bytes = parseSizeBytes(raw, "docker");
  if (bytes === null) {
    w.push(`${path}: "${String(raw)}" dropped — not a size we can express as wslc run -m`);
    return undefined;
  }
  const { value, exact } = toDockerSize(bytes);
  if (!exact) w.push(`${path}: "${String(raw)}" rounded to ${value} (whole MiB)`);
  return value;
}

function commandFromCompose(raw: unknown, path: string, w: string[]): string[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map((t) => String(t));
  if (typeof raw === "string") {
    const tokens = shlexSplit(raw);
    if (!tokens) {
      w.push(`${path}: ${JSON.stringify(raw)} dropped — unbalanced quotes`);
      return [];
    }
    return tokens;
  }
  w.push(`${path}: ignored — must be a string or a list`);
  return [];
}

/** compose `entrypoint:` (string → shlex, list → tokens) parsed the same way as `command:`.
 *
 * An empty `entrypoint: ""` means "clear the image's ENTRYPOINT" in compose. `wslc run
 * --entrypoint` needs an executable to point at and has no way to say "none", so that one
 * form is dropped with a warning rather than silently ignored or faked. */
function entrypointFromCompose(raw: unknown, path: string, w: string[]): string[] {
  if (raw === undefined) return [];
  const tokens = commandFromCompose(raw, path, w);
  // An empty `entrypoint: ""` (or `[]`) is the one form we cannot express. A parse failure
  // has already warned for itself, so only the genuinely-empty key reaches this.
  if (tokens.length === 0 && (raw === "" || (Array.isArray(raw) && raw.length === 0))) {
    w.push(
      `${path}: an empty entrypoint means "run no ENTRYPOINT at all" in compose — ` +
        `wslc run --entrypoint needs an executable, so the image's own ENTRYPOINT still runs`,
    );
  }
  return tokens;
}

/** docker/compose run `entrypoint` followed by `command`; wslc runs `--entrypoint <exe>`
 * followed by the positional args after the image. The two produce the SAME argv as long
 * as everything past the first entrypoint token is folded into the command — which is
 * exactly what this does (proven: `--entrypoint /bin/sh nginx -c 'echo works'` → works).
 * So a multi-token entrypoint loses nothing and needs no warning. */
function splitEntrypoint(
  entrypoint: string[],
  command: string[],
): { entrypoint?: string; command: string[] } {
  if (entrypoint.length === 0) return { command };
  return { entrypoint: entrypoint[0], command: [...entrypoint.slice(1), ...command] };
}

function importCompose(doc: Obj, defaultName: string | undefined, ctx: Ctx): Stack {
  const w = ctx.warnings;
  for (const k of Object.keys(doc)) {
    if (COMPOSE_TOP_HONOURED.has(k)) continue;
    if (k === "version") {
      w.push(`version: ignored — obsolete in the compose spec and meaningless to wslc`);
    } else {
      w.push(`${k}: ignored — top-level compose key with no wslc equivalent`);
    }
  }

  let stackName = sanitizeName(doc.name) ?? sanitizeName(defaultName);
  if (!stackName) {
    stackName = "stack";
    w.push(`name: not in the file — the stack is called "stack" (rename it before deploying)`);
  }

  const rawServices = doc.services;
  if (!isObj(rawServices) || Object.keys(rawServices).length === 0) {
    throw new ValidationError("services: the file declares no services");
  }

  const services: Record<string, unknown> = {};
  for (const [rawName, rawSvc] of Object.entries(rawServices)) {
    const svc = sanitizeName(rawName) ?? rawName; // keep the bad name; validateStack reports it
    if (!isObj(rawSvc)) throw new ValidationError(`services.${svc}: must be an object`);
    const p = `services.${svc}`;

    if (rawSvc.image === undefined) {
      if (rawSvc.build !== undefined) {
        throw new ValidationError(
          `services.${svc}: has build: but no image: — wslc cannot build images, so there is nothing to run. ` +
            `Build it yourself and add the resulting image: tag.`,
        );
      }
      throw new ValidationError(`services.${svc}.image: required`);
    }
    if (rawSvc.build !== undefined) {
      w.push(`${p}.build: ignored — wslc cannot build images; running image "${String(rawSvc.image)}" as given`);
    }

    for (const k of Object.keys(rawSvc)) {
      if (!COMPOSE_HONOURED.has(k)) {
        w.push(`${p}.${k}: ignored — wslc run documents no equivalent`);
      }
    }

    // compose semantics: final argv is `entrypoint` + `command` (r9 D1).
    const split = splitEntrypoint(
      entrypointFromCompose(rawSvc.entrypoint, `${p}.entrypoint`, w),
      commandFromCompose(rawSvc.command, `${p}.command`, w),
    );

    // MAJOR-2 (r9 review): the compose front end must DROP a bad value with a warning,
    // exactly as the k8s path does — never forward it into strict validateStack, which
    // would throw a 400 for the WHOLE file over one droppable value (a port range, a
    // multi-line env). Each array is filtered through its own strict validator here.
    const out: Record<string, unknown> = {
      image: rawSvc.image,
      ports: keepValid(portsFromCompose(rawSvc.ports, `${p}.ports`, w), (x) => portPair(x), `${p}.ports`, w),
      command: split.command,
      env: keepValid(envFromCompose(rawSvc.environment ?? rawSvc.env, `${p}.environment`, w), (x) => envPair(x), `${p}.environment`, w),
      volumes: keepValid(volumesFromCompose(rawSvc.volumes, `${p}.volumes`, w), (x) => mountSpec(x), `${p}.volumes`, w),
    };
    if (split.entrypoint !== undefined) out.entrypoint = split.entrypoint;
    if (rawSvc.detach !== undefined) out.detach = rawSvc.detach;
    if (rawSvc.rm !== undefined) out.rm = rawSvc.rm;
    if (rawSvc.interactive !== undefined) out.interactive = rawSvc.interactive;

    const rawMem = rawSvc.mem_limit ?? rawSvc.memory;
    if (rawMem !== undefined && rawMem !== "") out.memory = memFromCompose(rawMem, `${p}.mem_limit`, w);

    const rawShm = rawSvc.shm_size;
    if (rawShm !== undefined && rawShm !== "") out.shmSize = memFromCompose(rawShm, `${p}.shm_size`, w);

    const rawCpus = rawSvc.cpus ?? rawSvc.cpu_count;
    if (rawCpus !== undefined && rawCpus !== "") {
      // Same drop-with-warning rule (MAJOR-2): a cpus value validateStack would reject
      // (scientific notation, non-numeric) must not sink the whole import.
      try {
        out.cpus = cpusValue(String(rawCpus), `${p}.cpus`);
      } catch (e) {
        w.push(`${p}.cpus: "${String(rawCpus)}" dropped — ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // container_name is not a ServiceSpec field: compilePlan/deployStack derive the
    // container name as "<stack>-<service>". Honour it when it already agrees,
    // warn when it cannot be honoured.
    if (typeof rawSvc.container_name === "string") {
      const derived = containerNameFor(stackName, svc);
      if (rawSvc.container_name !== derived) {
        w.push(
          `${p}.container_name: "${rawSvc.container_name}" cannot be honoured — ` +
            `stack containers are named "<stack>-<service>", so this one runs as "${derived}"`,
        );
      }
    }

    // MAJOR-1 (r9 review): two compose service names that sanitizeName collapses to the
    // same key (e.g. "Api"/"api", "web-"/"web") must not silently overwrite each other —
    // the k8s path already guards this. Warn and keep the first.
    if (svc in services) {
      w.push(`services.${svc}: a second service resolves to the same name — only the first is kept`);
      continue;
    }
    services[svc] = out;
  }

  const { stack, warnings } = validateStack({ name: stackName, services });
  w.push(...warnings);
  return stack;
}

// ---------------------------------------------------------------- kubernetes

/** Generic pod-template locator (D6): every kind that carries a pod spec, found by
 * shape rather than by an allow-list of kinds, so a Job manifest is not arbitrarily
 * refused. Covers Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob. */
const POD_SPEC_PATHS = [
  ["spec"], // Pod
  ["spec", "template", "spec"], // Deployment/StatefulSet/DaemonSet/ReplicaSet/Job
  ["spec", "jobTemplate", "spec", "template", "spec"], // CronJob
];

function findPodSpec(doc: Obj): Obj | null {
  for (const path of POD_SPEC_PATHS) {
    let node: unknown = doc;
    for (const key of path) {
      if (!isObj(node)) {
        node = null;
        break;
      }
      node = node[key];
    }
    if (isObj(node) && Array.isArray(node.containers)) return node;
  }
  return null;
}

/** base64 → UTF-8 text. Secret `data` is base64; `stringData` is not. */
function decodeB64(s: string): string | null {
  try {
    const bin = atob(s.replace(/\s+/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

interface RefIndex {
  configMaps: Map<string, Record<string, string>>;
  secrets: Map<string, Record<string, string>>;
}

function indexRefDocs(docs: Obj[], w: string[]): RefIndex {
  const configMaps = new Map<string, Record<string, string>>();
  const secrets = new Map<string, Record<string, string>>();
  for (const d of docs) {
    const name = isObj(d.metadata) ? String(d.metadata.name ?? "") : "";
    if (d.kind === "ConfigMap" && isObj(d.data)) {
      configMaps.set(name, Object.fromEntries(Object.entries(d.data).map(([k, v]) => [k, String(v)])));
    } else if (d.kind === "Secret") {
      const out: Record<string, string> = {};
      if (isObj(d.data)) {
        for (const [k, v] of Object.entries(d.data)) {
          const dec = decodeB64(String(v));
          if (dec === null) w.push(`Secret/${name}.${k}: dropped — value is not valid base64`);
          else out[k] = dec;
        }
      }
      if (isObj(d.stringData)) {
        for (const [k, v] of Object.entries(d.stringData)) out[k] = String(v); // stringData is plain text
      }
      secrets.set(name, out);
    }
  }
  return { configMaps, secrets };
}

/** INFO-8: k8s applies `env` AFTER `envFrom`, last-wins. Collapse duplicate keys to a
 * single `KEY=value` (the last value seen) so a key set by both surfaces emits ONE `-e`,
 * matching k8s semantics, instead of two flags that only happen to resolve correctly. */
export function dedupeEnvLastWins(pairs: string[]): string[] {
  const order: string[] = [];
  const val = new Map<string, string>();
  for (const p of pairs) {
    const eq = p.indexOf("=");
    const key = eq >= 0 ? p.slice(0, eq) : p;
    if (!val.has(key)) order.push(key);
    val.set(key, p); // later wins
  }
  return order.map((k) => val.get(k)!);
}

/** A resolved env value still has to survive `-e KEY=value`. A secret whose value
 * carries a newline (base64 of a file, say) cannot be passed as a run flag: trim a
 * trailing newline, and drop — never mangle — anything still unusable. */
function pushEnv(env: string[], key: string, value: string, path: string, w: string[]): void {
  const clean = value.replace(/[\r\n]+$/, "");
  if (/[\0\r\n\t]/.test(clean)) {
    w.push(`${path}: dropped — the value contains control characters and cannot be passed as -e ${key}=…`);
    return;
  }
  env.push(`${key}=${clean}`);
}

function envFromKube(c: Obj, svc: string, idx: RefIndex, w: string[]): string[] {
  const env: string[] = [];

  for (const item of Array.isArray(c.envFrom) ? c.envFrom : []) {
    if (!isObj(item)) continue;
    const cmRef = isObj(item.configMapRef) ? item.configMapRef : null;
    const secRef = isObj(item.secretRef) ? item.secretRef : null;
    const src = cmRef ?? secRef;
    if (!src) continue;
    const kind = cmRef ? "configMapRef" : "secretRef";
    const name = String(src.name ?? "");
    const bag = cmRef ? idx.configMaps.get(name) : idx.secrets.get(name);
    if (!bag) {
      w.push(`${svc}.envFrom ← ${kind} '${name}' not in file — every variable it carries is dropped (never guessed)`);
      continue;
    }
    for (const [k, v] of Object.entries(bag)) pushEnv(env, k, v, `${svc}.env.${k}`, w);
  }

  for (const e of Array.isArray(c.env) ? c.env : []) {
    if (!isObj(e) || typeof e.name !== "string") continue;
    const key = e.name;
    if (typeof e.value === "string" || typeof e.value === "number" || typeof e.value === "boolean") {
      pushEnv(env, key, String(e.value), `${svc}.env.${key}`, w);
      continue;
    }
    const from = isObj(e.valueFrom) ? e.valueFrom : null;
    if (!from) {
      w.push(`${svc}.env.${key}: dropped — no value in the file`);
      continue;
    }
    const cmKey = isObj(from.configMapKeyRef) ? from.configMapKeyRef : null;
    const secKey = isObj(from.secretKeyRef) ? from.secretKeyRef : null;
    const ref = cmKey ?? secKey;
    if (!ref) {
      const kind = Object.keys(from)[0] ?? "valueFrom";
      w.push(`${svc}.env.${key} ← ${kind}: dropped — only in-file ConfigMap/Secret references can be resolved`);
      continue;
    }
    const kind = cmKey ? "configMapKeyRef" : "secretKeyRef";
    const name = String(ref.name ?? "");
    const k = String(ref.key ?? "");
    const bag = cmKey ? idx.configMaps.get(name) : idx.secrets.get(name);
    if (!bag) {
      w.push(`${svc}.env.${key} ← ${kind} '${name}' not in file — dropped (never guessed, never defaulted)`);
      continue;
    }
    if (!(k in bag)) {
      w.push(`${svc}.env.${key} ← ${kind} '${name}' has no key '${k}' — dropped (never guessed, never defaulted)`);
      continue;
    }
    pushEnv(env, key, bag[k], `${svc}.env.${key}`, w);
  }
  return dedupeEnvLastWins(env);
}

function portsFromKube(c: Obj, svc: string, w: string[]): string[] {
  const out: string[] = [];
  for (const p of Array.isArray(c.ports) ? c.ports : []) {
    if (!isObj(p)) continue;
    const cp = p.containerPort;
    if (p.hostPort === undefined) {
      w.push(`${svc}.ports.${String(cp)}: nothing is published — the manifest sets no hostPort (a k8s Service is not a wslc concept)`);
      continue;
    }
    if (typeof p.protocol === "string" && p.protocol.toUpperCase() !== "TCP") {
      w.push(`${svc}.ports.${String(cp)}/${p.protocol}: dropped — wslc run -p publishes TCP only`);
      continue;
    }
    out.push(`${p.hostPort}:${cp}`);
  }
  return out;
}

function volumesFromKube(c: Obj, pod: Obj, svc: string, w: string[]): string[] {
  const declared = new Map<string, Obj>();
  for (const vol of Array.isArray(pod.volumes) ? pod.volumes : []) {
    if (isObj(vol) && typeof vol.name === "string") declared.set(vol.name, vol);
  }
  const out: string[] = [];
  for (const mnt of Array.isArray(c.volumeMounts) ? c.volumeMounts : []) {
    if (!isObj(mnt) || typeof mnt.name !== "string") continue;
    const path = `${svc}.volumeMounts.${mnt.name}`;
    const vol = declared.get(mnt.name);
    if (!vol) {
      w.push(`${path}: dropped — no volume of that name is declared in the pod`);
      continue;
    }
    const hostPath = isObj(vol.hostPath) ? vol.hostPath : null;
    if (!hostPath || typeof hostPath.path !== "string") {
      const kind = Object.keys(vol).find((k) => k !== "name") ?? "unknown";
      w.push(`${path}: dropped — ${kind} volumes have no wslc equivalent (only hostPath maps to -v)`);
      continue;
    }
    if (mnt.readOnly === true) {
      w.push(`${path}: mounted read-write — readOnly is not a documented wslc run -v option`);
    }
    out.push(`${hostPath.path}:${mnt.mountPath}`);
  }
  return out;
}

/** Keys inside a container spec we can actually carry over. */
const KUBE_CONTAINER_HONOURED = new Set([
  "name",
  "image",
  "command",
  "args",
  "env",
  "envFrom",
  "ports",
  "volumeMounts",
  "resources",
]);

function importKube(docs: unknown[], defaultName: string | undefined, ctx: Ctx): Stack {
  const w = ctx.warnings;
  const objs = docs.filter(isObj);
  const idx = indexRefDocs(objs, w);
  const services: Record<string, unknown> = {};
  let stackName: string | null = null;

  for (const doc of objs) {
    const kind = String(doc.kind ?? "");
    const name = isObj(doc.metadata) ? String(doc.metadata.name ?? "") : "";
    if (kind === "ConfigMap" || kind === "Secret") continue; // consumed by the resolver

    const pod = findPodSpec(doc);
    if (!pod) {
      w.push(`${kind}/${name}: skipped — not a workload (it carries no pod template)`);
      continue;
    }
    stackName ??= sanitizeName(name);

    const replicas = isObj(doc.spec) ? doc.spec.replicas : undefined;
    if (typeof replicas === "number" && replicas > 1) {
      w.push(`${kind}/${name}.spec.replicas: ${replicas} requested — wslc has no scheduler, so exactly 1 container is started`);
    }
    for (const k of ["initContainers", "nodeSelector", "affinity", "tolerations", "serviceAccountName", "securityContext", "restartPolicy"]) {
      if (pod[k] !== undefined) w.push(`${kind}/${name}.spec.${k}: ignored — no wslc equivalent`);
    }

    const containers = (pod.containers as unknown[]).filter(isObj);
    for (const c of containers) {
      const cName = sanitizeName(c.name) ?? "container";
      const base = sanitizeName(name) ?? cName;
      const svc = containers.length > 1 ? `${base}-${cName}` : base;
      const spec: Record<string, unknown> = { image: c.image };

      for (const k of Object.keys(c)) {
        if (KUBE_CONTAINER_HONOURED.has(k)) continue;
        w.push(`${svc}.${k}: ignored — no wslc equivalent (k8s runtime semantics are not simulated)`);
      }

      // r9 D1 — the honest Kubernetes mapping, now that `--entrypoint` is exposed:
      //   k8s `command:` overrides the image ENTRYPOINT  → --entrypoint command[0],
      //                                                     command[1:] + args positional
      //   k8s `args:` alone replaces only the image CMD  → positional command, image
      //                                                     ENTRYPOINT left intact
      // Both land on the identical argv wslc executes, so neither needs a warning. r8's
      // "an image ENTRYPOINT still runs first" caveat is deleted: it is no longer true.
      const command = Array.isArray(c.command) ? c.command.map(String) : [];
      const args = Array.isArray(c.args) ? c.args.map(String) : [];
      const split = splitEntrypoint(command, args);
      spec.command = split.command;
      if (split.entrypoint !== undefined) spec.entrypoint = split.entrypoint;

      spec.env = envFromKube(c, svc, idx, w);
      spec.ports = portsFromKube(c, svc, w);
      spec.volumes = volumesFromKube(c, pod, svc, w);

      const res = isObj(c.resources) ? c.resources : null;
      if (res?.requests !== undefined) {
        w.push(`${svc}.resources.requests: ignored — wslc run sets limits, not scheduling requests`);
      }
      const limits = res && isObj(res.limits) ? res.limits : null;
      if (limits?.memory !== undefined) {
        const bytes = parseSizeBytes(limits.memory, "k8s");
        if (bytes === null) {
          w.push(`${svc}.resources.limits.memory: "${String(limits.memory)}" dropped — not a size we can express as -m`);
        } else {
          const { value, exact } = toDockerSize(bytes);
          if (!exact) {
            w.push(
              `${svc}.resources.limits.memory: "${String(limits.memory)}" → ${value} ` +
                `(k8s decimal units rounded to whole MiB; wslc -m is binary)`,
            );
          }
          spec.memory = value;
        }
      }
      if (limits?.cpu !== undefined) {
        const raw = String(limits.cpu);
        const milli = raw.match(/^(\d+)m$/);
        const cpus = milli ? String(Number(milli[1]) / 1000) : raw;
        if (/^\d+(\.\d+)?$/.test(cpus) && Number(cpus) > 0) spec.cpus = cpus;
        else w.push(`${svc}.resources.limits.cpu: "${raw}" dropped — not a value we can pass to --cpus`);
      }

      if (svc in services) {
        w.push(`${svc}: a second workload has the same name — only the first is deployed`);
        continue;
      }
      services[svc] = spec;
    }
  }

  if (Object.keys(services).length === 0) {
    throw new ValidationError(
      "kubernetes: no workload found — the file holds no Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job or CronJob",
    );
  }

  const finalName = stackName ?? sanitizeName(defaultName) ?? "stack";
  const { stack, warnings } = validateStack({ name: finalName, services });
  w.push(...warnings);
  return stack;
}

// ---------------------------------------------------------------- entry point

/** Parse any supported config document into the strict Stack the compiler runs.
 * `defaultName` (the picked file's stem) is the last-resort stack name. */
export function parseConfigDoc(text: string, defaultName?: string): ImportResult {
  if (typeof text !== "string" || text.trim() === "") {
    throw new ValidationError("yaml: the file is empty");
  }
  let docs: unknown[];
  try {
    docs = parseAll(text) as unknown[];
  } catch (err) {
    throw new ValidationError(`yaml: ${err instanceof Error ? err.message : String(err)}`);
  }
  const live = docs.filter((d) => d !== null && d !== undefined);
  if (live.length === 0) throw new ValidationError("yaml: the file has no documents");

  const ctx: Ctx = { warnings: [] };

  if (live.some((d) => isObj(d) && d.apiVersion !== undefined && d.kind !== undefined)) {
    const stack = importKube(live, defaultName, ctx);
    return { stack, warnings: ctx.warnings, source: "kubernetes" };
  }

  const first = live[0];
  if (!isObj(first)) throw new ValidationError("yaml: the document is not a mapping");
  for (const extra of live.slice(1)) {
    ctx.warnings.push(
      `document ${live.indexOf(extra) + 1}: ignored — only Kubernetes files may hold several documents`,
    );
  }

  // Our own stack schema is a strict subset of what we accept here: when the file
  // already validates, keep validateStack's verdict and report it as a stack.
  try {
    const strict = validateStack(first);
    return { stack: strict.stack, warnings: [...ctx.warnings, ...strict.warnings], source: "stack" };
  } catch {
    // fall through to the lenient compose front end (this is the E2 fix: our own
    // `toComposeYaml` export carries container_name/mem_limit and lands here)
  }

  if (first.services === undefined) {
    throw new ValidationError(
      "yaml: unrecognised file — expected a stack, a docker-compose/podman-compose file (services:), " +
        "or a Kubernetes manifest (apiVersion:/kind:)",
    );
  }
  const stack = importCompose(first, defaultName, ctx);
  return { stack, warnings: ctx.warnings, source: "compose" };
}
