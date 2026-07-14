// .wslconfig read/parse/edit/serialize with line preservation and backup-before-write
// (design/security.md §4). Catalog from intake/research-wslc-command-map.md §5.

export interface WslConfigKeyDef {
  section: "wsl2" | "experimental";
  key: string;
  type: "bool" | "number" | "size" | "path" | "string" | "enum";
  enumValues?: string[];
  default?: string;
  win11Only?: boolean;
  win11_22h2?: boolean;
  deprecatedValue?: string;
  description: string;
}

export const WSLCONFIG_CATALOG: WslConfigKeyDef[] = [
  { section: "wsl2", key: "kernel", type: "path", description: "Absolute Windows path to a custom Linux kernel." },
  { section: "wsl2", key: "kernelModules", type: "path", description: "Absolute Windows path to a custom kernel modules VHD." },
  { section: "wsl2", key: "memory", type: "size", default: "50% of Windows memory", description: "Memory assigned to the WSL 2 VM (e.g. 4GB)." },
  { section: "wsl2", key: "processors", type: "number", default: "all logical processors", description: "Logical processors assigned to the WSL 2 VM." },
  { section: "wsl2", key: "localhostForwarding", type: "bool", default: "true", description: "Connect to WSL ports via localhost:port (ignored when networkingMode=mirrored)." },
  { section: "wsl2", key: "kernelCommandLine", type: "string", description: "Additional kernel command line arguments." },
  { section: "wsl2", key: "safeMode", type: "bool", default: "false", win11Only: true, description: "Run WSL in Safe Mode (recovery; disables many features)." },
  { section: "wsl2", key: "swap", type: "size", default: "25% of memory", description: "Swap space for the WSL 2 VM; 0 disables swap." },
  { section: "wsl2", key: "swapFile", type: "path", default: "%Temp%\\swap.vhdx", description: "Absolute Windows path to the swap virtual hard disk." },
  { section: "wsl2", key: "guiApplications", type: "bool", default: "true", description: "GUI application support (WSLg)." },
  { section: "wsl2", key: "debugConsole", type: "bool", default: "false", description: "Show dmesg output console on WSL 2 distro start." },
  { section: "wsl2", key: "maxCrashDumpCount", type: "number", default: "10", description: "Maximum retained crash dump files." },
  { section: "wsl2", key: "nestedVirtualization", type: "bool", default: "true", win11Only: true, description: "Nested virtualization (VMs inside WSL 2)." },
  { section: "wsl2", key: "vmIdleTimeout", type: "number", default: "60000", win11Only: true, description: "Milliseconds a VM idles before shutdown." },
  { section: "wsl2", key: "dnsProxy", type: "bool", default: "true", description: "NAT mode only: configure Linux DNS server to the host NAT." },
  { section: "wsl2", key: "networkingMode", type: "enum", enumValues: ["none", "nat", "bridged", "mirrored", "virtioproxy"], default: "NAT", win11Only: true, win11_22h2: true, deprecatedValue: "bridged", description: "WSL network mode." },
  { section: "wsl2", key: "firewall", type: "bool", default: "true", win11Only: true, win11_22h2: true, description: "Windows Firewall filtering of WSL traffic." },
  { section: "wsl2", key: "dnsTunneling", type: "bool", default: "true", win11Only: true, win11_22h2: true, description: "DNS request proxying from WSL to Windows." },
  { section: "wsl2", key: "autoProxy", type: "bool", default: "true", win11Only: true, description: "Use Windows HTTP proxy settings in WSL." },
  { section: "wsl2", key: "defaultVhdSize", type: "size", default: "1099511627776 (1TB)", description: "Maximum VHD size for distro filesystems." },
  { section: "experimental", key: "autoMemoryReclaim", type: "enum", enumValues: ["disabled", "gradual", "dropCache"], default: "dropCache", description: "Automatic cached-memory reclamation strategy." },
  { section: "experimental", key: "sparseVhd", type: "bool", default: "false", description: "Create new VHDs as sparse automatically." },
  { section: "experimental", key: "bestEffortDnsParsing", type: "bool", default: "false", win11Only: true, win11_22h2: true, description: "Extract question from DNS request, ignore unknown records (needs dnsTunneling)." },
  { section: "experimental", key: "dnsTunnelingIpAddress", type: "string", default: "10.255.255.254", win11Only: true, win11_22h2: true, description: "Nameserver configured in resolv.conf when DNS tunneling is on." },
  { section: "experimental", key: "initialAutoProxyTimeout", type: "number", default: "1000", win11Only: true, description: "Milliseconds to wait for HTTP proxy info at start (needs autoProxy)." },
  { section: "experimental", key: "ignoredPorts", type: "string", win11Only: true, win11_22h2: true, description: "Mirrored mode: comma-separated ports Linux may bind even if used on Windows." },
  { section: "experimental", key: "hostAddressLoopback", type: "bool", default: "false", win11Only: true, win11_22h2: true, description: "Mirrored mode: allow host<->container connections via host-assigned IPv4 addresses." },
];

export interface WslConfigModel {
  lines: string[];
}

export interface ParsedWslConfig {
  model: WslConfigModel;
  values: Record<string, Record<string, string>>;
}

const SECTION_RE = /^\s*\[([A-Za-z0-9_.-]+)\]\s*$/;
const KV_RE = /^\s*([A-Za-z][\w.]*)\s*=\s*(.*)$/;

