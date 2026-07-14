import { useRef, useState } from "react";
import { useApp } from "../state.tsx";
import { api, ApiError } from "../lib/api.ts";
import { CopyButton, EmptyState, ErrorBanner, PickButton, Tablist, WslcUnavailableHero } from "../components/bits.tsx";
import { SizeInput } from "../components/SizeInput.tsx";
import { ConfirmModal, Modal } from "../components/Modal.tsx";
import { ActionMenu } from "../components/Menu.tsx";
import { Icon } from "../components/icons.tsx";
import type { CompiledStack, CompileResult, StackRecord, StackSource, ReadTextResult } from "../lib/types.ts";

interface QuickDraft {
  image: string;
  name: string;
  ports: string[];
  volumes: string[];
  env: string[];
  detach: boolean;
  rm: boolean;
  interactive: boolean;
  command: string;
  entrypoint: string;
  tmpfs: string;
  envFile: string;
  memory: string;
  shmSize: string;
  cpus: string;
  gpus: string;
  workdir: string;
  user: string;
  network: string;
  hostname: string;
}

/** Split a command line into argv the way a shell would: quotes group tokens and are
 * stripped. The server trusts this tokenization verbatim (commandTokens does not re-split),
 * so `sh -c "npm run build && npm start"` must become ["sh","-c","npm run build && npm start"],
 * not a split on every space (FE-2). Never returns null — an unbalanced quote keeps the
 * remainder as one token so the preview and the request stay the same command. */
export function tokenizeCommand(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const c of line) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started || cur) {
        out.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += c;
  }
  if (started || cur) out.push(cur);
  return out;
}

/** Quote a token for the copy-to-terminal preview. FE-4: the in-app request sends each
 * value's RAW string (no escaping), so the preview must round-trip to that same string once
 * a shell strips the quotes. `JSON.stringify` did not — it DOUBLES backslashes, so a copied
 * Windows-path volume like `C:\my data:/data` came out `"C:\\my data:/data"`, which no shell
 * un-escapes. Plain double quotes leave the backslashes intact (correct for cmd/PowerShell,
 * where wslc.exe is invoked); only an embedded `"` needs escaping. Untouched when no quoting
 * is required, so the common case stays clean. */
