# Docker & Compose compatibility

> **This project ships no `Dockerfile` and no `docker-compose.yml`, and it is not run in a
> container.** It is a Windows desktop executable.
>
> What it *does* have is a deep relationship with the Docker ecosystem: it **manages containers**
> through `wslc`, **imports** docker-compose and Kubernetes files, and **exports** standard
> `docker-compose.yaml`. This page is the reference for that compatibility layer — exactly what
> is honoured, exactly what is dropped, and why.

If you were looking for how to build or deploy the app itself, see
[Building and releasing](../guides/deploying-to-production.md).

---

## `wslc` is not Docker

Read this table before you assume anything transfers.

| | Docker / Docker Desktop | `wslc` |
| --- | --- | --- |
| Compose | `docker compose up` | **None.** No compose support at all. |
| Build | `docker build` | **None.** It cannot build images. |
| Run | `docker run` | `wslc run` — a broadly similar flag set |
| Volumes | full lifecycle | full lifecycle — **but `prune` only removes *anonymous* volumes** |
| Networks | user-defined networks, DNS between containers | `--network` exists as a run flag; there is no network-management surface |
| Registry auth | `docker login` | `login`/`push` exist in the binary; **this app does not expose them** — public images only |
| Swarm / Kubernetes | yes / via Desktop | **no** |

**The Deploy page exists precisely because `wslc` has no compose.** The app compiles your
compose file into an ordered sequence of documented `wslc run` calls, shows you the exact command
lines, and runs them one by one. It does not emulate compose — it tells you honestly what it can
execute and what it had to drop.

---

## The prime directive of the importer

> **Nothing is silently dropped. Nothing is ever guessed.**

Every key the app cannot honour produces a **specific, itemised warning** naming the value and
the reason. The UI renders that list **in full — never truncated, never summarised, never as a
toast that disappears**. Zero warnings gets you an explicit green banner saying so.

Only two things are hard rejects (HTTP 400), because there is genuinely nothing to run:

- a compose service with `build:` and no `image:`
- a file containing no workload at all

Everything else degrades with an explanation.

---

## Docker Compose → `wslc run`

### Honoured

| Compose key | Becomes | Notes |
| --- | --- | --- |
| `image` | the image argument | **Required.** |
| `ports` | `-p HOST:CONTAINER` | Short and long form. **TCP only.** |
| `command` | positional args after the image | String form is shlex-split (`"npm start"` → `["npm","start"]`). |
| `entrypoint` | `--entrypoint` 🔒 | First token becomes the flag; the rest fold into `command`. |
| `environment` | `-e KEY=value` | List or map form. |
| `volumes` | `-v` | Short string form only. |
| `mem_limit` | `-m` | Converted to a docker-style binary size. |
| `cpus` / `cpu_count` | `--cpus` | |
| `shm_size` | `--shm-size` 🔒 | |
| `container_name` | *(checked)* | See below. |
| `name` (top level) | the stack name | |

🔒 = gated on `wslc run --help` advertising the flag on your host. If it doesn't, deploy returns
**409 `verb_unavailable`** rather than emitting a flag `wslc` won't understand.

### Dropped — with a warning, every time

| Compose input | What you get told |
| --- | --- |
| `build:` **with** an `image:` | *"ignored — wslc cannot build images; running image `X` as given"* |
| `build:` **without** an `image:` | **400.** *"there is nothing to run. Build it yourself and add the resulting image: tag."* |
| `ports: "80"` (no host port) | *"dropped — no host port, so nothing is published (compose would pick a random one; we never invent one)"* |
| `ports: "8080:80/udp"` | *"dropped — wslc run -p publishes TCP only"* |
| `ports: "127.0.0.1:8080:80"` | *"dropped — a host IP binding is not a documented wslc run -p form"* |
| `environment: {KEY: null}` | *"ignored — no value in the file (compose would inherit it from the shell; we never invent one)"* |
| `entrypoint: ""` | *"an empty entrypoint means 'run no ENTRYPOINT at all' in compose — wslc run --entrypoint needs an executable, so the image's own ENTRYPOINT still runs"* |
| `command: "sh -c 'unbalanced"` | *"dropped — unbalanced quotes"* |
| `container_name` ≠ `<stack>-<service>` | *"cannot be honoured — stack containers are named `<stack>-<service>`, so this one runs as `X`"* |
| `version:` | *"ignored — obsolete in the compose spec and meaningless to wslc"* |
| `depends_on`, `restart`, `networks`, `healthcheck`, `deploy`, `logging`, … | *"ignored — wslc run documents no equivalent"* |
| Two services whose names collapse to the same key (`Api` / `api`) | *"a second service resolves to the same name — only the first is kept"* |
| A `mem_limit` that must be rounded | *"rounded to `512M` (whole MiB)"* |

