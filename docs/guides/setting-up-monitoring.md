# How to observe a running instance

This is a single-user desktop app. There is no Prometheus endpoint, no metrics backend, no log
aggregation, and adding one would be silly. **What it has instead is a live event stream**, and
knowing how to read it is how you debug anything from "the UI froze" to "why is my container
not showing up".

This guide covers what the app pushes, how to watch it, and how to tell a stuck UI from a
broken backend.

---

## The event stream

The server maintains one Server-Sent Events stream at **`GET /api/events`**. Every connected
client gets **snapshots** — complete current state, not deltas — so a client that misses a
frame simply catches up on the next one. Reducers stay idempotent and there is no
resynchronisation logic to get wrong.

### Channels and cadence

| Channel | Interval | What it carries | Gated on |
| --- | --- | --- | --- |
| `containers` | **`pollMs`** (default 2500 ms, user-configurable) | `wslc container list --all` + `wslc stats` | `wslc` present |
| `resources` | 8 s | distros, running list, `wsl --status`, `wsl --version`, VHDX sizes, container-session disks, swap | — |
| `images` | 30 s | `wslc image list` | `wslc` present |
| `volumes` | 30 s | `wslc volume list` + `volume inspect` | `wslc` present **and** `can.volumes` |
| `capabilities` | 60 s | the full capability probe | — |
| `error` | on failure | `{scope, message}` — surfaces as a toast | — |
| `:hb` | 25 s | a comment-only heartbeat that keeps the connection alive | — |

Only `containers` is configurable (Settings → Behavior). The rest are fixed.

### Three properties worth knowing

**Pollers only run while a client is connected.** Every push method returns immediately if
`clients.size === 0`. Close the window and the app stops shelling out to `wsl.exe` entirely.
It does not poll into the void.

**A slow probe skips its next tick instead of stacking.** Each channel is wrapped in an
in-flight guard: if a `wslc` call outlives its own interval, the next tick is dropped rather
than queued behind it. Without this, a slow host would accumulate an unbounded backlog of
`wslc` processes.

**Mutations poke their channel immediately.** After a container starts, the route calls
`hub.poke("containers")` and a fresh snapshot goes out at once — you do not wait up to 2.5 s to
see the result of your own click. The same happens on connect: a new client gets all five
snapshots immediately rather than waiting a full interval.

### Watching it

**In the browser:** DevTools → Network → `events` → the **EventStream** tab. You see every
frame as it arrives, tagged by channel.

**From a terminal** (headless mode):

```powershell
$t = "<token from dev:server>"
curl.exe -N "http://127.0.0.1:8747/api/events?t=$t"
```

`-N` disables buffering. You'll see the initial burst of five snapshots, then a `:hb` every
25 seconds, then periodic channel frames.

> The SSE route is the **only** one that accepts the token as a query parameter. `EventSource`
> cannot set an `Authorization` header, so this is a necessary exception — and every other
> route still requires the header, which keeps a token leaked into a copied URL from being a
> usable credential anywhere else.

---

## Reading the top bar

The Layout top bar is a permanent status readout. Learn it and most "is it broken?" questions
answer themselves.

| Pill | Meaning |
| --- | --- |
| `live` (green) | SSE connected. Snapshots flowing. |
| `reconnecting` | The stream dropped. The client is retrying with exponential backoff (1 s → 15 s cap). |
| `connecting` | Initial connection. |
| `no session token` | The SPA never got a token. Every API call is 401ing. |
| `WSL 2.x.x.x` | Detected WSL version. |
| `wslc 2.x.x.x` | `wslc` found and probed. |
| `wslc unavailable` | No `wslc`. Containers/Images/Deploy are in their unavailable state. |
| `probing…` | The first capability probe hasn't landed yet. |

**If the UI has gone stale, look here first.** `reconnecting` means the server went away.
`live` with stale data means the server is up but a poller is failing — and in that case an
`error` toast should have told you which scope.

---

## Live container stats

The `containers` channel carries `wslc stats` output as **raw text**. The client parses it (in
`pages/Containers.tsx`) rather than the server, because the column layout is not something the
project is willing to hard-code a promise about.

The parse:

- Splits columns on **two or more spaces**.
- Finds the CPU column by looking for a header containing `CPU`, memory by `MEM`, and the
  container key by `ID`/`CONTAINER`/`NAME`.
- Takes only the part before `/` in a memory cell (`12MiB / 1GiB` → `12MiB`).
- Returns `null` — and the UI falls back to a raw `<pre>` dump — if there is no CPU or MEM
  column at all.

**If `wslc stats` changes its layout, the app degrades to showing you the raw text.** It does
not invent numbers and it does not crash. The KPI tiles read "no stats reported" and the CPU/Mem
table columns disappear.

