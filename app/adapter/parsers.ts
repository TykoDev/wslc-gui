// Pure text parsers for wsl.exe / wslc.exe / reg.exe output.
// Contract: tolerate ANSI codes, BOMs, advisory lines (live-proven:
// "wsl: Nested virtualisation is not supported on this machine"), and
// unknown layouts (degrade to raw rows rather than throw).

// deno-lint-ignore no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function cleanLines(raw: string): string[] {
  return raw
    .replace(/^﻿/, "")
    .replace(ANSI_RE, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
}

/** Advisory/warning lines wsl.exe prints before real output. */
export function isAdvisoryLine(line: string): boolean {
  return /^wsl:\s/i.test(line.trim());
}

export interface DistroInfo {
  name: string;
  state: string;
  version: number;
  isDefault: boolean;
}

/** Parse `wsl --list --verbose` output.
 *
 * The columns are `[*] NAME  STATE  VERSION`, and a NAME may contain spaces (e.g.
 * `Ubuntu 22.04`). STATE is a single word and VERSION is a bare integer, both at the end
 * of the line — so match those two anchored to the end and treat everything between the
 * default marker and STATE as the (possibly spaced) name (BE MINOR-4). The old
 * `(\S+)` name capture silently dropped every spaced distro. */
export function parseDistroList(raw: string): DistroInfo[] {
  const lines = cleanLines(raw).filter((l) => !isAdvisoryLine(l));
  const out: DistroInfo[] = [];
  for (const line of lines) {
    if (/^\s*NAME\s+STATE\s+VERSION/i.test(line)) continue;
    const m = line.match(/^(\*?)\s*(.+?)\s+(\S+)\s+(\d+)\s*$/);
    if (!m) continue;
    out.push({
      name: m[2].trim(),
      state: m[3],
      version: Number(m[4]),
      isDefault: m[1] === "*",
    });
  }
  return out;
}

/** Parse `wsl --version` output into label → value. */
export function parseVersionBlock(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of cleanLines(raw)) {
    if (isAdvisoryLine(line)) continue;
    const m = line.match(/^(.{2,}?)\s*(?:version)?\s*:\s*(.+)$/i);
    if (m) map[m[1].trim().toLowerCase().replace(/\s+version$/, "")] = m[2].trim();
  }
  return map;
}

/** Parse `wsl --status` key: value lines. */
export function parseStatus(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of cleanLines(raw)) {
    if (isAdvisoryLine(line)) continue;
    const m = line.match(/^([^:]{2,60}):\s*(.*)$/);
    if (m) map[m[1].trim()] = m[2].trim();
  }
  return map;
}

/**
 * Extract subcommand names from CLI `--help` text (docker-style layouts):
 * indented word followed by 2+ spaces and a description.
 */
export function parseHelpVerbs(raw: string): Set<string> {
  const verbs = new Set<string>();
  for (const line of cleanLines(raw)) {
    const m = line.match(/^\s{2,}([a-z][a-z0-9-]{1,24})(?:,\s*[a-z-]+)*\s{2,}\S/);
    if (m) verbs.add(m[1]);
  }
  return verbs;
}

/** Extract long/short flags from `--help` text. */
export function parseHelpFlags(raw: string): Set<string> {
  const flags = new Set<string>();
  for (const m of raw.matchAll(/(?<![\w-])(--?[a-zA-Z][\w-]*)/g)) {
    flags.add(m[1]);
  }
  return flags;
}

export interface Table {
  headers: string[];
  rows: Record<string, string>[];
  raw: string[];
}

/**
 * Generic fixed-width table parser (docker-style `ps`/`images` output).
 * Column boundaries come from header token start offsets. Unknown layout →
 * headers [] and raw lines preserved.
 */
export function parseTable(raw: string): Table {
  const lines = cleanLines(raw).filter((l) => !isAdvisoryLine(l));
  if (lines.length === 0) return { headers: [], rows: [], raw: [] };
  const headerIdx = lines.findIndex((l) =>
    /^[A-Z][A-Z0-9 ()/_-]*[A-Z)]$/.test(l.trim()) && /\s{2,}/.test(l.trim())
  );
  if (headerIdx === -1) return { headers: [], rows: [], raw: lines };
  const headerLine = lines[headerIdx];
  const cols: { name: string; start: number }[] = [];
  for (const m of headerLine.matchAll(/\S+(?: \S+)*?(?=\s{2,}|$)/g)) {
    if (m[0].trim()) cols.push({ name: m[0].trim(), start: m.index ?? 0 });
  }
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const row: Record<string, string> = {};
    for (let c = 0; c < cols.length; c++) {
      const start = cols[c].start;
      const end = c + 1 < cols.length ? cols[c + 1].start : line.length;
      row[cols[c].name] = line.slice(start, end).trim();
    }
    if (Object.values(row).some((v) => v.length > 0)) rows.push(row);
  }
  return { headers: cols.map((c) => c.name), rows, raw: lines };
}

export interface SessionInfo {
  id: string;
  creatorPid: string;
  name: string;
}

/** Parse `wslc system session list` (mixed-case headers, so parseTable's
 * all-caps detector does not apply). Live shape 2026-07-13:
 * "ID   Creator PID   Display Name". */
export function parseSessionList(raw: string): SessionInfo[] {
  const lines = cleanLines(raw).filter((l) => !isAdvisoryLine(l));
  const out: SessionInfo[] = [];
  for (const line of lines) {
    if (/^ID\s/i.test(line.trim())) continue; // header
    const cells = line.trim().split(/\s{2,}/);
    if (cells.length < 3 || !/^\d+$/.test(cells[0])) continue;
    out.push({ id: cells[0], creatorPid: cells[1], name: cells[2] });
  }
  return out;
}

