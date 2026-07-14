# How to run the tests

```powershell
cd app
deno task test
```

That's it. **166 tests across 17 files, in about one second.**

```
ok | 166 passed | 0 failed (1s)
```

---

## What the task actually runs

```
deno test --allow-read --allow-env tests/
```

Look at those permissions. The suite gets `--allow-read` and `--allow-env` and **nothing else**
— no `--allow-run`, no `--allow-write`, no `--allow-net`.

That is a design constraint, not an oversight. **The tests cannot spawn a process, write a
file, or reach the network.** If a test could, it would be testing your machine rather than the
code. So the suite is fast, hermetic, and safe to run anywhere — and the code was shaped to
make that possible:

- Anything that shells out is split into a **pure function** (the argument builder, the output
  parser, the capability mapper) and a thin impure caller. The pure half is what gets tested.
- Anything that writes takes an **injectable IO port** — `writeWslConfig(text, io)` and
  `readTextDoc(path, io)` both accept a filesystem interface, so the tests drive every branch
  (symlink rejection, oversize file, TOCTOU growth, backup rotation) with a fake.

When you add code, keep this property. If a new test needs `--allow-run` to pass, the design is
usually wrong.

---

## Useful invocations

| Goal | Command |
| --- | --- |
| Everything | `deno task test` |
| One file | `deno test --allow-read --allow-env tests/validate_test.ts` |
| One test by name | `deno test --allow-read --allow-env tests/ --filter "buildRunArgs"` |
| Re-run on save | `deno test --allow-read --allow-env --watch tests/` |
| Coverage | `deno test --allow-read --allow-env --coverage=cov tests/` then `deno coverage cov` |
| Verbose failures | add `--fail-fast` to stop at the first one |

---

## What is covered

| File | Tests | What it pins down |
| --- | ---: | --- |
| `import_test.ts` | 34 | The compose/Kubernetes importer — by far the largest surface. Size-unit dialects (k8s `512M` is decimal, docker `512M` is binary), `envFrom` resolution from in-file ConfigMaps/Secrets, entrypoint/command splitting, drop-with-warning for everything unhonourable, name collisions, multi-doc manifests. |
| `validate_test.ts` | 19 | Every input validator. Leading-dash rejection, control characters, image-ref grammar, the `.wslconfig` size guard that refuses `4G`. |
| `parsers_test.ts` | 16 | Table/help/version/registry parsing. Distro names with spaces, ANSI codes, advisory lines, `--help` verb and flag extraction. |
| `wslc_test.ts` | 13 | `buildRunArgs` — the exact flag order and content of every `wslc run`. |
| `stacks_test.ts` | 13 | Stack schema validation and the compiler (plan + `docker-compose.yaml` export). |
| `read_text_test.ts` | 10 | The one file-read endpoint: extension allowlist, symlink/junction rejection, size cap before *and* after the read. |
| `auth_test.ts` | 9 | Token comparison, origin checks, the SSE query-param exception, JSON content-type enforcement. |
| `wslconfig_test.ts` | 9 | Line-preserving edits (comments and unknown keys survive), backup rotation, atomic write sequence. |
| `capabilities_test.ts` | 8 | Verb detection from real `wslc 2.9.3.0` `--help` fixtures. |
| `static_test.ts` | 7 | Static serving: traversal rejection, SPA fallback, CSP headers. |
| `exec_decode_test.ts` | 5 | UTF-16LE/BOM/interleaved-NUL decoding of `wsl.exe` output. |
| `registry_tags_test.ts` | 5 | Image-ref splitting, tag sorting, the link-local SSRF block. |
| `app_config_test.ts` | 4 | Config validation and corrupt-file quarantine. |
| `normalize_test.ts` | 4 | Mapping `wslc` table columns to stable UI shapes. |
| `routes_test.ts` | 4 | Pure route predicates (body-size gate, run-flag gating). |
| `runner_test.ts` | 4 | Orphaned-container carry-over on stack redeploy. |
| `sse_test.ts` | 2 | The client ceiling and the in-flight guard. |

Fixtures live in `tests/fixtures/`:

- **`wslc_real_output.ts`** — real captured output from `wslc 2.9.3.0`. The capability tests
  assert against what the binary actually printed, not against what anyone assumed it would.
- **`sample-compose.yaml`** — a compose file for the importer tests.

---

## What is *not* covered

Be honest with yourself about this before you ship.

The suite is **unit tests only**. There are no integration tests, no E2E tests, and no test
runner for the UI. Nothing in `deno task test` touches:

- the compiled `.exe`,
- the WebView2 window,
- the system tray,
- the native file/folder dialogs,
- any real `wsl.exe` or `wslc.exe` invocation,
- the React components.

**All of that is verified by hand.** The
[pre-release checklist](deploying-to-production.md#pre-release-checklist) is the closest thing
to an E2E suite this project has, and running it before a release is not optional.

If you want a read-only live check of the adapter against your actual machine:

```powershell
deno run --allow-run --allow-read --allow-env --allow-sys=osRelease scripts/smoke.ts
```

`scripts/smoke.ts` prints a JSON summary of capabilities, distros, `.wslconfig` sections, VHDX
sizes and swap. **It mutates nothing.** It is not part of the test suite because it depends
entirely on the host it runs on.

---

## Writing a new test

Standard `Deno.test`, `@std/assert`:

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { buildRunArgs } from "../adapter/wslc.ts";
import { ValidationError } from "../adapter/validate.ts";

Deno.test("buildRunArgs: --entrypoint sits immediately before --name", () => {
  const args = buildRunArgs({
    image: "nginx:latest",
    name: "web",
    entrypoint: "/bin/sh",
    command: ["-c", "echo hi"],
  });
  assertEquals(args, [
    "run", "-d", "--entrypoint", "/bin/sh", "--name", "web",
    "nginx:latest", "-c", "echo hi",
  ]);
});

Deno.test("buildRunArgs: an image that looks like a flag is refused", () => {
  assertThrows(() => buildRunArgs({ image: "--privileged" }), ValidationError);
});
```

Three habits worth copying from the existing suite:

**Test the pure function, not the process.** If you're adding a `wslc` verb, test the argument
builder and the output parser. The `exec()` call between them has one job and is already
covered.

**Name the test after the behaviour, including the failure it prevents.** The existing names
read like `"setValue: replaces existing key, preserves comments and layout"` and
`"writeWslConfig: backup + atomic tmp→rename + rotation when a prior file exists"`. When one
breaks, you know what you broke without opening the file.

**Fixtures come from the real binary.** If you need `wslc` output, capture it and add it to
`tests/fixtures/wslc_real_output.ts`. Do not hand-write what you think the output looks like —
that is how you end up with tests that pass against a fiction.

---

## In CI

The test step runs on `windows-latest` on every push and pull request, between the backend
typecheck and the frontend build. See
[`.github/workflows/build.yml`](../../.github/workflows/build.yml).

A red test fails the build and blocks the PR. Because the suite needs no process, no network and
no filesystem writes, it behaves identically on CI and on your machine — there is no "works on
my box" failure mode here.

---

## Related

- [Local development](../getting-started/03-local-development.md) — the full "before you push" list.
- [Development planning](development-planning.md) — the bar a change has to clear.
