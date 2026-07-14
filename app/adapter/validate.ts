// Input validators guarding every user-influenced process argument
// (design/security.md §3.3). Throwing ValidationError maps to HTTP 400.

export class ValidationError extends Error {}

function reject(msg: string): never {
  throw new ValidationError(msg);
}

function base(s: unknown, what: string, max: number, allowSpaces = false): string {
  if (typeof s !== "string" || s.length === 0) reject(`${what}: required`);
  if (s.length > max) reject(`${what}: too long`);
  if (/[\0\r\n\t]/.test(s)) reject(`${what}: control characters`);
  if (!allowSpaces && s.includes(" ")) reject(`${what}: spaces not allowed`);
  if (s.startsWith("-")) reject(`${what}: must not start with "-"`);
  return s;
}

/** Container / stack / service / distro name. */
export function name(s: unknown, what = "name"): string {
  const v = base(s, what, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v)) reject(`${what}: invalid characters`);
  return v;
}

/** OCI image reference (registry/repo:tag@digest subset). */
export function imageRef(s: unknown, what = "image"): string {
  const v = base(s, what, 256);
  if (!/^[a-z0-9][a-z0-9._\-/:@]*$/i.test(v)) reject(`${what}: invalid image reference`);
  if (v.includes("//") || v.includes("..")) reject(`${what}: invalid image reference`);
  return v;
}

export function port(n: unknown, what = "port"): number {
  const v = typeof n === "string" ? Number(n) : n;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
    reject(`${what}: must be an integer 1-65535`);
  }
  return v;
}

/** "HOST:CONTAINER" publish pair, normalized. */
export function portPair(s: unknown): string {
  if (typeof s !== "string") reject("ports: entry must be a string");
  const m = s.match(/^(\d{1,5}):(\d{1,5})$/);
  if (!m) reject(`ports: "${s}" must be HOST:CONTAINER`);
  return `${port(m[1], "host port")}:${port(m[2], "container port")}`;
}

/** Size strings we EMIT for `wsl --manage --resize` and `.wslconfig` (8GB, 512MB, 1TB).
 *
 * PDF (syntax authority): `--resize` takes `<Memory Value>B/M/MB/G/GB/T/TB` and
 * "Decimal values are currently unsupported (e.g. 2.5TB)"; `.wslconfig` memory
 * "can be set as whole numbers using GB or MB" (`memory=4GB`). So the emitted form
 * is a whole number + a long unit — never the docker-style `4G`, never `2.5TB`.
 * Parsing legacy values (bare bytes, `0`, `4G`) is a separate concern: see
 * `wslConfigValue` and the frontend SizeInput, which preserve what they cannot model. */
export function memSize(s: unknown, what = "size"): string {
  const v = base(s, what, 16);
  if (!/^[1-9]\d*(MB|GB|TB)$/i.test(v)) {
    reject(`${what}: use a whole number with MB, GB or TB (e.g. 8GB, 512MB) — decimals are unsupported`);
  }
  return v;
}

/** A `.wslconfig` size value. Only two shapes are DOCUMENTED and honoured by WSL:
 *   · a bare whole number of bytes (the `defaultVhdSize` default is `1099511627776`),
 *     which also covers `0` (documented: "0 for no swap file"); and
 *   · a whole number with `MB` or `GB` (the PDF: "can be set as whole numbers using
 *     GB or MB", e.g. `memory=4GB`).
 * Everything else is REJECTED (r10 I5): WSL silently ignores an undocumented size and
 * falls back to its default (e.g. 50% of RAM), which the user cannot see — so `4G`,
 * `4.5GB`, `4 GB`, `50%` and `potato` are all refused rather than written and ignored.
 * (This tightens r9's DD2, which used to let `50%`/junk pass through untouched.) */
const WSLCONFIG_BYTES = /^\d+$/;
const WSLCONFIG_MBGB = /^\d+(MB|GB)$/i;
const WSLCONFIG_SHORT_SUFFIX = /^\d+(\.\d+)?\s*[BKMGT]$/i;
const WSLCONFIG_DECIMAL = /^\d+\.\d+\s*(B|KB|MB|GB|TB)?$/i;

export function wslConfigValue(value: string, key: string, type: string): string {
  if (type !== "size") return value;
  const t = value.trim();
  if (t === "") return value;
  // Accept the two documented shapes verbatim (never rewrite the user's file).
  if (WSLCONFIG_BYTES.test(t) || WSLCONFIG_MBGB.test(t)) return value;
  // Tailored guidance for the two common near-misses, then a generic refusal.
  if (WSLCONFIG_SHORT_SUFFIX.test(t)) {
    reject(
      `${key}: "${t}" is not a documented .wslconfig size — use whole numbers with MB or GB ` +
        `(e.g. ${t.replace(/\s*[BKMGT]$/i, "")}GB). WSL ignores undocumented sizes and silently falls back to its default.`,
    );
  }
  if (WSLCONFIG_DECIMAL.test(t)) {
    reject(`${key}: "${t}" is a decimal — .wslconfig sizes must be whole numbers with MB or GB (e.g. 4GB).`);
  }
  reject(
    `${key}: "${t}" is not a valid .wslconfig size — use a whole number of bytes (e.g. 1099511627776), ` +
      `or a whole number with MB or GB (e.g. 4GB). WSL ignores anything else and silently falls back to its default.`,
  );
}

