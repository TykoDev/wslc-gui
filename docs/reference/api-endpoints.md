# API endpoints

Complete reference for the local HTTP API served by `wslc-gui`.

**Base URL** — `http://127.0.0.1:<port>`. In window mode the port is ephemeral (chosen by the
OS); in `--headless` mode it defaults to `8747`.

---

## Authentication

Every `/api` request requires the per-launch session token:

```
Authorization: Bearer <64-hex-character token>
```

**One exception.** `GET /api/events` also accepts `?t=<token>`, because `EventSource` cannot set
headers. No other route does.

Three global gates run before any handler:

| Gate | Failure |
| --- | --- |
| Remote address is `127.0.0.1` | **403** |
| `Origin` header, if present, equals the server's own origin | **403** `foreign origin` |
| Valid token (constant-time compare) | **401** `missing or invalid token` |
| Non-GET requests carry `Content-Type: application/json` | **415** `json required` |

Request bodies are capped at **1 MB**, rejected on `Content-Length` *before* being buffered
(**413** `payload_too_large`).

> **Note for clients:** because the JSON content-type is what makes a mutation valid, `DELETE`
> requests that carry no meaningful body must still send `{}` — otherwise they are rejected
> with 415.

---

## Error contract

Errors are JSON: `{ "error": "<code>", ...context }`.

| Status | Code | Meaning |
| --- | --- | --- |
| **400** | `validation` / `validation_error` | An input failed a validator. `detail` carries the reason. |
| 400 | `confirm_required` | A destructive operation needs its server-side echo. |
| 400 | `unknown_key`, `invalid_value`, `invalid_change`, `invalid_text`, `invalid_kind` | `.wslconfig` / picker payload problems. |
| **401** | — | Missing or invalid token. |
| **403** | — | Foreign origin, or a non-loopback peer. |
| **404** | `not_found`, `stack_not_found`, `path_not_found`, `unknown_action`, `wsl_settings_app_not_found`, `registry_not_found` | |
| **409** | `verb_unavailable` | **This `wslc` build does not advertise that verb.** `verb` names it. No process was spawned. |
| 409 | `picker_busy` | A native dialog is already open. One at a time. |
| **413** | `payload_too_large`, `too_large` | Body >1 MB, or a read-text file >256 KB. |
| **415** | — | A mutation without `Content-Type: application/json`. |
| **500** | `internal`, `picker_failed` | |
| **502** | `command_failed` | The child process exited nonzero. Carries `exitCode`, `stderr`, `stdout` — **verbatim**. |
| 502 | `registry_unreachable`, `registry_bad_response`, `online_list_failed`, `unparseable_output` | |
| **503** | `wslc_unavailable` | No `wslc` on this host. `hint` suggests `wsl --update`. |
| **504** | `command_timeout` | The child process was killed on timeout. |

A successful command returns `{ "ok": true, "stdout": "…" }`.

**Success is never fabricated.** If `wsl.exe` failed, you get its `stderr`.

---

## Capability gating

Routes marked **🔒** are gated on runtime feature detection. If your `wslc` build does not
advertise the verb in its `--help`, the route returns **409 `verb_unavailable`** *before* any
process is spawned. Check `GET /api/capabilities` → `wslc.can` to see what your host supports.

Routes marked **⚠️** require `wslc` to be present at all (otherwise **503**).

---

