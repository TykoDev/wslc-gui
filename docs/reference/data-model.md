# Data model

Every wire type, on-disk shape, and configuration key in the project.

**There is no database.** State is either read live from `wsl.exe` / `wslc.exe` / the Windows
registry, or persisted in two small JSON files. There are no migrations.

---

## Where state lives

| Path | Owner | Contents |
| --- | --- | --- |
| `%APPDATA%\wslc-gui\config.json` | **this app** | App settings |
| `%APPDATA%\wslc-gui\stacks.json` | **this app** | Deployed-stack records |
| `%USERPROFILE%\.wslconfig` | **WSL** — the app only edits it | WSL 2 VM settings |
| `%USERPROFILE%\.wslconfig.bak.<ts>` | this app | Automatic backups (5 newest kept) |
| `%LOCALAPPDATA%\wslc-gui\runtime\` | this app | WebView2 loader + tray icon working dir |
| `HKCU\…\CurrentVersion\Lxss` | **WSL** — read-only | Distro `BasePath` → `ext4.vhdx` discovery |
| `%LOCALAPPDATA%\wslc\sessions\<name>\*.vhdx` | **WSL** — read-only | Container-session disks |

Both JSON files are **schema-validated on read**. A corrupt file is renamed
`<name>.corrupt.<timestamp>` and defaults are regenerated — the app never crash-loops on bad
state.

---

## Capabilities

`GET /api/capabilities`. The single source of truth for what the UI enables.

```ts
interface Capabilities {
  wsl:  { present: boolean; version: string | null };
  wslc: {
    present: boolean;
    version: string | null;         // "2.9.3.0" — the "wslc " prefix is stripped
    topVerbs:       string[];       // parsed from `wslc --help`
    containerVerbs: string[];       // from `wslc container --help`
    imageVerbs:     string[];       // from `wslc image --help`
    volumeVerbs?:   string[];       // from `wslc volume --help` — optional on the wire
    runFlags:       string[];       // from `wslc run --help`, dashes kept: "--entrypoint"
    can: WslcCan;
  };
  windows:        { build: number; win11: boolean };   // win11 = build >= 22000
  wslSettingsApp: { present: boolean; path: string | null };
  probedAt:       string;           // ISO 8601
}
```

```ts
interface WslcCan {
  // Documented — assumed true whenever wslc is present:
  run: boolean; stop: boolean; logs: boolean; inspect: boolean; execIn: boolean;
  stats: boolean; listAll: boolean; pruneContainers: boolean;
  imageList: boolean; imageInspect: boolean; imagePrune: boolean; build: boolean;

  // API-implied — true ONLY when `--help` proves it:
  start: boolean;         // container start
  rmContainer: boolean;   // container rm | remove | delete
  pull: boolean;          // pull  |  image pull
  rmImage: boolean;       // image rm | remove | delete
  volumes: boolean;       // volume list
  volumeCreate: boolean;
  volumeRemove: boolean;
  volumePrune: boolean;
  volumeInspect: boolean;
  entrypoint: boolean;    // run --entrypoint
}
```

Cached 60 s; `?force=1` bypasses. `volumeVerbs` is optional because a server predating the
volume feature sends no such field — clients must read it as `volumeVerbs ?? []`.

---

## Containers & images

`wslc`'s exact column set is not something the project will hard-code a promise about, so
normalization is **best-effort and the raw table travels alongside it.** If `wslc` changes its
columns, the UI renders the raw rows rather than lying or crashing.

```ts
interface ContainerRow {
  id:     string | null;   // from "CONTAINER ID" | "ID"
  name:   string | null;   // from "NAMES" | "NAME"
  image:  string | null;
  status: string | null;   // from "STATUS" | "STATE"
  ports:  string | null;
  raw:    Record<string, string>;   // every column, verbatim
}

interface ContainersSnapshot {
  containers: ContainerRow[];
  headers:    string[];    // as wslc printed them
  raw:        string[];    // the raw lines
  stats?:     string | null;   // raw `wslc stats` stdout — parsed CLIENT-side
}

