import { assertEquals, assertMatch, assertStringIncludes, assertThrows } from "@std/assert";
import { dedupeEnvLastWins, parseConfigDoc, parseSizeBytes, shlexSplit, toDockerSize } from "../stacks/import.ts";
import { validateStack } from "../stacks/schema.ts";
import { compilePlan, toComposeYaml } from "../stacks/compile.ts";
import { ValidationError } from "../adapter/validate.ts";

/** Every warning is itemised, so a test asserts on the ONE line it cares about. */
function warning(warnings: string[], needle: string): string {
  const hit = warnings.find((w) => w.includes(needle));
  if (!hit) throw new Error(`no warning mentioning "${needle}" in:\n  ${warnings.join("\n  ")}`);
  return hit;
}

// ------------------------------------------------------------------ kubernetes

const POD = `
apiVersion: v1
kind: Pod
metadata:
  name: web-pod
spec:
  containers:
    - name: web
      image: nginx:1.27
      ports:
        - containerPort: 80
          hostPort: 8080
      env:
        - name: MODE
          value: production
      resources:
        limits:
          memory: 512Mi
          cpu: 500m
`;

Deno.test("import k8s: a Pod becomes one service with ports/env/limits", () => {
  const { stack, warnings, source } = parseConfigDoc(POD);
  assertEquals(source, "kubernetes");
  assertEquals(stack.name, "web-pod");
  assertEquals(Object.keys(stack.services), ["web-pod"]);
  const svc = stack.services["web-pod"];
  assertEquals(svc.image, "nginx:1.27");
  assertEquals(svc.ports, ["8080:80"]);
  assertEquals(svc.env, ["MODE=production"]);
  assertEquals(svc.memory, "512M"); // 512Mi is exactly 512 MiB — docker -m is binary
  assertEquals(svc.cpus, "0.5"); // 500m millicores
  assertEquals(warnings, []);
  assertEquals(
    compilePlan(stack)[0].preview,
    // service === stack, so the container name collapses to "web-pod" (not "web-pod-web-pod")
    "wslc run -d -p 8080:80 -e MODE=production -m 512M --cpus 0.5 --name web-pod nginx:1.27",
  );
});

const DEPLOYMENT = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  template:
    spec:
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: api-pvc
        - name: hostdir
          hostPath:
            path: /mnt/c/appdata
      containers:
        - name: api
          image: ghcr.io/org/api:1.2
          imagePullPolicy: Always
          ports:
            - containerPort: 3000
          livenessProbe:
            httpGet:
              path: /health
          volumeMounts:
            - name: data
              mountPath: /var/lib/data
            - name: hostdir
              mountPath: /host
---
apiVersion: v1
kind: Service
metadata:
  name: api-svc
spec:
  selector:
    app: api
  ports:
    - port: 80
`;

Deno.test("import k8s: Deployment pod template, replicas/PVC/probe/Service all warned, never guessed", () => {
  const { stack, warnings } = parseConfigDoc(DEPLOYMENT);
  assertEquals(Object.keys(stack.services), ["api"]);
  const svc = stack.services.api;
  assertEquals(svc.image, "ghcr.io/org/api:1.2");
  // hostPath is the only volume type with a -v equivalent; the PVC is dropped.
  assertEquals(svc.volumes, ["/mnt/c/appdata:/host"]);
  // containerPort with no hostPort publishes nothing — we do not invent a host port.
  assertEquals(svc.ports, []);

  assertStringIncludes(warning(warnings, "replicas"), "no scheduler");
  assertStringIncludes(warning(warnings, "volumeMounts.data"), "persistentVolumeClaim");
  assertStringIncludes(warning(warnings, "ports.3000"), "nothing is published");
  assertStringIncludes(warning(warnings, "livenessProbe"), "no wslc equivalent");
  assertStringIncludes(warning(warnings, "imagePullPolicy"), "no wslc equivalent");
  assertStringIncludes(warning(warnings, "Service/api-svc"), "not a workload");
});

const MULTIDOC = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  LOG_LEVEL: debug
  REGION: eu-north-1
---
apiVersion: v1
kind: Secret
metadata:
  name: db-creds
type: Opaque
data:
  DB_PASS: czNjcjN0
stringData:
  DB_USER: postgres
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  template:
    spec:
      containers:
        - name: db
          image: postgres:16
          envFrom:
            - configMapRef:
                name: app-config
          env:
            - name: DB_PASS
              valueFrom:
                secretKeyRef:
                  name: db-creds
                  key: DB_PASS
            - name: DB_USER
              valueFrom:
                secretKeyRef:
                  name: db-creds
                  key: DB_USER
            - name: API_KEY
              valueFrom:
                secretKeyRef:
                  name: external-vault
                  key: token
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
`;