export function parseWslConfig(text: string): ParsedWslConfig {
  const lines = text.split(/\r?\n/);
  const values: Record<string, Record<string, string>> = {};
  let section = "";
  for (const line of lines) {
    const s = line.match(SECTION_RE);
    if (s) {
      section = s[1];
      values[section] ??= {};
      continue;
    }
    if (/^\s*[#;]/.test(line)) continue;
    const kv = line.match(KV_RE);
    if (kv && section) values[section][kv[1]] = kv[2].trim();
  }
  return { model: { lines }, values };
}

/** Line-preserving set: replaces the key's line in its section, appends to the
 * section, or creates the section at the end. value=null removes the line. */
export function setValue(
  model: WslConfigModel,
  section: string,
  key: string,
  value: string | null,
): WslConfigModel {
  const lines = [...model.lines];
  let sectionStart = -1;
  let sectionEnd = lines.length;
  let current = "";
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].match(SECTION_RE);
    if (s) {
      if (current === section && sectionStart !== -1) {
        sectionEnd = i;
        break;
      }
      current = s[1];
      if (current === section) sectionStart = i;
    }
  }
  if (sectionStart === -1) {
    if (value === null) return { lines };
    const tail = lines.length > 0 && lines[lines.length - 1].trim() === "" ? [] : [""];
    return { lines: [...lines, ...tail, `[${section}]`, `${key}=${value}`] };
  }
  if (current === section) sectionEnd = Math.max(sectionEnd, lines.length);
  const keyRe = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
  for (let i = sectionStart + 1; i < sectionEnd; i++) {
    if (SECTION_RE.test(lines[i])) break;
    if (keyRe.test(lines[i])) {
      if (value === null) lines.splice(i, 1);
      else lines[i] = `${key}=${value}`;
      return { lines };
    }
  }
  if (value === null) return { lines };
  // Insert right after the section header (before any following blank tail).
  lines.splice(sectionStart + 1, 0, `${key}=${value}`);
  return { lines };
}

export function serialize(model: WslConfigModel): string {
  return model.lines.join("\r\n");
}

export function wslConfigPath(): string {
  const home = Deno.env.get("USERPROFILE");
  if (!home) throw new Error("USERPROFILE not set");
  return `${home}\\.wslconfig`;
}

export async function readWslConfig(): Promise<{ path: string; exists: boolean; text: string; values: Record<string, Record<string, string>> }> {
  const path = wslConfigPath();
  try {
    const text = await Deno.readTextFile(path);
    return { path, exists: true, text, values: parseWslConfig(text).values };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { path, exists: false, text: "", values: {} };
    }
    throw err;
  }
}

/** How many `.wslconfig.bak.<ts>` backups to keep (newest wins). */
export const WSLCONFIG_BACKUP_KEEP = 5;

/** Newest-N backup retention (M3). Given the file names in the config directory, return
 * the `.wslconfig.bak.<ts>` names to delete so only the newest `keep` survive. Pure so
 * the rotation policy is testable without touching the real filesystem. */
export function backupsToPrune(names: string[], keep: number): string[] {
  const ts = (n: string) => Number(n.slice(".wslconfig.bak.".length));
  const baks = names
    .filter((n) => /^\.wslconfig\.bak\.\d+$/.test(n))
    .sort((a, b) => ts(b) - ts(a)); // newest first
  return baks.slice(Math.max(0, keep));
}

/** Injectable filesystem for writeWslConfig, so the atomic sequence + rotation are
 * testable under the suite's read-only permission set. */
export interface WslConfigWriteIo {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  listDir(dir: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}

const denoWriteIo: WslConfigWriteIo = {
  readTextFile: (p) => Deno.readTextFile(p),
  writeTextFile: (p, d) => Deno.writeTextFile(p, d),
  rename: (from, to) => Deno.rename(from, to),
  async listDir(dir) {
    const names: string[] = [];
    for await (const e of Deno.readDir(dir)) if (e.isFile) names.push(e.name);
    return names;
  },
  remove: (p) => Deno.remove(p),
};

/** Backup-then-atomically-replace. Returns the backup path ("" when no prior file
 * existed). Writes to `path.tmp` then renames over `path` (atomic on NTFS), so a crash
 * mid-write can never leave a half-written `.wslconfig`; keeps a timestamped backup of
 * the prior file and rotates old backups to the newest N (M3). */
export async function writeWslConfig(
  text: string,
  io: WslConfigWriteIo = denoWriteIo,
): Promise<{ path: string; backupPath: string }> {
  const path = wslConfigPath();
  const dir = path.slice(0, path.lastIndexOf("\\"));
  let backupPath = "";
  try {
    const prior = await io.readTextFile(path);
    backupPath = `${path}.bak.${Date.now()}`;
    await io.writeTextFile(backupPath, prior);
    await pruneBackups(io, dir);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const tmp = `${path}.tmp`;
  await io.writeTextFile(tmp, text);
  await io.rename(tmp, path); // atomic replace on NTFS (Deno.rename → MoveFileEx REPLACE_EXISTING)
  return { path, backupPath };
}

async function pruneBackups(io: WslConfigWriteIo, dir: string): Promise<void> {
  let names: string[];
  try {
    names = await io.listDir(dir);
  } catch {
    return; // rotation is best-effort — a listing failure must never fail the write
  }
  for (const name of backupsToPrune(names, WSLCONFIG_BACKUP_KEEP)) {
    try {
      await io.remove(`${dir}\\${name}`);
    } catch {
      // a failed delete must never fail the write
    }
  }
}
