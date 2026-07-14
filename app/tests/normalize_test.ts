import { assertEquals } from "@std/assert";
import { parseTable } from "../adapter/parsers.ts";
import { containerRef, normalizeContainers, normalizeImages } from "../server/normalize.ts";
import {
  WSLC_CONTAINER_LIST_EMPTY,
  WSLC_CONTAINER_LIST_RUNNING,
  WSLC_IMAGE_LIST,
} from "./fixtures/wslc_real_output.ts";

Deno.test("normalizeContainers: real wslc 2.9.3 list format", () => {
  const n = normalizeContainers(parseTable(WSLC_CONTAINER_LIST_RUNNING));
  assertEquals(n.containers.length, 1);
  const c = n.containers[0];
  assertEquals(c.id, "2cd4a4f3024d");
  assertEquals(c.name, "web");
  assertEquals(c.image, "nginx");
  assertEquals(c.status, "running 3 seconds ago");
  assertEquals(c.ports, "127.0.0.1:8080->80/tcp");
  assertEquals(containerRef(c), "web");
});

Deno.test("normalizeContainers: header-only output → empty list, headers kept", () => {
  const n = normalizeContainers(parseTable(WSLC_CONTAINER_LIST_EMPTY));
  assertEquals(n.containers, []);
  assertEquals(n.headers, ["CONTAINER ID", "NAME", "IMAGE", "CREATED", "STATUS", "PORTS"]);
});

Deno.test("normalizeImages: real wslc 2.9.3 image list format", () => {
  const n = normalizeImages(parseTable(WSLC_IMAGE_LIST));
  assertEquals(n.images.length, 2);
  assertEquals(n.images[0].repository, "hello-world");
  assertEquals(n.images[0].tag, "latest");
  assertEquals(n.images[0].id, "e2ac70e7319a");
  assertEquals(n.images[0].size, "0.01 MB");
  assertEquals(n.images[1].repository, "nginx");
});

Deno.test("normalizeContainers: unknown layout degrades to raw, ref null-safe", () => {
  const n = normalizeContainers(parseTable("something wholly unexpected\nno headers here"));
  assertEquals(n.containers, []);
  assertEquals(n.raw.length, 2);
});
