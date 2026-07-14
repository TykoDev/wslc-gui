import { assertEquals } from "@std/assert";
import {
  BODY_MAX_BYTES,
  bodyLenExceeds,
  GATED_RUN_FLAGS,
  handleApi,
  type RouteCtx,
  ungatedRunFlags,
} from "../server/routes.ts";
import { EventHub } from "../server/sse.ts";
import type { AppConfig } from "../server/app_config.ts";

const CONFIG: AppConfig = { theme: "system", pollMs: 2500, showStoppedDefault: false };

function ctx(): RouteCtx {
  // No hub.start() → no timers/exec; the routes exercised here never poke the hub.
  return { hub: new EventHub(() => CONFIG), config: { current: CONFIG }, ownerHwnd: { value: null } };
}

// ---------------------------------------------------------------- M4: request-body cap

Deno.test("bodyLenExceeds: Content-Length over the 1 MB cap is rejected, at/under it is allowed", () => {
  assertEquals(BODY_MAX_BYTES, 1024 * 1024);
  assertEquals(bodyLenExceeds(String(BODY_MAX_BYTES + 1)), true);
  assertEquals(bodyLenExceeds(String(BODY_MAX_BYTES)), false);
  assertEquals(bodyLenExceeds("0"), false);
  assertEquals(bodyLenExceeds(null), false); // no header → cannot pre-judge; parse proceeds
  assertEquals(bodyLenExceeds("not-a-number"), false);
});

Deno.test("handleApi: an oversize body is refused with 413 BEFORE it is parsed (M4)", async () => {
  // A real >1 MB JSON body — Deno sets Content-Length from it. /api/stacks/compile calls
  // body() first, so this proves the cap fires before req.json() runs.
  const big = JSON.stringify({ yaml: "x".repeat(BODY_MAX_BYTES + 64) });
  const url = new URL("http://127.0.0.1/api/stacks/compile");
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(big.length) },
    body: big,
  });
  const res = await handleApi(req, url, ctx());
  assertEquals(res.status, 413);
  assertEquals((await res.json()).error, "payload_too_large");
});

// ---------------------------------------------------------------- I4: specialized run-flag gate

Deno.test("GATED_RUN_FLAGS: the five specialized flags map body keys → run-help flags", () => {
  assertEquals(GATED_RUN_FLAGS, {
    tmpfs: "--tmpfs",
    envFile: "--env-file",
    gpus: "--gpus",
    network: "--network",
    shmSize: "--shm-size",
  });
});

Deno.test("ungatedRunFlags: returns the present flags this wslc build does not advertise (I4)", () => {
  // wslc advertises --tmpfs but not --gpus → a request using both is missing --gpus.
  assertEquals(ungatedRunFlags(["tmpfs", "gpus"], ["--tmpfs", "-d", "-p"]), ["--gpus"]);
  // all advertised → nothing missing
  assertEquals(
    ungatedRunFlags(["tmpfs", "envFile", "gpus", "network", "shmSize"], [
      "--tmpfs",
      "--env-file",
      "--gpus",
      "--network",
      "--shm-size",
    ]),
    [],
  );
  // nothing specialized present → nothing to gate
  assertEquals(ungatedRunFlags([], []), []);
  // a non-gated key is ignored even if present
  assertEquals(ungatedRunFlags(["memory", "cpus"], []), []);
});
