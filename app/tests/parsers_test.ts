import { assertEquals } from "@std/assert";
import {
  mergeVolumeRows,
  parseDistroList,
  parseHelpFlags,
  parseHelpVerbs,
  parsePruneOutput,
  parseRegQuery,
  parseSessionList,
  parseStatus,
  parseTable,
  parseVersionBlock,
  parseVolumeInspectJson,
  parseVolumeListJson,
} from "../adapter/parsers.ts";
import {
  WSL_LIST_ONLINE,
  WSLC_SESSION_LIST,
  WSLC_VOLUME_INSPECT_JSON,
  WSLC_VOLUME_INSPECT_MISSING,
  WSLC_VOLUME_LIST_EMPTY_JSON,
  WSLC_VOLUME_LIST_JSON,
  WSLC_VOLUME_PRUNE,
} from "./fixtures/wslc_real_output.ts";

const ANON = "60e1ab6c49daa80ebb6177869fafaf29e72024fa15ed5f3cf1242ced703648ba";

// ------------------------------------------------------------------ volumes (r9)

Deno.test("parseVolumeListJson: the real --format json shape (Driver + Name, nothing else)", () => {
  const rows = parseVolumeListJson(WSLC_VOLUME_LIST_JSON);
  assertEquals(rows.length, 2);
  assertEquals(rows[0], { name: ANON, driver: "guest" });
  assertEquals(rows[1], { name: "r9probe-named", driver: "guest" });
  assertEquals(parseVolumeListJson(WSLC_VOLUME_LIST_EMPTY_JSON), []);
  // We parse the documented JSON, never the table — and never throw on junk.
  assertEquals(parseVolumeListJson("DRIVER   VOLUME NAME\nguest    x"), []);
  assertEquals(parseVolumeListJson(""), []);
});

Deno.test("parseVolumeInspectJson: several names in one call; anonymous is a LABEL, not a guess", () => {
  const map = parseVolumeInspectJson(WSLC_VOLUME_INSPECT_JSON);
  assertEquals(map.size, 2);
  assertEquals(map.get(ANON)?.createdAt, "2026-07-13T03:32:26Z");
  assertEquals(map.get(ANON)?.labels, { "com.docker.volume.anonymous": "" });
  assertEquals(map.get("r9probe-named")?.createdAt, "2026-07-13T20:39:05Z");
  assertEquals(map.get("r9probe-named")?.labels, {});
  // wslc prints "Volume not found: 'x'" BEFORE the empty array — the JSON still parses.
  assertEquals(parseVolumeInspectJson(WSLC_VOLUME_INSPECT_MISSING).size, 0);
  assertEquals(parseVolumeInspectJson("").size, 0);
});

Deno.test("mergeVolumeRows: the list decides existence; inspect only enriches (r9 P3)", () => {
  const rows = mergeVolumeRows(
    parseVolumeListJson(WSLC_VOLUME_LIST_JSON),
    parseVolumeInspectJson(WSLC_VOLUME_INSPECT_JSON),
  );
  assertEquals(rows[0].anonymous, true, "the com.docker.volume.anonymous label is present");
  assertEquals(rows[0].createdAt, "2026-07-13T03:32:26Z");
  assertEquals(rows[1].anonymous, false, "a named volume carries no anonymous label");
  assertEquals(rows[1].driver, "guest");
  // No size and no mountpoint exist anywhere in this type — wslc reports neither (P3).
  assertEquals(Object.keys(rows[1]).sort(), ["anonymous", "createdAt", "driver", "labels", "name"]);

  // Inspect unreadable (or the volume vanished between the two calls): the row SURVIVES
  // with createdAt null. It is never dropped, and never given an invented date.
  const degraded = mergeVolumeRows(parseVolumeListJson(WSLC_VOLUME_LIST_JSON), new Map());
  assertEquals(degraded.length, 2);
  assertEquals(degraded[0].createdAt, null);
  assertEquals(degraded[0].anonymous, false);
  assertEquals(degraded[0].name, ANON);
});

Deno.test("parsePruneOutput: what wslc SAYS it destroyed, and its own reclaimed figure", () => {
  const { removed, reclaimed } = parsePruneOutput(WSLC_VOLUME_PRUNE);
  assertEquals(removed, ["0afb8c734624ce9f6602c2449873ea65359d1d81862037b206a93eda5cbf4000"]);
  assertEquals(reclaimed, "0 B"); // passed through verbatim, never computed
  // A prune that found nothing reports nothing — not a fabricated empty success.
  assertEquals(parsePruneOutput("Total reclaimed space: 0 B"), { removed: [], reclaimed: "0 B" });
  assertEquals(parsePruneOutput(""), { removed: [], reclaimed: null });
});

Deno.test("parseTable: real `wsl --list --online` output (r7 online install)", () => {
  const t = parseTable(WSL_LIST_ONLINE);
  assertEquals(t.headers, ["NAME", "FRIENDLY NAME"]);
  assertEquals(t.rows.length, 5);
  assertEquals(t.rows[1], { "NAME": "Ubuntu-26.04", "FRIENDLY NAME": "Ubuntu 26.04 LTS" });
  assertEquals(t.rows[4]["NAME"], "SUSE-Linux-Enterprise-15-SP7");
});

Deno.test("parseSessionList: real 2.9.3.0 output (mixed-case headers)", () => {
  assertEquals(parseSessionList(WSLC_SESSION_LIST), [
    { id: "1", creatorPid: "12308", name: "wslc-cli-user" },
  ]);
  assertEquals(parseSessionList(""), []);
  assertEquals(parseSessionList("ID   Creator PID   Display Name"), []); // header only
});