/** Absolute Windows path (drive-letter form; spaces are legal in paths). */
export function winPath(s: unknown, what = "path"): string {
  const v = base(s, what, 1024, true);
  if (!/^[A-Za-z]:[\\/](?!.*\.\.)[^<>"|?*]*$/.test(v)) {
    reject(`${what}: must be an absolute Windows path`);
  }
  return v;
}

/** -v/--volume mount spec: "HOST:CONTAINER[:opts]" or "NAME:/path". Host may be
 * a Windows path (embedded colon), so only structural checks are possible here —
 * wslc itself is the final validator and its stderr passes through. */
export function mountSpec(s: unknown, what = "volume"): string {
  const v = base(s, what, 512, true);
  if (!v.includes(":")) reject(`${what}: "${v}" must be HOST:CONTAINER`);
  return v;
}

/** -e/--env pair: KEY=value (value may be empty or contain spaces). */
export function envPair(s: unknown, what = "env"): string {
  const v = base(s, what, 512, true);
  if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) reject(`${what}: "${v}" must be KEY=value`);
  return v;
}

/** -m/--memory limit per run help: "512M, 1G". Docker-style: decimals are legal here
 * (command map §117) — unlike `.wslconfig`/`--resize`, which take `memSize`. */
export function memValue(s: unknown, what = "memory"): string {
  const v = base(s, what, 16);
  if (!/^\d+(\.\d+)?[KMGT]i?B?$/i.test(v)) reject(`${what}: use e.g. 512M or 1G`);
  return v;
}

/** --shm-size: same docker-style grammar as -m (verified flag, command map §117). */
export function shmSize(s: unknown, what = "shm-size"): string {
  return memValue(s, what);
}

/** --cpus per run help: "0.5, 1, 2.5". */
export function cpusValue(s: unknown, what = "cpus"): string {
  const v = base(s, what, 8);
  if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) reject(`${what}: use e.g. 0.5, 1, 2.5`);
  return v;
}

/** --gpus: 'all' or a device selector token. */
export function gpusValue(s: unknown, what = "gpus"): string {
  return base(s, what, 64);
}

/** Absolute container-side path (-w workdir, --tmpfs target). */
export function containerPath(s: unknown, what = "path"): string {
  const v = base(s, what, 256);
  if (!v.startsWith("/") || v.includes("..")) reject(`${what}: must be an absolute container path`);
  return v;
}

/** -u/--user: name|uid|uid:gid. */
export function userSpec(s: unknown, what = "user"): string {
  const v = base(s, what, 64);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(v)) reject(`${what}: invalid user`);
  return v;
}

/** Volume name for `wslc volume create|remove|inspect`.
 *
 * Docker's own rule (`[a-zA-Z0-9][a-zA-Z0-9_.-]`, 128 max), which wslc mirrors —
 * live-probed 2026-07-13: `volume create` accepts `r9probe-named`, and the auto-created
 * anonymous volumes are 64-char hex. This is a PROCESS-ARGUMENT SINK FED BY IMPORTED
 * YAML (`services.<svc>.volumes: "dbdata:/var/lib"` → `wslc volume create dbdata`), so a
 * name that could turn into a flag (`-f`, `--all`) or split a token must never survive:
 * `base()` already refuses a leading "-", spaces and control characters. */
export function volumeName(s: unknown, what = "volume name"): string {
  const v = base(s, what, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(v)) {
    reject(`${what}: use letters, digits, "_", "." or "-" (must start with a letter or digit)`);
  }
  return v;
}

/** `--entrypoint` — "Specifies the container init process executable" (run --help,
 * live 2.9.3.0). ONE executable token, never a shell line: docker/wslc exec it directly,
 * so `--entrypoint "sh -c evil"` is not a shell command but a lookup for a binary literally
 * named "sh -c evil". It is also a process-argument sink fed by imported YAML (compose
 * `entrypoint:`, k8s `command[0]`), so it is validated like one — no control characters,
 * no leading "-" (which would be read as a flag), no spaces, length-capped. Arguments to
 * the entrypoint are NOT its business: they go through `commandTokens` as positional args
 * (proven: `run --rm --entrypoint /bin/sh nginx -c 'echo works'` → works). */
export function entrypointValue(s: unknown, what = "entrypoint"): string {
  return base(s, what, 256);
}

/** Command tokens passed to `wslc run IMAGE [command...]` / `wslc exec`.
 * Spaces inside a token are legitimate (e.g. bash -c "echo hi there"). */
export function commandTokens(v: unknown, what = "command"): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) reject(`${what}: must be an array of tokens`);
  if (v.length > 64) reject(`${what}: too many tokens`);
  return v.map((t, i) => {
    if (typeof t !== "string" || t.length === 0 || t.length > 512) {
      reject(`${what}[${i}]: invalid token`);
    }
    if (/[\0\r\n]/.test(t)) reject(`${what}[${i}]: control characters`);
    return t;
  });
}
