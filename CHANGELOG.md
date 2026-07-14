# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **No version has been tagged yet.** Everything below sits under `[Unreleased]`. Cutting the
> first release means moving these entries into a dated `## [0.1.0] - YYYY-MM-DD` section, tagging
> `v0.1.0`, and letting CI attach the executable — see
> [Building and releasing](docs/guides/deploying-to-production.md#cutting-a-release).

---

## [Unreleased]

### Added

**The application** — a single compiled Windows executable (Deno + React 19 + WebView2) that puts
the native `wsl.exe` and `wslc.exe` command surface behind one GUI. It invents no commands: every
action maps to a documented CLI invocation, or to one the installed `wslc` binary proved it
supports via `--help`.

**Containers page** — list running or all, stop, start*, delete*, logs, inspect, exec, prune, and
live `wslc stats` (CPU and memory joined into the table, with KPI totals). Running WSL
distributions are shown alongside, with a terminate action.

**Images page** — list, inspect, delete*, prune, and pull with tag discovery. Pull works on every
host: an explicit `pull` verb when the build has one, otherwise the documented auto-pull fallback
(a throwaway `wslc run --rm <image> true`), and the response says which path was taken. Tags come
from the Docker Hub API for `docker.io` refs and the OCI v2 `/tags/list` for everything else.

**Resources page** — distributions (terminate, start, set default, set version, resize, sparse,
move, export, import, install from the online catalogue, unregister), storage (real `ext4.vhdx`
paths and sizes discovered through the registry, `wslc` container-session disks, swap), WSL
platform versions, disk mount/unmount, and the volume lifecycle* (list, create, remove, inspect,
prune). **This page works fully on a host with no `wslc`.**

**Deploy page** — Quick run, a `wslc run` configurator with a live command preview that mirrors the
server's argument builder byte for byte; and Stack mode, which compiles a compose-subset YAML into
an ordered `wslc run` plan, shows it before executing, deploys sequentially with honest per-service
results, and exports standard `docker-compose.yaml`. Imports **docker-compose**, **podman-compose**
and **Kubernetes** manifests (Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob) —
telling you item by item, in full and never truncated, what it could not honour.

**Settings page** — theme (system/light/dark), container polling cadence, and a guided `.wslconfig`
editor: the full documented key catalogue, Windows-11-only keys disabled with a reason on Windows
10, backup-before-write, atomic replace, line-preserving edits that keep your comments and unknown
keys, and a raw-file escape hatch.

**System tray** — always present while the app runs. Minimize-to-tray, double-click to restore,
and a context menu (Open app · Stop WSL · Restart WSL · Quit).

**Capability model** — `wslc` verbs that exist in the binary but not in the documentation
(`container start`/`rm`, explicit `pull`, `image rm`, the `volume` lifecycle, `run --entrypoint`,
and the specialised run flags) are enabled **only** when `wslc --help` on the user's own host lists
them. Both the server (409 before any process spawn) and the client (disabled control naming the
missing verb) gate on the same probe. On a host with no `wslc` at all, Containers/Images/Deploy
show an explicit unavailable state with a re-check button, and Resources/Settings stay fully
functional.

**Live updates** — one SSE stream, five channels (`containers` at the user's cadence, `resources`
at 8 s, `images` and `volumes` at 30 s, `capabilities` at 60 s), pushing snapshots rather than
deltas. Pollers only run while a client is connected; a slow probe skips its tick rather than
stacking; mutations refresh their channel immediately.

**Headless mode** — `--headless` serves the UI to any browser. Used for development, and as the
automatic fallback when the WebView2 runtime cannot be loaded.

**Offline launch** — shipping `webview.dll` and `WebView2Loader.dll` in a `dll/` folder next to the
executable makes the first launch fully offline. Without them, the two DLLs are fetched once.

**Tests** — 166 unit tests across 17 files, running in about a second with `--allow-read` and
`--allow-env` only: no process spawning, no writes, no network.

**CI** — a Windows build workflow that typechecks the backend, runs the tests, builds the frontend,
typechecks the frontend, compiles the executable, and attaches it to a GitHub Release on a `v*`
tag.

\* Capability-gated.

### Security

- **Loopback only.** The server binds `127.0.0.1` and additionally rejects any non-loopback peer.
- **Per-launch 256-bit session token**, delivered through the URL fragment (never sent to a
  server, never written to a request log), required on every `/api` call, compared in constant
  time. Only `/api/events` accepts it as a query parameter — `EventSource` cannot set headers, and
  that exception is scoped to exactly one route.
- **Origin allowlist** and **no CORS headers ever**, so a cross-origin read is blocked by the
  browser and a cross-origin blind write is blocked by a 403.
- **JSON content-type required on every mutation**, which kills HTML-form CSRF.
- **One child-process choke point** with a binary allowlist (`wsl`, `wslc`, `reg`, `explorer`)
  mirrored exactly by the compile-time `--allow-run` list. Argument arrays only — never a shell.
  Every user-influenced argument is validated at the sink, and **any argument starting with `-` is
  rejected** (flag injection). Every child has a timeout and is killed on expiry.
- **Destructive operations are double-gated** — a UI confirmation is never the only gate. The
  server requires its own echo: `confirmName` for distro unregister, `{confirm: true}` for WSL
  shutdown and volume prune.
- **`.wslconfig` writes** create a timestamped backup first (5 newest kept), then write to a temp
  file and atomically rename over the target, so a crash mid-write cannot leave a half-written
  config.
- **The one file-read endpoint** (`/api/system/read-text`) is restricted to `.yaml`/`.yml`, absolute
  paths only, rejects symlinks and junctions before following them, and caps reads at 256 KB —
  checked both before and after the read, so a file that grows in between cannot slip past.
- **SSRF control** on registry tag lookups: the link-local range `169.254.0.0/16` (cloud metadata)
  is blocked, on the initial request and on any `WWW-Authenticate` realm redirect, which must also
  be HTTPS. Loopback and RFC1918 are deliberately allowed — a private registry is a legitimate
  target for a local-first tool. Responses are capped at 2 MB.
- **Static assets** are served from an in-memory map, so path traversal has nothing to traverse, and
  carry a strict CSP whose locked `connect-src` prevents a compromised renderer from exfiltrating
  the session token.
- **Bounded everywhere:** 64 concurrent SSE clients, 1 MB request bodies (rejected on
  `Content-Length`, before buffering), 64 KB `.wslconfig` raw text.

### Fixed

- **Console flashing.** A GUI-subsystem (`--no-terminal`) executable spawning console children
  gives each child a brand-new visible console window — with an 8-second poll, that meant a console
  flashing on screen forever. Deno 2.9 has no `windowsHide` option, so the app now allocates one
  console at startup via FFI and hides it; every child inherits it.
- **Silent startup failure.** Because that console is hidden, `console.error` reaches nobody. Fatal
  startup errors now surface as native message boxes.
- **Invisible zombie on WebView2 failure.** A failed webview used to keep the server alive while
  showing nothing — no window, no tray, the URL only on a hidden console: an unreachable process
  holding a port. It now tells the user, opens their browser at the working URL, and keeps serving
  so that URL resolves.
- **Distribution names containing spaces** (`Ubuntu 22.04`) were silently dropped by the
  `wsl --list --verbose` parser.
- **`.wslconfig` sizes.** `memory=4G` is undocumented — WSL ignores the key and silently falls back
  to 50% of RAM, with no error. The size control now emits `4GB`, and the server rejects
  undocumented forms on the structured-edit path, while raw-file mode remains the escape hatch and
  legacy values the control cannot model are passed through untouched rather than rewritten.
- **Kubernetes-to-Docker memory conversion.** k8s `512M` is decimal (512 × 10⁶); docker `512M` is
  binary (512 MiB). The importer now converts between them and warns whenever the conversion had to
  round. A lowercase k8s `m` (milli) is dropped with a warning rather than being folded to
  megabytes.
- **`wslc stats` memory totals** ran ~4.8% low: parsed as decimal, formatted as binary. Both now use
  one binary base.
- **A single bad value no longer sinks an entire compose file.** An unparseable port or environment
  entry is dropped with its own warning, as the Kubernetes path already did, instead of returning a
  400 for the whole document.
- **Frontend type errors produced a green build.** `deno task check` does not cover `frontend/`, and
  Vite does not typecheck — so `deno task check:web` was added and wired into CI.

### Documentation

- Full [Diátaxis](https://diataxis.fr/) documentation set under `docs/` — getting-started tutorials,
  how-to guides, concept explanations (architecture, security model), and reference material (API
  endpoints, data model, environment variables, commands, dependencies, Docker/Compose
  compatibility).
- [`AGENTS.md`](AGENTS.md), [`CONTRIBUTING.md`](CONTRIBUTING.md), [`CONDUCT.md`](CONDUCT.md),
  [`SECURITY.md`](SECURITY.md), GitHub issue and pull-request templates, and `CODEOWNERS`.
- GPL-3.0 licence.

### Known limitations

- **`wslc` cannot build images.** A compose service with `build:` and no `image:` is rejected — there
  is genuinely nothing to run.
- **Private registries are not supported.** Tag discovery is anonymous; public repositories only.
- **`wslc volume prune` only removes anonymous volumes** — this is `wslc`'s own semantics, not a
  limitation of this app. Unused *named* volumes survive. The more destructive `--all` is
  deliberately not exposed.
- **Volumes have no size.** `wslc volume inspect` reports neither a size nor a mountpoint, so a
  per-volume byte count cannot be obtained — and is not invented. Those bytes are counted in the
  Resources "Container storage" total.
- **Container logs are a snapshot, not a follow.** `wslc container logs` is not streamed.
- **Exec is one command per run,** not an interactive TTY.
- **Registries with more than 1000 tags may truncate.** The OCI v2 path requests `n=1000` and shows
  the top 60 after sorting.
- **No integration or E2E test suite.** The compiled executable, the WebView2 window, the tray, the
  native dialogs and every real `wsl`/`wslc` invocation are verified by hand against the
  [pre-release checklist](docs/guides/deploying-to-production.md#pre-release-checklist).
- **`--allow-read` and `--allow-write` are unscoped** in the compiled binary. The paths the app
  touches are not knowable at compile time; the mitigation is that every write site is centralised.
  Recorded and accepted — see the [security model](docs/concepts/security-model.md#accepted-residual-risks).
- **Windows x64 only.** `x86_64-pc-windows-msvc` is Deno's only Windows compile target.

---

[Unreleased]: https://github.com/TykoDev/wslc-gui/commits/master