## Read endpoints

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/api/capabilities` | The full capability probe. `?force=1` bypasses the 60 s cache. |
| `GET` | `/api/containers` ⚠️ | `{containers[], headers[], raw[]}`. `?all=1` includes stopped. |
| `GET` | `/api/containers/:name/logs` ⚠️ | `{ok, stdout}` — `wslc container logs`. |
| `GET` | `/api/containers/:name/inspect` ⚠️ | `{ok, stdout}` — raw inspect JSON as text. |
| `GET` | `/api/images` ⚠️ | `{images[], headers[], raw[]}`. |
| `GET` | `/api/images/inspect?ref=` ⚠️ | `{ok, stdout}`. |
| `GET` | `/api/volumes` ⚠️🔒 | `{volumes[]}`. Gated on `can.volumes`. |
| `GET` | `/api/volumes/:name/inspect` ⚠️🔒 | `{inspect}` — parsed docker-shaped JSON. Gated on `can.volumeInspect`. |
| `GET` | `/api/resources` | `{distros, running, status, version, storage, sessionStorage, sessions, swap}`. **Works without `wslc`.** |
| `GET` | `/api/distros/online` | `{distros:[{name, friendlyName}]}` — `wsl --list --online`. |
| `GET` | `/api/registry/tags?ref=` | Up to 60 tags, newest first. Docker Hub API for `docker.io`, OCI v2 otherwise. |
| `GET` | `/api/wslconfig` | `{path, exists, text, values, catalog}` — the file **and** the full key catalog. |
| `GET` | `/api/config` | App settings. |
| `GET` | `/api/stacks` | Deployed-stack records. |
| `GET` | `/api/events` | **SSE stream.** Accepts `?t=<token>`. 503 beyond 64 concurrent clients. |

### `GET /api/events`

Channels: `capabilities` (60 s) · `containers` (`pollMs`, default 2500 ms) · `resources` (8 s) ·
`images` (30 s) · `volumes` (30 s) · `error` (on failure) · `:hb` comment heartbeat (25 s).

Snapshots, not deltas. A new client receives all five immediately on connect. Mutations push
their channel at once. See [observing a running instance](../guides/setting-up-monitoring.md).

---

## Containers

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/containers/prune` ⚠️ | `{}` | `wslc container prune`. |
| `POST` | `/api/containers/:name/stop` ⚠️ | `{}` | |
| `POST` | `/api/containers/:name/start` ⚠️🔒 | `{}` | Gated on `can.start`. |
| `POST` | `/api/containers/:name/exec` ⚠️ | `{command: string[]}` | Token array. Empty → 400. |
| `DELETE` | `/api/containers/:name` ⚠️🔒 | `{}` | Gated on `can.rmContainer`. The concrete verb (`rm`/`remove`/`delete`) is whichever your build advertises. |

### `POST /api/run` ⚠️

Runs a container. Every field is validated; the flag order in the emitted command is fixed and
mirrored exactly by the UI's live preview.

```jsonc
{
  "image":       "nginx:latest",   // required
  "name":        "web",
  "ports":       ["8080:80"],      // HOST:CONTAINER
  "volumes":     ["C:\\data:/data", "dbdata:/var/lib"],
  "env":         ["KEY=value"],
  "command":     ["nginx", "-g", "daemon off;"],
  "detach":      true,             // default true
  "rm":          false,
  "interactive": false,

  // 🔒 each of these must be advertised by `wslc run --help`, or → 409:
  "entrypoint":  "/bin/sh",        // needs --entrypoint
  "tmpfs":       "/tmp",           // needs --tmpfs
  "envFile":     "C:\\app\\.env",  // needs --env-file
  "gpus":        "all",            // needs --gpus
  "network":     "mynet",          // needs --network
  "shmSize":     "256M",           // needs --shm-size

  // core run flags, always available:
  "memory":      "512M",           // -m   docker-style (binary, decimals ok)
  "cpus":        "1.5",            // --cpus
  "workdir":     "/app",           // -w
  "user":        "1000:1000",      // -u
  "hostname":    "web"             // -h
}
```

**Emitted flag order** (`buildRunArgs`):
`run` · `-d` · `--rm` · `-it` · `-p` · `-v` · `--tmpfs` · `-e` · `--env-file` · `-m` · `--cpus` ·
`--shm-size` · `--gpus` · `-w` · `-u` · `--network` · `-h` · `--entrypoint` · `--name` · IMAGE ·
command tokens.

Timeout **300 s** — a missing image is auto-pulled on first run.

Pokes `containers`, `images` and `volumes` (a `-v NAME:/path` auto-creates a named volume).

---

## Volumes

All gated. `wslc volume list --format json` reports only `Driver` and `Name`; `createdAt`,
`labels` and the anonymous flag come from a second `volume inspect` call (one call, all names).

| Method | Path | Body | Gate |
| --- | --- | --- | --- |
| `POST` | `/api/volumes` ⚠️🔒 | `{name}` | `can.volumeCreate` |
| `DELETE` | `/api/volumes?name=` ⚠️🔒 | `{}` | `can.volumeRemove` |
| `POST` | `/api/volumes/prune` ⚠️🔒 | **`{confirm: true}`** | `can.volumePrune` |

`POST /api/volumes/prune` without `{confirm: true}` → **400 `confirm_required`**.