Deno.test("import k8s: in-file ConfigMap and base64 Secret resolve; unresolvable refs are dropped, never guessed", () => {
  const { stack, warnings } = parseConfigDoc(MULTIDOC);
  const env = stack.services.db.env;
  // envFrom configMapRef → every key; secretKeyRef → base64 `data` decoded;
  // `stringData` is plain text.
  assertEquals(env, [
    "LOG_LEVEL=debug",
    "REGION=eu-north-1",
    "DB_PASS=s3cr3t",
    "DB_USER=postgres",
  ]);
  // The value that is NOT in the file is dropped with its path and its reason.
  assertStringIncludes(
    warning(warnings, "API_KEY"),
    "secretKeyRef 'external-vault' not in file",
  );
  assertStringIncludes(warning(warnings, "API_KEY"), "never guessed, never defaulted");
  assertStringIncludes(warning(warnings, "NODE_NAME"), "fieldRef");
  // …and no invented value leaked into the run args.
  const preview = compilePlan(stack)[0].preview;
  assertEquals(preview.includes("API_KEY"), false);
  assertEquals(preview.includes("NODE_NAME"), false);
});

Deno.test("import k8s: a pod with several containers yields one service each", () => {
  const { stack } = parseConfigDoc(`
apiVersion: v1
kind: Pod
metadata:
  name: pair
spec:
  containers:
    - name: web
      image: nginx
    - name: sidecar
      image: fluentd
`);
  assertEquals(Object.keys(stack.services).sort(), ["pair-sidecar", "pair-web"]);
});

Deno.test("import k8s: CronJob's nested pod template is found by the generic locator", () => {
  const { stack } = parseConfigDoc(`
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly
spec:
  schedule: "0 3 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: job
              image: alpine:3.20
              command: ["/bin/sh"]
              args: ["-c", "echo hi"]
`);
  assertEquals(stack.services.nightly.image, "alpine:3.20");
  // r9 CONTRACT CHANGE (was: command = ["/bin/sh", "-c", "echo hi"]).
  // r8 concatenated k8s `command` + `args` into positional args and warned that the image
  // ENTRYPOINT would still run first — which silently ran the WRONG process whenever the
  // image had an ENTRYPOINT. `--entrypoint` is now exposed, so `command[0]` becomes the
  // entrypoint (what k8s means) and the rest stays positional. Same argv, correct process.
  assertEquals(stack.services.nightly.entrypoint, "/bin/sh");
  assertEquals(stack.services.nightly.command, ["-c", "echo hi"]);
});

Deno.test("import k8s: a file with no workload is a hard reject, not a silent empty stack", () => {
  const err = assertThrows(
    () =>
      parseConfigDoc(`
apiVersion: v1
kind: Service
metadata:
  name: only-a-service
spec:
  ports:
    - port: 80
`),
    ValidationError,
  );
  assertStringIncludes(String(err.message), "no workload found");
});

Deno.test("import k8s: decimal memory units are converted honestly and the rounding is warned", () => {
  // k8s `512M` is 512e6 bytes (decimal), NOT 512 MiB — docker -m is binary.
  const { stack, warnings } = parseConfigDoc(`
apiVersion: v1
kind: Pod
metadata:
  name: p
spec:
  containers:
    - name: c
      image: nginx
      resources:
        limits:
          memory: 512M
`);
  assertEquals(stack.services.p.memory, "488M"); // 512e6 / 2^20 = 488.28 → 488 MiB
  assertStringIncludes(warning(warnings, "limits.memory"), "rounded to whole MiB");
});

// --------------------------------------------------------------------- compose

const COMPOSE = `
version: "3.9"
name: shop
services:
  web:
    image: nginx:latest
    container_name: shop-web
    restart: always
    depends_on:
      - api
    ports:
      - "8080:80"
      - "9000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost"]
    networks:
      - front
  api:
    image: ghcr.io/org/api:1.2
    command: node server.js --port 3000
    environment:
      DB_HOST: db
      FROM_SHELL:
    mem_limit: 1g
    cpus: 1.5
    labels:
      com.example: x
networks:
  front: {}
`;

