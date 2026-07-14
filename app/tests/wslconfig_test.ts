import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  backupsToPrune,
  parseWslConfig,
  serialize,
  setValue,
  WSLCONFIG_BACKUP_KEEP,
  wslConfigPath,
  writeWslConfig,
  type WslConfigWriteIo,
} from "../adapter/wslconfig.ts";

const basename = (p: string): string => p.slice(p.lastIndexOf("\\") + 1);

/** In-memory filesystem for writeWslConfig so the atomic sequence + rotation are testable
 * under the suite's read-only permissions (no --allow-write). Records the ordered ops. */
function recordingIo(seed: Record<string, string>): { io: WslConfigWriteIo; ops: string[]; files: Record<string, string> } {
  const files: Record<string, string> = { ...seed };
  const ops: string[] = [];
  const io: WslConfigWriteIo = {
    readTextFile: (p) => p in files ? Promise.resolve(files[p]) : Promise.reject(new Deno.errors.NotFound(p)),
    writeTextFile: (p, d) => {
      ops.push(`write ${basename(p)}`);
      files[p] = d;
      return Promise.resolve();
    },
    rename: (from, to) => {
      ops.push(`rename ${basename(from)} -> ${basename(to)}`);
      files[to] = files[from];
      delete files[from];
      return Promise.resolve();
    },
    listDir: () => Promise.resolve(Object.keys(files).map(basename)),
    remove: (p) => {
      ops.push(`remove ${basename(p)}`);
      delete files[p];
      return Promise.resolve();
    },
  };
  return { io, ops, files };
}

const SAMPLE = [
  "# my custom wsl config",
  "[wsl2]",
  "memory=4GB",
  "processors=2",
  "",
  "[experimental]",
  "sparseVhd=true",
].join("\r\n");

Deno.test("parseWslConfig: sections and values", () => {
  const { values } = parseWslConfig(SAMPLE);
  assertEquals(values["wsl2"]["memory"], "4GB");
  assertEquals(values["wsl2"]["processors"], "2");
  assertEquals(values["experimental"]["sparseVhd"], "true");
});

Deno.test("setValue: replaces existing key, preserves comments and layout", () => {
  const { model } = parseWslConfig(SAMPLE);
  const next = setValue(model, "wsl2", "memory", "8GB");
  const text = serialize(next);
  assertEquals(text.includes("memory=8GB"), true);
  assertEquals(text.includes("# my custom wsl config"), true);
  assertEquals(text.includes("processors=2"), true);
  assertEquals(parseWslConfig(text).values["experimental"]["sparseVhd"], "true");
});

Deno.test("setValue: inserts new key into existing section", () => {
  const { model } = parseWslConfig(SAMPLE);
  const text = serialize(setValue(model, "wsl2", "swap", "8GB"));
  const parsed = parseWslConfig(text);
  assertEquals(parsed.values["wsl2"]["swap"], "8GB");
  assertEquals(parsed.values["wsl2"]["memory"], "4GB");
});

Deno.test("setValue: creates missing section at end", () => {
  const { model } = parseWslConfig("[wsl2]\r\nmemory=4GB");
  const text = serialize(setValue(model, "experimental", "autoMemoryReclaim", "gradual"));
  assertEquals(parseWslConfig(text).values["experimental"]["autoMemoryReclaim"], "gradual");
});

Deno.test("setValue: null removes the key line", () => {
  const { model } = parseWslConfig(SAMPLE);
  const text = serialize(setValue(model, "wsl2", "processors", null));
  assertEquals(parseWslConfig(text).values["wsl2"]["processors"], undefined);
  assertEquals(parseWslConfig(text).values["wsl2"]["memory"], "4GB");
});

Deno.test("setValue: empty file gets section + key", () => {
  const { model } = parseWslConfig("");
  const text = serialize(setValue(model, "wsl2", "memory", "2GB"));
  assertEquals(parseWslConfig(text).values["wsl2"]["memory"], "2GB");
});

// ---------------------------------------------------------------- M3: atomic write + rotation

Deno.test("backupsToPrune: keeps the newest N .bak files, deletes the rest (M3)", () => {
  const names = [
    ".wslconfig",
    ".wslconfig.bak.100",
    ".wslconfig.bak.300",
    ".wslconfig.bak.200",
    ".wslconfig.bak.500",
    ".wslconfig.bak.400",
    ".wslconfig.bak.600",
    "unrelated.txt",
  ];
  assertEquals(WSLCONFIG_BACKUP_KEEP, 5);
  // keep 5 newest (600,500,400,300,200) → prune only the oldest
  assertEquals(backupsToPrune(names, 5), [".wslconfig.bak.100"]);
  // keep 2 → prune the four oldest
  assertEquals(backupsToPrune(names, 2).sort(), [
    ".wslconfig.bak.100",
    ".wslconfig.bak.200",
    ".wslconfig.bak.300",
    ".wslconfig.bak.400",
  ]);
  // nothing that is not a real .bak.<ts> is ever touched
  assertEquals(backupsToPrune([".wslconfig", "notes.bak.txt"], 0), []);
});

Deno.test("writeWslConfig: backup + atomic tmp→rename + rotation when a prior file exists (M3)", async () => {
  const path = wslConfigPath();
  const files: Record<string, string> = { [path]: "[wsl2]\r\nmemory=4GB" };
  for (const ts of [10, 20, 30, 40, 50, 60]) files[`${path}.bak.${ts}`] = `old ${ts}`; // 6 existing backups
  const { io, ops, files: fs } = recordingIo(files);

  const { backupPath } = await writeWslConfig("[wsl2]\r\nmemory=8GB", io);

  assertMatch(backupPath, /\.wslconfig\.bak\.\d+$/); // a backup of the prior file was made
  assertEquals(fs[path], "[wsl2]\r\nmemory=8GB"); // final content is in place
  assert(
    ops.some((o) => o.startsWith("rename") && o.includes(".wslconfig.tmp")),
    `expected a tmp→target rename, got: ${ops.join(" | ")}`,
  );
  assert(!(`${path}.tmp` in fs), "the temp file must not linger after the rename");
  const remaining = Object.keys(fs).filter((k) => /\.wslconfig\.bak\.\d+$/.test(k));
  assertEquals(remaining.length, WSLCONFIG_BACKUP_KEEP, "old backups rotated down to the newest N");
});

Deno.test("writeWslConfig: no prior file → no backup, still atomic tmp→rename (M3)", async () => {
  const { io, ops } = recordingIo({});
  const { backupPath } = await writeWslConfig("[wsl2]\r\n", io);
  assertEquals(backupPath, "");
  assert(ops.some((o) => o.startsWith("write") && o.includes(".wslconfig.tmp")));
  assert(ops.some((o) => o.startsWith("rename")));
  assert(!ops.some((o) => o.startsWith("remove")), "nothing to rotate when there was no prior file");
});