> **`wslc volume prune` is narrower than Docker's reputation suggests.** Its own help says
> *"Removes all unused **anonymous** local volumes"*. An unused **named** volume survives. A
> volume whose container still exists but has exited survives (it is still a reference). The
> more destructive `--all` is deliberately **not** exposed.
>
> The response reports what `wslc` said it destroyed — parsed from its output, never inferred:
> `{ok, stdout, removed: string[], reclaimed: string|null}`.

**There is no volume size field, by design.** `wslc volume inspect` reports neither a size nor a
mountpoint, so a per-volume byte count cannot be obtained — and is not invented. Those bytes are
already counted in the Resources "Container storage" total.

---

## Images

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/images/pull` ⚠️ | `{ref}` | **Never gated.** See below. |
| `POST` | `/api/images/prune` ⚠️ | `{}` | |
| `DELETE` | `/api/images?ref=` ⚠️🔒 | `{}` | Gated on `can.rmImage`. |

`POST /api/images/pull` always works, via one of two paths, and tells you which in the response:

- `can.pull` true → `wslc pull` or `wslc image pull` (whichever verb is detected) → `via: "pull"`
- `can.pull` false → the **documented auto-pull fallback**: a throwaway
  `wslc run --rm <ref> true` forces the fetch → `via: "throwaway-run"`

Timeout **300 s** on both.

---

## Stacks

### `POST /api/stacks/compile`

Pure preview — **spawns nothing.** Accepts either form:

```jsonc
{ "yaml": "<raw document text>", "name": "fallback-stack-name" }   // any supported format
{ "stack": { "name": "web", "services": { … } } }                  // the strict schema
```

The `yaml` form is leniently imported — **stack**, **docker-compose/podman-compose**, or
**Kubernetes** (Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob) — and the
format is auto-detected.

```jsonc
{
  "stack":  { "name": "web", "services": { … } },
  "warnings": [
    "services.api.build: ignored — wslc cannot build images; running image \"api:1\" as given",
    "services.db.ports: \"5432\" dropped — no host port, so nothing is published (compose would pick a random one; we never invent one)"
  ],
  "plan": [
    { "service": "web", "container": "myapp-web",
      "preview": "wslc run -d -p 8080:80 --name myapp-web nginx:latest" }
  ],
  "composeYaml": "# Generated by wslc-gui …",
  "source": "compose"          // "stack" | "compose" | "kubernetes"
}
```

**`warnings` is the contract.** Every key the app could not honour is listed individually, with
the value and the reason. The UI renders the list in full — never truncated, never summarised.
Nothing is dropped silently.

Hard rejects (400 `validation_error`): a compose service with `build:` and no `image:`, and a
file with no workload at all.

### The rest

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/stacks/deploy` ⚠️ | Same as compile | **200** all services ok; **207** partial. Gated on `--entrypoint`/`--shm-size` if the stack uses them. |
| `POST` | `/api/stacks/:name/down` ⚠️ | `{}` | Stops every member container (and removes it if the build has a remove verb). |
| `DELETE` | `/api/stacks/:name` | `{}` | **Forgets the record only.** Does not touch containers. |

Deploy is **sequential**, with an honest per-service result. A partial failure keeps the
successes and reports them:

```jsonc
{
  "name": "myapp", "status": "partial",   // "deployed" | "partial" | "down"
  "deployedAt": "2026-07-14T09:00:00.000Z",
  "services": [
    { "service": "web", "container": "myapp-web", "image": "nginx", "ok": true },
    { "service": "db",  "container": "myapp-db",  "image": "pg:16", "ok": false,
      "stderr": "port is already allocated" }
  ],
  "yaml": "…",
  "warnings": ["myapp-cache: kept as an orphaned container — …"]
}
```

Containers are named `<stack>-<service>`. On redeploy, a container the previous record managed
but the new stack no longer defines is carried over flagged `orphaned` — **and never
auto-stopped.**

---

