// wsl.exe operations (all live-verified against WSL 2.7.10 --help surface;
// see intake/research-wslc-command-map.md §4).

import { exec, type ExecResult } from "./exec.ts";
import { type DistroInfo, parseDistroList, parseStatus, parseTable, parseVersionBlock, type Table } from "./parsers.ts";
import * as v from "./validate.ts";

const LONG_MS = 600_000; // export/import/resize/move can be genuinely slow

export async function listDistros(): Promise<DistroInfo[]> {
  const res = await exec("wsl", ["--list", "--verbose"]);
  // Nonzero + empty parse is the honest "no distributions" answer.
  return parseDistroList(res.stdout);
}

export async function listRunning(): Promise<string[]> {
  const res = await exec("wsl", ["--list", "--running", "--quiet"]);
  if (res.code !== 0) return [];
  return res.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) =>
    l.length > 0 && !/^wsl:/i.test(l) && !/no running distributions/i.test(l)
  );
}

export async function status(): Promise<Record<string, string>> {
  return parseStatus((await exec("wsl", ["--status"])).stdout);
}

export async function version(): Promise<Record<string, string>> {
  return parseVersionBlock((await exec("wsl", ["--version"])).stdout);
}

export function terminate(name: string): Promise<ExecResult> {
  return exec("wsl", ["--terminate", v.name(name, "distro")]);
}

/** Boot a distro. wsl.exe documents no --start verb; a no-op exec is the
 * honest start (probed 2026-07-13: exit 0, state flips to Running). */
export function startDistro(name: string): Promise<ExecResult> {
  return exec("wsl", ["-d", v.name(name, "distro"), "-e", "true"], { timeoutMs: 120_000 });
}

/** `wsl --list --online` — installable distros from the Microsoft registry
 * (probed 2026-07-13: exit 0, ALL-CAPS fixed-width NAME / FRIENDLY NAME table). */
export async function listOnline(): Promise<Table> {
  const res = await exec("wsl", ["--list", "--online"], { timeoutMs: 60_000 });
  return res.code === 0 ? parseTable(res.stdout) : { headers: [], rows: [], raw: [res.stderr.trim()] };
}

/** `wsl --install <Distro> --no-launch` (flag verified in live --help).
 * Downloads can be multi-GB — generous timeout, progress is not streamable. */
export function installOnline(name: string): Promise<ExecResult> {
  return exec("wsl", ["--install", v.name(name, "distro"), "--no-launch"], { timeoutMs: 1_800_000 });
}

export function shutdown(force = false): Promise<ExecResult> {
  const args = ["--shutdown"];
  if (force) args.push("--force");
  return exec("wsl", args, { timeoutMs: 60_000 });
}

export function setDefault(name: string): Promise<ExecResult> {
  return exec("wsl", ["--set-default", v.name(name, "distro")]);
}

export function setVersion(name: string, ver: 1 | 2): Promise<ExecResult> {
  if (ver !== 1 && ver !== 2) throw new v.ValidationError("version: must be 1 or 2");
  return exec("wsl", ["--set-version", v.name(name, "distro"), String(ver)], { timeoutMs: LONG_MS });
}

export function unregister(name: string): Promise<ExecResult> {
  return exec("wsl", ["--unregister", v.name(name, "distro")], { timeoutMs: 120_000 });
}

const EXPORT_FORMATS = new Set(["tar", "tar.gz", "tar.xz", "vhd"]);

export function exportDistro(name: string, file: string, format?: string): Promise<ExecResult> {
  const args = ["--export", v.name(name, "distro"), v.winPath(file, "file")];
  if (format !== undefined) {
    if (!EXPORT_FORMATS.has(format)) throw new v.ValidationError("format: tar|tar.gz|tar.xz|vhd");
    args.push("--format", format);
  }
  return exec("wsl", args, { timeoutMs: LONG_MS });
}

export function importDistro(
  name: string,
  location: string,
  file: string,
  opts: { vhd?: boolean; version?: 1 | 2 } = {},
): Promise<ExecResult> {
  const args = ["--import", v.name(name, "distro"), v.winPath(location, "location"), v.winPath(file, "file")];
  if (opts.version !== undefined) args.push("--version", String(opts.version));
  if (opts.vhd) args.push("--vhd");
  return exec("wsl", args, { timeoutMs: LONG_MS });
}

export function manageResize(name: string, size: string): Promise<ExecResult> {
  return exec("wsl", ["--manage", v.name(name, "distro"), "--resize", v.memSize(size)], { timeoutMs: LONG_MS });
}

export function manageSparse(name: string, sparse: boolean): Promise<ExecResult> {
  return exec("wsl", ["--manage", v.name(name, "distro"), "--set-sparse", sparse ? "true" : "false"], { timeoutMs: 120_000 });
}

export function manageMove(name: string, location: string): Promise<ExecResult> {
  return exec("wsl", ["--manage", v.name(name, "distro"), "--move", v.winPath(location, "location")], { timeoutMs: LONG_MS });
}

export function mount(
  disk: string,
  opts: { vhd?: boolean; bare?: boolean; name?: string; type?: string; partition?: number; options?: string } = {},
): Promise<ExecResult> {
  // Disk may be \\.\PHYSICALDRIVE0 or a vhdx path — validate loosely but firmly.
  if (typeof disk !== "string" || disk.length === 0 || disk.length > 512 || /[\0\r\n]/.test(disk) || disk.startsWith("-")) {
    throw new v.ValidationError("disk: invalid");
  }
  const args = ["--mount", disk];
  if (opts.vhd) args.push("--vhd");
  if (opts.bare) args.push("--bare");
  if (opts.name !== undefined) args.push("--name", v.name(opts.name, "mount name"));
  if (opts.type !== undefined) args.push("--type", v.name(opts.type, "fs type"));
  if (opts.partition !== undefined) {
    if (!Number.isInteger(opts.partition) || opts.partition < 0) throw new v.ValidationError("partition: invalid");
    args.push("--partition", String(opts.partition));
  }
  if (opts.options !== undefined) {
    if (!/^[\w=,.-]+$/.test(opts.options)) throw new v.ValidationError("options: invalid");
    args.push("--options", opts.options);
  }
  return exec("wsl", args, { timeoutMs: 60_000 });
}

export function unmount(disk?: string): Promise<ExecResult> {
  const args = ["--unmount"];
  if (disk !== undefined) {
    if (typeof disk !== "string" || disk.length === 0 || /[\0\r\n]/.test(disk) || disk.startsWith("-")) {
      throw new v.ValidationError("disk: invalid");
    }
    args.push(disk);
  }
  return exec("wsl", args, { timeoutMs: 60_000 });
}
