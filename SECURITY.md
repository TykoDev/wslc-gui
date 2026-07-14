# Security Policy

## Our approach

This app holds no secrets and serves one local user. It would be easy to conclude that its
security posture doesn't matter much.

That conclusion is wrong, and it is worth being blunt about why:

> **The app runs a loopback HTTP server whose endpoints delete distributions, shut down the WSL
> VM, and execute arbitrary containers.** Any process on the machine — and **any website open in
> any browser on the machine** — can attempt `fetch("http://127.0.0.1:PORT/api/...")`.

An unauthenticated version of this app would let a random web page destroy your Ubuntu install via
a drive-by request. Everything in the security model exists to make that impossible, and we treat
reports against it seriously.

The full model — trust boundaries, controls, verification commands, and the risks we **accepted**
rather than closed — is documented in
**[docs/concepts/security-model.md](docs/concepts/security-model.md)**. Reading it before you
report is worthwhile: several classes of finding are already known and recorded there.

---

## Supported versions

| Version | Supported |
| --- | --- |
| `master` (unreleased) | ✅ Yes |

**No version has been tagged yet.** Until a first release exists, security fixes land on `master`.
Once releases begin, the most recent minor version will receive security updates and this table
will be kept current.

---

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.** A public report gives everyone
the exploit before anyone has the fix.

Use one of these private channels instead:

### 1. GitHub Security Advisories — preferred

Go to the repository's **[Security → Report a vulnerability](https://github.com/TykoDev/wslc-gui/security/advisories/new)**
tab. This opens a private advisory visible only to you and the maintainers, and it lets us
collaborate on a fix and coordinate disclosure in one place.

### 2. Email

**stoffe@tykotech.eu**

Use the subject line `[SECURITY] wslc-gui` so it doesn't get lost. If you would like to encrypt
your report, say so and we will arrange a key.

---

## What to include

The more of this you can give us, the faster the fix:

- **A description** of the vulnerability and the class it falls into (e.g. CSRF, command injection,
  path traversal, SSRF).
- **Impact.** What can an attacker actually do? Who has to be tricked into what? A finding that
  requires the user to already be running arbitrary code as themselves is different from one a web
  page can trigger silently.
- **Steps to reproduce** — a `curl` invocation, a proof-of-concept HTML page, or a code path. The
  most useful reports are the ones we can run.
- **The version.** The commit hash, or the release you downloaded.
- **Your environment.** Windows version and build, WSL version, whether `wslc` is present.
- **Any suggested fix**, if you have one in mind.

### Especially valuable

If you can demonstrate any of the following, we want to hear about it immediately:

- A way to make an `/api` call **without a valid session token**.
- A way for a **web page on another origin** to reach a mutating endpoint (bypassing the origin
  check or the JSON content-type requirement).
- A way to make the app **spawn a binary outside the allowlist** (`wsl`, `wslc`, `reg`,
  `explorer`), or to inject a **flag** into a command through a value (the leading-dash rule).
- A way to reach a **destructive endpoint** without its server-side confirmation echo
  (`confirmName` / `confirm: true`).
- A way to **read a file** outside the `.yaml`/`.yml` allowlist through `/api/system/read-text`,
  including via a link type we don't reject.
- A way to **exfiltrate the session token** out of the renderer despite the CSP.
- A path-traversal escape from the in-memory static file map.

---

## Already known — please read before reporting

These are documented, deliberate, and recorded in the
[security model](docs/concepts/security-model.md#accepted-residual-risks). Reporting them again is
not useful, though a *bypass* of the reasoning behind them very much is:

| Known item | Why it stands |
| --- | --- |
| **`--allow-read` / `--allow-write` are unscoped** in the compiled binary | The paths the app touches (`%APPDATA%`, `%USERPROFILE%\.wslconfig`, arbitrary VHDX locations, user-picked export targets) are not knowable at compile time, and pinning them risks breaking across WSL updates. Every write site is centralised. `--allow-run`, `--allow-net`, `--allow-ffi` and `--allow-env` *are* scoped. |
| **Hardlinks bypass the `read-text` symlink check** | A hardlink is indistinguishable from the file itself at the syscall level — it cannot be closed. On a loopback single-user box, the token-holder can read their own files anyway; the check closes the cheap symlink/junction vector, which is the one worth closing. |
| **DNS-name SSRF is out of scope** | Only IPv4 *literals* in `169.254.0.0/16` are blocked. Resolving every registry hostname and re-checking the resolved IP would break legitimate LAN and `localhost:5000` registries — a worse outcome for a local-first container tool. |
| **Loopback and RFC1918 registries are allowed** | Deliberate. A private registry on your LAN is a legitimate target, not an attack. |
| **Token lifetime = process lifetime** | Acceptable for a single-user local tool. Regenerated on every launch. |
| **`wsl --mount` may require elevation** | The app never auto-elevates and never raises a UAC prompt. It surfaces `stderr` and lets you decide. |

**A bypass of any of the *reasoning* above is in scope.** For example: if you can show that the
link-local block can be defeated with an IPv6 literal, an octal-encoded IPv4, or a redirect chain —
that is a real finding, and we want it.

---

## What happens next

| When | What |
| --- | --- |
| **Within 72 hours** | We acknowledge your report and confirm we can reproduce it (or tell you what we're missing). |
| **Within 7 days** | We give you an assessment: severity, whether we consider it in scope, and a rough timeline. |
| **Then** | We develop and test a fix privately, and keep you updated. |
| **On release** | The fix ships, the advisory is published, and — unless you'd rather not be named — **you are credited.** |

This is a small project maintained by very few people. If a timeline slips we will tell you rather
than go quiet. If you have not heard from us in a week, please chase — the message may simply have
been missed, and we would rather be nagged than leave a real issue unfixed.

---

## Disclosure

We ask for **coordinated disclosure**: give us a reasonable window to ship a fix before going
public. **90 days** is the default, and we will normally be much faster than that.

If a vulnerability is being actively exploited, tell us and we will treat it as an emergency and
disclose alongside the fix as fast as we can build one.

We will not take legal action against anyone who reports a vulnerability in good faith, follows
this policy, and does not access, modify or destroy other people's data in the course of their
research.

**Thank you.** Finding these things is real work, and doing it responsibly is a genuine service to
everyone who uses this software.