Deno.test("import compose: version/restart/depends_on are warned, not fatal (E2)", () => {
  const { stack, warnings, source } = parseConfigDoc(COMPOSE);
  assertEquals(source, "compose");
  assertEquals(stack.name, "shop");
  assertEquals(Object.keys(stack.services), ["web", "api"]);
  assertEquals(stack.services.web.ports, ["8080:80"]);
  assertEquals(stack.services.api.command, ["node", "server.js", "--port", "3000"]);
  assertEquals(stack.services.api.env, ["DB_HOST=db"]);
  assertEquals(stack.services.api.memory, "1G");
  assertEquals(stack.services.api.cpus, "1.5");

  // Every dropped key is itemised with its own path — nothing is summarised away.
  assertStringIncludes(warning(warnings, "services.web.restart"), "no equivalent");
  assertStringIncludes(warning(warnings, "services.web.depends_on"), "no equivalent");
  assertStringIncludes(warning(warnings, "services.web.healthcheck"), "no equivalent");
  assertStringIncludes(warning(warnings, "services.web.networks"), "no equivalent");
  assertStringIncludes(warning(warnings, "services.api.labels"), "no equivalent");
  assertStringIncludes(warning(warnings, "version"), "obsolete");
  assertStringIncludes(warning(warnings, "9000"), "no host port");
  // A compose env key with no value would be inherited from the shell — we never invent it.
  assertStringIncludes(warning(warnings, "FROM_SHELL"), "never invent");
  // container_name already agrees with the derived name, so it is honoured silently.
  assertEquals(warnings.some((w) => w.includes("container_name")), false);
});

Deno.test("import compose: build: with no image: is the one hard reject", () => {
  const err = assertThrows(
    () =>
      parseConfigDoc(`
services:
  web:
    build: ./web
    ports:
      - "8080:80"
`),
    ValidationError,
  );
  assertStringIncludes(String(err.message), "build:");
  assertStringIncludes(String(err.message), "nothing to run");
});

Deno.test("import compose: build: WITH an image: only warns — it can still run", () => {
  const { stack, warnings } = parseConfigDoc(`
services:
  web:
    build: ./web
    image: myorg/web:dev
`);
  assertEquals(stack.services.web.image, "myorg/web:dev");
  assertStringIncludes(warning(warnings, "build"), "cannot build images");
});

Deno.test("import compose: a container_name we cannot honour is warned, not silently ignored", () => {
  const { stack, warnings } = parseConfigDoc(`
name: shop
services:
  web:
    image: nginx
    container_name: my-custom-name
`);
  assertEquals(compilePlan(stack)[0].container, "shop-web");
  assertStringIncludes(warning(warnings, "container_name"), 'runs as "shop-web"');
});

Deno.test("import compose: no name in the file falls back to the filename stem, then warns", () => {
  const named = parseConfigDoc(`services:\n  web:\n    image: nginx\n`, "docker-compose");
  assertEquals(named.stack.name, "docker-compose");

  const anon = parseConfigDoc(`services:\n  web:\n    image: nginx\n`);
  assertEquals(anon.stack.name, "stack");
  assertStringIncludes(warning(anon.warnings, "name"), "not in the file");
});

// ------------------------------------------------------- round-trip (E2 fix)

Deno.test("round-trip: toComposeYaml → parseConfigDoc re-imports the app's own export", () => {
  const { stack } = validateStack({
    name: "shop",
    services: {
      web: {
        image: "nginx:latest",
        ports: ["8080:80"],
        env: ["MODE=prod"],
        volumes: ["C:\\data:/data"],
        memory: "512M",
        cpus: "1.5",
      },
    },
  });
  const exported = toComposeYaml(stack);
  // The export carries container_name + mem_limit, which validateStack hard-rejects…
  assertThrows(() => validateStack(JSON.parse(JSON.stringify({ name: "shop", services: { web: { container_name: "x", image: "nginx" } } }))), ValidationError);
  // …and the importer is exactly the lenient front end that fixes it.
  const back = parseConfigDoc(exported);
  assertEquals(back.source, "compose");
  assertEquals(back.stack, stack); // byte-for-byte the same Stack we exported
  assertEquals(back.warnings, []); // a clean round-trip warns about nothing
});

// ------------------------------------------------------------------- helpers

