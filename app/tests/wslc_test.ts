import { assertEquals, assertThrows } from "@std/assert";
import { buildRunArgs, removeVolume, volumeRemoveVerb } from "../adapter/wslc.ts";
import { ValidationError } from "../adapter/validate.ts";

Deno.test("buildRunArgs: defaults to detached", () => {
  assertEquals(buildRunArgs({ image: "nginx" }), ["run", "-d", "nginx"]);
});

Deno.test("buildRunArgs: full documented flag set, doc-example order", () => {
  // Mirrors doc example: wslc run -d --rm -p 8080:80 --name web nginx
  assertEquals(
    buildRunArgs({ image: "nginx", name: "web", ports: ["8080:80"], detach: true, rm: true }),
    ["run", "-d", "--rm", "-p", "8080:80", "--name", "web", "nginx"],
  );
});

Deno.test("buildRunArgs: foreground interactive with command", () => {
  assertEquals(
    buildRunArgs({
      image: "ubuntu:latest",
      detach: false,
      rm: true,
      interactive: true,
      command: ["bash", "-c", "echo Hello world from WSL container!"],
    }),
    ["run", "--rm", "-it", "ubuntu:latest", "bash", "-c", "echo Hello world from WSL container!"],
  );
});

Deno.test("buildRunArgs: flag injection via image/name/command rejected", () => {
  assertThrows(() => buildRunArgs({ image: "--privileged" }), ValidationError);
  assertThrows(() => buildRunArgs({ image: "nginx", name: "--volume" }), ValidationError);
  assertThrows(() => buildRunArgs({ image: "nginx", ports: ["8080:80", "evil"] }), ValidationError);
});

Deno.test("buildRunArgs: --shm-size sits after --cpus and moves no existing flag (r8 D2)", () => {
  assertEquals(
    buildRunArgs({ image: "postgres:16", name: "db", memory: "1G", cpus: "2", shmSize: "512M" }),
    ["run", "-d", "-m", "1G", "--cpus", "2", "--shm-size", "512M", "--name", "db", "postgres:16"],
  );
  // absent → the arg list is byte-for-byte what it was before r8
  assertEquals(buildRunArgs({ image: "nginx" }), ["run", "-d", "nginx"]);
  // docker-style grammar (decimals legal), and no flag injection
  assertEquals(buildRunArgs({ image: "nginx", shmSize: "1.5G" }), ["run", "-d", "--shm-size", "1.5G", "nginx"]);
  assertThrows(() => buildRunArgs({ image: "nginx", shmSize: "--privileged" }), ValidationError);
  assertThrows(() => buildRunArgs({ image: "nginx", shmSize: "lots" }), ValidationError);
});

Deno.test("buildRunArgs: multiple port pairs preserved in order", () => {
  assertEquals(
    buildRunArgs({ image: "app", ports: ["8080:80", "8443:443"], detach: true }),
    ["run", "-d", "-p", "8080:80", "-p", "8443:443", "app"],
  );
});

Deno.test("buildRunArgs: full r6 surface in stable flag order (live 2.9.3.0 flags)", () => {
  assertEquals(
    buildRunArgs({
      image: "postgres:16",
      name: "db",
      ports: ["5432:5432"],
      volumes: ["C:\\pg:/var/lib/postgresql/data"],
      tmpfs: "/tmp",
      env: ["PGUSER=admin", "EMPTY="],
      envFile: "C:\\app\\.env",
      memory: "1G",
      cpus: "1.5",
      gpus: "all",
      workdir: "/work",
      user: "999:999",
      network: "backend",
      hostname: "db01",
    }),
    [
      "run", "-d",
      "-p", "5432:5432",
      "-v", "C:\\pg:/var/lib/postgresql/data",
      "--tmpfs", "/tmp",
      "-e", "PGUSER=admin",
      "-e", "EMPTY=",
      "--env-file", "C:\\app\\.env",
      "-m", "1G",
      "--cpus", "1.5",
      "--gpus", "all",
      "-w", "/work",
      "-u", "999:999",
      "--network", "backend",
      "-h", "db01",
      "--name", "db",
      "postgres:16",
    ],
  );
});

