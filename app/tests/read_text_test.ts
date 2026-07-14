import { assertEquals, assertStringIncludes } from "@std/assert";
import { READ_TEXT_MAX_BYTES, readTextDoc, type ReadTextIo } from "../server/read_text.ts";
import { parseConfigDoc } from "../stacks/import.ts";

/** A fake filesystem, so every branch (oversize, missing, TOCTOU) is exercised
 * without the test suite needing write permission. */
function io(over: Partial<ReadTextIo> = {}): ReadTextIo {
  return {
    lstat: () => Promise.resolve({ isSymlink: false }),
    stat: () => Promise.resolve({ isFile: true, size: 10 }),
    readFile: () => Promise.resolve(new TextEncoder().encode("name: x\n")),
    ...over,
  };
}

Deno.test("read-text: rejects any extension outside the .yaml/.yml allow-list", async () => {
  for (const p of [
    "C:\\Users\\me\\.ssh\\id_rsa",
    "C:\\app\\.env",
    "C:\\Windows\\System32\\config\\SAM",
    "C:\\stack.yaml.exe",
    "C:\\stack.yml.txt",
  ]) {
    const r = await readTextDoc(p, io());
    assertEquals(r.status, 400, p);
    assertEquals(r.status === 400 && r.error, "validation_error");
  }
  assertEquals((await readTextDoc("C:\\ok.yaml", io())).status, 200);
  assertEquals((await readTextDoc("C:\\ok.YML", io())).status, 200);
});

Deno.test("read-text: rejects traversal, relative and UNC paths", async () => {
  for (const p of [
    "C:\\stacks\\..\\..\\Windows\\win.yaml",
    "..\\..\\secrets.yaml",
    "stacks\\app.yaml",
    "\\\\server\\share\\app.yaml",
    "/etc/passwd.yaml",
    "C:\\bad|pipe.yaml",
  ]) {
    const r = await readTextDoc(p, io());
    assertEquals(r.status, 400, p);
  }
});

Deno.test("read-text: rejects a non-string path", async () => {
  for (const p of [undefined, null, 42, { path: "C:\\x.yaml" }]) {
    assertEquals((await readTextDoc(p, io())).status, 400);
  }
});

Deno.test("read-text: a symlink/junction is rejected before the file is read (M1)", async () => {
  let read = false;
  const r = await readTextDoc("C:\\link.yaml", io({
    lstat: () => Promise.resolve({ isSymlink: true }),
    readFile: () => {
      read = true;
      return Promise.resolve(new TextEncoder().encode("secret"));
    },
  }));
  assertEquals(r.status, 400);
  assertEquals(r.status === 400 && r.error, "validation_error");
  assertStringIncludes(r.status === 400 ? r.detail : "", "symlink");
  assertEquals(read, false, "a symlinked path must never be followed and read");
});

Deno.test("read-text: a real (non-symlink) .yaml still reads (M1 does not regress the happy path)", async () => {
  const r = await readTextDoc("C:\\ok.yaml", io({ lstat: () => Promise.resolve({ isSymlink: false }) }));
  assertEquals(r.status, 200);
});

Deno.test("read-text: a missing path fails lstat → 404 (M1)", async () => {
  const r = await readTextDoc("C:\\gone.yaml", io({ lstat: () => Promise.reject(new Error("ENOENT")) }));
  assertEquals(r.status, 404);
});

Deno.test("read-text: over 256 KB is refused before the file is read", async () => {
  let read = false;
  const r = await readTextDoc("C:\\big.yaml", io({
    stat: () => Promise.resolve({ isFile: true, size: READ_TEXT_MAX_BYTES + 1 }),
    readFile: () => {
      read = true;
      return Promise.resolve(new Uint8Array());
    },
  }));
  assertEquals(r.status, 413);
  assertEquals(r.status === 413 && r.error, "too_large");
  assertEquals(read, false, "an oversize file must never be read into memory");
});

Deno.test("read-text: a file that grows between stat and read is still refused (TOCTOU)", async () => {
  const r = await readTextDoc("C:\\grows.yaml", io({
    stat: () => Promise.resolve({ isFile: true, size: 10 }),
    readFile: () => Promise.resolve(new Uint8Array(READ_TEXT_MAX_BYTES + 1)),
  }));
  assertEquals(r.status, 413);
});

Deno.test("read-text: missing file is 404, a directory is 400", async () => {
  const missing = await readTextDoc("C:\\nope.yaml", io({ stat: () => Promise.reject(new Error("ENOENT")) }));
  assertEquals(missing.status, 404);
  assertEquals(missing.status === 404 && missing.error, "not_found");

  const dir = await readTextDoc("C:\\adir.yaml", io({ stat: () => Promise.resolve({ isFile: false, size: 0 }) }));
  assertEquals(dir.status, 400);
});

Deno.test("read-text: reads a real .yaml off disk and it imports (end to end, real IO)", async () => {
  const path = `${import.meta.dirname}\\fixtures\\sample-compose.yaml`;
  const r = await readTextDoc(path); // default Deno IO — no injected port
  assertEquals(r.status, 200);
  if (r.status !== 200) return;
  assertStringIncludes(r.text, "image: nginx:latest");
  const { stack, source } = parseConfigDoc(r.text, "sample-compose");
  assertEquals(source, "stack");
  assertEquals(stack.name, "fixture");
  assertEquals(stack.services.web.ports, ["8080:80"]);
});