Deno.test("parseSizeBytes: the same token means different things in k8s and docker", () => {
  assertEquals(parseSizeBytes("512Mi", "k8s"), 512 * 1024 ** 2); // binary in both
  assertEquals(parseSizeBytes("512Mi", "docker"), 512 * 1024 ** 2);
  assertEquals(parseSizeBytes("512M", "k8s"), 512e6); // k8s: decimal MEGA (uppercase M)
  assertEquals(parseSizeBytes("512M", "docker"), 512 * 1024 ** 2); // docker: binary
  assertEquals(parseSizeBytes(67108864, "docker"), 67108864); // compose bytes int
  assertEquals(parseSizeBytes("50%", "docker"), null);
  assertEquals(parseSizeBytes("lots", "docker"), null);
});

Deno.test("parseSizeBytes: k8s lowercase `m` is MILLI (unusable memory) → null (BE MINOR-3)", () => {
  // The bug folded `100m` to 100 MB (100e6). It is 100 milli-bytes — return null.
  assertEquals(parseSizeBytes("100m", "k8s"), null);
  assertEquals(parseSizeBytes("500m", "k8s"), null);
  // Uppercase M is still decimal mega, and Mi is still binary — case is load-bearing.
  assertEquals(parseSizeBytes("100M", "k8s"), 100e6);
  assertEquals(parseSizeBytes("100Mi", "k8s"), 100 * 1024 ** 2);
  // docker `m`/`M` are both binary mega (unchanged) — the milli rule is k8s-only.
  assertEquals(parseSizeBytes("100m", "docker"), 100 * 1024 ** 2);
});

Deno.test("import k8s: a milli-byte memory limit is dropped with a warning, not folded to mega (BE MINOR-3)", () => {
  const { stack, warnings } = parseConfigDoc(`
apiVersion: v1
kind: Pod
metadata:
  name: p
spec:
  containers:
    - name: c
      image: nginx
      resources:
        limits:
          memory: 100m
`);
  assertEquals(stack.services.p.memory, undefined); // NOT "100M"
  assertStringIncludes(warning(warnings, "limits.memory"), "dropped");
});

Deno.test("dedupeEnvLastWins: one entry per key, last value wins (INFO-8)", () => {
  assertEquals(
    dedupeEnvLastWins(["A=1", "B=2", "A=3"]),
    ["A=3", "B=2"], // A collapses to its last value, first-seen order kept
  );
  assertEquals(dedupeEnvLastWins(["X=1"]), ["X=1"]);
  assertEquals(dedupeEnvLastWins([]), []);
});

Deno.test("import k8s: a key in both envFrom and env emits ONE -e, env wins (INFO-8)", () => {
  const { stack } = parseConfigDoc(`
apiVersion: v1
kind: ConfigMap
metadata:
  name: cfg
data:
  SHARED: from-configmap
  ONLY_CM: cm-value
---
apiVersion: v1
kind: Pod
metadata:
  name: app
spec:
  containers:
    - name: app
      image: nginx
      envFrom:
        - configMapRef:
            name: cfg
      env:
        - name: SHARED
          value: from-env
`);
  const env = stack.services.app.env;
  // exactly one SHARED entry, and it is the env value (last-wins), not the configMap one
  assertEquals(env.filter((e) => e.startsWith("SHARED=")), ["SHARED=from-env"]);
  assertEquals(env.includes("ONLY_CM=cm-value"), true);
});

Deno.test("round-trip: memory 1.5G → toComposeYaml → parseConfigDoc yields 1536M, value-preserving (INFO-7)", () => {
  const { stack } = validateStack({ name: "shop", services: { web: { image: "nginx:latest", memory: "1.5G" } } });
  const back = parseConfigDoc(toComposeYaml(stack));
  assertEquals(back.source, "compose");
  assertEquals(back.stack.services.web.memory, "1536M"); // 1.5 GiB normalized to whole MiB
  assertEquals(back.warnings, []); // exact — nothing rounded, nothing to warn about
  // 1.5G and 1536M are the SAME byte count — the normalization loses nothing.
  assertEquals(parseSizeBytes("1.5G", "docker"), parseSizeBytes("1536M", "docker"));
});

Deno.test("toDockerSize: exact where it can be, rounded and flagged where it cannot", () => {
  assertEquals(toDockerSize(1024 ** 3), { value: "1G", exact: true });
  assertEquals(toDockerSize(512 * 1024 ** 2), { value: "512M", exact: true });
  assertEquals(toDockerSize(512e6), { value: "488M", exact: false });
});

Deno.test("shlexSplit: compose's exec-form string command, quotes preserved", () => {
  assertEquals(shlexSplit(`sh -c "echo a && echo b"`), ["sh", "-c", "echo a && echo b"]);
  assertEquals(shlexSplit(`npm start`), ["npm", "start"]);
  assertEquals(shlexSplit(`sh -c "unbalanced`), null);
});