interface ImageRow {
  repository: string | null;   // from "REPOSITORY" | "REPO" | "IMAGE"
  tag:        string | null;
  id:         string | null;
  size:       string | null;
  raw:        Record<string, string>;
}
```

The container reference used for stop/start/rm is `name ?? id`.

---

## Volumes

```ts
interface VolumeRow {
  name:      string;
  driver:    string;                    // wslc reports "guest"
  createdAt: string | null;             // only `volume inspect` carries it
  anonymous: boolean;                   // Labels["com.docker.volume.anonymous"] present
  labels:    Record<string, string>;
}
```

**There is deliberately no `size` and no `mountpoint`.** `wslc volume inspect` reports neither
(live-probed), so a per-volume byte count cannot be obtained — and is never invented. Those bytes
are already inside the container-session VHD that the Resources page totals.

`volume list --format json` carries only `Driver` and `Name`. `createdAt`, `labels` and the
anonymous flag come from one enriching `volume inspect` (which accepts every name in a single
call — two commands, not N+1). **The list is the source of truth for existence:** if the inspect
fails, rows survive with `createdAt: null` rather than disappearing or acquiring an invented
date.

`anonymous` volumes are what `volume prune` reclaims by default — hence the badge in the UI.

---

## Resources

```ts
interface ResourcesSnapshot {
  distros:        DistroInfo[];
  running:        string[];                  // names, from `wsl --list --running --quiet`
  status:         Record<string, string>;    // parsed `wsl --status`
  version?:       Record<string, string>;    // parsed `wsl --version`
  storage:        DistroStorage[];           // distro ext4.vhdx, via the registry
  sessionStorage: SessionStorage[];          // wslc container-session disks
  sessions:       SessionInfo[];             // `wslc system session list`
  swap:           { path: string; sizeBytes: number | null; exists: boolean };
}

interface DistroInfo {
  name:      string;     // may contain spaces — "Ubuntu 22.04"
  state:     string;     // "Running" | "Stopped" | …
  version:   number;     // 1 | 2
  isDefault: boolean;    // the "*" marker
}

interface DistroStorage {
  name:      string;
  guid:      string;            // "{…}" from the Lxss registry key path
  basePath:  string;            // long-path "\\?\" prefix stripped
  vhdxPath:  string | null;     // null for WSL1 distros (directory rootfs) or moved disks
  sizeBytes: number | null;
}

interface SessionStorage {
  session:   string;     // the session directory name
  file:      string;     // "storage.vhdx" | "swap.vhdx"
  path:      string;
  sizeBytes: number | null;
}

interface SessionInfo { id: string; creatorPid: string; name: string; }
```

`DistroStorage` is **discovered, not stored**: `reg query HKCU\…\Lxss /s` yields each
distribution's `DistributionName` and `BasePath`; the app then `stat`s `<basePath>\ext4.vhdx`.
A distro with no such file (WSL 1, or a moved disk) reports `vhdxPath: null` rather than a
fabricated path.

---

## Stacks

### The strict schema

What the app can **honestly execute** via documented `wslc run` flags. Anything else is rejected
with an explicit list of the offending keys — never silently dropped.

```ts
interface Stack {
  name:     string;                          // ^[A-Za-z0-9][A-Za-z0-9_.-]*$
  services: Record<string, ServiceSpec>;     // 1–20 services
}

interface ServiceSpec {
  image:       string;      // required
  ports:       string[];    // "HOST:CONTAINER"      → -p
  command:     string[];                            // positional, after the image
  detach:      boolean;     // default true          → -d
  rm:          boolean;                             // → --rm
  interactive: boolean;                             // → -it
  env:         string[];    // "KEY=value"           → -e
  volumes:     string[];    // "HOST:CONTAINER" | "NAME:/path"  → -v
  memory?:     string;      // "512M" | "1G"        → -m
  cpus?:       string;      // "0.5" | "2"          → --cpus
  shmSize?:    string;      // compose: shm_size    → --shm-size   🔒
  entrypoint?: string;      // ONE executable token → --entrypoint 🔒
}
```

Accepted service keys: `image`, `ports`, `command`, `detach`, `rm`, `interactive`, `env`
(or `environment`), `volumes`, `memory`, `cpus`, `shmSize`, `entrypoint`. **Anything else is a
400** naming the unsupported keys — `wslc` documents no equivalent, and the app will not pretend
otherwise.

`entrypoint` is a **single executable token**, never a shell line. `wslc` execs it directly, so
`--entrypoint "sh -c evil"` is not a shell command — it is a lookup for a binary literally named
`sh -c evil`. Its *arguments* go through `command` as positional args.

### The compiled plan

```ts
interface PlanStep {
  service:   string;
  container: string;     // "<stack>-<service>", collapsed when they'd double up
  image:     string;
  args:      string[];   // the exact argv
  preview:   string;     // the exact command line, shown before you deploy
}
```

### The deployed record

`%APPDATA%\wslc-gui\stacks.json` holds an array of these.

```ts
interface StackRecord {
  name:       string;
  status:     "deployed" | "partial" | "down";
  deployedAt: string;                       // ISO 8601
  services:   StackServiceRecord[];
  yaml:       string;                       // the docker-compose export
  warnings?:  string[];
}

