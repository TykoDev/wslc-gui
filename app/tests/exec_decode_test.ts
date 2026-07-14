import { assertEquals } from "@std/assert";
import { decodeOutput } from "../adapter/exec.ts";

const enc = new TextEncoder();

Deno.test("decodeOutput: plain UTF-8 passthrough", () => {
  assertEquals(decodeOutput(enc.encode("NAME  STATE\nUbuntu  Running")), "NAME  STATE\nUbuntu  Running");
});

Deno.test("decodeOutput: UTF-16LE detected and decoded (wsl.exe without WSL_UTF8)", () => {
  const s = "WSL version: 2.9.3.0";
  const bytes = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    bytes[i * 2] = s.charCodeAt(i) & 0xff;
    bytes[i * 2 + 1] = s.charCodeAt(i) >> 8;
  }
  assertEquals(decodeOutput(bytes), s);
});

Deno.test("decodeOutput: UTF-16LE WITH a BOM is detected and decoded (INFO-6)", () => {
  // The old ASCII heuristic missed this: the BOM's 2nd byte is 0xFE, not 0x00.
  const s = "WSL version: 2.9.3.0";
  const bytes = new Uint8Array(2 + s.length * 2);
  bytes[0] = 0xff; // BOM: FF FE
  bytes[1] = 0xfe;
  for (let i = 0; i < s.length; i++) {
    bytes[2 + i * 2] = s.charCodeAt(i) & 0xff;
    bytes[2 + i * 2 + 1] = s.charCodeAt(i) >> 8;
  }
  assertEquals(decodeOutput(bytes), s); // BOM stripped, content intact
});

Deno.test("decodeOutput: interleaved NULs stripped (torn UTF-16 stream)", () => {
  // First byte lost → looks like UTF-8 with NUL between every char.
  const s = "A\u0000B\u0000C\u0000";
  assertEquals(decodeOutput(enc.encode(s)), "ABC");
});

Deno.test("decodeOutput: empty input", () => {
  assertEquals(decodeOutput(new Uint8Array(0)), "");
});