function shellQuote(t: string): string {
  if (t === "") return '""';
  if (!/[\s"]/.test(t)) return t;
  return `"${t.replaceAll('"', '\\"')}"`;
}

/** Client-side preview mirror of the server's buildRunArgs — same flag order
 * (server re-validates; this only has to be honest about what will run).
 * `--shm-size` is emitted after `--cpus`, matching adapter/wslc.ts:buildRunArgs, which
 * appended it there so every pre-existing flag kept its position. If that order moves,
 * this must move with it or the preview lies about the command that runs.
 * r9 pins `--entrypoint` immediately before `--name` (build brief r9.1, "Flag order") —
 * both packages emit it there, so the preview and buildRunArgs stay one command.
 * FE-15: `--entrypoint` is gated on `canEntrypoint`, matching the send path — a build
 * without the verb never shows a flag it would strip before sending. */
function previewRun(s: QuickDraft, canEntrypoint: boolean): string {
  const parts = ["wslc", "run"];
  const push = (flag: string, val: string) => {
    const t = val.trim();
    if (t) parts.push(flag, shellQuote(t));
  };
  if (s.detach) parts.push("-d");
  if (s.rm) parts.push("--rm");
  if (s.interactive) parts.push("-it");
  for (const p of s.ports) push("-p", p);
  for (const m of s.volumes) push("-v", m);
  push("--tmpfs", s.tmpfs);
  for (const e of s.env) push("-e", e);
  push("--env-file", s.envFile);
  push("-m", s.memory);
  push("--cpus", s.cpus);
  push("--shm-size", s.shmSize);
  push("--gpus", s.gpus);
  push("-w", s.workdir);
  push("-u", s.user);
  push("--network", s.network);
  push("-h", s.hostname);
  if (canEntrypoint) push("--entrypoint", s.entrypoint);
  push("--name", s.name);
  parts.push(s.image.trim() || "<image>");
  // Quote a token that contains spaces so the preview reads as the argv that runs.
  for (const tok of tokenizeCommand(s.command)) parts.push(shellQuote(tok));
  return parts.join(" ");
}

export interface DeployError {
  title: string;
  detail?: string;
}

/** Deploy-page failures open centered and fully expanded (r7-u6) instead of
 * collapsing into a corner toast. */
function ErrorDialog({ err, onClose }: { err: DeployError; onClose: () => void }) {
  return (
    <Modal
      title={err.title}
      onClose={onClose}
      wide
      actions={<button className="primary" onClick={onClose}>Close</button>}
    >
      {err.detail
        ? <pre className="mono" style={{ margin: 0, background: "var(--danger-soft)", borderRadius: 8, padding: 12, maxHeight: "50vh", overflowY: "auto" }}>{err.detail}</pre>
        : <p>The command failed without further output.</p>}
    </Modal>
  );
}

/** Repeatable one-line entries (ports, volumes, env) with remove/add controls. */
function ListField({ label, items, onChange, placeholder, width = 170, addLabel }: {
  label: string;
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  width?: number;
  addLabel: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {items.map((val, i) => (
          <span key={i} className="pickrow" style={{ width }}>
            <input type="text" value={val} placeholder={placeholder}
              aria-label={`${label} ${i + 1}`}
              onChange={(e) => onChange(items.map((x, xi) => xi === i ? e.target.value : x))} />
            <button className="icon small" aria-label={`Remove ${label} ${i + 1}`}
              onClick={() => onChange(items.filter((_, xi) => xi !== i))}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <button className="small ghost" onClick={() => onChange([...items, ""])}>
          <Icon name="plus" size={12} />
          {addLabel}
        </button>
      </div>
    </label>
  );
}

interface SvcDraft {
  id: number;
  service: string;
  image: string;
  ports: string;
  command: string;
  entrypoint: string;
  rm: boolean;
  env: string; // one KEY=value per line
  volumes: string; // one host:container per line
  memory: string;
  cpus: string;
}

const splitLines = (s: string): string[] => s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

let svcId = 1;

const emptySvc = (service: string): SvcDraft => ({
  id: svcId++, service, image: "", ports: "", command: "", entrypoint: "", rm: false,
  env: "", volumes: "", memory: "", cpus: "",
});

/** Imported stack → the builder form's drafts. Lossy by construction: the form only
 * carries what it can represent, which is why the importer's warnings are shown on the
 * From-file tab *before* this hand-off (D4). */
const toDrafts = (stack: CompiledStack): SvcDraft[] => {
  const drafts = Object.entries(stack.services ?? {}).map(([service, s]) => ({
    id: svcId++,
    service,
    image: s.image ?? "",
    ports: (s.ports ?? []).join(", "),
    command: (s.command ?? []).join(" "),
    entrypoint: s.entrypoint ?? "",
    rm: s.rm ?? false,
    env: (s.env ?? []).join("\n"),
    volumes: (s.volumes ?? []).join("\n"),
    memory: s.memory ?? "",
    cpus: s.cpus ?? "",
  }));
  return drafts.length > 0 ? drafts : [emptySvc("web")];
};

export function DeployPage() {
  const { caps, stacks, toast, refreshStacks, images } = useApp();
  const [tab, setTab] = useState<"quick" | "stack" | "file">("quick");
  // Lifted so the From-file tab can hand a parsed stack to the builder (D4).
  const [stackName, setStackName] = useState("");
  const [services, setServices] = useState<SvcDraft[]>([emptySvc("web")]);

  const localImages = (images?.images ?? [])
    .map((i) => (i.repository && i.tag && i.tag !== "<none>" ? `${i.repository}:${i.tag}` : i.repository ?? i.id))
    .filter((r): r is string => typeof r === "string" && r.length > 0);

  if (caps === null) return <div className="page"><div className="card"><div className="body"><span className="skeleton" style={{ width: "50%" }} /></div></div></div>;
  if (!caps.wslc.present) return <div className="page"><WslcUnavailableHero /></div>;

  const openInBuilder = (stack: CompiledStack) => {
    const drafts = toDrafts(stack);
    setStackName(stack.name ?? "");
    setServices(drafts);
    setTab("stack");
    toast("info", `Loaded ${drafts.length} service${drafts.length === 1 ? "" : "s"} into the stack builder`,
      "Only fields the builder can represent were carried over — review the plan before deploying.");
  };

  return (
    <div className="page">
      <Tablist
        label="Deploy mode"
        idBase="deploy"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "quick", label: "Quick run", id: "tab-quick", controls: "panel-quick" },
          { value: "stack", label: "Stack (compose)", id: "tab-stack", controls: "panel-stack" },
          { value: "file", label: "From file", id: "tab-file", controls: "panel-file" },
        ]}
      />
      {/* Local images feed every image input on this page (type to add new refs). */}
      <datalist id="local-images">
        {localImages.map((r) => <option key={r} value={r} />)}
      </datalist>
      {tab === "quick" && (
        <div id="panel-quick" role="tabpanel" aria-labelledby="tab-quick">
          <QuickRun />
        </div>
      )}
      {tab === "stack" && (
        <div id="panel-stack" role="tabpanel" aria-labelledby="tab-stack">
          <StackBuilder
            stackName={stackName}
            setStackName={setStackName}
            services={services}
            setServices={setServices}
          />
        </div>
      )}
      {tab === "file" && (
        <div id="panel-file" role="tabpanel" aria-labelledby="tab-file">
          <FromFile onOpenInBuilder={openInBuilder} />
        </div>
      )}
      <DeployedStacks stacks={stacks} refresh={refreshStacks} toast={toast} canDown={caps.wslc.present} />
    </div>
  );
}

const QUICK_INITIAL: QuickDraft = {
  image: "", name: "", ports: [""], volumes: [], env: [],
  detach: true, rm: false, interactive: false, command: "", entrypoint: "",
  tmpfs: "", envFile: "", memory: "", shmSize: "", cpus: "", gpus: "",
  workdir: "", user: "", network: "", hostname: "",
};

/** r9 D1/DD4: `--entrypoint` is feature-detected, so a wslc build without it disables the
 * field instead of emitting a flag that cannot run. */
const NO_ENTRYPOINT_TITLE = "This wslc build does not expose run --entrypoint";

function QuickRun() {
  const { caps, toast } = useApp();
  const [d, setD] = useState<QuickDraft>(QUICK_INITIAL);
  const [busy, setBusy] = useState(false);
  const [errDlg, setErrDlg] = useState<DeployError | null>(null);
  const set = (patch: Partial<QuickDraft>) => setD((cur) => ({ ...cur, ...patch }));

  const canEntrypoint = caps?.wslc.can.entrypoint ?? false;
  const preview = previewRun(d, canEntrypoint);
  const clean = (xs: string[]) => xs.map((x) => x.trim()).filter((x) => x.length > 0);
  const advActive = [d.entrypoint, d.tmpfs, d.envFile, d.memory, d.shmSize, d.cpus, d.gpus, d.workdir, d.user, d.network, d.hostname]
    .filter((x) => x.trim() !== "").length;

  return (
    <div className="card">
      <header>Single container</header>
      <div className="body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="formrow">
          <label className="field" style={{ flex: 2, minWidth: 220 }}>
            <span className="req">Image (pick local or type a new ref)</span>
            <input type="text" value={d.image} placeholder="nginx:latest" list="local-images" onChange={(e) => set({ image: e.target.value })} />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 140 }}>
            <span>Container name</span>
            <input type="text" value={d.name} placeholder="web" onChange={(e) => set({ name: e.target.value })} />
          </label>
        </div>
        <ListField label="Ports (host:container)" items={d.ports} onChange={(ports) => set({ ports })}
          placeholder="8080:80" width={150} addLabel="Add port" />
        <ListField label="Volumes (-v host:container)" items={d.volumes} onChange={(volumes) => set({ volumes })}
          placeholder="C:\data:/data" width={260} addLabel="Add volume" />
        <ListField label="Environment (-e KEY=value)" items={d.env} onChange={(env) => set({ env })}
          placeholder="KEY=value" width={210} addLabel="Add variable" />
        <div className="formrow">
          <label className="checkline"><input type="checkbox" checked={d.detach} onChange={(e) => set({ detach: e.target.checked })} /> Detached (-d)</label>
          <label className="checkline"><input type="checkbox" checked={d.rm} onChange={(e) => set({ rm: e.target.checked })} /> Auto-remove (--rm)</label>
          <label className="checkline"><input type="checkbox" checked={d.interactive} onChange={(e) => set({ interactive: e.target.checked })} /> Interactive (-it)</label>
        </div>
        <div className="formrow">
          <label className="field" style={{ flex: 1, minWidth: 200, maxWidth: 560 }}>
            <span>Command (optional, tokens split on spaces)</span>
            <input type="text" value={d.command} placeholder="bash -c 'echo hi'" onChange={(e) => set({ command: e.target.value })} />
            {/* Armed only once an entrypoint is actually set — that is the moment these
                tokens stop being the command and become someone else's arguments. */}
            {d.entrypoint.trim() !== "" && (
              <span className="fieldhint">
                An entrypoint is set: these tokens are the arguments to{" "}
                <code>{d.entrypoint.trim()}</code>.
              </span>
            )}
          </label>
        </div>
        <details className="adv">
          <summary>Advanced options{advActive > 0 ? ` · ${advActive} set` : ""}</summary>
          <div className="advgrid">
            {/* First in the grid on purpose: it is the only flag here that changes *what
                runs*, and it must read next to the Command field just above. */}
            <label className="field">
              <span>Entrypoint (--entrypoint)</span>
              <input
                type="text"
                value={d.entrypoint}
                placeholder="/bin/sh"
                disabled={!canEntrypoint}
                title={canEntrypoint ? undefined : NO_ENTRYPOINT_TITLE}
                aria-describedby="ep-hint"
                onChange={(e) => set({ entrypoint: e.target.value })}
              />
              <span id="ep-hint" className="fieldhint">
                {canEntrypoint
                  ? "Replaces the image's entrypoint. Command above becomes its arguments."
                  : NO_ENTRYPOINT_TITLE}
              </span>
            </label>
            <span className="field"><span>Memory limit (-m)</span>
              <SizeInput label="Memory limit" value={d.memory} onChange={(memory) => set({ memory })}
                suffix="short" placeholder="512" /></span>
            <span className="field"><span>Shared memory (--shm-size)</span>
              <SizeInput label="Shared memory" value={d.shmSize} onChange={(shmSize) => set({ shmSize })}
                suffix="short" placeholder="64" /></span>
            <label className="field"><span>CPUs (--cpus)</span>
              <input type="text" value={d.cpus} placeholder="1.5" onChange={(e) => set({ cpus: e.target.value })} /></label>
            <label className="field"><span>GPUs (--gpus)</span>
              <input type="text" value={d.gpus} placeholder="all" onChange={(e) => set({ gpus: e.target.value })} /></label>
            <label className="field"><span>Working dir (-w)</span>
              <input type="text" value={d.workdir} placeholder="/app" onChange={(e) => set({ workdir: e.target.value })} /></label>
            <label className="field"><span>User (-u)</span>
              <input type="text" value={d.user} placeholder="uid[:gid]" onChange={(e) => set({ user: e.target.value })} /></label>
            <label className="field"><span>Network (--network)</span>
              <input type="text" value={d.network} placeholder="bridge" onChange={(e) => set({ network: e.target.value })} /></label>
            <label className="field"><span>Hostname (-h)</span>
              <input type="text" value={d.hostname} placeholder="web01" onChange={(e) => set({ hostname: e.target.value })} /></label>
            <label className="field"><span>Tmpfs (--tmpfs)</span>
              <input type="text" value={d.tmpfs} placeholder="/tmp" onChange={(e) => set({ tmpfs: e.target.value })} /></label>
            <label className="field"><span>Env file (--env-file)</span>
              <div className="pickrow">
                <input type="text" value={d.envFile} placeholder="C:\app\.env" onChange={(e) => set({ envFile: e.target.value })} />
                <PickButton spec={{ kind: "file-open", title: "Select env file" }} onPick={(p) => set({ envFile: p })} label="" />
              </div></label>
          </div>
        </details>
        <div className="cmdpreview">
          <code className="mono" aria-label="Command preview">{preview}</code>
          <CopyButton text={preview} label="" />
        </div>
        <div>
          <button className="primary" disabled={d.image.trim().length === 0 || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api("/api/run", {
                  method: "POST",
                  body: {
                    image: d.image.trim(),
                    name: d.name.trim() || undefined,
                    ports: clean(d.ports),
                    volumes: clean(d.volumes),
                    env: clean(d.env),
                    detach: d.detach,
                    rm: d.rm,
                    interactive: d.interactive,
                    command: tokenizeCommand(d.command),
                    entrypoint: canEntrypoint ? d.entrypoint.trim() || undefined : undefined,
                    tmpfs: d.tmpfs.trim() || undefined,
                    envFile: d.envFile.trim() || undefined,
                    memory: d.memory.trim() || undefined,
                    shmSize: d.shmSize.trim() || undefined,
                    cpus: d.cpus.trim() || undefined,
                    gpus: d.gpus.trim() || undefined,
                    workdir: d.workdir.trim() || undefined,
                    user: d.user.trim() || undefined,
                    network: d.network.trim() || undefined,
                    hostname: d.hostname.trim() || undefined,
                  },
                });
                toast("ok", `Container started from ${d.image.trim()}`);
              } catch (err) {
                setErrDlg({ title: "Run failed", detail: err instanceof ApiError ? err.detail : String(err) });
              } finally {
                setBusy(false);
              }
            }}>
            <Icon name="play" size={14} />
            {busy ? "Starting… (image pull can take a while)" : "Run container"}
          </button>
        </div>
      </div>
      {errDlg && <ErrorDialog err={errDlg} onClose={() => setErrDlg(null)} />}
    </div>
  );
}