**A bad *value* is dropped; it does not sink the whole file.** An unparseable port in one service
produces a warning for that port. It does not 400 your entire compose file. (This was a real bug
once, and it is now covered by tests.)

---

## Kubernetes → `wslc run`

The importer accepts **Pod, Deployment, StatefulSet, DaemonSet, ReplicaSet, Job and CronJob** —
located by *shape* (a pod template with a `containers` array), not by an allowlist of kinds.

### Honoured

| Kubernetes | Becomes |
| --- | --- |
| `spec.containers[].image` | the image |
| `command:` | **`--entrypoint command[0]`**, with `command[1:]` + `args` positional |
| `args:` (alone) | positional command — the image's `ENTRYPOINT` stays intact |
| `env[].value` | `-e KEY=value` |
| `env[].valueFrom.configMapKeyRef` / `secretKeyRef` | resolved — **only from ConfigMaps/Secrets in the same file** |
| `envFrom.configMapRef` / `secretRef` | resolved, same restriction |
| `ports[].hostPort` + `containerPort` | `-p HOST:CONTAINER` |
| `volumeMounts` → a `hostPath` volume | `-v HOST:CONTAINER` |
| `resources.limits.memory` | `-m` — **decimal → binary, with a warning when it rounds** |
| `resources.limits.cpu` | `--cpus` — millicores (`500m`) converted to `0.5` |

The `command`/`args` mapping is exact. k8s `command:` overrides the image `ENTRYPOINT`; `args:`
alone replaces only `CMD`. Both land on the identical argv `wslc` executes, so neither needs a
warning.

### Dropped — with a warning

| Kubernetes input | What you get told |
| --- | --- |
| `replicas: 3` | *"3 requested — wslc has no scheduler, so exactly 1 container is started"* |
| `ports[]` with no `hostPort` | *"nothing is published — the manifest sets no hostPort (a k8s Service is not a wslc concept)"* |
| Any non-TCP port | *"dropped — wslc run -p publishes TCP only"* |
| A `configMapKeyRef` naming a ConfigMap **not in the file** | *"not in file — dropped (never guessed, never defaulted)"* |
| A volume that isn't `hostPath` (`emptyDir`, `pvc`, `configMap`…) | *"dropped — X volumes have no wslc equivalent (only hostPath maps to -v)"* |
| `volumeMounts[].readOnly: true` | *"mounted read-write — readOnly is not a documented wslc run -v option"* |
| `initContainers`, `nodeSelector`, `affinity`, `tolerations`, `serviceAccountName`, `securityContext`, `restartPolicy` | *"ignored — no wslc equivalent"* |
| `resources.requests` | *"ignored — wslc run sets limits, not scheduling requests"* |
| A Service, Ingress, PVC, … | *"skipped — not a workload (it carries no pod template)"* |

**Secrets and ConfigMaps are resolved only from the same file.** A reference to something that
isn't there is **dropped with a warning** — never guessed, never defaulted to an empty string.
`Secret.data` is base64-decoded; `stringData` is taken as plain text. A resolved value carrying
control characters is dropped rather than mangled, because it cannot survive `-e KEY=value`.

`env` is applied **after** `envFrom`, last-wins, and duplicate keys are collapsed to a single
`-e` — matching Kubernetes semantics, rather than emitting two flags that only happen to resolve
correctly.

Multiple containers in one pod become `<workload>-<container>` services.

---

## Size units: the trap

**`512M` means different things in Kubernetes and Docker, and the difference is silent.**

| Dialect | `512M` | `512Mi` |
| --- | --- | --- |
| **Kubernetes** | 512 × 10⁶ = **512,000,000 bytes** (decimal SI) | 512 × 1024² = 536,870,912 bytes |
| **Docker / compose / `wslc run`** | 512 × 1024² = **536,870,912 bytes** (binary) | same |