Deno.test("import: an unrecognised document is refused with an actionable message", () => {
  const err = assertThrows(() => parseConfigDoc("hello: world\n"), ValidationError);
  assertMatch(String(err.message), /unrecognised file/);
  assertThrows(() => parseConfigDoc("   "), ValidationError);
});

Deno.test("import compose: a named volume mounts with NO warning (r9 — r8's warning was false)", () => {
  const { stack, warnings } = parseConfigDoc(`
name: shop
services:
  db:
    image: postgres:16
    volumes:
      - dbdata:/var/lib/postgresql/data
      - C:\\host\\conf:/etc/conf
`);
  // Both mounts survive verbatim.
  assertEquals(stack.services.db.volumes, ["dbdata:/var/lib/postgresql/data", "C:\\host\\conf:/etc/conf"]);

  // r8 warned that "wslc documents no volume-create verb". That was FALSE: wslc 2.9.3.0
  // ships create/remove/inspect/list/prune, and `run -v dbdata:/path` auto-creates the
  // volume, which then outlives the container (probe P2, re-verified live 2026-07-13).
  // The warning is deleted, not softened — a working feature is never called unsupported.
  assertEquals(warnings, []);
  assertEquals(warnings.some((w) => w.includes("volume-create verb")), false);
  assertEquals(warnings.some((w) => w.includes("names a volume, not a host path")), false);

  // …and the named volume still reaches wslc exactly as written.
  assertEquals(
    compilePlan(stack)[0].preview,
    "wslc run -d -v dbdata:/var/lib/postgresql/data -v C:\\host\\conf:/etc/conf --name shop-db postgres:16",
  );
});

// ------------------------------------------------------------- entrypoint (r9 D1)

Deno.test("import k8s: `command:` becomes --entrypoint + args, with NO warning (r9)", () => {
  // k8s `command:` overrides the image ENTRYPOINT; `args:` replaces the CMD. wslc's
  // --entrypoint is docker-shaped, so the mapping is exact: command[0] is the entrypoint
  // and everything after it — command[1:] then args — is the positional command.
  const { stack, warnings } = parseConfigDoc(`
apiVersion: v1
kind: Pod
metadata:
  name: job
spec:
  containers:
    - name: job
      image: alpine:3.20
      command: ["/bin/sh", "-c"]
      args: ["echo hi"]
`);
  const svc = stack.services.job;
  assertEquals(svc.entrypoint, "/bin/sh");
  assertEquals(svc.command, ["-c", "echo hi"]);
  // r8 warned "an image ENTRYPOINT still runs first". It no longer applies — and a
  // correct mapping must not apologise for itself.
  assertEquals(warnings, []);
  assertEquals(warnings.some((w) => w.includes("ENTRYPOINT still runs first")), false);
  assertEquals(
    compilePlan(stack)[0].preview,
    `wslc run -d --entrypoint /bin/sh --name job alpine:3.20 -c "echo hi"`,
  );
});

Deno.test("import k8s: `args:` ALONE leaves the image ENTRYPOINT intact (no --entrypoint)", () => {
  const { stack, warnings } = parseConfigDoc(`
apiVersion: v1
kind: Pod
metadata:
  name: db
spec:
  containers:
    - name: db
      image: postgres:16
      args: ["-c", "max_connections=200"]
`);
  // args alone = "replace the CMD, keep the ENTRYPOINT" → positional command, no flag.
  assertEquals(stack.services.db.entrypoint, undefined);
  assertEquals(stack.services.db.command, ["-c", "max_connections=200"]);
  assertEquals(warnings, []);
  const preview = compilePlan(stack)[0].preview;
  assertEquals(preview.includes("--entrypoint"), false);
});

Deno.test("import compose: `entrypoint:` is honoured in both string and list form (r9)", () => {
  // string form → shlex, exactly like `command:`
  const s = parseConfigDoc(`
name: shop
services:
  web:
    image: nginx:latest
    entrypoint: /bin/sh
    command: -c "echo up"
`);
  assertEquals(s.stack.services.web.entrypoint, "/bin/sh");
  assertEquals(s.stack.services.web.command, ["-c", "echo up"]);
  assertEquals(s.warnings, []);

  // list form → tokens. compose runs entrypoint + command, and wslc runs
  // `--entrypoint <exe>` + positional args: the same argv, so nothing is lost or warned.
  const l = parseConfigDoc(`
name: shop
services:
  web:
    image: nginx:latest
    entrypoint: ["/bin/sh", "-c"]
    command: ["echo up"]
`);
  assertEquals(l.stack.services.web.entrypoint, "/bin/sh");
  assertEquals(l.stack.services.web.command, ["-c", "echo up"]);
  assertEquals(l.warnings, []);

  // …and it is no longer swept into the "no wslc equivalent" bucket.
  assertEquals(l.warnings.some((w) => w.includes("entrypoint")), false);
});

