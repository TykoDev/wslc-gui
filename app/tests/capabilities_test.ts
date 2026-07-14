import { assertEquals } from "@std/assert";
import { buildWslcCapabilities } from "../adapter/capabilities.ts";
import { volumeRemoveVerb } from "../adapter/wslc.ts";
import {
  WSLC_CONTAINER_HELP,
  WSLC_IMAGE_HELP,
  WSLC_RUN_HELP,
  WSLC_TOP_HELP,
  WSLC_VERSION_LINE,
  WSLC_VOLUME_HELP,
} from "./fixtures/wslc_real_output.ts";

const REAL = {
  versionLine: WSLC_VERSION_LINE,
  topHelp: WSLC_TOP_HELP,
  containerHelp: WSLC_CONTAINER_HELP,
  imageHelp: WSLC_IMAGE_HELP,
  runHelp: WSLC_RUN_HELP,
  volumeHelp: WSLC_VOLUME_HELP,
};

Deno.test("capabilities: real wslc 2.9.3 help lights ALL flags", () => {
  const c = buildWslcCapabilities(REAL);
  assertEquals(c.present, true);
  assertEquals(c.version, "2.9.3.0"); // "wslc " prefix stripped for the UI pill
  for (const [k, v] of Object.entries(c.can)) {
    assertEquals(v, true, `capability ${k} should be true on real 2.9.3 help`);
  }
});

Deno.test("capabilities: real verb extraction (spot checks incl. new surface)", () => {
  const c = buildWslcCapabilities(REAL);
  for (const v of ["container", "image", "network", "volume", "registry", "login", "pull", "rmi", "start"]) {
    assertEquals(c.topVerbs.includes(v), true, `top verb ${v}`);
  }
  for (const v of ["start", "remove", "prune", "kill", "create"]) {
    assertEquals(c.containerVerbs.includes(v), true, `container verb ${v}`);
  }
  for (const v of ["pull", "push", "tag", "remove", "save", "load"]) {
    assertEquals(c.imageVerbs.includes(v), true, `image verb ${v}`);
  }
  assertEquals(c.topVerbs.includes("compose"), false, "compose must remain absent (D1)");
});

Deno.test("capabilities: documented run flags detected (incl. env/volume unlock)", () => {
  const c = buildWslcCapabilities(REAL);
  for (const f of ["-d", "--detach", "--rm", "-p", "--publish", "--name", "-e", "--env", "-v", "--volume", "-w", "--gpus"]) {
    assertEquals(c.runFlags.includes(f), true, `run flag ${f}`);
  }
});

Deno.test("capabilities: real wslc 2.9.3 volume verbs + --entrypoint detected (r9)", () => {
  const c = buildWslcCapabilities(REAL);
  assertEquals(c.volumeVerbs, ["create", "inspect", "list", "prune", "remove"]);
  assertEquals(c.can.volumes, true);
  assertEquals(c.can.volumeCreate, true);
  assertEquals(c.can.volumeRemove, true);
  assertEquals(c.can.volumePrune, true);
  assertEquals(c.can.volumeInspect, true);
  // `--entrypoint  Specifies the container init process executable` (live run --help).
  assertEquals(c.can.entrypoint, true);
  assertEquals(c.runFlags.includes("--entrypoint"), true);
  // wslc spells remove "remove" (aliases delete/rm) — the route emits the detected one.
  assertEquals(volumeRemoveVerb(c.volumeVerbs), "remove");
});

Deno.test("capabilities: sparse/older help gates API-implied verbs OFF", () => {
  // Simulates the doc-era CLI: only documented verbs in help.
  const c = buildWslcCapabilities({
    versionLine: "wslc 0.1.0",
    topHelp: "Commands:\n  container  Manage containers.\n  image      Manage images.\n  run        Run a container.\n  version    Show version.",
    containerHelp: "Commands:\n  list     List containers.\n  stop     Stop containers.\n  logs     View logs.\n  inspect  Inspect a container.\n  prune    Remove stopped containers.",
    imageHelp: "Commands:\n  list     List images.\n  inspect  Inspect images.\n  prune    Remove unused images.",
    runHelp: "Options:\n  -d,--detach  Detach\n  --rm  Remove after stop\n  -p,--publish  Publish\n  --name  Name",
    volumeHelp: "", // this build has no `volume` verb at all
  });
  assertEquals(c.can.stop, true, "documented verbs stay assumed");
  assertEquals(c.can.start, false, "start must be OFF without proof");
  assertEquals(c.can.rmContainer, false);
  assertEquals(c.can.pull, false);
  assertEquals(c.can.rmImage, false);
});

Deno.test("capabilities: a wslc WITHOUT volume support lights no volume flag (r9)", () => {
  // The safety-critical direction: absent verb ⇒ capability off ⇒ the route 409s and we
  // never emit a command this build cannot run.
  const c = buildWslcCapabilities({
    versionLine: "wslc 0.1.0",
    topHelp: "Commands:\n  container  Manage containers.\n  image      Manage images.\n  run        Run a container.",
    containerHelp: "Commands:\n  list  List containers.",
    imageHelp: "Commands:\n  list  List images.",
    runHelp: "Options:\n  -d,--detach  Detach\n  --name  Name", // no --entrypoint
    volumeHelp: "",
  });
  assertEquals(c.volumeVerbs, []);
  assertEquals(c.can.volumes, false);
  assertEquals(c.can.volumeCreate, false);
  assertEquals(c.can.volumeRemove, false);
  assertEquals(c.can.volumePrune, false);
  assertEquals(c.can.volumeInspect, false);
  assertEquals(c.can.entrypoint, false, "--entrypoint must be OFF without proof in run --help");
  assertEquals(volumeRemoveVerb(c.volumeVerbs), null, "no verb ⇒ nothing to emit ⇒ 409");
});

Deno.test("capabilities: a `volume` help that lacks prune keeps only the verbs it proves (r9)", () => {
  // A partial build: list/create exist, prune and remove do not. Each flag stands alone —
  // one present verb must never imply another.
  const c = buildWslcCapabilities({
    versionLine: "wslc 1.0.0",
    topHelp: "Commands:\n  volume  Manage volumes.\n  run     Run a container.",
    containerHelp: "",
    imageHelp: "",
    runHelp: "Options:\n  --entrypoint  Specifies the container init process executable",
    volumeHelp: "Commands:\n  create  Create a volume.\n  list    List volumes.",
  });
  assertEquals(c.can.volumes, true);
  assertEquals(c.can.volumeCreate, true);
  assertEquals(c.can.volumeRemove, false, "no remove verb in help ⇒ off");
  assertEquals(c.can.volumePrune, false, "no prune verb in help ⇒ off");
  assertEquals(c.can.volumeInspect, false);
  assertEquals(c.can.entrypoint, true);
  assertEquals(volumeRemoveVerb(c.volumeVerbs), null);
});

Deno.test("capabilities: garbage help degrades safely (documented on, implied off)", () => {
  const c = buildWslcCapabilities({
    versionLine: "", topHelp: "unexpected banner only", containerHelp: "", imageHelp: "", runHelp: "",
    volumeHelp: "",
  });
  assertEquals(c.version, null);
  assertEquals(c.can.run, true);
  assertEquals(c.can.start, false);
  assertEquals(c.can.volumes, false);
  assertEquals(c.can.entrypoint, false);
});