const DISTRO_FIXTURE = [
  "wsl: Nested virtualisation is not supported on this machine.",
  "  NAME              STATE           VERSION",
  "* Ubuntu            Running         2",
  "  Debian            Stopped         2",
  "  docker-desktop    Stopped         2",
  "",
].join("\r\n");

Deno.test("parseDistroList: advisory line skipped, default marker, states", () => {
  const distros = parseDistroList(DISTRO_FIXTURE);
  assertEquals(distros.length, 3);
  assertEquals(distros[0], { name: "Ubuntu", state: "Running", version: 2, isDefault: true });
  assertEquals(distros[1].isDefault, false);
  assertEquals(distros[2].name, "docker-desktop");
});

Deno.test("parseDistroList: a NAME with spaces is kept (BE MINOR-4)", () => {
  const fixture = [
    "  NAME              STATE           VERSION",
    "* Ubuntu 22.04      Running         2",
    "  SUSE Linux 15     Stopped         2",
    "  Debian            Stopped         1",
    "",
  ].join("\r\n");
  const distros = parseDistroList(fixture);
  assertEquals(distros.length, 3);
  // the spaced names survive verbatim — the old (\S+) capture dropped them entirely
  assertEquals(distros[0], { name: "Ubuntu 22.04", state: "Running", version: 2, isDefault: true });
  assertEquals(distros[1], { name: "SUSE Linux 15", state: "Stopped", version: 2, isDefault: false });
  assertEquals(distros[2], { name: "Debian", state: "Stopped", version: 1, isDefault: false });
});

Deno.test("parseDistroList: empty/garbage input", () => {
  assertEquals(parseDistroList(""), []);
  assertEquals(parseDistroList("There are no installed distributions."), []);
});

const VERSION_FIXTURE = [
  "WSL version: 2.7.10.0",
  "Kernel version: 6.18.33.2-2",
  "WSLg version: 1.0.73.2",
  "Windows version: 10.0.19045.6937",
].join("\n");

Deno.test("parseVersionBlock: labels normalized", () => {
  const m = parseVersionBlock(VERSION_FIXTURE);
  assertEquals(m["wsl"], "2.7.10.0");
  assertEquals(m["kernel"], "6.18.33.2-2");
  assertEquals(m["windows"], "10.0.19045.6937");
});

Deno.test("parseStatus: key/value lines", () => {
  const m = parseStatus("Default Distribution: Ubuntu\nDefault Version: 2");
  assertEquals(m["Default Distribution"], "Ubuntu");
  assertEquals(m["Default Version"], "2");
});

const HELP_FIXTURE = [
  "Usage:  wslc container COMMAND",
  "",
  "Commands:",
  "  list        List containers",
  "  ps          Alias for list",
  "  start       Start a stopped container",
  "  stop        Stop a running container",
  "  rm          Remove a container",
  "  logs        Fetch container logs",
  "  inspect     Show detailed information",
  "  prune       Remove stopped containers",
].join("\n");

Deno.test("parseHelpVerbs: docker-style help layout", () => {
  const verbs = parseHelpVerbs(HELP_FIXTURE);
  for (const expected of ["list", "ps", "start", "stop", "rm", "logs", "inspect", "prune"]) {
    assertEquals(verbs.has(expected), true, `missing verb ${expected}`);
  }
  assertEquals(verbs.has("usage"), false);
});

Deno.test("parseHelpFlags: long and short flags", () => {
  const flags = parseHelpFlags("  -d, --detach   Run in background\n  -p, --publish  Publish port\n  --rm  Auto remove");
  for (const f of ["-d", "--detach", "-p", "--publish", "--rm"]) {
    assertEquals(flags.has(f), true, `missing flag ${f}`);
  }
});

const TABLE_FIXTURE = [
  "wsl: some advisory noise",
  "CONTAINER ID   IMAGE          STATUS          PORTS                  NAMES",
  "a1b2c3d4e5f6   nginx:latest   Up 2 minutes    0.0.0.0:8080->80/tcp   web",
  "f6e5d4c3b2a1   redis:7        Exited (0)                             cache",
].join("\n");

Deno.test("parseTable: fixed-width columns from header offsets", () => {
  const t = parseTable(TABLE_FIXTURE);
  assertEquals(t.headers, ["CONTAINER ID", "IMAGE", "STATUS", "PORTS", "NAMES"]);
  assertEquals(t.rows.length, 2);
  assertEquals(t.rows[0]["NAMES"], "web");
  assertEquals(t.rows[0]["PORTS"], "0.0.0.0:8080->80/tcp");
  assertEquals(t.rows[1]["PORTS"], "");
  assertEquals(t.rows[1]["NAMES"], "cache");
});

Deno.test("parseTable: headerless output degrades to raw", () => {
  const t = parseTable("no table here\njust text");
  assertEquals(t.headers, []);
  assertEquals(t.rows, []);
  assertEquals(t.raw.length, 2);
});

const REG_FIXTURE = [
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss",
  "    DefaultDistribution    REG_SZ    {12345678-1234-1234-1234-123456789abc}",
  "",
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{12345678-1234-1234-1234-123456789abc}",
  "    DistributionName    REG_SZ    Ubuntu",
  "    BasePath    REG_SZ    \\\\?\\C:\\Users\\x\\AppData\\Local\\Packages\\Ubuntu\\LocalState",
  "    Flags    REG_DWORD    0xf",
].join("\r\n");

Deno.test("parseRegQuery: per-key value maps", () => {
  const entries = parseRegQuery(REG_FIXTURE);
  assertEquals(entries.length, 2);
  assertEquals(entries[1].values["DistributionName"], "Ubuntu");
  assertEquals(
    entries[1].values["BasePath"],
    "\\\\?\\C:\\Users\\x\\AppData\\Local\\Packages\\Ubuntu\\LocalState",
  );
});
