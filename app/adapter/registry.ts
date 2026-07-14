// Distro VHDX discovery via HKCU\...\Lxss (research map §4: BasePath + ext4.vhdx).

import { exec } from "./exec.ts";
import { parseRegQuery } from "./parsers.ts";

const LXSS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";

export interface DistroStorage {
  name: string;
  guid: string;
  basePath: string;
  vhdxPath: string | null;
  sizeBytes: number | null;
}

function stripLongPathPrefix(p: string): string {
  return p.replace(/^\\\\\?\\/, "");
}

export async function distroStorage(): Promise<DistroStorage[]> {
  const res = await exec("reg", ["query", LXSS, "/s"]);
  if (res.code !== 0) return [];
  const out: DistroStorage[] = [];
  for (const entry of parseRegQuery(res.stdout)) {
    const name = entry.values["DistributionName"];
    const rawBase = entry.values["BasePath"];
    if (!name || !rawBase) continue; // Lxss root key or unrelated subkey
    const guidMatch = entry.keyPath.match(/\{[0-9a-f-]+\}\s*$/i);
    const basePath = stripLongPathPrefix(rawBase);
    const vhdxPath = `${basePath}\\ext4.vhdx`;
    let sizeBytes: number | null = null;
    let vhdxExists = false;
    try {
      const st = await Deno.stat(vhdxPath);
      vhdxExists = st.isFile;
      sizeBytes = st.size;
    } catch {
      // WSL1 distros (directory rootfs) or moved disks have no ext4.vhdx
    }
    out.push({
      name,
      guid: guidMatch ? guidMatch[0].trim() : "",
      basePath,
      vhdxPath: vhdxExists ? vhdxPath : null,
      sizeBytes,
    });
  }
  return out;
}

export interface SessionStorage {
  session: string;
  file: string; // storage.vhdx | swap.vhdx
  path: string;
  sizeBytes: number | null;
}

/** wslc container-session disks: %LOCALAPPDATA%\wslc\sessions\<name>\*.vhdx
 * (live-probed 2026-07-13 — this is where images/containers actually live;
 * absent dir → empty list, never an error). */
export async function wslcSessionStorage(): Promise<SessionStorage[]> {
  const local = Deno.env.get("LOCALAPPDATA");
  if (!local) return [];
  const root = `${local}\\wslc\\sessions`;
  const out: SessionStorage[] = [];
  try {
    for await (const dir of Deno.readDir(root)) {
      if (!dir.isDirectory) continue;
      for await (const f of Deno.readDir(`${root}\\${dir.name}`)) {
        if (!f.isFile || !f.name.toLowerCase().endsWith(".vhdx")) continue;
        const path = `${root}\\${dir.name}\\${f.name}`;
        let sizeBytes: number | null = null;
        try {
          sizeBytes = (await Deno.stat(path)).size;
        } catch {
          // race with session teardown — report the file without a size
        }
        out.push({ session: dir.name, file: f.name, path, sizeBytes });
      }
    }
  } catch {
    // no wslc session directory on this host (wslc absent or never used)
  }
  return out;
}

export interface SwapInfo {
  path: string;
  sizeBytes: number | null;
  exists: boolean;
}

/** Default %TEMP%\swap.vhdx unless .wslconfig overrides (caller passes override). */
export async function swapInfo(overridePath?: string | null): Promise<SwapInfo> {
  const temp = Deno.env.get("TEMP") ?? Deno.env.get("TMP") ?? "";
  const path = overridePath && overridePath.length > 0 ? overridePath : `${temp}\\swap.vhdx`;
  try {
    const st = await Deno.stat(path);
    return { path, sizeBytes: st.size, exists: st.isFile };
  } catch {
    return { path, sizeBytes: null, exists: false };
  }
}
