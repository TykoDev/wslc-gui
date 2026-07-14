// Stack YAML v1 — the compose-subset our app can HONESTLY execute via
// documented `wslc run` flags (decision D1; architecture §6). Unsupported
// compose keys are rejected with an explicit list, never silently dropped.

import * as v from "../adapter/validate.ts";

export interface ServiceSpec {
  image: string;
  ports: string[];
  command: string[];
  detach: boolean;
  rm: boolean;
  interactive: boolean;
  env: string[]; // KEY=value → wslc run -e (verified 2.9.3.0)
  volumes: string[]; // HOST:CONTAINER or NAME:CONTAINER → wslc run -v (verified 2.9.3.0)
  memory?: string; // → wslc run -m
  cpus?: string; // → wslc run --cpus
  shmSize?: string; // → wslc run --shm-size (compose spells it shm_size)
  entrypoint?: string; // → wslc run --entrypoint (compose `entrypoint:`, k8s command[0])
}

export interface Stack {
  name: string;
  services: Record<string, ServiceSpec>;
}

const SUPPORTED_KEYS = new Set([
  "image",
  "ports",
  "command",
  "detach",
  "rm",
  "interactive",
  "env",
  "environment", // compose spelling, accepted as alias for env
  "volumes",
  "memory",
  "cpus",
  "shmSize",
  "entrypoint",
]);

export function validateStack(input: unknown): { stack: Stack; warnings: string[] } {
  if (typeof input !== "object" || input === null) {
    throw new v.ValidationError("stack: must be an object");
  }
  const o = input as Record<string, unknown>;
  const name = v.name(o.name, "stack name");
  if (typeof o.services !== "object" || o.services === null) {
    throw new v.ValidationError("services: required");
  }
  const entries = Object.entries(o.services as Record<string, unknown>);
  if (entries.length === 0) throw new v.ValidationError("services: at least one required");
  if (entries.length > 20) throw new v.ValidationError("services: too many (max 20)");

  const warnings: string[] = [];
  const services: Record<string, ServiceSpec> = {};
  for (const [svcName, raw] of entries) {
    const svc = v.name(svcName, "service name");
    if (typeof raw !== "object" || raw === null) {
      throw new v.ValidationError(`services.${svc}: must be an object`);
    }
    const s = raw as Record<string, unknown>;
    const unsupported = Object.keys(s).filter((k) => !SUPPORTED_KEYS.has(k));
    if (unsupported.length > 0) {
      throw new v.ValidationError(
        `services.${svc}: unsupported keys [${unsupported.join(", ")}] — ` +
          `wslc documents no equivalent yet (supported: ${[...SUPPORTED_KEYS].join(", ")})`,
      );
    }
    const ports = Array.isArray(s.ports) ? s.ports.map((p) => v.portPair(p)) : [];
    const rawEnv = s.env ?? s.environment;
    let env: string[] = [];
    if (Array.isArray(rawEnv)) {
      env = rawEnv.map((e) => v.envPair(e, `services.${svc}.env`));
    } else if (typeof rawEnv === "object" && rawEnv !== null) {
      // compose map form: { KEY: value }
      env = Object.entries(rawEnv as Record<string, unknown>)
        .map(([k, val]) => v.envPair(`${k}=${val ?? ""}`, `services.${svc}.env`));
    } else if (rawEnv !== undefined) {
      throw new v.ValidationError(`services.${svc}.env: must be an array of KEY=value or a map`);
    }
    const volumes = Array.isArray(s.volumes)
      ? s.volumes.map((m) => v.mountSpec(m, `services.${svc}.volumes`))
      : [];
    // r9: a named volume (`dbdata:/var/lib/…`) needs NO warning. r8 warned that "wslc
    // documents no volume-create verb"; that was false. wslc 2.9.3.0 ships a full
    // `volume` lifecycle, and `run -v NAME:/path` auto-creates the volume, which then
    // outlives the container — proven E2E (probe P2, re-verified 2026-07-13). Compose's
    // own semantics are therefore honoured exactly, so there is nothing to tell the user.
    services[svc] = {
      image: v.imageRef(s.image, `services.${svc}.image`),
      ports,
      command: v.commandTokens(s.command, `services.${svc}.command`),
      detach: s.detach === undefined ? true : s.detach === true,
      rm: s.rm === true,
      interactive: s.interactive === true,
      env,
      volumes,
      memory: s.memory === undefined || s.memory === "" ? undefined : v.memValue(s.memory, `services.${svc}.memory`),
      cpus: s.cpus === undefined || s.cpus === "" ? undefined : v.cpusValue(String(s.cpus), `services.${svc}.cpus`),
      shmSize: s.shmSize === undefined || s.shmSize === ""
        ? undefined
        : v.shmSize(s.shmSize, `services.${svc}.shmSize`),
      entrypoint: s.entrypoint === undefined || s.entrypoint === ""
        ? undefined
        : v.entrypointValue(s.entrypoint, `services.${svc}.entrypoint`),
    };
    if (services[svc].interactive && services[svc].detach) {
      warnings.push(`services.${svc}: interactive with detach — the terminal is not attached to the GUI`);
    }
  }
  return { stack: { name, services }, warnings };
}