Deno.test("buildRunArgs: r6 flag injection rejected across new fields", () => {
  assertThrows(() => buildRunArgs({ image: "nginx", volumes: ["--privileged"] }), ValidationError);
  assertThrows(() => buildRunArgs({ image: "nginx", env: ["--env-file=/etc/passwd"] }), ValidationError);
  assertThrows(() => buildRunArgs({ image: "nginx", memory: "--oom" }), ValidationError);
  assertThrows(() => buildRunArgs({ image: "nginx", workdir: "relative" }), ValidationError);
  assertThrows(() => buildRunArgs({ image: "nginx", network: "-evil" }), ValidationError);
});

// ------------------------------------------------------------------ r9: --entrypoint

Deno.test("buildRunArgs: --entrypoint sits immediately before --name (pinned r9 flag order)", () => {
  // The build brief pins this position so the client's previewRun() mirrors it exactly.
  assertEquals(
    buildRunArgs({ image: "nginx:latest", name: "web", entrypoint: "/bin/sh", hostname: "web01" }),
    ["run", "-d", "-h", "web01", "--entrypoint", "/bin/sh", "--name", "web", "nginx:latest"],
  );
  // …and with no --name it still lands after every other flag, right before the image.
  assertEquals(
    buildRunArgs({ image: "nginx:latest", entrypoint: "/bin/echo", rm: true, detach: false }),
    ["run", "--rm", "--entrypoint", "/bin/echo", "nginx:latest"],
  );
  // absent → byte-for-byte the pre-r9 arg list (no existing flag moved)
  assertEquals(buildRunArgs({ image: "nginx" }), ["run", "-d", "nginx"]);
});

Deno.test("buildRunArgs: entrypoint ARGS stay positional — the exact live-proven shape", () => {
  // Live: `wslc run --rm --entrypoint /bin/sh nginx:latest -c 'echo works'` → works
  assertEquals(
    buildRunArgs({
      image: "nginx:latest",
      detach: false,
      rm: true,
      entrypoint: "/bin/sh",
      command: ["-c", "echo works"],
    }),
    ["run", "--rm", "--entrypoint", "/bin/sh", "nginx:latest", "-c", "echo works"],
  );
});

Deno.test("buildRunArgs: --entrypoint is a hostile-YAML sink — flags and shell lines rejected", () => {
  assertThrows(() => buildRunArgs({ image: "nginx", entrypoint: "--privileged" }), ValidationError);
  assertThrows(() => buildRunArgs({ image: "nginx", entrypoint: "/bin/sh -c evil" }), ValidationError);
  assertThrows(() => buildRunArgs({ image: "nginx", entrypoint: "/bin/sh\nevil" }), ValidationError);
});

Deno.test("volumeRemoveVerb: emits only a verb this wslc build advertises", () => {
  assertEquals(volumeRemoveVerb(["create", "inspect", "list", "prune", "remove"]), "remove");
  assertEquals(volumeRemoveVerb(["rm"]), "rm");
  assertEquals(volumeRemoveVerb(["delete"]), "delete");
  // No remove verb ⇒ null ⇒ the route answers 409 and no command is ever emitted.
  assertEquals(volumeRemoveVerb(["create", "list"]), null);
  assertEquals(volumeRemoveVerb([]), null);
});

Deno.test("removeVolume: a verb the capability layer did not detect never reaches exec", () => {
  // Second layer under the route's 409: the adapter refuses an unproven verb outright,
  // and it throws BEFORE spawning anything (this test runs without --allow-run).
  assertThrows(() => removeVolume("dbdata", "obliterate"), ValidationError);
  assertThrows(() => removeVolume("dbdata", "--all"), ValidationError);
  assertThrows(() => removeVolume("dbdata", ""), ValidationError);
  // A detected verb passes the guard, but a hostile NAME is still refused at the sink.
  assertThrows(() => removeVolume("--all", "remove"), ValidationError);
});
