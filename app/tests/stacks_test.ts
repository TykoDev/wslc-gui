import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { validateStack } from "../stacks/schema.ts";
import { compilePlan, containerNameFor, toComposeYaml } from "../stacks/compile.ts";
import { ValidationError } from "../adapter/validate.ts";

const GOOD = {
  name: "shop",
  services: {
    web: { image: "nginx:latest", ports: ["8080:80"] },
    api: { image: "ghcr.io/org/api:1.2", ports: ["3000:3000"], command: ["node", "server.js"] },
  },
};

Deno.test("validateStack: accepts supported subset, applies defaults", () => {
  const { stack, warnings } = validateStack(GOOD);
  assertEquals(warnings, []);
  assertEquals(stack.services.web.detach, true);
  assertEquals(stack.services.web.rm, false);
  assertEquals(stack.services.api.command, ["node", "server.js"]);
});

Deno.test("validateStack: rejects unsupported compose keys with explicit list", () => {
  const err = assertThrows(
    () =>
      validateStack({
        name: "s",
        services: { db: { image: "postgres:16", depends_on: ["web"], restart: "always" } },
      }),
    ValidationError,
  );
  assertStringIncludes(String(err.message), "depends_on");
  assertStringIncludes(String(err.message), "restart");
});

Deno.test("validateStack: env/volumes/limits accepted since wslc 2.9.3 (r6-d2)", () => {
  const { stack } = validateStack({
    name: "s",
    services: {
      db: {
        image: "postgres:16",
        environment: { POSTGRES_PASSWORD: "x", EMPTY: "" }, // compose map form
        volumes: ["C:\\data:/var/lib/postgresql/data"],
        memory: "512M",
        cpus: 1.5,
      },
      web: { image: "nginx", env: ["A=1"] }, // array form
    },
  });
  assertEquals(stack.services.db.env, ["POSTGRES_PASSWORD=x", "EMPTY="]);
  assertEquals(stack.services.db.volumes, ["C:\\data:/var/lib/postgresql/data"]);
  assertEquals(stack.services.db.memory, "512M");
  assertEquals(stack.services.db.cpus, "1.5");
  assertEquals(stack.services.web.env, ["A=1"]);
});

Deno.test("validateStack: env pairs and mounts are still validated", () => {
  assertThrows(
    () => validateStack({ name: "s", services: { w: { image: "nginx", env: ["NOEQUALS"] } } }),
    ValidationError,
  );
  assertThrows(
    () => validateStack({ name: "s", services: { w: { image: "nginx", volumes: ["nocolon"] } } }),
    ValidationError,
  );
  assertThrows(
    () => validateStack({ name: "s", services: { w: { image: "nginx", memory: "lots" } } }),
    ValidationError,
  );
});

Deno.test("compilePlan: env/volumes/limits flow into wslc run args", () => {
  const { stack } = validateStack({
    name: "s",
    services: {
      db: { image: "postgres:16", env: ["PGUSER=admin"], volumes: ["C:\\d:/data"], memory: "1G", cpus: "2" },
    },
  });
  const plan = compilePlan(stack);
  assertEquals(plan[0].args, [
    "run", "-d", "-v", "C:\\d:/data", "-e", "PGUSER=admin", "-m", "1G", "--cpus", "2",
    "--name", "s-db", "postgres:16",
  ]);
});

Deno.test("validateStack: rejects flag injection in image/service names", () => {
  assertThrows(() => validateStack({ name: "s", services: { web: { image: "--privileged" } } }), ValidationError);
  assertThrows(() => validateStack({ name: "s", services: { "-evil": { image: "nginx" } } }), ValidationError);
  assertThrows(() => validateStack({ name: "s", services: {} }), ValidationError);
});

Deno.test("compilePlan: ordered documented wslc run commands", () => {
  const { stack } = validateStack(GOOD);
  const plan = compilePlan(stack);
  assertEquals(plan.length, 2);
  assertEquals(plan[0].container, "shop-web");
  assertEquals(plan[0].args, ["run", "-d", "-p", "8080:80", "--name", "shop-web", "nginx:latest"]);
  assertEquals(plan[0].preview, "wslc run -d -p 8080:80 --name shop-web nginx:latest");
  assertEquals(plan[1].args, [
    "run", "-d", "-p", "3000:3000", "--name", "shop-api",
    "ghcr.io/org/api:1.2", "node", "server.js",
  ]);
});

Deno.test("toComposeYaml: exports deployable subset as valid compose", () => {
  const { stack } = validateStack(GOOD);
  const yaml = toComposeYaml(stack);
  assertStringIncludes(yaml, "image: 'nginx:latest'");
  assertStringIncludes(yaml, "container_name: shop-web");
  assertStringIncludes(yaml, "- '8080:80'");
  assertStringIncludes(yaml, "name: shop");
});

Deno.test("containerNameFor: stable stack-service prefix scheme", () => {
  assertEquals(containerNameFor("shop", "web"), "shop-web");
});

// ------------------------------------------------------------------ r9

Deno.test("validateStack: `entrypoint` is a supported key and reaches the run args", () => {
  const { stack, warnings } = validateStack({
    name: "s",
    services: { web: { image: "nginx", entrypoint: "/bin/sh", command: ["-c", "echo up"] } },
  });
  assertEquals(warnings, []);
  assertEquals(stack.services.web.entrypoint, "/bin/sh");
  assertEquals(compilePlan(stack)[0].args, [
    "run", "-d", "--entrypoint", "/bin/sh", "--name", "s-web", "nginx", "-c", "echo up",
  ]);
});

Deno.test("validateStack: an entrypoint that could become a flag is refused", () => {
  assertThrows(
    () => validateStack({ name: "s", services: { w: { image: "nginx", entrypoint: "--privileged" } } }),
    ValidationError,
  );
  assertThrows(
    () => validateStack({ name: "s", services: { w: { image: "nginx", entrypoint: "/bin/sh -c evil" } } }),
    ValidationError,
  );
});

Deno.test("validateStack: a named volume produces NO warning (r9 — r8's claim was false)", () => {
  // `run -v dbdata:/path` auto-creates the volume and it outlives the container (probe P2).
  const { stack, warnings } = validateStack({
    name: "s",
    services: { db: { image: "postgres:16", volumes: ["dbdata:/var/lib/postgresql/data"] } },
  });
  assertEquals(warnings, []);
  assertEquals(stack.services.db.volumes, ["dbdata:/var/lib/postgresql/data"]);
});

Deno.test("toComposeYaml: entrypoint is exported so the file round-trips", () => {
  const { stack } = validateStack({
    name: "s",
    services: { web: { image: "nginx", entrypoint: "/bin/sh" } },
  });
  assertStringIncludes(toComposeYaml(stack), "entrypoint: /bin/sh");
});