const SOURCE_LABEL: Record<StackSource, string> = {
  stack: "wslc stack",
  compose: "docker-compose",
  kubernetes: "kubernetes",
};

/** Deploy → From file (D4/D5): pick a YAML file, read it off disk, compile it, and show
 * the *whole* truth — detected format, every dropped key, the exact run plan — before
 * anything starts. Deploying sends the file's text as-is; the builder hand-off is opt-in. */
function FromFile({ onOpenInBuilder }: { onOpenInBuilder: (stack: CompiledStack) => void }) {
  const { toast, refreshStacks } = useApp();
  const [path, setPath] = useState("");
  const [text, setText] = useState("");
  const [res, setRes] = useState<CompileResult | null>(null);
  const [phase, setPhase] = useState<"idle" | "reading" | "compiling" | "deploying">("idle");
  const [errDlg, setErrDlg] = useState<DeployError | null>(null);
  /** The dialog is dismissable; the banner keeps the failure on screen until it is fixed. */
  const [failure, setFailure] = useState<DeployError | null>(null);
  const [showYaml, setShowYaml] = useState(false);

  const busy = phase !== "idle";
  /** Reading/compiling replaces the result area; deploying must NOT — the plan stays on
   * screen under the button that is acting on it. */
  const loading = phase === "reading" || phase === "compiling";

  /** Fallback stack name when the file carries none — the picked file's stem.
   * Wire field is `name`: the r8 brief called it `defaultName`, but the shipped route
   * (`stackFromBody`, server/routes.ts) reads `b.name`. Sent as `name` to match the code;
   * flagged for contract reconciliation. Without it, every imported compose file deploys
   * under the literal stack name "stack". */
  const stemOf = (p: string): string =>
    (p.split(/[\\/]/).pop() ?? "").replace(/\.(ya?ml)$/i, "") || "stack";

  const load = async (p: string) => {
    setPath(p);
    setRes(null);
    setErrDlg(null);
    setFailure(null);
    setShowYaml(false);
    let stage: "read" | "compile" = "read";
    try {
      setPhase("reading");
      const file = await api<ReadTextResult>("/api/system/read-text", { method: "POST", body: { path: p } });
      setPath(file.path);
      setText(file.text);
      stage = "compile";
      setPhase("compiling");
      const compiled = await api<CompileResult>("/api/stacks/compile", {
        method: "POST",
        body: { yaml: file.text, name: stemOf(file.path) },
      });
      setRes(compiled);
    } catch (err) {
      const e: DeployError = {
        title: stage === "read" ? "Could not read that file" : "That file cannot be deployed",
        detail: err instanceof ApiError ? err.detail : String(err),
      };
      setErrDlg(e);
      setFailure(e);
      setText("");
    } finally {
      setPhase("idle");
    }
  };

  const deploy = async () => {
    setPhase("deploying");
    try {
      // Deploys the file's text as read — not a re-serialisation of the parsed stack, so
      // what runs is what the reviewed plan was compiled from.
      const rec = await api<StackRecord>("/api/stacks/deploy", {
        method: "POST",
        body: { yaml: text, name: stemOf(path) },
      });
      const perService = rec.services.map((s) => `${s.service}: ${s.ok ? "ok" : s.stderr ?? "failed"}`).join("\n");
      if (rec.status === "deployed") {
        toast("ok", `Stack ${rec.name} deployed`, perService);
      } else {
        setErrDlg({ title: `Stack ${rec.name} partially deployed`, detail: perService });
      }
      await refreshStacks();
    } catch (err) {
      setErrDlg({ title: "Deploy failed", detail: err instanceof ApiError ? err.detail : String(err) });
    } finally {
      setPhase("idle");
    }
  };

  const pickSpec = {
    kind: "file-open" as const,
    title: "Select a compose, kubernetes, or stack YAML file",
    filters: [["YAML", "*.yaml;*.yml"], ["All files", "*.*"]] as [string, string][],
  };

  return (
    <div className="card">
      <header>
        From file
        {res?.source && <span className="badge">{SOURCE_LABEL[res.source]}</span>}
        <span className="spacer" />
        <PickButton spec={pickSpec} onPick={(p) => void load(p)} label={path ? "Choose another…" : "Choose file…"} />
        {path && (
          <button className="small ghost" disabled={busy} title="Re-read the file from disk"
            onClick={() => void load(path)}>
            <Icon name="refresh" size={13} />
            Reload
          </button>
        )}
      </header>
      <div className="body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {path && <div className="filepath mono muted" title={path}>{path}</div>}

        {loading && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-live="polite">
            <span className="muted" style={{ fontSize: 12.5 }}>
              {phase === "reading" ? "Reading file…" : "Compiling…"}
            </span>
            <span className="skeleton" style={{ width: "70%" }} />
            <span className="skeleton" style={{ width: "45%" }} />
          </div>
        )}

        {!path && !loading && (
          <EmptyState
            title="Deploy from a YAML file"
            hint="Pick a docker-compose file, a kubernetes manifest (Pod, Deployment, StatefulSet, Job…), or a wslc stack file. Nothing runs until you review the plan."
            action={<PickButton spec={pickSpec} onPick={(p) => void load(p)} label="Choose file…" className="primary" />}
          />
        )}

        {failure && !loading && (
          <ErrorBanner
            message={failure.title}
            detail={failure.detail}
            onRetry={path ? () => void load(path) : undefined}
          />
        )}

        {res && !loading && (
          <>
            <Warnings items={res.warnings} />

            <section>
              <h4 className="sectionhead">
                Plan · {res.plan.length} container{res.plan.length === 1 ? "" : "s"}
              </h4>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {res.plan.map((p) => (
                  <div key={p.service} className="cmdpreview">
                    <code className="mono">{p.preview}</code>
                    <CopyButton text={p.preview} label="" />
                  </div>
                ))}
              </div>
            </section>

            <div className="formrow">
              <button className="primary" disabled={busy || res.plan.length === 0}
                onClick={() => void deploy()}>
                <Icon name="deploy" size={14} />
                {phase === "deploying" ? "Deploying…" : "Deploy stack"}
              </button>
              <button disabled={busy} onClick={() => onOpenInBuilder(res.stack)}>
                <Icon name="edit" size={13} />
                Open in builder
              </button>
              <button className="ghost" aria-expanded={showYaml} onClick={() => setShowYaml(!showYaml)}>
                <Icon name="inspect" size={13} />
                {showYaml ? "Hide raw YAML" : "View raw YAML"}
              </button>
            </div>

            {showYaml && (
              <pre className="mono rawyaml" aria-label="Raw YAML source">{text}</pre>
            )}
          </>
        )}
      </div>
      {errDlg && <ErrorDialog err={errDlg} onClose={() => setErrDlg(null)} />}
    </div>
  );
}