One subtlety that was a real bug: the memory total uses **one binary base for both parsing and
formatting** (`K=1024`, `M=1024²`, …). Parsing `MB` as decimal and formatting as binary ran the
total about 4.8% low. If you touch that code, keep the bases consistent.

---

## The capability probe

Everything the UI enables or greys out comes from one endpoint:

```powershell
curl.exe -H "Authorization: Bearer $t" http://127.0.0.1:8747/api/capabilities
```

```jsonc
{
  "wsl":  { "present": true, "version": "2.9.3.0" },
  "wslc": {
    "present": true,
    "version": "2.9.3.0",
    "topVerbs":       ["container", "image", "run", "volume", "..."],
    "containerVerbs": ["inspect", "list", "logs", "prune", "start", "stop", "..."],
    "imageVerbs":     ["inspect", "list", "prune", "..."],
    "volumeVerbs":    ["create", "inspect", "list", "prune", "remove"],
    "runFlags":       ["--entrypoint", "--gpus", "--shm-size", "-e", "-v", "..."],
    "can": {
      "run": true, "stop": true, "start": true, "rmContainer": true,
      "pull": true, "rmImage": true, "volumes": true, "entrypoint": true
      // …
    }
  },
  "windows":        { "build": 19045, "win11": false },
  "wslSettingsApp": { "present": true, "path": "C:\\Program Files\\WSL\\wslsettings.exe" },
  "probedAt": "2026-07-14T09:12:00.000Z"
}
```

**This is the single source of truth for "why is that button greyed out".** Every disabled
control in the UI carries a `title` naming the exact verb it needs. Cross-reference it against
`can` here.

The probe runs `wslc version`, then `wslc --help`, `container --help`, `image --help`,
`run --help` and `volume --help`, and parses the verbs and flags out of them. It is **cached for
60 seconds**. `?force=1` bypasses the cache — which is exactly what the **Re-check** button on
the unavailable-hero screen does after you run `wsl --update`.

---

## Error surfaces

The app is deliberately loud about failure and never fabricates success.

| Where | What you see |
| --- | --- |
| **Toasts** | Transient failures and every SSE `error` frame. Errors persist 10 s, others 5 s. The detail is expandable and mirrored into an `sr-only` span so screen readers actually announce it. |
| **Error dialogs** (Deploy) | Deploy failures open a centered, fully-expanded modal with the raw `stderr` in a `<pre>`. Not a toast — a failed deploy is not something you should be able to miss. |
| **Error banner** (Resources) | A dismissible banner above the cards. |
| **Native message box** | Fatal startup errors only. In the compiled exe the console is hidden, so this is the *only* channel that can reach the user. |

**Every `stderr` from a failed child process is passed through verbatim.** A 502 response
carries `{error: "command_failed", exitCode, stderr, stdout}`. The app never summarises,
paraphrases or swallows what `wsl.exe` told it.

---

## Health checks

There is no `/health` endpoint. The equivalents:

| Question | How |
| --- | --- |
| Is the server up? | `GET /api/capabilities` returns 200. |
| Is the stream alive? | The top bar says `live`; or a `:hb` arrives on `/api/events` every 25 s. |
| Is `wslc` usable? | `capabilities.wslc.present` — and `.can` for each specific verb. |
| Did the server die under a live window? | The main thread re-points its worker handlers after startup precisely to catch this, and shows a "server stopped" message box. There is **no restart supervisor** — that is deliberately out of scope. |

---

## Resource ceilings

Bounds that exist so a runaway client cannot exhaust the process:

| Limit | Value | Where |
| --- | --- | --- |
| Concurrent SSE clients | **64** | A renderer reconnecting in a loop cannot grow the client set without bound. Beyond it: 503. |
| Request body | **1 MB** | Rejected on `Content-Length`, *before* buffering. |
| `.wslconfig` raw text | **64 KB** | |
| `read-text` file size | **256 KB** | Checked before *and* after the read — a file that grows in between cannot slip past. |
| Registry API response | **2 MB** | The stream is cancelled the moment the cap is crossed. |
| Child process timeouts | 10 s default; 30–120 s for most verbs; **300 s** for pulls; **600 s** for export/import/resize/move; **1800 s** for `wsl --install` | Every child is killed on timeout. No zombies. |
| Capability cache | 60 s | |
| `.wslconfig` backups kept | 5 | Newest win; older rotated away. |

---

## Related

- [API endpoints](../reference/api-endpoints.md) — every route and its error codes.
- [Architectural overview](../concepts/architectural-overview.md) — why the event hub is shaped this way.
- [Security model](../concepts/security-model.md) — why the SSE route is the one token-in-query exception.
