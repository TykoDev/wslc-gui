// POST /api/system/read-text — the only file-read the GUI exposes (decision D5).
//
// Trust boundary: the path comes from the renderer, which the API token protects
// but does not sanctify. Four controls, all enforced here, all tested:
//   1. extension allow-list — .yaml/.yml only (never a .env, a key, an SSH config)
//   2. absolute Windows path via the existing winPath() validator — no traversal,
//      no UNC, no relative path
//   3. a symlink/junction/reparse-point reject via lstat BEFORE the read (r10 M1/D2),
//      so a `stack.yaml` that is really a link to `C:\secret\key` cannot be read.
//      Hardlinks are indistinguishable from the file itself and CANNOT be blocked
//      (documented residual): on a loopback single-user box the token-holder can read
//      their own files anyway, so this closes the cheap symlink/junction vector only.
//   4. a 256 KB cap checked BEFORE the read and again on the bytes actually read,
//      so a file that grows between stat and read cannot slip past it.
//
// The IO port is injectable purely so the tests can drive every branch (symlink,
// oversize, missing, TOCTOU) without needing write permission.

import { ValidationError, winPath } from "../adapter/validate.ts";

export const READ_TEXT_MAX_BYTES = 256 * 1024;

export interface ReadTextIo {
  lstat(path: string): Promise<{ isSymlink: boolean }>;
  stat(path: string): Promise<{ isFile: boolean; size: number }>;
  readFile(path: string): Promise<Uint8Array>;
}

const denoIo: ReadTextIo = {
  async lstat(path) {
    // lstat does NOT follow the link, so isSymlink is true for symlinks AND for the
    // Windows reparse points (junctions) Deno surfaces through the same flag.
    const s = await Deno.lstat(path);
    return { isSymlink: s.isSymlink };
  },
  async stat(path) {
    const s = await Deno.stat(path);
    return { isFile: s.isFile, size: s.size };
  },
  readFile: (path) => Deno.readFile(path),
};

export type ReadTextResult =
  | { status: 200; path: string; text: string }
  | { status: 400; error: "validation_error"; detail: string }
  | { status: 404; error: "not_found"; detail: string }
  | { status: 413; error: "too_large"; detail: string };

export async function readTextDoc(rawPath: unknown, io: ReadTextIo = denoIo): Promise<ReadTextResult> {
  let path: string;
  try {
    path = winPath(rawPath, "path");
  } catch (err) {
    const detail = err instanceof ValidationError ? err.message : "path: invalid";
    return { status: 400, error: "validation_error", detail };
  }
  if (!/\.(ya?ml)$/i.test(path)) {
    return {
      status: 400,
      error: "validation_error",
      detail: "path: only .yaml or .yml files can be read",
    };
  }

  // Reject a symlink/junction/reparse point BEFORE following it (M1/D2). lstat on a
  // missing path throws → 404, matching the stat branch below.
  let link: { isSymlink: boolean };
  try {
    link = await io.lstat(path);
  } catch {
    return { status: 404, error: "not_found", detail: `path: ${path} does not exist` };
  }
  if (link.isSymlink) {
    return {
      status: 400,
      error: "validation_error",
      detail: "path: symlinks and junctions are not allowed",
    };
  }

  let info: { isFile: boolean; size: number };
  try {
    info = await io.stat(path);
  } catch {
    return { status: 404, error: "not_found", detail: `path: ${path} does not exist` };
  }
  if (!info.isFile) {
    return { status: 400, error: "validation_error", detail: "path: not a file" };
  }
  if (info.size > READ_TEXT_MAX_BYTES) {
    return { status: 413, error: "too_large", detail: `path: ${info.size} bytes exceeds the 256 KB limit` };
  }

  let bytes: Uint8Array;
  try {
    bytes = await io.readFile(path);
  } catch {
    return { status: 404, error: "not_found", detail: `path: ${path} could not be read` };
  }
  // Re-check after the read: stat and read are not atomic.
  if (bytes.length > READ_TEXT_MAX_BYTES) {
    return { status: 413, error: "too_large", detail: `path: ${bytes.length} bytes exceeds the 256 KB limit` };
  }

  const text = new TextDecoder().decode(bytes).replace(/^﻿/, "");
  return { status: 200, path, text };
}