/** Every "we could not honour this" fact, itemised and complete (D3/D7).
 * Never a toast, never truncated — deploying a manifest whose secrets silently vanished
 * is exactly the failure this list exists to prevent. */
function Warnings({ items }: { items: string[] }) {
  if (items.length === 0) {
    return (
      <div className="okbanner errorbanner" role="status" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="check" size={14} />
        <span>Everything in this file maps onto wslc — nothing was dropped.</span>
      </div>
    );
  }
  return (
    <section className="warnbox" role="region" aria-label="Import warnings">
      <h4 className="sectionhead warn">
        {items.length} thing{items.length === 1 ? "" : "s"} this file asks for that wslc cannot do
      </h4>
      <ul className="warnlist" aria-label="Importer warnings">
        {items.map((w, i) => <li key={i}>{w}</li>)}
      </ul>
      <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
        Everything above is dropped from the plan below. Nothing is guessed or invented.
      </p>
    </section>
  );
}

function StackBuilder({ stackName, setStackName, services, setServices }: {
  stackName: string;
  setStackName: (v: string) => void;
  services: SvcDraft[];
  setServices: (v: SvcDraft[]) => void;
}) {
  const { caps, toast, refreshStacks } = useApp();
  const [compiled, setCompiled] = useState<CompileResult | null>(null);
  const [busy, setBusy] = useState<"compile" | "deploy" | null>(null);
  const [rail, setRail] = useState<"plan" | "yaml">("plan");
  const [errDlg, setErrDlg] = useState<DeployError | null>(null);

  const canEntrypoint = caps?.wslc.can.entrypoint ?? false;

  const toStackBody = () => ({
    name: stackName.trim(),
    services: Object.fromEntries(services.map((s) => [
      s.service.trim(),
      {
        image: s.image.trim(),
        ports: s.ports.split(",").map((p) => p.trim()).filter((p) => p.length > 0),
        command: tokenizeCommand(s.command),
        rm: s.rm,
        env: splitLines(s.env),
        volumes: splitLines(s.volumes),
        ...(s.memory.trim() ? { memory: s.memory.trim() } : {}),
        ...(s.cpus.trim() ? { cpus: s.cpus.trim() } : {}),
        // Omitted entirely when blank or unsupported — an empty `entrypoint: ""` would
        // ask wslc to run "" as the init process.
        ...(canEntrypoint && s.entrypoint.trim() ? { entrypoint: s.entrypoint.trim() } : {}),
      },
    ])),
  });

  const compile = async (): Promise<CompileResult | null> => {
    setBusy("compile");
    try {
      const res = await api<CompileResult>("/api/stacks/compile", { method: "POST", body: { stack: toStackBody() } });
      setCompiled(res);
      return res;
    } catch (err) {
      setErrDlg({ title: "Stack invalid", detail: err instanceof ApiError ? err.detail : String(err) });
      setCompiled(null);
      return null;
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="twocol">
      <div className="card">
        <header>Stack definition</header>
        <div className="body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <label className="field" style={{ maxWidth: 260 }}>
            <span className="req">Stack name</span>
            <input type="text" value={stackName} placeholder="shop" onChange={(e) => setStackName(e.target.value)} />
          </label>
          {services.map((s) => (
            <div key={s.id} className="stack-svc">
              <div className="formrow">
                <label className="field"><span className="req">Service</span>
                  <input type="text" value={s.service} style={{ width: 120 }}
                    onChange={(e) => setServices(services.map((x) => x.id === s.id ? { ...x, service: e.target.value } : x))} /></label>
                <label className="field" style={{ flex: 1, minWidth: 160 }}><span className="req">Image</span>
                  <input type="text" value={s.image} placeholder="nginx:latest" list="local-images"
                    onChange={(e) => setServices(services.map((x) => x.id === s.id ? { ...x, image: e.target.value } : x))} /></label>
                <button className="icon" aria-label={`Remove service ${s.service}`} disabled={services.length === 1}
                  onClick={() => setServices(services.filter((x) => x.id !== s.id))}>
                  <Icon name="x" size={13} />
                </button>
              </div>
              <div className="formrow">
                <label className="field"><span>Ports (comma-separated host:container)</span>
                  <input type="text" value={s.ports} placeholder="8080:80, 8443:443" style={{ width: 220 }}
                    onChange={(e) => setServices(services.map((x) => x.id === s.id ? { ...x, ports: e.target.value } : x))} /></label>
                <label className="field" style={{ flex: 1, minWidth: 140 }}><span>Command</span>
                  <input type="text" value={s.command}
                    onChange={(e) => setServices(services.map((x) => x.id === s.id ? { ...x, command: e.target.value } : x))} /></label>
                {/* Sits next to Command because the two compose: --entrypoint replaces the
                    image's init process and Command becomes the arguments passed to it. */}
                <label className="field" style={{ flex: 1, minWidth: 140 }}><span>Entrypoint (--entrypoint)</span>
                  <input type="text" value={s.entrypoint} placeholder="/bin/sh"
                    disabled={!canEntrypoint}
                    title={canEntrypoint
                      ? "Replaces the image's entrypoint. Command becomes its arguments."
                      : NO_ENTRYPOINT_TITLE}
                    aria-label={`Entrypoint for ${s.service || "service"}`}
                    onChange={(e) => setServices(services.map((x) => x.id === s.id ? { ...x, entrypoint: e.target.value } : x))} /></label>
                <label className="checkline"><input type="checkbox" checked={s.rm}
                  onChange={(e) => setServices(services.map((x) => x.id === s.id ? { ...x, rm: e.target.checked } : x))} /> --rm</label>
              </div>
              <div className="formrow">
                <label className="field" style={{ flex: 1, minWidth: 180 }}>
                  <span>Environment (one KEY=value per line)</span>
                  <textarea rows={2} value={s.env} placeholder={"PGUSER=admin\nPGPASSWORD=secret"}
                    onChange={(e) => setServices(services.map((x) => x.id === s.id ? { ...x, env: e.target.value } : x))} />
                </label>
                <label className="field" style={{ flex: 1, minWidth: 180 }}>
                  <span>Volumes (one host:container per line)</span>
                  <textarea rows={2} value={s.volumes} placeholder={"C:\\data:/var/lib/data"}
                    onChange={(e) => setServices(services.map((x) => x.id === s.id ? { ...x, volumes: e.target.value } : x))} />
                </label>
              </div>
              <div className="formrow">
                <span className="field" style={{ width: 170 }}><span>Memory (-m)</span>
                  <SizeInput label={`${s.service || "Service"} memory`} value={s.memory} suffix="short" placeholder="512"
                    onChange={(memory) => setServices(services.map((x) => x.id === s.id ? { ...x, memory } : x))} /></span>
                <label className="field"><span>CPUs (--cpus)</span>
                  <input type="text" value={s.cpus} placeholder="1" style={{ width: 90 }}
                    onChange={(e) => setServices(services.map((x) => x.id === s.id ? { ...x, cpus: e.target.value } : x))} /></label>
              </div>
            </div>
          ))}
          <div>
            <button className="small ghost" onClick={() => setServices([...services, emptySvc(`svc${services.length + 1}`)])}>
              <Icon name="plus" size={12} />
              Add service
            </button>
          </div>
          <div className="formrow">
            <button disabled={busy !== null || !stackName.trim()} onClick={() => void compile()}>
              {busy === "compile" ? "Compiling…" : "Compile preview"}
            </button>
            <button className="primary" disabled={busy !== null || !stackName.trim()}
              onClick={async () => {
                const ok = await compile();
                if (!ok) return;
                setBusy("deploy");
                try {
                  const rec = await api<StackRecord>("/api/stacks/deploy", { method: "POST", body: { stack: toStackBody() } });
                  const perService = rec.services.map((s) => `${s.service}: ${s.ok ? "ok" : s.stderr ?? "failed"}`).join("\n");
                  if (rec.status === "deployed") {
                    toast("ok", `Stack ${rec.name} deployed`, perService);
                  } else {
                    setErrDlg({ title: `Stack ${rec.name} partially deployed`, detail: perService });
                  }
                  await refreshStacks();
                } catch (err) {
                  setErrDlg({ title: "Deploy failed", detail: err instanceof ApiError ? err.detail : String(err) });
                } finally {
                  setBusy(null);
                }
              }}>
              <Icon name="deploy" size={14} />
              {busy === "deploy" ? "Deploying…" : "Deploy stack"}
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <header>
          <Tablist
            label="Preview"
            idBase="deploy-preview"
            className="seg small"
            value={rail}
            onChange={setRail}
            tabs={[
              { value: "plan", label: "Plan" },
              { value: "yaml", label: "compose.yaml" },
            ]}
          />
          <span className="spacer" />
          {compiled && (
            <button className="small ghost" onClick={() => {
              const blob = new Blob([compiled.composeYaml], { type: "text/yaml" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = "docker-compose.yaml";
              a.click();
              URL.revokeObjectURL(a.href);
            }}>
              <Icon name="download" size={13} />
              Download
            </button>
          )}
        </header>
        <div
          className="body"
          role="tabpanel"
          id={`deploy-preview-panel-${rail}`}
          aria-labelledby={`deploy-preview-tab-${rail}`}
        >
          {!compiled ? (
            <p className="muted">Compile to see the exact <code>wslc run</code> sequence this stack executes.</p>
          ) : rail === "plan" ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {compiled.warnings.length > 0 && <Warnings items={compiled.warnings} />}
              {compiled.plan.map((p) => (
                <div key={p.service} className="cmdpreview">
                  <code className="mono">{p.preview}</code>
                  <CopyButton text={p.preview} label="" />
                </div>
              ))}
            </div>
          ) : (
            <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{compiled.composeYaml}</pre>
          )}
        </div>
      </div>
      {errDlg && <ErrorDialog err={errDlg} onClose={() => setErrDlg(null)} />}
    </div>
  );
}

function DeployedStacks({ stacks, refresh, toast, canDown }: {
  stacks: StackRecord[];
  refresh: () => Promise<void>;
  toast: (k: "ok" | "error" | "info", t: string, d?: string) => void;
  canDown: boolean;
}) {
  const [confirm, setConfirm] = useState<StackRecord | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [errDlg, setErrDlg] = useState<DeployError | null>(null);
  // FE-12: "Forget record" removes the row that holds the kebab that was focused, dropping
  // focus to <body>. After the row is gone, land focus on the card heading (or, if the whole
  // card unmounts because it was the last stack, the first control in the page content).
  const headerRef = useRef<HTMLElement>(null);
  const restoreFocus = () => {
    requestAnimationFrame(() => {
      (headerRef.current ?? document.querySelector<HTMLElement>("main.content button, main.content a"))?.focus();
    });
  };
  if (stacks.length === 0) return null;
  return (
    <div className="card">
      <header ref={headerRef} tabIndex={-1}>Deployed stacks</header>
      <div className="tablewrap">
        <table className="responsive">
          <thead>
            <tr>
              <th>Stack</th><th>Status</th><th>Services</th><th>Deployed</th>
              <th className="actions"><span style={{ position: "absolute", clip: "rect(0 0 0 0)" }}>Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {stacks.map((s) => (
              <tr key={s.name}>
                <td className="mono" data-label="Stack">{s.name}</td>
                <td data-label="Status"><span className={`pill ${s.status === "deployed" ? "ok" : s.status === "partial" ? "warn" : ""}`}>{s.status}</span></td>
                <td className="mono" data-label="Services">{s.services.map((x) => x.container).join(", ")}</td>
                <td data-label="Deployed">{new Date(s.deployedAt).toLocaleString()}</td>
                <td className="actions" data-label="Actions">
                  <div className="rowactions">
                    <ActionMenu
                      label={`Actions for stack ${s.name}`}
                      items={[
                        {
                          label: "Take down…",
                          icon: "stop",
                          disabled: !canDown || busy !== null || s.status === "down",
                          title: s.status === "down" ? "Stack is already down" : undefined,
                          onSelect: () => setConfirm(s),
                        },
                        "sep",
                        {
                          label: "Forget record",
                          icon: "trash",
                          danger: true,
                          disabled: busy !== null,
                          onSelect: async () => {
                            setBusy(s.name);
                            try {
                              await api(`/api/stacks/${s.name}`, { method: "DELETE", body: {} });
                              await refresh();
                              toast("ok", `Removed stack record ${s.name}`);
                              restoreFocus();
                            } catch (err) {
                              setErrDlg({ title: "Remove failed", detail: err instanceof ApiError ? err.detail : String(err) });
                            } finally {
                              setBusy(null);
                            }
                          },
                        },
                      ]}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirm && (
        <ConfirmModal
          title={`Take down stack ${confirm.name}?`}
          body={<p>Stops containers {confirm.services.map((s) => s.container).join(", ")}{" "}(and removes them when this wslc build exposes a remove verb).</p>}
          confirmLabel="Take down"
          danger
          onConfirm={async () => {
            setBusy(confirm.name);
            try {
              await api(`/api/stacks/${confirm.name}/down`, { method: "POST", body: {} });
              await refresh();
              toast("ok", `Stack ${confirm.name} down`);
            } catch (err) {
              setErrDlg({ title: "Down failed", detail: err instanceof ApiError ? err.detail : String(err) });
            } finally {
              setBusy(null);
            }
          }}
          onClose={() => setConfirm(null)}
        />
      )}
      {errDlg && <ErrorDialog err={errDlg} onClose={() => setErrDlg(null)} />}
    </div>
  );
}