A 4.9% difference, in the direction of "your container gets less memory than the manifest asked
for" — and nothing tells you.

The importer converts k8s decimal units into the binary sizes `wslc run -m` documents, and
**warns whenever the conversion had to round**:

```
web.resources.limits.memory: "512M" → 489M (k8s decimal units rounded to whole MiB; wslc -m is binary)
```

One more k8s trap the importer handles: a **lowercase `m`** is the *milli* suffix. `100m` of
memory is a hundredth of a byte, not 100 MB. Rather than folding it to megabytes — which would
read `100m` as `100M` and silently give the container 100 MiB — it is dropped with a warning.
(CPU millicores are a separate, legitimate path and *are* converted: `500m` → `--cpus 0.5`.)

The `.wslconfig` and `wsl --manage --resize` grammars are different again. See
[size grammars](data-model.md#size-grammars).

---

## The `docker-compose.yaml` export

Any stack — built in the form, or imported from a Kubernetes manifest — exports as a standard
compose file. This is your **exit path**: nothing you build here traps you in this tool.

```yaml
# Generated by wslc-gui from stack "myapp"
# Deployable subset only (ports/entrypoint/command/env/volumes/limits/container_name)
name: myapp
services:
  web:
    image: nginx:latest
    container_name: myapp-web
    ports:
      - "8080:80"
    environment:
      - LOG_LEVEL=debug
    mem_limit: 512M
```

It contains **only the subset the app can actually execute** — which is precisely why it is
trustworthy. It is a real compose file that will run under `docker compose up`, and it round-trips:
re-importing it produces the same stack.

---

## Volume semantics

Volumes work, and mostly as you'd expect — with two differences that matter.

**`wslc run -v NAME:/path` auto-creates a named volume**, and it survives the container. Compose's
semantics are honoured exactly; there is nothing to warn about.

**`wslc volume prune` is much narrower than `docker volume prune`.** Its own help says:
*"Removes all unused **anonymous** local volumes."*

- Anonymous volumes with no container referencing them → **deleted**.
- An unused **named** volume → **survives.** (Docker would delete it.)
- A volume whose container exists but has *exited* → **survives.** It is still a reference.

The more destructive `--all` flag is **deliberately not exposed** by this app. The route requires
`{"confirm": true}`, the UI requires you to type the word `prune`, and the result reports every
volume name `wslc` said it removed — parsed from its output, never inferred.

**There is no volume size anywhere in the UI.** `wslc volume inspect` reports neither a size nor
a mountpoint, so a per-volume byte count cannot be obtained — and is not invented. Those bytes are
already counted in the Resources page's "Container storage" tile, which reads the actual session
VHD.

---

## Coming from Docker Desktop

| You'd normally… | Here |
| --- | --- |
| `docker compose up` | **Deploy → From file.** Pick the compose file, read the warnings, review the exact plan, deploy. |
| `docker compose down` | **Deploy → Deployed stacks → Take down.** |
| `docker run -d -p 8080:80 nginx` | **Deploy → Quick run.** The live preview shows the exact `wslc run` line before you commit. |
| `docker ps` | **Containers.** |
| `docker logs -f` | **Containers → kebab → Logs.** (A snapshot, not a follow — `wslc container logs` is not streamed.) |
| `docker exec -it sh` | **Containers → kebab → Exec.** One command per run; not an interactive TTY. |
| `docker build` | **Not possible.** `wslc` cannot build images. Build elsewhere, then reference the tag. |
| `docker login` + private images | **Not supported.** Public registries only. |
| Settings → Resources → Memory/CPU | **Settings → WSL → `.wslconfig`.** Same underlying VM, different file. |

The Deploy page's **command preview** is the thing worth internalising. Docker Desktop hides the
command it runs. This app shows you the exact argv before you press the button — and if it cannot
express something honestly, it disables the control and tells you which verb your `wslc` build is
missing.

---

## Related

- [Data model](data-model.md#stacks) — the strict `ServiceSpec` everything normalises into.
- [API endpoints](api-endpoints.md#stacks) — `/api/stacks/compile` and its `warnings` contract.
- [Architectural overview](../concepts/architectural-overview.md#stacks-compose-without-compose) — why the importer is lenient and the schema is strict.
