import { assertEquals } from "@std/assert";
import { validateConfig } from "../server/app_config.ts";

Deno.test("validateConfig: valid config passes through", () => {
  assertEquals(
    validateConfig({ theme: "dark", pollMs: 5000, showStoppedDefault: true }),
    { theme: "dark", pollMs: 5000, showStoppedDefault: true },
  );
});

Deno.test("validateConfig: invalid fields fall back to defaults individually", () => {
  const v = validateConfig({ theme: "neon", pollMs: 50, showStoppedDefault: "yes" });
  assertEquals(v, { theme: "system", pollMs: 2500, showStoppedDefault: false });
});

Deno.test("validateConfig: pollMs bounds enforced (1s–60s)", () => {
  assertEquals(validateConfig({ pollMs: 999 })?.pollMs, 2500);
  assertEquals(validateConfig({ pollMs: 60001 })?.pollMs, 2500);
  assertEquals(validateConfig({ pollMs: 1000 })?.pollMs, 1000);
});

Deno.test("validateConfig: non-object input rejected", () => {
  assertEquals(validateConfig(null), null);
  assertEquals(validateConfig("string"), null);
  assertEquals(validateConfig(42), null);
});
