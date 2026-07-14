// Single choke point for child processes. Security contract (design/security.md §3):
// allowlisted binaries only, args arrays only, WSL_UTF8=1 always, timeout+kill always.

const BIN_ALLOWLIST = new Set(["wsl", "wslc", "reg", "explorer"]);
export type AllowedBin = "wsl" | "wslc" | "reg" | "explorer";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  notFound: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
}

// wsl.exe emits UTF-16LE unless WSL_UTF8=1; we set the env var but decode
// defensively anyway (older builds ignore it for some subcommands).
export function decodeOutput(bytes: Uint8Array): string {
  // A UTF-16LE stream that carries a BOM (FF FE ...) - the ASCII heuristic below misses it
  // because the BOM's second byte is 0xFE, not 0x00 (review INFO-6). Detect it explicitly.
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes).replace(/^\uFEFF/, "");
  }
  if (bytes.length >= 2 && bytes[0] !== 0 && bytes[1] === 0) {
    return new TextDecoder("utf-16le").decode(bytes).replace(/^\uFEFF/, "");
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // Interleaved NULs remain when a UTF-16 stream lost its lead byte.
  return text.includes("\u0000") ? text.replaceAll("\u0000", "") : text;
}

export async function exec(
  bin: AllowedBin,
  args: string[],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  if (!BIN_ALLOWLIST.has(bin)) {
    throw new Error(`exec: binary not allowlisted: ${bin}`);
  }
  for (const a of args) {
    // Spaces are fine (args arrays, no shell); NUL/CR/LF never are.
    if (typeof a !== "string" || /[\0\r\n]/.test(a)) {
      throw new Error("exec: invalid argument");
    }
  }
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const spawn = (cmd: string) =>
    new Deno.Command(cmd, {
      args,
      env: { WSL_UTF8: "1" },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
  let child: Deno.ChildProcess;
  try {
    child = spawn(bin);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    // wslc ships at a fixed location but PATH entries only reach processes
    // started after the WSL update (a stale Explorer won't have it) — retry
    // by absolute path before reporting absence.
    if (bin === "wslc") {
      try {
        child = spawn("C:\\Program Files\\WSL\\wslc.exe");
      } catch (err2) {
        if (err2 instanceof Deno.errors.NotFound) {
          return { code: 127, stdout: "", stderr: `${bin}: not found`, timedOut: false, notFound: true };
        }
        throw err2;
      }
    } else {
      return { code: 127, stdout: "", stderr: `${bin}: not found`, timedOut: false, notFound: true };
    }
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill();
    } catch {
      // already exited
    }
  }, timeoutMs);
  try {
    const out = await child.output();
    return {
      code: out.code,
      stdout: decodeOutput(out.stdout),
      stderr: decodeOutput(out.stderr),
      timedOut,
      notFound: false,
    };
  } finally {
    clearTimeout(timer);
  }
}
