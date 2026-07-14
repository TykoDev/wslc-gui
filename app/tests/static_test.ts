import { assertEquals, assertStringIncludes } from "@std/assert";
import { serveStatic, type StaticStore } from "../server/static.ts";

function store(withIndex = true): StaticStore {
  const files = new Map<string, { bytes: Uint8Array; type: string }>();
  const enc = new TextEncoder();
  if (withIndex) files.set("/index.html", { bytes: enc.encode("<html>app</html>"), type: "text/html; charset=utf-8" });
  files.set("/assets/app.js", { bytes: enc.encode("js"), type: "text/javascript; charset=utf-8" });
  files.set("/logo.ico", { bytes: enc.encode("ico"), type: "image/x-icon" });
  return { files, hasIndex: withIndex };
}

Deno.test("serveStatic: exact asset hit with immutable caching", async () => {
  const res = serveStatic(store(), "/assets/app.js");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("cache-control")?.includes("immutable"), true);
  assertEquals(await res.text(), "js");
});

Deno.test("serveStatic: root and SPA-router fallback serve index (no-cache)", async () => {
  for (const path of ["/", "/containers", "/settings"]) {
    const res = serveStatic(store(), path);
    assertEquals(res.status, 200, path);
    assertEquals(res.headers.get("cache-control"), "no-cache", path);
    assertEquals(await res.text(), "<html>app</html>", path);
  }
});

Deno.test("serveStatic: traversal shapes rejected", () => {
  // Raw ../ and %2e%2e are dot-normalized away by the URL parser BEFORE this
  // layer (proven live); what survives must still die here:
  assertEquals(serveStatic(store(), "/..%5Csecret").status, 404); // decodes to backslash
  assertEquals(serveStatic(store(), "/a..b/x.js").status, 404); // contains ".."
  assertEquals(serveStatic(store(), "/%zz").status, 400); // malformed encoding
});

Deno.test("serveStatic: unknown asset with extension → 404, not index", () => {
  assertEquals(serveStatic(store(), "/assets/missing.js").status, 404);
});

Deno.test("serveStatic: missing bundle → built-in fallback page", async () => {
  const res = serveStatic(store(false), "/");
  assertEquals(res.status, 200);
  assertStringIncludes(await res.text(), "Frontend bundle not found");
});

Deno.test("serveStatic: nosniff header present on assets", () => {
  assertEquals(serveStatic(store(), "/logo.ico").headers.get("x-content-type-options"), "nosniff");
});

Deno.test("serveStatic: SPA HTML carries CSP + nosniff (I2)", () => {
  // index (exact), SPA-router fallback, and the built-in fallback page all get the headers.
  for (const [s, path] of [
    [store(), "/"],
    [store(), "/index.html"],
    [store(), "/containers"], // history-router fallback → index
    [store(false), "/"], // missing-bundle fallback page
  ] as const) {
    const res = serveStatic(s, path);
    const csp = res.headers.get("content-security-policy") ?? "";
    assertStringIncludes(csp, "default-src 'self'", path);
    assertStringIncludes(csp, "connect-src 'self'", path); // the token-exfil channel is locked to self
    assertStringIncludes(csp, "object-src 'none'", path);
    assertEquals(res.headers.get("x-content-type-options"), "nosniff", path);
  }
});
