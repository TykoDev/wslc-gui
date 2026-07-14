import { assertEquals, assertStringIncludes } from "@std/assert";
import { carryOrphans } from "../stacks/runner.ts";
import type { StackRecord, StackServiceRecord } from "../server/app_config.ts";

const svc = (container: string, over: Partial<StackServiceRecord> = {}): StackServiceRecord => ({
  service: container.replace(/^.*-/, ""),
  container,
  image: "nginx:latest",
  ok: true,
  ...over,
});

const priorRecord = (containers: string[]): StackRecord => ({
  name: "shop",
  status: "deployed",
  deployedAt: "2026-07-13T00:00:00Z",
  services: containers.map((c) => svc(c)),
  yaml: "",
});

// BE MINOR-5 / D3: redeploy carries a vanished prior container into the record as an orphan
// (with a warning), and NEVER auto-stops it.

Deno.test("carryOrphans: a container dropped from the stack is carried over flagged orphaned + warned", () => {
  const deployed = [svc("shop-web"), svc("shop-cache")];
  const prior = priorRecord(["shop-web", "shop-db"]); // shop-db is gone from the new stack
  const { services, warnings } = carryOrphans(deployed, prior);

  // the freshly deployed ones stay non-orphaned…
  assertEquals(services.filter((s) => !s.orphaned).map((s) => s.container), ["shop-web", "shop-cache"]);
  // …and shop-db is carried over, flagged, not dropped
  const orphan = services.find((s) => s.orphaned);
  assertEquals(orphan?.container, "shop-db");
  assertEquals(orphan?.orphaned, true);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "shop-db");
  assertStringIncludes(warnings[0], "orphaned");
  assertStringIncludes(warnings[0], "NOT stopped"); // D3: never auto-stop
});

Deno.test("carryOrphans: no prior record → nothing added, no warnings", () => {
  const deployed = [svc("shop-web")];
  const { services, warnings } = carryOrphans(deployed, undefined);
  assertEquals(services, deployed);
  assertEquals(warnings, []);
});

Deno.test("carryOrphans: a stack that still defines everything produces no orphans", () => {
  const deployed = [svc("shop-web"), svc("shop-db")];
  const prior = priorRecord(["shop-web", "shop-db"]);
  const { services, warnings } = carryOrphans(deployed, prior);
  assertEquals(services.some((s) => s.orphaned), false);
  assertEquals(warnings, []);
});

Deno.test("carryOrphans: an already-orphaned prior container stays reachable (down/delete iterate the record)", () => {
  const deployed = [svc("shop-web")];
  const prior = priorRecord(["shop-web"]);
  prior.services.push(svc("shop-legacy", { orphaned: true })); // an orphan from an even earlier deploy
  const { services } = carryOrphans(deployed, prior);
  // it is still present in the new record so downStack/deleteStackRecord can reach it
  assertEquals(services.some((s) => s.container === "shop-legacy" && s.orphaned), true);
});