Deno.test("import compose: an EMPTY entrypoint cannot be expressed and says so", () => {
  // compose `entrypoint: ""` means "clear the image ENTRYPOINT". wslc's --entrypoint
  // needs an executable to point at, so we warn rather than pretend or invent one.
  // (No top-level `name:` ⇒ this is not a valid strict stack ⇒ it takes the lenient
  // compose front end, which is the only place where compose's semantics apply.)
  const { stack, warnings } = parseConfigDoc(
    `
services:
  web:
    image: nginx:latest
    entrypoint: ""
`,
    "shop",
  );
  assertEquals(stack.services.web.entrypoint, undefined);
  assertStringIncludes(warning(warnings, "entrypoint"), "still runs");
});

Deno.test("stack schema: an empty entrypoint field from the BUILDER is just unset, not a warning", () => {
  // The same "" through our own strict schema (the Stack builder posts an empty input)
  // means "no entrypoint", which is ordinary — the compose-semantics warning above is
  // specific to compose files and must not fire here.
  const { stack, warnings } = parseConfigDoc(`
name: shop
services:
  web:
    image: nginx:latest
    entrypoint: ""
`);
  assertEquals(stack.services.web.entrypoint, undefined);
  assertEquals(warnings, []);
});

Deno.test("import: a hostile entrypoint from imported YAML is refused at the boundary (r9)", () => {
  // --entrypoint is a process-argument sink: a compose file is untrusted input.
  const err = assertThrows(
    () =>
      parseConfigDoc(`
name: evil
services:
  web:
    image: nginx
    entrypoint: ["--privileged"]
`),
    ValidationError,
  );
  assertStringIncludes(String(err.message), "entrypoint");
});

Deno.test("round-trip: entrypoint survives toComposeYaml → parseConfigDoc (r9)", () => {
  const { stack } = validateStack({
    name: "shop",
    services: { web: { image: "nginx:latest", entrypoint: "/bin/sh", command: ["-c", "echo up"] } },
  });
  const back = parseConfigDoc(toComposeYaml(stack));
  assertEquals(back.stack, stack);
  assertEquals(back.warnings, []);
});

Deno.test("stack containers stay <stack>-<service> when the names differ", () => {
  const { stack } = parseConfigDoc(`
name: shop
services:
  web:
    image: nginx:latest
`);
  assertEquals(compilePlan(stack)[0].container, "shop-web");
});

Deno.test("import compose: two names that collapse to one key keep the FIRST + warn (r9 MAJOR-1)", () => {
  const { stack, warnings, source } = parseConfigDoc(`
name: shop
services:
  Api:
    image: nginx:1.27
    restart: always
  api:
    image: redis:7
    restart: always
`);
  assertEquals(source, "compose");
  assertEquals(Object.keys(stack.services), ["api"]);
  // the FIRST service must survive — not be silently overwritten by the second
  assertEquals(stack.services.api.image, "nginx:1.27");
  assertStringIncludes(warning(warnings, "same name"), "only the first is kept");
});

Deno.test("import compose: a port range is dropped with a warning, not a 400 for the whole file (r9 MAJOR-2)", () => {
  const { stack, warnings } = parseConfigDoc(`
name: web
services:
  app:
    image: nginx:latest
    ports:
      - "8080:80"
      - "3000-3005:3000-3005"
`);
  // the valid port survives; the range is dropped, and the import does NOT throw
  assertEquals(stack.services.app.ports, ["8080:80"]);
  assertStringIncludes(warning(warnings, "3000-3005"), "dropped");
});

Deno.test("import compose: a multi-line env value is dropped, not a 400 for the whole file (r9 MAJOR-2)", () => {
  const { stack, warnings } = parseConfigDoc(`
name: web
services:
  app:
    image: nginx:latest
    environment:
      GOOD: value
      MOTD: |
        line1
        line2
`);
  // the good var survives; the control-char value is dropped, matching the k8s path
  assertEquals(stack.services.app.env, ["GOOD=value"]);
  assertStringIncludes(warning(warnings, "MOTD"), "dropped");
});
