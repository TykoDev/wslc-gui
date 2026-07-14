import { assertEquals } from "@std/assert";
import { makeInFlightGuard, MAX_SSE_CLIENTS, sseAtCapacity } from "../server/sse.ts";

// m7: a channel whose prior push is still running skips the next tick rather than stacking
// a second slow wslc probe behind the first.
Deno.test("makeInFlightGuard: a still-running channel skips the next tick, then runs again once free", async () => {
  const guard = makeInFlightGuard();
  let runs = 0;
  let release!: () => void;
  const first = new Promise<void>((r) => (release = r));

  guard("c", () => {
    runs++;
    return first;
  });
  guard("c", () => {
    runs++;
    return Promise.resolve();
  }); // skipped — "c" is still in flight
  assertEquals(runs, 1);

  // a DIFFERENT channel is independent and runs immediately
  guard("other", () => {
    runs++;
    return Promise.resolve();
  });
  assertEquals(runs, 2);

  release();
  await first;
  await Promise.resolve(); // let the .finally clear the in-flight set

  guard("c", () => {
    runs++;
    return Promise.resolve();
  }); // now free → runs
  assertEquals(runs, 3);
});

// I6: a hard ceiling on concurrent SSE clients.
Deno.test("sseAtCapacity: refuses at the ceiling, admits below it", () => {
  assertEquals(MAX_SSE_CLIENTS, 64);
  assertEquals(sseAtCapacity(MAX_SSE_CLIENTS - 1), false);
  assertEquals(sseAtCapacity(MAX_SSE_CLIENTS), true);
  assertEquals(sseAtCapacity(MAX_SSE_CLIENTS + 100), true);
  assertEquals(sseAtCapacity(0), false);
});