// ---------------------------------------------------------------- volumes

/** A volume as the GUI shows it. Every field is something wslc ACTUALLY reports:
 * there is deliberately no `size` and no `mountpoint` — `volume inspect` returns
 * neither (live-probed 2.9.3.0), and a number we cannot obtain is not invented.
 * Volume bytes live inside the container-session VHD that Resources already totals. */
export interface VolumeRow {
  name: string;
  driver: string; // wslc reports "guest" (a "vhd" driver is documented on create)
  createdAt: string | null; // only `volume inspect` carries it; null when unreadable
  anonymous: boolean; // Labels["com.docker.volume.anonymous"] is present
  labels: Record<string, string>;
}

/** The label docker (and wslc) stamps on a volume an image's VOLUME directive created. */
const ANONYMOUS_LABEL = "com.docker.volume.anonymous";

function asLabels(x: unknown): Record<string, string> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return {};
  return Object.fromEntries(
    Object.entries(x as Record<string, unknown>).map(([k, v]) => [k, v == null ? "" : String(v)]),
  );
}

/** Parse `wslc volume list --format json` (live shape: `[{"Driver","Name"}]` — those two
 * keys and NOTHING else; created/labels come from `volume inspect`). We parse the JSON
 * the CLI documents rather than splitting the table columns. Unparseable → []. */
export function parseVolumeListJson(raw: string): { name: string; driver: string }[] {
  let docs: unknown;
  try {
    docs = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(docs)) return [];
  const out: { name: string; driver: string }[] = [];
  for (const d of docs) {
    if (typeof d !== "object" || d === null) continue;
    const o = d as Record<string, unknown>;
    const name = typeof o.Name === "string" ? o.Name : "";
    if (name === "") continue;
    out.push({ name, driver: typeof o.Driver === "string" ? o.Driver : "" });
  }
  return out;
}

export interface VolumeInspect {
  name: string;
  createdAt: string | null;
  driver: string;
  labels: Record<string, string>;
}

/** Parse `wslc volume inspect <name>...` (docker-shaped array; accepts several names in
 * one call — live-verified). A missing name prints "Volume not found: 'x'" and an empty
 * array, so an absent entry is simply absent from the map, never defaulted into one. */
export function parseVolumeInspectJson(raw: string): Map<string, VolumeInspect> {
  const map = new Map<string, VolumeInspect>();
  const start = raw.indexOf("["); // a "Volume not found" line can precede the JSON
  if (start === -1) return map;
  let docs: unknown;
  try {
    docs = JSON.parse(raw.slice(start));
  } catch {
    return map;
  }
  if (!Array.isArray(docs)) return map;
  for (const d of docs) {
    if (typeof d !== "object" || d === null) continue;
    const o = d as Record<string, unknown>;
    const name = typeof o.Name === "string" ? o.Name : "";
    if (name === "") continue;
    map.set(name, {
      name,
      createdAt: typeof o.CreatedAt === "string" && o.CreatedAt !== "" ? o.CreatedAt : null,
      driver: typeof o.Driver === "string" ? o.Driver : "",
      labels: asLabels(o.Labels),
    });
  }
  return map;
}

/** Merge the list (which volumes exist) with the inspect enrichment (what they are).
 * The LIST is the source of truth for existence: a volume whose inspect we could not read
 * still appears, with `createdAt: null` — it is never dropped and never given a made-up date. */
export function mergeVolumeRows(
  listed: { name: string; driver: string }[],
  details: Map<string, VolumeInspect>,
): VolumeRow[] {
  return listed.map((v) => {
    const d = details.get(v.name);
    const labels = d?.labels ?? {};
    return {
      name: v.name,
      driver: v.driver || d?.driver || "",
      createdAt: d?.createdAt ?? null,
      anonymous: ANONYMOUS_LABEL in labels,
      labels,
    };
  });
}

/** Parse `wslc volume prune` (live shape):
 *
 *     Deleted: 0afb8c73…
 *
 *     Total reclaimed space: 0 B
 *
 * `reclaimed` is wslc's own figure, passed through verbatim — not computed, not estimated. */
export function parsePruneOutput(raw: string): { removed: string[]; reclaimed: string | null } {
  const removed: string[] = [];
  let reclaimed: string | null = null;
  for (const line of cleanLines(raw)) {
    const del = line.match(/^Deleted:\s*(\S+)\s*$/i);
    if (del) {
      removed.push(del[1]);
      continue;
    }
    const rec = line.match(/^Total reclaimed space:\s*(.+?)\s*$/i);
    if (rec) reclaimed = rec[1];
  }
  return { removed, reclaimed };
}

export interface LxssEntry {
  keyPath: string;
  values: Record<string, string>;
}

/** Parse `reg query HKCU\...\Lxss /s` output into per-key value maps. */
export function parseRegQuery(raw: string): LxssEntry[] {
  const entries: LxssEntry[] = [];
  let current: LxssEntry | null = null;
  for (const line of cleanLines(raw)) {
    if (/^HKEY_/i.test(line)) {
      current = { keyPath: line.trim(), values: {} };
      entries.push(current);
      continue;
    }
    const m = line.match(/^\s{2,}(\S+)\s+REG_[A-Z_]+\s+(.*)$/);
    if (m && current) current.values[m[1]] = m[2].trim();
  }
  return entries;
}