interface StackServiceRecord {
  service:   string;
  container: string;
  image:     string;
  ok:        boolean;
  stderr?:   string;      // set when ok === false — verbatim from wslc
  orphaned?: boolean;     // see below
}
```

**`orphaned`** — a container the *previous* record managed but the current stack no longer
defines. It is kept in the record so Down/Delete can still reach it, and it is **never
auto-stopped**: a redeploy must not silently kill a container. `status` reflects only *this*
deploy, so orphans do not make it `partial`.

---

## App config

`%APPDATA%\wslc-gui\config.json`.

```ts
interface AppConfig {
  theme:              "system" | "light" | "dark";   // default "system"
  pollMs:             number;                        // default 2500, valid 1000–60000
  showStoppedDefault: boolean;                       // default false
}
```

Out-of-range or wrong-typed values **fall back to the default** rather than erroring — a bad
config file must not brick the app. `pollMs` drives the `containers` SSE channel only; the other
cadences are fixed.

---

## `.wslconfig` key catalog

The full documented catalog, served with the file at `GET /api/wslconfig` and rendered as the
guided editor.

```ts
interface WslConfigKeyDef {
  section:         "wsl2" | "experimental";
  key:             string;
  type:            "bool" | "number" | "size" | "path" | "string" | "enum";
  enumValues?:     string[];
  default?:        string;
  win11Only?:      boolean;    // disabled on Windows 10, with the reason shown
  win11_22h2?:     boolean;    // needs Windows 11 22H2 or newer
  deprecatedValue?: string;
  description:     string;
}
```

### `[wsl2]`

| Key | Type | Default | Win11 | Description |
| --- | --- | --- | :---: | --- |
| `kernel` | path | | | Absolute Windows path to a custom Linux kernel. |
| `kernelModules` | path | | | Absolute Windows path to a custom kernel modules VHD. |
| `memory` | **size** | 50% of Windows memory | | Memory assigned to the WSL 2 VM (e.g. `4GB`). |
| `processors` | number | all logical processors | | Logical processors assigned to the VM. |
| `localhostForwarding` | bool | `true` | | Connect to WSL ports via `localhost:port`. Ignored when `networkingMode=mirrored`. |
| `kernelCommandLine` | string | | | Additional kernel command-line arguments. |
| `safeMode` | bool | `false` | ✅ | Run WSL in Safe Mode (recovery; disables many features). |
| `swap` | **size** | 25% of memory | | Swap space for the VM. `0` disables swap. |
| `swapFile` | path | `%Temp%\swap.vhdx` | | Absolute Windows path to the swap VHD. |
| `guiApplications` | bool | `true` | | GUI application support (WSLg). |
| `debugConsole` | bool | `false` | | Show `dmesg` console on distro start. |
| `maxCrashDumpCount` | number | `10` | | Maximum retained crash dump files. |
| `nestedVirtualization` | bool | `true` | ✅ | Nested virtualization (VMs inside WSL 2). |
| `vmIdleTimeout` | number | `60000` | ✅ | Milliseconds a VM idles before shutdown. |
| `dnsProxy` | bool | `true` | | NAT mode only: point Linux DNS at the host NAT. |
| `networkingMode` | enum | `NAT` | ✅ 22H2 | `none` · `nat` · `bridged`⚠️ · `mirrored` · `virtioproxy` |
| `firewall` | bool | `true` | ✅ 22H2 | Windows Firewall filtering of WSL traffic. |
| `dnsTunneling` | bool | `true` | ✅ 22H2 | DNS request proxying from WSL to Windows. |
| `autoProxy` | bool | `true` | ✅ | Use Windows HTTP proxy settings in WSL. |
| `defaultVhdSize` | **size** | `1099511627776` (1 TB) | | Maximum VHD size for distro filesystems. |

⚠️ `bridged` is a deprecated value for `networkingMode` — flagged in the UI.

### `[experimental]`

| Key | Type | Default | Win11 | Description |
| --- | --- | --- | :---: | --- |
| `autoMemoryReclaim` | enum | `dropCache` | | `disabled` · `gradual` · `dropCache` |
| `sparseVhd` | bool | `false` | | Create new VHDs as sparse automatically. |
| `bestEffortDnsParsing` | bool | `false` | ✅ 22H2 | Needs `dnsTunneling`. |
| `dnsTunnelingIpAddress` | string | `10.255.255.254` | ✅ 22H2 | Nameserver written to `resolv.conf`. |
| `initialAutoProxyTimeout` | number | `1000` | ✅ | Needs `autoProxy`. |
| `ignoredPorts` | string | | ✅ 22H2 | Mirrored mode: comma-separated ports Linux may bind. |
| `hostAddressLoopback` | bool | `false` | ✅ 22H2 | Mirrored mode: host↔container via host IPv4. |

---

## Size grammars

**These are four different grammars and they do not unify.** Getting one wrong is silent.

| Target | Grammar | Valid | Invalid |
| --- | --- | --- | --- |
| **`.wslconfig`** | whole number + `MB`/`GB`, **or** a bare byte count | `4GB` · `512MB` · `1099511627776` · `0` | **`4G`** · `4.5GB` · `4 GB` · `50%` |
| **`wsl --manage --resize`** | whole number + `B`/`M`/`MB`/`G`/`GB`/`T`/`TB` | `100GB` · `512MB` | `2.5TB` (decimals unsupported) |
| **`wslc run -m` / `--shm-size`** | docker-style, **binary**, decimals allowed | `512M` · `1G` · `1.5G` | |
| **Kubernetes `limits.memory`** | **decimal** SI — `512M` is 512 × 10⁶ | `512M` · `512Mi` | lowercase `m` (milli — a fraction of a byte) |

> **The one that will silently cost you memory:** `memory=4G` in `.wslconfig` is **undocumented**.
> WSL ignores the key and falls back to 50% of your RAM. No error. The server refuses `4G` on
> the structured-edit path precisely because a visible error beats an invisible default.

> **The one that will silently cost you a factor of 1.048:** Kubernetes `512M` is 512 **million**
> bytes; Docker `512M` is 512 **MiB**. The importer converts between them and **warns when the
> conversion had to round.**

Raw-file mode in the `.wslconfig` editor bypasses the guard — it is the escape hatch for legacy
values the control cannot model, which are passed through character-for-character rather than
rewritten.

---

## Validation rules

Every user-influenced process argument passes these, at the sink, in
[`adapter/validate.ts`](../../app/adapter/validate.ts).

| Validator | Rule | Max |
| --- | --- | --- |
| `name` | `^[A-Za-z0-9][A-Za-z0-9_.-]*$` | 128 |
| `imageRef` | `^[a-z0-9][a-z0-9._\-/:@]*$`, no `//`, no `..` | 256 |
| `volumeName` | `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$` | 128 |
| `port` / `portPair` | integer 1–65535 · `HOST:CONTAINER` | |
| `winPath` | absolute drive-letter path, no `..`, no `<>"\|?*` | 1024 |
| `containerPath` | absolute, starts `/`, no `..` | 256 |
| `envPair` | `^[A-Za-z_][A-Za-z0-9_]*=` | 512 |
| `memValue` / `shmSize` | `^\d+(\.\d+)?[KMGT]i?B?$` | 16 |
| `memSize` (`.wslconfig`, `--resize`) | `^[1-9]\d*(MB\|GB\|TB)$` | 16 |
| `cpusValue` | `^\d+(\.\d+)?$`, > 0 | 8 |
| `userSpec` | `^[A-Za-z0-9_][A-Za-z0-9_.:-]*$` | 64 |
| `entrypointValue` | one token, no spaces, no leading `-` | 256 |
| `commandTokens` | ≤64 tokens, no NUL/CR/LF | 512 each |

**Applied to every one of them:** no NUL, CR, LF or tab; **no leading `-`**. That last rule is
the flag-injection defence — without it a container named `--privileged` becomes a flag rather
than a value.

---

## Related

- [API endpoints](api-endpoints.md) — where each of these types appears on the wire.
- [Docker & Compose compatibility](docker-reference.md) — how compose and k8s map onto `ServiceSpec`.
- [Security model](../concepts/security-model.md) — why validation happens at the sink.
