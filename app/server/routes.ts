// /api route table. Thin handlers: validate → adapter → honest JSON.
// ValidationError → 400 · wslc absent → 503 · undetected verb → 409 ·
// child nonzero exit → 502 with stderr passthrough (never fabricated success).

import { ValidationError } from "../adapter/validate.ts";
import * as v from "../adapter/validate.ts";
import type { ExecResult } from "../adapter/exec.ts";
import { getCapabilities } from "../adapter/capabilities.ts";
import * as wsl from "../adapter/wsl.ts";
import * as wslc from "../adapter/wslc.ts";
import { exec } from "../adapter/exec.ts";
import { distroStorage, swapInfo, wslcSessionStorage } from "../adapter/registry.ts";
import { fetchTags, TagFetchError } from "./registry_tags.ts";
import { parseWslConfig, readWslConfig, serialize, setValue, writeWslConfig, WSLCONFIG_CATALOG } from "../adapter/wslconfig.ts";
import { normalizeContainers, normalizeImages } from "./normalize.ts";
import { loadConfig, loadStacks, saveConfig, type AppConfig } from "./app_config.ts";
import { validateStack, type Stack } from "../stacks/schema.ts";
import { parseConfigDoc, type ConfigSource } from "../stacks/import.ts";
import { compilePlan, toComposeYaml } from "../stacks/compile.ts";
import { deleteStackRecord, deployStack, downStack } from "../stacks/runner.ts";
import { readTextDoc } from "./read_text.ts";
import type { EventHub } from "./sse.ts";

export interface RouteCtx {
  hub: EventHub;
  config: { current: AppConfig };
  // m5: webview HWND (decimal string) for native-dialog ownership; null until the window is up.
  ownerHwnd: { value: string | null };
}

// One native dialog at a time (each holds a transient worker + user focus).
let picking = false;

// M4: reject an over-large request body on its Content-Length BEFORE buffering/parsing it.
// 1 MB is far above any legitimate stack/compose paste; the wslconfig text path keeps its
// own tighter 64 KB check on the parsed field.
export const BODY_MAX_BYTES = 1024 * 1024;

class PayloadTooLargeError extends Error {}

/** True when a declared Content-Length exceeds the body cap (M4, pure for testing). */
export function bodyLenExceeds(contentLength: string | null): boolean {
  const len = Number(contentLength ?? "");
  return Number.isFinite(len) && len > BODY_MAX_BYTES;
}

// I4/DD2: specialized `wslc run` flags that must each be advertised by `run --help`
// before we emit them — the request body key → the flag it becomes.
export const GATED_RUN_FLAGS: Record<string, string> = {
  tmpfs: "--tmpfs",
  envFile: "--env-file",
  gpus: "--gpus",
  network: "--network",
  shmSize: "--shm-size",
};

/** Of the gated flags PRESENT in a request, the ones this wslc build does not advertise
 * (→ 409 verb_unavailable). Pure so the gate is tested without a live wslc. */