## Distributions & WSL

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/api/distros/:name/terminate` | `{}` |
| `POST` | `/api/distros/:name/start` | `{}` — boots via `wsl -d <name> -e true` |
| `POST` | `/api/distros/:name/set-default` | `{}` |
| `POST` | `/api/distros/:name/set-version` | `{version: 1 \| 2}` |
| `POST` | `/api/distros/:name/resize` | `{size: "100GB"}` — **whole numbers only** |
| `POST` | `/api/distros/:name/set-sparse` | `{sparse: boolean}` |
| `POST` | `/api/distros/:name/move` | `{location: "D:\\wsl\\ubuntu"}` |
| `POST` | `/api/distros/:name/export` | `{file, format?}` — `tar` \| `tar.gz` \| `tar.xz` \| `vhd` |
| `POST` | `/api/distros/import` | `{name, location, file, vhd?, version?}` |
| `POST` | `/api/distros/install-online` | `{name}` — `wsl --install <name> --no-launch`. Timeout **1800 s**. |
| `DELETE` | `/api/distros/:name` | **`{confirmName: "<exact name>"}`** |
| `POST` | `/api/wsl/shutdown` | **`{confirm: true, force?: boolean}`** |
| `POST` | `/api/wsl/mount` | `{disk, vhd?, bare?, name?, type?, partition?, options?}` |
| `POST` | `/api/wsl/unmount` | `{disk?}` — omit `disk` to unmount all |

> **`DELETE /api/distros/:name` requires `confirmName` to exactly match the distro name.** Without
> it: **400 `confirm_required`**. This permanently deletes the distribution's root filesystem.
> There is no undo.
>
> **`POST /api/wsl/shutdown` requires `{confirm: true}`.** Called without it, it returns 400
> **plus the list of running distributions**, so the UI can tell you exactly what is about to be
> killed.

`--resize` takes a **whole number** with `B`/`M`/`MB`/`G`/`GB`/`T`/`TB`. Decimals are
unsupported by WSL and rejected here.

---

## Settings & system

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `PUT` | `/api/config` | `{theme, pollMs, showStoppedDefault}` | Restarts the SSE pollers. Invalid values fall back to defaults rather than erroring. |
| `PUT` | `/api/wslconfig` | See below | Backs up first, writes atomically. |
| `POST` | `/api/system/pick` | `{kind, title?, filters?, defExt?}` | Native dialog. `kind` ∈ `file-open` \| `file-save` \| `folder`. **409 `picker_busy`** if one is already open. 300 s timeout. |
| `POST` | `/api/system/read-text` | `{path}` | **`.yaml`/`.yml` only**, absolute path, symlinks rejected, 256 KB cap. |
| `POST` | `/api/system/reveal` | `{path}` | `explorer /select,<path>`. |
| `POST` | `/api/system/open-wslconfig` | `{}` | Creates `[wsl2]` if the file is absent, then opens it. |
| `POST` | `/api/system/open-wsl-settings` | `{}` | 404 if `wslsettings.exe` is not on this host. |

### `PUT /api/wslconfig`

Two modes.

**Structured (preferred)** — line-preserving, catalog-validated:

```jsonc
{
  "changes": [
    { "section": "wsl2",         "key": "memory",            "value": "4GB" },
    { "section": "wsl2",         "key": "processors",        "value": "4" },
    { "section": "experimental", "key": "autoMemoryReclaim", "value": "gradual" },
    { "section": "wsl2",         "key": "swap",              "value": null }   // null = delete the key
  ]
}
```

An unknown `section.key` → **400 `unknown_key`**. A value >1024 chars or containing newlines →
**400 `invalid_value`**.

Size values are guarded:

> **`memory=4G` is not a documented `.wslconfig` size. WSL ignores the key and silently falls
> back to 50% of your RAM — no error, no warning.** So `4G`, `4.5GB`, `4 GB`, `50%` and `potato`
> are all **rejected** on this path rather than written and ignored. Valid: a whole number with
> `MB`/`GB` (`4GB`), or a bare byte count (`1099511627776`, which covers `0`).

**Raw** — the escape hatch, no catalog validation, ≤64 KB:

```jsonc
{ "text": "[wsl2]\r\nmemory=4GB\r\n" }
```

Both modes respond:

```jsonc
{
  "ok": true,
  "path": "C:\\Users\\you\\.wslconfig",
  "backupPath": "C:\\Users\\you\\.wslconfig.bak.1768392000000",   // "" if no prior file
  "applyHint": "Changes apply after WSL restarts (8-second rule / wsl --shutdown)."
}
```

---

## Related

- [Data model](data-model.md) — the shape of every payload above.
- [Security model](../concepts/security-model.md) — why the auth and confirmation gates are what they are.
- [Docker & Compose compatibility](docker-reference.md) — exactly what the importer honours and drops.
