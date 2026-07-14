import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertRegistryHostAllowed,
  isLinkLocalHost,
  parseImageRef,
  parseWwwAuthenticate,
  readCappedJson,
  sortTagsDesc,
  TagFetchError,
} from "../server/registry_tags.ts";
import { ValidationError } from "../adapter/validate.ts";

Deno.test("parseImageRef: docker shortname rules", () => {
  assertEquals(parseImageRef("nginx"), { registry: "docker.io", repository: "library/nginx", tag: null });
  assertEquals(parseImageRef("nginx:1.27"), { registry: "docker.io", repository: "library/nginx", tag: "1.27" });
  assertEquals(parseImageRef("user/app"), { registry: "docker.io", repository: "user/app", tag: null });
  assertEquals(parseImageRef("docker.io/library/alpine:latest"), {
    registry: "docker.io",
    repository: "library/alpine",
    tag: "latest",
  });
  assertEquals(parseImageRef("ghcr.io/org/app:v2"), { registry: "ghcr.io", repository: "org/app", tag: "v2" });
  assertEquals(parseImageRef("localhost:5000/thing"), { registry: "localhost:5000", repository: "thing", tag: null });
  assertEquals(parseImageRef("ghcr.io/org/app@sha256:abc"), { registry: "ghcr.io", repository: "org/app", tag: null });
});

Deno.test("parseWwwAuthenticate: bearer challenge fields", () => {
  assertEquals(
    parseWwwAuthenticate('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x:pull"'),
    { realm: "https://ghcr.io/token", service: "ghcr.io" },
  );
  assertEquals(parseWwwAuthenticate('Basic realm="x"'), null);
  assertEquals(parseWwwAuthenticate(""), null);
});

Deno.test("sortTagsDesc: latest first, then version-aware descending", () => {
  assertEquals(
    sortTagsDesc(["1.9", "1.27.2", "latest", "alpine", "1.27", "2.0"]),
    ["latest", "2.0", "1.27.2", "1.27", "1.9", "alpine"],
  );
});

// --- M2 (D1): block ONLY link-local 169.254.0.0/16; ALLOW loopback + RFC1918 + public.
Deno.test("M2 SSRF: registry host allow/deny table (169.254 blocked; loopback/RFC1918/public allowed)", () => {
  const blocked = [
    "169.254.169.254", // cloud-metadata
    "169.254.169.254:80",
    "169.254.0.1",
    "169.254.255.255",
    "[169.254.169.254]:443",
  ];
  const allowed = [
    "127.0.0.1", // loopback
    "127.0.0.1:9200",
    "localhost:5000", // local registry (not an IP → allowed)
    "192.168.1.1:8443", // RFC1918
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "ghcr.io", // public
    "registry-1.docker.io",
    "169.253.0.1", // adjacent /16 — NOT link-local
    "169.255.0.1",
  ];
  for (const h of blocked) {
    assertEquals(isLinkLocalHost(h), true, `${h} should be link-local`);
    assertThrows(() => assertRegistryHostAllowed(h), ValidationError, undefined, h);
  }
  for (const h of allowed) {
    assertEquals(isLinkLocalHost(h), false, `${h} should be allowed`);
    assertRegistryHostAllowed(h); // must not throw
  }
});

// --- I6: registry answers are read with a hard 2 MB ceiling, never unbounded.
Deno.test("I6: readCappedJson parses a small body and refuses an oversize one", async () => {
  const ok = await readCappedJson(new Response(JSON.stringify({ tags: ["a", "b"] })));
  assertEquals((ok as { tags: string[] }).tags, ["a", "b"]);

  // > 2 MB body → bad_response, never buffered whole.
  const huge = "x".repeat(2 * 1024 * 1024 + 16);
  await assertRejects(
    () => readCappedJson(new Response(JSON.stringify({ blob: huge }))),
    TagFetchError,
    "2 MB",
  );

  // Invalid JSON → bad_response (not a thrown SyntaxError).
  await assertRejects(() => readCappedJson(new Response("<html>nope")), TagFetchError, "invalid JSON");
});