export function ungatedRunFlags(present: Iterable<string>, runFlags: string[]): string[] {
  const have = new Set(runFlags);
  const missing: string[] = [];
  for (const key of present) {
    const flag = GATED_RUN_FLAGS[key];
    if (flag && !have.has(flag)) missing.push(flag);
  }
  return missing;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errRes(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return json({ error, ...extra }, status);
}

/** Map a completed child process to a response, stderr passed through. */
function execRes(res: ExecResult, okData: Record<string, unknown> = {}): Response {
  if (res.notFound) return errRes(503, "wslc_unavailable");
  if (res.timedOut) return errRes(504, "command_timeout", { stderr: res.stderr.trim() });
  if (res.code !== 0) {
    return errRes(502, "command_failed", {
      exitCode: res.code,
      stderr: res.stderr.trim(),
      stdout: res.stdout.trim(),
    });
  }
  return json({ ok: true, stdout: res.stdout.trim(), ...okData });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  // M4: refuse before parsing, so an oversize body is never buffered into memory.
  if (bodyLenExceeds(req.headers.get("content-length"))) {
    throw new PayloadTooLargeError(
      `request body exceeds the ${BODY_MAX_BYTES}-byte limit`,
    );
  }
  try {
    const parsed = await req.json();
    return typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Both stack entry points take EITHER a raw document in any supported format
 * (leniently imported: stack / compose / kubernetes) OR an already-strict `stack`
 * object posted by the builder form, which keeps validateStack's strict contract. */
function stackFromBody(
  b: Record<string, unknown>,
): { stack: Stack; warnings: string[]; source?: ConfigSource } {
  if (typeof b.yaml === "string") {
    const defaultName = typeof b.name === "string" ? b.name : undefined;
    return parseConfigDoc(b.yaml, defaultName);
  }
  return validateStack(b.stack);
}

async function requireWslc(): Promise<Response | null> {
  const caps = await getCapabilities();
  return caps.wslc.present ? null : errRes(503, "wslc_unavailable", {
    hint: "wslc ships with newer WSL. Run: wsl --update (this host: stable WSL without wslc).",
  });
}

export async function handleApi(req: Request, url: URL, ctx: RouteCtx): Promise<Response> {
  const seg = url.pathname.replace(/\/+$/, "").split("/").slice(2); // after /api
  const m = req.method;

  try {
    // ---------- read endpoints ----------
    if (m === "GET" && seg[0] === "capabilities") {
      return json(await getCapabilities(url.searchParams.get("force") === "1"));
    }
    if (m === "GET" && seg[0] === "containers" && seg.length === 1) {
      const gate = await requireWslc();
      if (gate) return gate;
      const all = url.searchParams.get("all") === "1";
      return json(normalizeContainers(await wslc.listContainers(all)));
    }
    if (m === "GET" && seg[0] === "containers" && seg[2] === "logs") {
      const gate = await requireWslc();
      if (gate) return gate;
      return execRes(await wslc.containerLogs(seg[1]));
    }
    if (m === "GET" && seg[0] === "containers" && seg[2] === "inspect") {
      const gate = await requireWslc();
      if (gate) return gate;
      return execRes(await wslc.inspectContainer(seg[1]));
    }
    if (m === "GET" && seg[0] === "images" && seg.length === 1) {
      const gate = await requireWslc();
      if (gate) return gate;
      return json(normalizeImages(await wslc.listImages()));
    }
    if (m === "GET" && seg[0] === "images" && seg[1] === "inspect") {
      const gate = await requireWslc();
      if (gate) return gate;
      return execRes(await wslc.inspectImage(url.searchParams.get("ref") ?? ""));
    }
    if (m === "GET" && seg[0] === "resources") {
      const cfg = await readWslConfig();
      const caps = await getCapabilities();
      const [distros, running, status, version, storage, sessionStorage, sessions] = await Promise.all([
        wsl.listDistros(),
        wsl.listRunning(),
        wsl.status(),
        wsl.version(),
        distroStorage(),
        wslcSessionStorage(),
        caps.wslc.present ? wslc.listSessions() : Promise.resolve([]),
      ]);
      const swap = await swapInfo(cfg.values["wsl2"]?.["swapFile"] ?? null);
      return json({ distros, running, status, version, storage, sessionStorage, sessions, swap });
    }
    if (m === "GET" && seg[0] === "registry" && seg[1] === "tags") {
      const ref = v.imageRef(url.searchParams.get("ref") ?? "", "ref");
      try {
        return json(await fetchTags(ref));
      } catch (err) {
        if (err instanceof TagFetchError) {
          const status = err.kind === "not_found" ? 404 : 502;
          return errRes(status, `registry_${err.kind}`, { detail: err.message });
        }
        throw err;
      }
    }
    if (m === "GET" && seg[0] === "wslconfig") {
      const cfg = await readWslConfig();
      return json({ ...cfg, catalog: WSLCONFIG_CATALOG });
    }
    if (m === "GET" && seg[0] === "config") {
      return json(ctx.config.current);
    }
    if (m === "GET" && seg[0] === "stacks") {
      return json(await loadStacks());
    }

    // ---------- container mutations ----------
    if (m === "POST" && seg[0] === "containers" && seg[1] === "prune") {
      const gate = await requireWslc();
      if (gate) return gate;
      const res = await wslc.pruneContainers();
      ctx.hub.poke("containers");
      return execRes(res);
    }
    if (m === "POST" && seg[0] === "containers" && seg[2] === "stop") {
      const gate = await requireWslc();
      if (gate) return gate;
      const res = await wslc.stopContainer(seg[1]);
      ctx.hub.poke("containers");
      return execRes(res);
    }
    if (m === "POST" && seg[0] === "containers" && seg[2] === "start") {
      const gate = await requireWslc();
      if (gate) return gate;
      const caps = await getCapabilities();
      if (!caps.wslc.can.start) return errRes(409, "verb_unavailable", { verb: "container start" });
      const res = await wslc.startContainer(seg[1], "start");
      ctx.hub.poke("containers");
      return execRes(res);
    }
    if (m === "POST" && seg[0] === "containers" && seg[2] === "exec") {
      const gate = await requireWslc();
      if (gate) return gate;
      const b = await body(req);
      return execRes(await wslc.execInContainer(seg[1], (b.command as string[]) ?? []));
    }
    if (m === "DELETE" && seg[0] === "containers" && seg.length === 2) {
      const gate = await requireWslc();
      if (gate) return gate;
      const caps = await getCapabilities();
      const verb = caps.wslc.containerVerbs.find((v) => ["rm", "remove", "delete"].includes(v));
      if (!verb || !caps.wslc.can.rmContainer) {
        return errRes(409, "verb_unavailable", { verb: "container rm" });
      }
      const res = await wslc.removeContainer(seg[1], verb);
      ctx.hub.poke("containers");
      return execRes(res);
    }
    if (m === "POST" && seg[0] === "run") {
      const gate = await requireWslc();
      if (gate) return gate;
      const b = await body(req);
      const opt = (k: string): string | undefined =>
        typeof b[k] === "string" && (b[k] as string).trim() !== "" ? (b[k] as string).trim() : undefined;
      const runCaps = await getCapabilities();
      // r9 Finding 1: --entrypoint is help-detected like the volume verbs. The client
      // hides the field on a build that lacks it, but the client is not trusted — gate it
      // here too, so a hand-crafted body cannot emit an unknown flag at wslc.
      if (opt("entrypoint") && !runCaps.wslc.can.entrypoint) {
        return errRes(409, "verb_unavailable", { verb: "run --entrypoint" });
      }
      // I4/DD2: gate the specialized run flags the same way — a flag this wslc build does
      // not advertise gets a 409 here rather than a raw 502 from wslc for an unknown flag.
      const presentGated = Object.keys(GATED_RUN_FLAGS).filter((k) => opt(k) !== undefined);
      const missingFlags = ungatedRunFlags(presentGated, runCaps.wslc.runFlags);
      if (missingFlags.length > 0) {
        return errRes(409, "verb_unavailable", { verb: `run ${missingFlags.join(", ")}` });
      }
      const res = await wslc.runContainer({
        image: b.image as string,
        name: b.name as string | undefined,
        ports: (b.ports as string[]) ?? [],
        detach: b.detach !== false,
        rm: b.rm === true,
        interactive: b.interactive === true,
        command: (b.command as string[]) ?? [],
        volumes: (b.volumes as string[]) ?? [],
        env: (b.env as string[]) ?? [],
        tmpfs: opt("tmpfs"),
        envFile: opt("envFile"),
        memory: opt("memory"),
        cpus: opt("cpus"),
        shmSize: opt("shmSize"),
        gpus: opt("gpus"),
        workdir: opt("workdir"),
        user: opt("user"),
        network: opt("network"),
        hostname: opt("hostname"),
        entrypoint: opt("entrypoint"),
      });
      ctx.hub.poke("containers");
      ctx.hub.poke("images");
      // `run -v NAME:/path` auto-creates a named volume (probe P2), so a run can change
      // the volume list even when no volume verb was called.
      ctx.hub.poke("volumes");
      return execRes(res);
    }

    // ---------- volumes (r9 D2) ----------
    // Every verb is feature-detected from `wslc volume --help`: a build without it gets a
    // 409 and no command is emitted at it.
    if (m === "GET" && seg[0] === "volumes" && seg.length === 1) {
      const gate = await requireWslc();
      if (gate) return gate;
      const caps = await getCapabilities();
      if (!caps.wslc.can.volumes) return errRes(409, "verb_unavailable", { verb: "volume list" });
      return json({ volumes: await wslc.listVolumes() });
    }
    if (m === "GET" && seg[0] === "volumes" && seg[2] === "inspect") {
      const gate = await requireWslc();
      if (gate) return gate;
      const caps = await getCapabilities();
      if (!caps.wslc.can.volumeInspect) {
        return errRes(409, "verb_unavailable", { verb: "volume inspect" });
      }
      const res = await wslc.inspectVolume(seg[1]);
      if (res.code !== 0 || res.notFound || res.timedOut) return execRes(res);
      // Raw docker-shaped JSON, passed through exactly as wslc emitted it.
      let inspect: unknown;
      try {
        inspect = JSON.parse(res.stdout);
      } catch {
        return errRes(502, "unparseable_output", { stdout: res.stdout.trim() });
      }
      return json({ inspect });
    }
    if (m === "POST" && seg[0] === "volumes" && seg[1] === "prune") {
      const gate = await requireWslc();
      if (gate) return gate;
      const caps = await getCapabilities();
      if (!caps.wslc.can.volumePrune) return errRes(409, "verb_unavailable", { verb: "volume prune" });
      const b = await body(req);
      // Irreversible: the UI confirm is never the only gate (security §3.4, as unregister).
      if (b.confirm !== true) {
        return errRes(400, "confirm_required", {
          hint: "body.confirm must be true — prune permanently deletes volumes",
        });
      }
      const res = await wslc.pruneVolumes();
      ctx.hub.poke("volumes");
      if (res.code !== 0 || res.notFound || res.timedOut) return execRes(res);
      // What wslc says it destroyed, parsed from its own output — never inferred.
      const { removed, reclaimed } = wslc.parsePruneOutput(res.stdout);
      return json({ ok: true, stdout: res.stdout.trim(), removed, reclaimed });
    }
    if (m === "POST" && seg[0] === "volumes" && seg.length === 1) {
      const gate = await requireWslc();
      if (gate) return gate;
      const caps = await getCapabilities();
      if (!caps.wslc.can.volumeCreate) {
        return errRes(409, "verb_unavailable", { verb: "volume create" });
      }
      const b = await body(req);
      const res = await wslc.createVolume(b.name as string);
      ctx.hub.poke("volumes");
      return execRes(res);
    }
    if (m === "DELETE" && seg[0] === "volumes" && seg.length === 1) {
      const gate = await requireWslc();
      if (gate) return gate;
      const caps = await getCapabilities();
      const verb = wslc.volumeRemoveVerb(caps.wslc.volumeVerbs);
      if (!verb || !caps.wslc.can.volumeRemove) {
        return errRes(409, "verb_unavailable", { verb: "volume remove" });
      }
      const res = await wslc.removeVolume(url.searchParams.get("name") ?? "", verb);
      ctx.hub.poke("volumes");
      return execRes(res);
    }

    // ---------- image mutations ----------
    if (m === "POST" && seg[0] === "images" && seg[1] === "pull") {
      const gate = await requireWslc();
      if (gate) return gate;
      const b = await body(req);
      const ref = b.ref as string;
      const caps = await getCapabilities();
      let res: ExecResult;
      let via = "pull";
      if (caps.wslc.can.pull) {
        const verbPath = caps.wslc.topVerbs.includes("pull") ? ["pull"] : ["image", "pull"];
        res = await wslc.pullImage(ref, verbPath);
      } else {
        // Documented fallback: run auto-pulls missing images.
        res = await wslc.pullViaThrowawayRun(ref);
        via = "throwaway-run";
      }
      ctx.hub.poke("images");
      return execRes(res, { via });
    }
    if (m === "POST" && seg[0] === "images" && seg[1] === "prune") {
      const gate = await requireWslc();
      if (gate) return gate;
      const res = await wslc.pruneImages();
      ctx.hub.poke("images");
      return execRes(res);
    }
    if (m === "DELETE" && seg[0] === "images") {
      const gate = await requireWslc();
      if (gate) return gate;
      const caps = await getCapabilities();
      const verb = caps.wslc.imageVerbs.find((v) => ["rm", "remove", "delete"].includes(v));
      if (!verb || !caps.wslc.can.rmImage) return errRes(409, "verb_unavailable", { verb: "image rm" });
      const res = await wslc.removeImage(url.searchParams.get("ref") ?? "", verb);
      ctx.hub.poke("images");
      return execRes(res);
    }

    // ---------- stacks ----------
    if (m === "POST" && seg[0] === "stacks" && seg[1] === "compile") {
      const b = await body(req);
      let parsed: { stack: Stack; warnings: string[]; source?: ConfigSource };
      try {
        parsed = stackFromBody(b);
      } catch (err) {
        // r8.1 contract pins `validation_error` (not the generic `validation`) here.
        if (err instanceof ValidationError) return errRes(400, "validation_error", { detail: err.message });
        throw err;
      }
      const { stack, warnings, source } = parsed;
      const plan = compilePlan(stack);
      return json({
        stack,
        warnings,
        plan: plan.map((p) => ({ service: p.service, container: p.container, preview: p.preview })),
        composeYaml: toComposeYaml(stack),
        source,
      });
    }
    if (m === "POST" && seg[0] === "stacks" && seg[1] === "deploy") {
      const gate = await requireWslc();
      if (gate) return gate;
      const b = await body(req);
      let stack: Stack;
      try {
        stack = stackFromBody(b).stack;
      } catch (err) {
        if (err instanceof ValidationError) return errRes(400, "validation_error", { detail: err.message });
        throw err;
      }
      // Same gate as /api/run (Finding 1 + I4): a stack service may carry entrypoint or
      // shm_size via an imported compose/k8s file, and deploy is the execution sink.
      // (memory/cpus/ports/env/volumes are core `run` flags; of the I4 gated set only
      // shmSize is expressible in a Stack — the others aren't ServiceSpec fields.)
      const deployCaps = await getCapabilities();
      if (Object.values(stack.services).some((s) => s.entrypoint) && !deployCaps.wslc.can.entrypoint) {
        return errRes(409, "verb_unavailable", { verb: "run --entrypoint" });
      }
      if (
        Object.values(stack.services).some((s) => s.shmSize) &&
        !deployCaps.wslc.runFlags.includes("--shm-size")
      ) {
        return errRes(409, "verb_unavailable", { verb: "run --shm-size" });
      }
      const record = await deployStack(stack);
      ctx.hub.poke("containers");
      ctx.hub.poke("images");
      return json(record, record.status === "deployed" ? 200 : 207);
    }
    if (m === "POST" && seg[0] === "stacks" && seg[2] === "down") {
      const gate = await requireWslc();
      if (gate) return gate;
      const caps = await getCapabilities();
      const { record, results } = await downStack(seg[1], caps);
      if (!record) return errRes(404, "stack_not_found");
      ctx.hub.poke("containers");
      return json({ record, results });
    }
    if (m === "DELETE" && seg[0] === "stacks" && seg.length === 2) {
      return (await deleteStackRecord(seg[1])) ? json({ ok: true }) : errRes(404, "stack_not_found");
    }

    // ---------- distro / wsl management ----------
    if (m === "POST" && seg[0] === "distros" && seg.length === 3) {
      const name = seg[1];
      const action = seg[2];
      const b = await body(req);
      let res: ExecResult;
      switch (action) {
        case "terminate":
          res = await wsl.terminate(name);
          break;
        case "start":
          res = await wsl.startDistro(name);
          break;
        case "set-default":
          res = await wsl.setDefault(name);
          break;
        case "set-version":
          res = await wsl.setVersion(name, b.version === 1 ? 1 : 2);
          break;
        case "resize":
          res = await wsl.manageResize(name, b.size as string);
          break;
        case "set-sparse":
          res = await wsl.manageSparse(name, b.sparse === true);
          break;
        case "move":
          res = await wsl.manageMove(name, b.location as string);
          break;
        case "export":
          res = await wsl.exportDistro(name, b.file as string, b.format as string | undefined);
          break;
        default:
          return errRes(404, "unknown_action", { action });
      }
      ctx.hub.poke("resources");
      return execRes(res);
    }
    if (m === "GET" && seg[0] === "distros" && seg[1] === "online") {
      const table = await wsl.listOnline();
      const distros = table.rows
        .map((r) => ({ name: r["NAME"] ?? "", friendlyName: r["FRIENDLY NAME"] ?? r["NAME"] ?? "" }))
        .filter((d) => d.name.length > 0);
      if (distros.length === 0 && table.raw.length > 0) {
        return errRes(502, "online_list_failed", { detail: table.raw.join("\n") });
      }
      return json({ distros });
    }
    if (m === "POST" && seg[0] === "distros" && seg[1] === "install-online") {
      const b = await body(req);
      const res = await wsl.installOnline(b.name as string);
      ctx.hub.poke("resources");
      return execRes(res);
    }
    if (m === "POST" && seg[0] === "distros" && seg[1] === "import") {
      const b = await body(req);
      const res = await wsl.importDistro(
        b.name as string,
        b.location as string,
        b.file as string,
        { vhd: b.vhd === true, version: b.version === 1 ? 1 : 2 },
      );
      ctx.hub.poke("resources");
      return execRes(res);
    }
    if (m === "DELETE" && seg[0] === "distros" && seg.length === 2) {
      const b = await body(req);
      // Server-side typed-name echo — UI confirm alone is not trusted (security §3.4).
      if (b.confirmName !== seg[1]) {
        return errRes(400, "confirm_required", {
          hint: "body.confirmName must exactly match the distro name",
        });
      }
      const res = await wsl.unregister(seg[1]);
      ctx.hub.poke("resources");
      return execRes(res);
    }
    if (m === "POST" && seg[0] === "wsl" && seg[1] === "shutdown") {
      const b = await body(req);
      if (b.confirm !== true) {
        const running = await wsl.listRunning();
        return errRes(400, "confirm_required", { running });
      }
      const res = await wsl.shutdown(b.force === true);
      ctx.hub.poke("resources");
      return execRes(res);
    }
    if (m === "POST" && seg[0] === "wsl" && seg[1] === "mount") {
      const b = await body(req);
      const res = await wsl.mount(b.disk as string, {
        vhd: b.vhd === true,
        bare: b.bare === true,
        name: b.name as string | undefined,
        type: b.type as string | undefined,
        partition: b.partition as number | undefined,
        options: b.options as string | undefined,
      });
      ctx.hub.poke("resources");
      return execRes(res);
    }
    if (m === "POST" && seg[0] === "wsl" && seg[1] === "unmount") {
      const b = await body(req);
      const res = await wsl.unmount(b.disk as string | undefined);
      ctx.hub.poke("resources");
      return execRes(res);
    }

    // ---------- config / settings ----------
    if (m === "PUT" && seg[0] === "config") {
      const b = await body(req);
      ctx.config.current = await saveConfig(b as unknown as AppConfig);
      ctx.hub.restart();
      return json(ctx.config.current);
    }
    if (m === "PUT" && seg[0] === "wslconfig") {
      const b = await body(req);
      let nextText: string;
      if (Array.isArray(b.changes)) {
        // Typed-form mode: apply line-preserving edits server-side.
        const current = await readWslConfig();
        let model = parseWslConfig(current.text).model;
        for (const ch of b.changes as { section: string; key: string; value: string | null }[]) {
          if (typeof ch.section !== "string" || typeof ch.key !== "string") {
            return errRes(400, "invalid_change");
          }
          const def = WSLCONFIG_CATALOG.find((d) => d.section === ch.section && d.key === ch.key);
          if (!def) return errRes(400, "unknown_key", { key: `${ch.section}.${ch.key}` });
          if (ch.value !== null && (typeof ch.value !== "string" || ch.value.length > 1024 || /[\r\n]/.test(ch.value))) {
            return errRes(400, "invalid_value", { key: ch.key });
          }
          // Last line of defence on the size grammar: `memory=4G` is undocumented, so
          // WSL ignores the key and silently falls back to 50% of RAM. The UI emits
          // `4GB`, but the UI is not trusted to be the only writer (security §3.3).
          // Only the two hazard shapes are refused — legacy values the control cannot
          // model (a raw byte count, `0`, `50%`) still pass through untouched (DD2).
          if (ch.value !== null) v.wslConfigValue(ch.value, `${ch.section}.${ch.key}`, def.type);
          model = setValue(model, ch.section, ch.key, ch.value);
        }
        nextText = serialize(model);
      } else if (typeof b.text === "string" && b.text.length <= 64 * 1024) {
        nextText = b.text;
      } else {
        return errRes(400, "invalid_text");
      }
      const { path, backupPath } = await writeWslConfig(nextText);
      return json({
        ok: true,
        path,
        backupPath,
        applyHint: "Changes apply after WSL restarts (8-second rule / wsl --shutdown).",
      });
    }
    if (m === "POST" && seg[0] === "system" && seg[1] === "pick") {
      const b = await body(req);
      const kind = b.kind;
      if (kind !== "file-open" && kind !== "file-save" && kind !== "folder") {
        return errRes(400, "invalid_kind");
      }
      if (picking) return errRes(409, "picker_busy");
      const title = typeof b.title === "string" && b.title.length <= 128
        ? b.title.replaceAll("\u0000", "")
        : "Select";
      const filters: [string, string][] = [];
      if (Array.isArray(b.filters)) {
        for (const f of b.filters.slice(0, 8)) {
          if (
            Array.isArray(f) && typeof f[0] === "string" && typeof f[1] === "string" &&
            f[0].length <= 64 && /^[\w*.;? ()-]+$/.test(f[1])
          ) {
            filters.push([f[0].replaceAll("\u0000", ""), f[1]]);
          }
        }
      }
      const defExt = typeof b.defExt === "string" && /^[A-Za-z0-9.]{1,10}$/.test(b.defExt) ? b.defExt : null;
      picking = true;
      try {
        const result = await new Promise<Record<string, unknown>>((resolve) => {
          const w = new Worker(new URL("../system/dialog_worker.ts", import.meta.url), { type: "module" });
          const timer = setTimeout(() => {
            w.terminate();
            resolve({ cancelled: true, timedOut: true });
          }, 300_000);
          w.onmessage = (e: MessageEvent) => {
            clearTimeout(timer);
            w.terminate();
            resolve(e.data as Record<string, unknown>);
          };
          w.onerror = (e) => {
            clearTimeout(timer);
            w.terminate();
            resolve({ error: e.message });
          };
          // m5: thread the app window HWND so the dialog is modal to the app, not lost behind it.
          w.postMessage({ type: "pick", kind, title, filters, defExt, hwnd: ctx.ownerHwnd.value });
        });
        if (typeof result.error === "string") return errRes(500, "picker_failed", { detail: result.error });
        return json(result);
      } finally {
        picking = false;
      }
    }
    if (m === "POST" && seg[0] === "system" && seg[1] === "read-text") {
      const b = await body(req);
      const r = await readTextDoc(b.path);
      if (r.status === 200) return json({ path: r.path, text: r.text });
      return errRes(r.status, r.error, { detail: r.detail });
    }
    if (m === "POST" && seg[0] === "system" && seg[1] === "reveal") {
      const b = await body(req);
      const path = v.winPath(b.path, "path");
      try {
        await Deno.stat(path);
      } catch {
        return errRes(404, "path_not_found", { path });
      }
      // explorer /select,PATH highlights the file; exit codes are unreliable.
      const res = await exec("explorer", [`/select,${path}`], { timeoutMs: 15_000 });
      return json({ ok: true, launched: true, exitCode: res.code });
    }
    if (m === "POST" && seg[0] === "system" && seg[1] === "open-wslconfig") {
      const cfg = await readWslConfig();
      if (!cfg.exists) await writeWslConfig("[wsl2]\r\n");
      const res = await exec("explorer", [cfg.path], { timeoutMs: 15_000 });
      // explorer.exe exit codes are unreliable (returns 1 on success) — report launch.
      return json({ ok: true, launched: true, exitCode: res.code });
    }
    if (m === "POST" && seg[0] === "system" && seg[1] === "open-wsl-settings") {
      const caps = await getCapabilities();
      if (!caps.wslSettingsApp.present || !caps.wslSettingsApp.path) {
        return errRes(404, "wsl_settings_app_not_found");
      }
      const res = await exec("explorer", [caps.wslSettingsApp.path], { timeoutMs: 15_000 });
      return json({ ok: true, launched: true, exitCode: res.code });
    }

    return errRes(404, "not_found");
  } catch (err) {
    if (err instanceof ValidationError) return errRes(400, "validation", { detail: err.message });
    if (err instanceof PayloadTooLargeError) return errRes(413, "payload_too_large", { detail: err.message });
    return errRes(500, "internal", { detail: String(err) });
  }
}
