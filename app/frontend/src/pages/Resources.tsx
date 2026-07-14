import { useCallback, useEffect, useState } from "react";
import { useApp } from "../state.tsx";
import { api, ApiError } from "../lib/api.ts";
import { CopyButton, EmptyState, ErrorBanner, fmtBytes, PickButton, type PickSpec, SkeletonRows, StatsBar } from "../components/bits.tsx";
import { SizeInput, type SizeSuffix } from "../components/SizeInput.tsx";
import { ConfirmModal, Modal } from "../components/Modal.tsx";
import { ActionMenu } from "../components/Menu.tsx";
import { Icon } from "../components/icons.tsx";
import type { VolumeRow } from "../lib/types.ts";

type Confirm = {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  requireText?: string;
  onConfirm: () => Promise<void>;
};

type Prompt = {
  title: string;
  fields: {
    key: string;
    label: string;
    placeholder?: string;
    required?: boolean;
    pick?: PickSpec;
    suggestions?: string[];
    /** Renders the MB/GB control instead of a free-text field. */
    size?: { suffix: SizeSuffix; integersOnly?: boolean };
  }[];
  submitLabel: string;
  onSubmit: (values: Record<string, string>) => Promise<void>;
};

export function ResourcesPage() {
  const { resources, toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [promptVals, setPromptVals] = useState<Record<string, string>>({});
  const [showImport, setShowImport] = useState(false);
  const [showMount, setShowMount] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  /** Runs an action with toast feedback; resolves true on success so modal
      flows can close only when the command actually landed. */
  const act = async (key: string, label: string, fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(key);
    setLastError(null);
    try {
      await fn();
      toast("ok", label);
      return true;
    } catch (err) {
      const detail = err instanceof ApiError ? err.detail : String(err);
      toast("error", `${label} failed`, detail);
      setLastError(`${label} failed: ${detail}`);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const distros = resources?.distros ?? [];
  const running = new Set(resources?.running ?? []);
  const loading = resources === null;
  const sessionBytes = (resources?.sessionStorage ?? []).reduce((a, s) => a + (s.sizeBytes ?? 0), 0);
  const storageBytes = (resources?.storage ?? []).reduce((a, s) => a + (s.sizeBytes ?? 0), 0) +
    (resources?.swap.sizeBytes ?? 0) + sessionBytes;

  return (
    <div className="page">
      <StatsBar stats={[
        { label: "Distributions", value: distros.length, loading },
        { label: "Running", value: running.size, dot: running.size > 0 ? "ok" : "neutral", loading },
        { label: "Disk used", value: storageBytes > 0 ? fmtBytes(storageBytes) : "—", meta: "distros + container sessions + swap", loading },
        {
          label: "Container storage",
          value: sessionBytes > 0 ? fmtBytes(sessionBytes) : "—",
          meta: resources?.sessions.length
            ? `${resources.sessions.length} wslc session${resources.sessions.length === 1 ? "" : "s"}`
            : "no active wslc session",
          loading,
        },
        { label: "WSL version", value: resources?.version?.["wsl"] ?? resources?.version?.["WSL"] ?? "—", loading },
      ]} />

      {lastError && <ErrorBanner message={lastError} onRetry={() => setLastError(null)} />}

      <div className="card">
        <header>
          Distributions
          <span className="spacer" />
          <button className="small primary" disabled={busy !== null} onClick={() => setShowImport(true)}>
            <Icon name="download" size={13} />
            Import…
          </button>
        </header>
        <div className="tablewrap">
          <table className="responsive">
            <thead>
              <tr>
                <th>Name</th><th>State</th><th>WSL</th>
                <th className="actions"><span style={{ position: "absolute", clip: "rect(0 0 0 0)" }}>Actions</span></th>
              </tr>
            </thead>
            {resources === null ? <SkeletonRows cols={4} /> : (
              <tbody>
                {distros.map((d) => (
                  <tr key={d.name}>
                    <td className="mono" data-label="Name">{d.name} {d.isDefault && <span className="badge" title="Default distribution">default</span>}</td>
                    <td data-label="State">
                      <span className={`pill ${d.state === "Running" ? "ok" : ""}`}>{d.state.toLowerCase()}</span>
                    </td>
                    <td data-label="WSL">{d.version}</td>
                    <td className="actions" data-label="Actions">
                      <div className="rowactions">
                        {d.state === "Running" ? (
                          <button className="icon small" disabled={busy !== null}
                            title={`Terminate ${d.name}`} aria-label={`Terminate ${d.name}`}
                            onClick={() => void act(`term:${d.name}`, `Terminated ${d.name}`, () => api(`/api/distros/${d.name}/terminate`, { method: "POST", body: {} }))}>
                            {busy === `term:${d.name}` ? "…" : <Icon name="stop" size={14} />}
                          </button>
                        ) : (
                          <button className="icon small" disabled={busy !== null}
                            title={`Start ${d.name}`} aria-label={`Start ${d.name}`}
                            onClick={() => void act(`startd:${d.name}`, `Started ${d.name}`, () => api(`/api/distros/${d.name}/start`, { method: "POST", body: {} }))}>
                            {busy === `startd:${d.name}` ? "…" : <Icon name="play" size={14} />}
                          </button>
                        )}
                        <ActionMenu
                          label={`Actions for ${d.name}`}
                          items={[
                            {
                              label: "Set as default",
                              icon: "star",
                              disabled: d.isDefault || busy !== null,
                              title: d.isDefault ? `${d.name} is already the default` : undefined,
                              onSelect: () => void act(`def:${d.name}`, `${d.name} is now default`, () => api(`/api/distros/${d.name}/set-default`, { method: "POST", body: {} })),
                            },
                            {
                              label: "Resize disk…",
                              icon: "resize",
                              disabled: busy !== null,
                              onSelect: () =>
                                setPrompt({
                                  title: `Resize ${d.name} disk`,
                                  fields: [{
                                    key: "size",
                                    label: "New size",
                                    required: true,
                                    placeholder: "256",
                                    // `wsl --manage --resize`: "Decimal values are currently
                                    // unsupported" (DD3) — whole MB/GB only.
                                    size: { suffix: "long", integersOnly: true },
                                  }],
                                  submitLabel: "Resize",
                                  onSubmit: async (v) => {
                                    if (!await act(`resize:${d.name}`, `Resized ${d.name}`, () => api(`/api/distros/${d.name}/resize`, { method: "POST", body: { size: v.size } }))) {
                                      throw new Error("resize failed");
                                    }
                                  },
                                }),
                            },
                            {
                              label: "Enable sparse VHD…",
                              icon: "shrink",
                              disabled: busy !== null,
                              onSelect: () =>
                                setConfirm({
                                  title: `Toggle sparse VHD for ${d.name}`,
                                  body: "Sparse VHDs return freed disk space to Windows automatically (`wsl --manage --set-sparse`). Enable?",
                                  confirmLabel: "Enable sparse",
                                  onConfirm: async () => {
                                    // FE-7: throw on failure so ConfirmModal holds the dialog
                                    // open (it closes on a resolved promise). `act` already
                                    // surfaces the failure (toast + banner) and returns false.
                                    if (!await act(`sparse:${d.name}`, `Sparse enabled for ${d.name}`, () => api(`/api/distros/${d.name}/set-sparse`, { method: "POST", body: { sparse: true } }))) {
                                      throw new Error("sparse toggle failed");
                                    }
                                  },
                                }),
                            },
                            {
                              label: "Move…",
                              icon: "move",
                              disabled: busy !== null,
                              onSelect: () =>
                                setPrompt({
                                  title: `Move ${d.name}`,
                                  fields: [{
                                    key: "location",
                                    label: "New location (folder)",
                                    required: true,
                                    pick: { kind: "folder", title: "Select new distribution location" },
                                  }],
                                  submitLabel: "Move",
                                  onSubmit: async (v) => {
                                    if (!await act(`move:${d.name}`, `Moved ${d.name}`, () => api(`/api/distros/${d.name}/move`, { method: "POST", body: { location: v.location } }))) {
                                      throw new Error("move failed");
                                    }
                                  },
                                }),
                            },
                            {
                              label: "Export…",
                              icon: "upload",
                              disabled: busy !== null,
                              onSelect: () =>
                                setPrompt({
                                  title: `Export ${d.name}`,
                                  fields: [
                                    {
                                      key: "file",
                                      label: "Target file",
                                      placeholder: "D:\\backups\\ubuntu.tar",
                                      required: true,
                                      pick: {
                                        kind: "file-save",
                                        title: "Export distribution to",
                                        filters: [["Tar archives", "*.tar;*.tar.gz;*.tar.xz"], ["Virtual disks", "*.vhd;*.vhdx"], ["All files", "*.*"]],
                                        defExt: "tar",
                                      },
                                    },
                                    { key: "format", label: "Format", suggestions: ["tar", "tar.gz", "tar.xz", "vhd"] },
                                  ],
                                  submitLabel: "Export",
                                  onSubmit: async (v) => {
                                    if (!await act(`export:${d.name}`, `Exported ${d.name}`, () => api(`/api/distros/${d.name}/export`, { method: "POST", body: { file: v.file, format: v.format || undefined } }))) {
                                      throw new Error("export failed");
                                    }
                                  },
                                }),
                            },
                            "sep",
                            {
                              label: "Unregister…",
                              icon: "trash",
                              danger: true,
                              disabled: busy !== null,
                              onSelect: () =>
                                setConfirm({
                                  title: `Unregister ${d.name}?`,
                                  body: "This DELETES the distribution's root filesystem permanently (`wsl --unregister`). There is no undo. Export first if you need a backup.",
                                  confirmLabel: "Unregister permanently",
                                  danger: true,
                                  requireText: d.name,
                                  onConfirm: async () => {
                                    // FE-7: throw on failure so the dialog (with the typed
                                    // name intact) stays open instead of closing as if the
                                    // unregister succeeded.
                                    if (!await act(`unreg:${d.name}`, `Unregistered ${d.name}`, () => api(`/api/distros/${d.name}`, { method: "DELETE", body: { confirmName: d.name } }))) {
                                      throw new Error("unregister failed");
                                    }
                                  },
                                }),
                            },
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>
        {resources !== null && distros.length === 0 && (
          <EmptyState
            title="No distributions"
            hint="Install one with `wsl --install <distro>` or import a tarball."
            action={<button className="primary" onClick={() => setShowImport(true)}><Icon name="download" size={14} />Import distribution</button>}
          />
        )}
      </div>

      <div className="card">
        {/* r8 D8/DD4 (revised r8.2): the disk-level actions live with the disks they act
            on. Shutdown does NOT — it terminates the VM, not a mount — so it moved to the
            Settings page header, where it is reachable from both tabs. The WSL platform
            *version table* moved to Settings → Application. */}
        <header>
          Storage
          <span className="spacer" />
          <button className="small ghost" disabled={busy !== null} onClick={() => setShowMount(true)}>
            <Icon name="disk" size={13} />
            Mount disk…
          </button>
          <button className="small ghost" disabled={busy !== null}
            onClick={() => void act("unmount", "Unmounted all disks", () => api("/api/wsl/unmount", { method: "POST", body: {} }))}>
            Unmount all
          </button>
        </header>
        <div className="tablewrap">
          <table className="responsive">
            <thead><tr><th>Item</th><th>Path</th><th>Size</th><th className="actions"></th></tr></thead>
            {resources === null ? <SkeletonRows cols={4} rows={3} /> : (
              <tbody>
                {(resources.storage ?? []).map((s) => (
                  <tr key={s.name}>
                    <td data-label="Item">{s.name} <span className="badge">ext4.vhdx</span></td>
                    <td className="mono muted" data-label="Path" style={{ wordBreak: "break-all" }}>{s.vhdxPath ?? s.basePath}</td>
                    <td data-label="Size">{fmtBytes(s.sizeBytes)}</td>
                    <td className="actions">
                      <div className="rowactions">
                        {s.vhdxPath && <RevealButton path={s.vhdxPath} />}
                        {s.vhdxPath && <CopyButton text={s.vhdxPath} label="Copy" />}
                      </div>
                    </td>
                  </tr>
                ))}
                {(resources.sessionStorage ?? []).map((s) => (
                  <tr key={s.path}>
                    <td data-label="Item" title="Disk of the wslc session that hosts your containers and images">
                      {s.session} <span className="badge">container session · {s.file}</span>
                    </td>
                    <td className="mono muted" data-label="Path" style={{ wordBreak: "break-all" }}>{s.path}</td>
                    <td data-label="Size">{fmtBytes(s.sizeBytes)}</td>
                    <td className="actions">
                      <div className="rowactions">
                        <RevealButton path={s.path} />
                        <CopyButton text={s.path} label="Copy" />
                      </div>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td data-label="Item">Swap <span className="badge">vhdx</span></td>
                  <td className="mono muted" data-label="Path" style={{ wordBreak: "break-all" }}>{resources.swap.path}</td>
                  <td data-label="Size">{resources.swap.exists ? fmtBytes(resources.swap.sizeBytes) : "not present (created on demand)"}</td>
                  <td className="actions">
                    <div className="rowactions">
                      <RevealButton path={resources.swap.path} disabled={!resources.swap.exists}
                        title={resources.swap.exists ? "Open file location in Explorer" : "Swap file not present"} />
                      <CopyButton text={resources.swap.path} label="Copy" />
                    </div>
                  </td>
                </tr>
              </tbody>
            )}
          </table>
        </div>
      </div>

      {/* r9 DD2: volumes are a storage-class resource, so they live beside Storage rather
          than on a nav page of their own. */}
      <VolumesCard />

      {showImport && <ImportModal busyKey={busy} act={act} onClose={() => setShowImport(false)} />}
      {showMount && <MountModal busyKey={busy} act={act} onClose={() => setShowMount(false)} />}

      {prompt && (
        <ConfirmModal
          title={prompt.title}
          body={
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {prompt.fields.map((f) => (
                /* A size field is two controls (number + unit), so it cannot live in a
                   <label> — SizeInput names both of them itself. */
                f.size ? (
                  <span key={f.key} className="field">
                    <span className={f.required ? "req" : undefined}>{f.label}</span>
                    <SizeInput
                      label={f.label}
                      value={promptVals[f.key] ?? ""}
                      onChange={(v) => setPromptVals((x) => ({ ...x, [f.key]: v }))}
                      suffix={f.size.suffix}
                      integersOnly={f.size.integersOnly}
                      placeholder={f.placeholder}
                    />
                  </span>
                ) : (
                  <label key={f.key} className="field">
                    <span className={f.required ? "req" : undefined}>{f.label}</span>
                    <div className="pickrow">
                      <input type="text" placeholder={f.placeholder} value={promptVals[f.key] ?? ""}
                        list={f.suggestions ? `sugg-${f.key}` : undefined}
                        onChange={(e) => setPromptVals((v) => ({ ...v, [f.key]: e.target.value }))} />
                      {f.pick && <PickButton spec={f.pick} onPick={(p) => setPromptVals((v) => ({ ...v, [f.key]: p }))} />}
                    </div>
                    {f.suggestions && (
                      <datalist id={`sugg-${f.key}`}>
                        {f.suggestions.map((s) => <option key={s} value={s} />)}
                      </datalist>
                    )}
                  </label>
                )
              ))}
            </div>
          }
          confirmLabel={prompt.submitLabel}
          onConfirm={async () => {
            await prompt.onSubmit(promptVals);
            setPromptVals({});
          }}
          onClose={() => { setPrompt(null); setPromptVals({}); }}
        />
      )}
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          body={<p>{confirm.body}</p>}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          requireText={confirm.requireText}
          onConfirm={confirm.onConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

/* ======================= r9 · Volumes (D2 / DD1–DD4) =======================
 * wslc auto-creates a named volume the first time `run -v name:/path` mounts one and
 * persists it across containers (probe P2), so a volume can grow disk the user never
 * asked for and cannot see. This card is where they see it and reclaim it.
 *
 * There is deliberately NO size column. `wslc volume inspect` reports no size and no
 * mountpoint (probe P3), so a per-volume byte count cannot be measured — and is never
 * estimated. The bytes are not unaccounted for: they sit inside the wslc session VHD that
 * the "Container storage" tile at the top of this page already totals. The note under the
 * table says exactly that.
 */

/** Which of the five verbs this wslc build actually has (DD4). `volumeVerbs` is parsed
 * from `wslc volume --help` by the server; an absent verb is never offered, because a
 * button that emits a command wslc cannot run is worse than no button. */
const noVerbTitle = (verb: string) => `This wslc build does not expose "wslc volume ${verb}"`;

/** Docker's rule, mirrored from the server-side validator so a bad name is caught while
 * the user is still typing. The server re-validates — this is feedback, not a control. */
const VOLUME_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

function VolumesCard() {
  const { caps, volumesTick, toast } = useApp();
  const [rows, setRows] = useState<VolumeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showPrune, setShowPrune] = useState(false);
  const [toRemove, setToRemove] = useState<VolumeRow | null>(null);
  const [toInspect, setToInspect] = useState<string | null>(null);

  // Read the server's derived `can.*` rather than matching volumeVerbs here: it is computed
  // from the same `wslc volume --help` but folds in the verb aliases (rm/delete for remove,
  // ls for list) that a literal includes("remove") would miss on some builds. Absent on a
  // pre-r9 server, where `undefined === true` is false — so every action stays hidden.
  const can = caps?.wslc.can ?? {};
  const canList = can.volumes === true;
  const canCreate = can.volumeCreate === true;
  const canRemove = can.volumeRemove === true;
  const canPrune = can.volumePrune === true;
  const canInspect = can.volumeInspect === true;

  const load = useCallback(async () => {
    if (!canList) return;
    try {
      const res = await api<{ volumes: VolumeRow[] }>("/api/volumes");
      setRows(res.volumes ?? []);
      setError(null);
    } catch (err) {
      // Keep whatever is on screen: a failed *refresh* should not blank a good table.
      setError(err instanceof ApiError ? err.detail : String(err));
    }
  }, [canList]);

  // volumesTick fires on the server's `volumes` poke (create/remove/prune from anywhere).
  // It does not fire when `wslc run -v name:/path` auto-creates one, which is why the
  // header also carries a Refresh.
  useEffect(() => {
    void load();
  }, [load, volumesTick]);

  /** Mutations rethrow so ConfirmModal keeps the dialog open (with the typed text intact)
   * when the command fails, instead of closing over a failure. */
  const run = async (key: string, okText: string, failText: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      toast("ok", okText);
      setError(null);
      await load();
    } catch (err) {
      const detail = err instanceof ApiError
        ? (err.status === 409 ? `This wslc build cannot run that command. ${err.detail}` : err.detail)
        : String(err);
      toast("error", failText, detail);
      setError(`${failText}: ${detail}`);
      throw err;
    } finally {
      setBusy(null);
    }
  };

  const prune = async () => {
    setBusy("prune");
    try {
      const res = await api<{ removed: string[]; reclaimed: string | null }>(
        "/api/volumes/prune",
        { method: "POST", body: { confirm: true } },
      );
      const removed = res.removed ?? [];
      if (removed.length === 0) {
        toast("info", "Nothing to prune", "No unused anonymous volumes were found.");
      } else {
        // The names are the only receipt the user will ever get of what was destroyed, so
        // they are listed in full and never summarised to a count. `reclaimed` is wslc's
        // own figure from its prune output — reported, not computed here.
        toast(
          "ok",
          `Pruned ${removed.length} volume${removed.length === 1 ? "" : "s"}`,
          [...removed, ...(res.reclaimed ? [`Reclaimed: ${res.reclaimed}`] : [])].join("\n"),
        );
      }
      setError(null);
      await load();
    } catch (err) {
      const detail = err instanceof ApiError ? err.detail : String(err);
      toast("error", "Prune failed", detail);
      setError(`Prune failed: ${detail}`);
      throw err;
    } finally {
      setBusy(null);
    }
  };

  if (caps === null) {
    return (
      <div className="card">
        <header>Volumes</header>
        <div className="body"><span className="skeleton" style={{ width: "40%" }} /></div>
      </div>
    );
  }

  // No wslc, no volumes. The card is not rendered at all rather than rendered unsupported:
  // WslcUnavailableHero promises "the Resources and Settings pages work fully without
  // wslc", and a dead card on this page would contradict that in the user's face.
  if (!caps.wslc.present) return null;

  const anon = (rows ?? []).filter((v) => v.anonymous);
  const loading = rows === null && error === null;
  // Never open a prune dialog over a list we cannot enumerate: the dialog's whole job is
  // to show what is at stake, and it cannot do that from an unknown or empty list.
  const pruneBlocked = !canPrune || rows === null || rows.length === 0 || busy !== null;

  return (
    <div className="card">
      <header>
        Volumes
        {rows !== null && rows.length > 0 && <span className="badge">{rows.length}</span>}
        <span className="spacer" />
        {/* Absent, not disabled, when the verb group does not exist: there is nothing to
            enable, so a greyed row of buttons would only be furniture. */}
        {canList && (
          <>
            <button
              className="icon small"
              disabled={busy !== null}
              title="Refresh volumes"
              aria-label="Refresh volumes"
              onClick={() => void load()}
            >
              <Icon name="refresh" size={13} />
            </button>
            <button
              className="small primary"
              disabled={!canCreate || busy !== null}
              title={canCreate ? undefined : noVerbTitle("create")}
              onClick={() => setShowCreate(true)}
            >
              <Icon name="plus" size={13} />
              Create volume…
            </button>
            <span className="hdrsep" />
            {/* Ghost, not danger: a red button parked in a card header is a permanent
                alarm nobody reads. The danger styling lives in the dialog, where the
                decision is actually made (and matches Images' existing Prune). */}
            <button
              className="small ghost"
              disabled={pruneBlocked}
              title={!canPrune
                ? noVerbTitle("prune")
                : rows !== null && rows.length === 0
                ? "No volumes to prune"
                : "Remove unused anonymous volumes"}
              onClick={() => setShowPrune(true)}
            >
              <Icon name="trash" size={13} />
              Prune…
            </button>
          </>
        )}
      </header>

      {!canList ? (
        <EmptyState
          title="Volumes are not available in this wslc build"
          hint={`wslc ${caps.wslc.version ?? ""} does not expose "wslc volume". Containers can still bind-mount host paths with -v.`}
        />
      ) : (
        <>
          {error !== null && (
            <div style={{ padding: "0 var(--gap-4)" }}>
              <ErrorBanner message="Could not read volumes" detail={error} onRetry={() => void load()} />
            </div>
          )}

          <div className="tablewrap">
            <table className="responsive" aria-label="Container volumes">
              <thead>
                <tr>
                  <th>Name</th><th>Driver</th><th>Created</th>
                  <th className="actions"><span style={{ position: "absolute", clip: "rect(0 0 0 0)" }}>Actions</span></th>
                </tr>
              </thead>
              {loading ? <SkeletonRows cols={4} rows={2} /> : (
                <tbody>
                  {(rows ?? []).map((v) => (
                    <tr key={v.name} aria-busy={busy === `rm:${v.name}` ? true : undefined}>
                      <td className="mono" data-label="Name">
                        {v.name}{" "}
                        {/* A coloured chip is styling, not information — the SR-only word
                            says what the colour means. Named volumes get no badge:
                            badging both states badges neither. */}
                        {v.anonymous && (
                          <span
                            className="badge warn"
                            title="Created automatically by a container rather than by name. These are what Prune reclaims."
                          >
                            <span className="sronly">kind: </span>anonymous
                          </span>
                        )}
                        {busy === `rm:${v.name}` && <span className="pill warn">removing…</span>}
                      </td>
                      <td data-label="Driver">{v.driver || "—"}</td>
                      <td data-label="Created">
                        {v.createdAt ? new Date(v.createdAt).toLocaleString() : "—"}
                      </td>
                      <td className="actions" data-label="Actions">
                        <div className="rowactions">
                          <ActionMenu
                            label={`Actions for volume ${v.name}`}
                            items={[
                              {
                                label: "Inspect",
                                icon: "inspect",
                                disabled: !canInspect || busy !== null,
                                title: canInspect ? undefined : noVerbTitle("inspect"),
                                onSelect: () => setToInspect(v.name),
                              },
                              "sep",
                              {
                                label: "Remove…",
                                icon: "trash",
                                danger: true,
                                disabled: !canRemove || busy !== null,
                                title: canRemove ? undefined : noVerbTitle("remove"),
                                onSelect: () => setToRemove(v),
                              },
                            ]}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>

          {rows !== null && rows.length === 0 && error === null && (
            <EmptyState
              title="No volumes yet"
              hint="A named volume keeps container data alive between runs. Volumes a container creates for itself show up here too."
              action={canCreate
                ? (
                  <button className="primary" onClick={() => setShowCreate(true)}>
                    <Icon name="plus" size={14} />
                    Create volume
                  </button>
                )
                : undefined}
            />
          )}

          {/* DD1 / probe P3. Leads with where the bytes *are*, states wslc's behaviour as a
              fact, and closes with the anti-invention pledge. Only shown when there are rows
              — in the empty state there is no absent column to account for. */}
          {rows !== null && rows.length > 0 && (
            <p className="cardnote">
              Volumes live inside the wslc session VHD, so their bytes are already counted in the
              {" "}<strong>Container storage</strong> tile above. wslc reports no per-volume size,
              so none is shown here.
            </p>
          )}
        </>
      )}

      {showCreate && (
        <CreateVolumeModal
          busy={busy === "create"}
          onClose={() => setShowCreate(false)}
          onCreate={async (name) => {
            await run("create", `Created volume ${name}`, `Create volume ${name} failed`,
              () => api("/api/volumes", { method: "POST", body: { name } }));
          }}
        />
      )}

      {toInspect !== null && (
        <InspectVolumeModal name={toInspect} onClose={() => setToInspect(null)} />
      )}

      {/* The typed confirm asks for the volume's *name* — but only for a named volume.
          An anonymous volume's name is a 64-char hex blob: demanding it back would buy a
          reflexive copy-paste, not attention, so it gets the danger confirm alone. The
          typed gate exists to stop you destroying the wrong *recognisable* thing. */}
      {toRemove !== null && (
        <ConfirmModal
          title={`Remove volume ${toRemove.name}?`}
          danger
          confirmLabel="Remove permanently"
          requireText={toRemove.anonymous ? undefined : toRemove.name}
          body={
            <>
              <p>
                Everything stored in <code>{toRemove.name}</code> is deleted permanently.
                There is no undo.
              </p>
              <p className="muted" style={{ fontSize: 12.5 }}>
                If a container is still using it, wslc refuses and nothing is removed.
              </p>
            </>
          }
          onConfirm={async () => {
            // body:{} is required, not decorative: api() only sends a JSON content-type when
            // a body is present, and the server rejects a bodyless mutation with 415. Every
            // other DELETE in this app (Images ?ref=, stacks, distros) does the same.
            await run(`rm:${toRemove.name}`, `Removed volume ${toRemove.name}`,
              `Remove volume ${toRemove.name} failed`,
              () => api(`/api/volumes?name=${encodeURIComponent(toRemove.name)}`, { method: "DELETE", body: {} }));
          }}
          onClose={() => setToRemove(null)}
        />
      )}

      {/* Wording is taken from `wslc volume prune --help` on the live 2.9.3.0 build:
          "Removes all unused anonymous local volumes. If --all is specified, also removes
          unused named volumes. A volume is considered unused when it is not referenced by
          any container." The pinned API sends no --all, so this deletes ANONYMOUS unused
          volumes only — and that is what the dialog says. Claiming it deletes every
          unattached volume would frighten the user about their named data for no reason,
          and a confirm dialog that misstates its own blast radius is worthless.

          There is deliberately no "will be deleted" preview: attachment is not in
          `volume list` and not in `volume inspect`, so a true preview cannot be computed —
          and a preview that turns out wrong is worse than none. The anonymous volumes we
          *can* see are listed, with the rule stated, and wslc makes the final call. */}
      {showPrune && (
        <ConfirmModal
          title="Prune unused volumes?"
          danger
          requireText="prune"
          confirmLabel="Prune volumes"
          body={
            <>
              <p>
                <strong>
                  This permanently deletes every anonymous volume that is not attached to a
                  container.
                </strong>{" "}
                Everything stored in them is gone for good — there is no undo. Volumes you
                named yourself are not touched.
              </p>
              {anon.length > 0
                ? (
                  <section className="warnbox" role="region" aria-label="Anonymous volumes that exist now">
                    <h4 className="sectionhead warn">
                      {anon.length === 1
                        ? "1 anonymous volume exists right now"
                        : `${anon.length} anonymous volumes exist right now`}
                    </h4>
                    <ul className="warnlist">
                      {anon.map((v) => <li key={v.name} className="mono">{v.name}</li>)}
                    </ul>
                    <p className="muted" style={{ margin: 0, fontSize: 11.5 }}>
                      wslc decides which of these are unattached and skips any a container still
                      uses, so fewer may actually be removed.
                    </p>
                  </section>
                )
                : (
                  <p className="muted" style={{ fontSize: 12.5 }}>
                    No anonymous volumes are listed right now, so this will most likely reclaim nothing.
                  </p>
                )}
            </>
          }
          onConfirm={prune}
          onClose={() => setShowPrune(false)}
        />
      )}
    </div>
  );
}

function CreateVolumeModal({ busy, onCreate, onClose }: {
  busy: boolean;
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const invalid = trimmed.length > 0 && !VOLUME_NAME_RE.test(trimmed);

  const submit = async () => {
    if (trimmed.length === 0 || invalid) return;
    try {
      await onCreate(trimmed);
      onClose();
    } catch {
      // Surfaced by the toast + card banner; keep the dialog open with the name intact.
    }
  };

  return (
    <Modal
      title="Create volume"
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" disabled={trimmed.length === 0 || invalid || busy} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create"}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="req">Volume name</span>
        <input
          type="text"
          value={name}
          placeholder="app-data"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={invalid || undefined}
          aria-describedby="volname-hint"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
        <span id="volname-hint" className={invalid ? "fieldhint bad" : "fieldhint"}>
          {invalid
            ? "Letters, digits, then any of _ . - — must start with a letter or digit (max 128)."
            : "Mount it later with -v app-data:/var/lib/data."}
        </span>
      </label>
    </Modal>
  );
}

/** Raw `wslc volume inspect` JSON, verbatim. Nothing is summarised or re-labelled here —
 * this is the escape hatch for everything the table deliberately does not model. */
function InspectVolumeModal({ name, onClose }: { name: string; onClose: () => void }) {
  const [json, setJson] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await api<{ inspect: unknown }>(`/api/volumes/${encodeURIComponent(name)}/inspect`);
        if (live) setJson(JSON.stringify(res.inspect, null, 2));
      } catch (err) {
        if (live) setError(err instanceof ApiError ? err.detail : String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [name]);

  return (
    <Modal
      title={`Inspect ${name}`}
      onClose={onClose}
      wide
      actions={
        <>
          {json !== null && <CopyButton text={json} label="Copy JSON" />}
          <button className="primary" onClick={onClose}>Close</button>
        </>
      }
    >
      {error !== null
        ? <ErrorBanner message="Could not inspect that volume" detail={error} />
        : json === null
        ? (
          <div aria-live="polite">
            <span className="skeleton" style={{ width: "70%" }} />
            <span className="skeleton" style={{ width: "50%", marginTop: 6 }} />
          </div>
        )
        : <pre className="mono rawyaml" aria-label={`Raw inspect JSON for ${name}`}>{json}</pre>}
    </Modal>
  );
}

type ActFn = (k: string, l: string, fn: () => Promise<unknown>) => Promise<boolean>;

/** Highlights the file in Windows Explorer via /api/system/reveal. */
function RevealButton({ path, disabled, title = "Open file location in Explorer" }: {
  path: string;
  disabled?: boolean;
  title?: string;
}) {
  const { toast } = useApp();
  return (
    <button
      className="icon small"
      disabled={disabled}
      title={title}
      aria-label={title}
      onClick={async () => {
        try {
          await api("/api/system/reveal", { method: "POST", body: { path } });
        } catch (err) {
          toast("error", "Open location failed", err instanceof ApiError ? err.detail : String(err));
        }
      }}
    >
      <Icon name="folder" size={13} />
    </button>
  );
}

function MountModal({ busyKey, act, onClose }: { busyKey: string | null; act: ActFn; onClose: () => void }) {
  const [disk, setDisk] = useState("");
  const [vhd, setVhd] = useState(false);
  const [bare, setBare] = useState(false);
  const [partition, setPartition] = useState("");
  const busy = busyKey !== null;
  const submit = async () => {
    const ok = await act("mount", `Mounted ${disk.trim()}`, () => api("/api/wsl/mount", {
      method: "POST",
      body: { disk: disk.trim(), vhd, bare, partition: partition === "" ? undefined : Number(partition) },
    }));
    if (ok) onClose();
  };
  return (
    <Modal
      title="Mount disk"
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose} disabled={busyKey === "mount"}>Cancel</button>
          <button className="primary" disabled={disk.trim().length === 0 || busy} onClick={() => void submit()}>
            {busyKey === "mount" ? "Mounting…" : "Mount"}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="req">Disk (\\.\PHYSICALDRIVE1 or path to .vhdx)</span>
        <div className="pickrow">
          <input type="text" value={disk} list="disk-suggest" onChange={(e) => setDisk(e.target.value)} />
          <PickButton
            spec={{ kind: "file-open", title: "Select virtual disk", filters: [["Virtual disks", "*.vhdx;*.vhd"], ["All files", "*.*"]] }}
            onPick={(p) => {
              setDisk(p);
              setVhd(true);
            }}
          />
        </div>
        <datalist id="disk-suggest">
          {["\\\\.\\PHYSICALDRIVE1", "\\\\.\\PHYSICALDRIVE2"].map((s) => <option key={s} value={s} />)}
        </datalist>
      </label>
      <div className="formrow">
        <label className="checkline"><input type="checkbox" checked={vhd} onChange={(e) => setVhd(e.target.checked)} /> --vhd</label>
        <label className="checkline"><input type="checkbox" checked={bare} onChange={(e) => setBare(e.target.checked)} /> --bare</label>
        <label className="field"><span>Partition #</span>
          <input type="number" style={{ width: 90 }} value={partition} onChange={(e) => setPartition(e.target.value)} />
        </label>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        Mounting physical disks may require an elevated (Administrator) session — errors from wsl.exe are shown as-is.
      </p>
    </Modal>
  );
}

function ImportModal({ busyKey, act, onClose }: { busyKey: string | null; act: ActFn; onClose: () => void }) {
  const { toast } = useApp();
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [file, setFile] = useState("");
  const [vhd, setVhd] = useState(false);
  const [online, setOnline] = useState<{ name: string; friendlyName: string }[] | null>(null);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [onlineError, setOnlineError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const busy = busyKey !== null;

  const submit = async () => {
    const ok = await act("import", `Imported ${name}`, () => api("/api/distros/import", {
      method: "POST",
      body: { name, location, file, vhd },
    }));
    if (ok) onClose();
  };

  const fetchOnline = async () => {
    setOnlineBusy(true);
    setOnlineError(null);
    try {
      const res = await api<{ distros: { name: string; friendlyName: string }[] }>("/api/distros/online");
      setOnline(res.distros);
    } catch (err) {
      setOnlineError(err instanceof ApiError ? err.detail : String(err));
    } finally {
      setOnlineBusy(false);
    }
  };

  const install = async () => {
    if (!selected) return;
    toast("info", `Installing ${selected} — the download can take a while`);
    const ok = await act("install-online", `Installed ${selected}`, () => api("/api/distros/install-online", {
      method: "POST",
      body: { name: selected },
    }));
    if (ok) onClose();
  };

  return (
    <Modal
      title="Add distribution"
      onClose={onClose}
      wide
      actions={
        <>
          <button onClick={onClose} disabled={busyKey === "import" || busyKey === "install-online"}>Cancel</button>
          {selected ? (
            <button className="primary" disabled={busy} onClick={() => void install()}>
              <Icon name="download" size={13} />
              {busyKey === "install-online" ? "Installing… (download can take a while)" : `Install ${selected}`}
            </button>
          ) : (
            <button className="primary" disabled={!name || !location || !file || busy} onClick={() => void submit()}>
              {busyKey === "import" ? "Importing…" : "Import"}
            </button>
          )}
        </>
      }
    >
      <span className="muted" style={{ fontSize: 11.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        Import from local file
      </span>
      <label className="field"><span className="req">Name</span>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="CentOS" /></label>
      <label className="field"><span className="req">Install location</span>
        <div className="pickrow">
          <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="D:\wsl\centos" />
          <PickButton spec={{ kind: "folder", title: "Select install location" }} onPick={setLocation} />
        </div></label>
      <label className="field"><span className="req">Source file (.tar / .vhdx)</span>
        <div className="pickrow">
          <input type="text" value={file} onChange={(e) => setFile(e.target.value)} placeholder="D:\downloads\centos.tar" />
          <PickButton
            spec={{
              kind: "file-open",
              title: "Select distribution source",
              filters: [["Distribution sources", "*.tar;*.tar.gz;*.tar.xz;*.vhdx;*.vhd"], ["All files", "*.*"]],
            }}
            onPick={(p) => {
              setFile(p);
              if (/\.vhdx?$/i.test(p)) setVhd(true);
            }}
          />
        </div></label>
      <label className="checkline"><input type="checkbox" checked={vhd} onChange={(e) => setVhd(e.target.checked)} /> Import as VHD (--vhd)</label>

      <div style={{ borderTop: "1px solid var(--hairline)", margin: "4px 0" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="muted" style={{ fontSize: 11.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", flex: 1 }}>
          Or install from the online registry
        </span>
        <button className="small" disabled={onlineBusy} onClick={() => void fetchOnline()}>
          <Icon name="refresh" size={12} />
          {onlineBusy ? "Fetching…" : "Fetch available"}
        </button>
      </div>
      {onlineError && (
        <div className="errorbanner" role="alert" style={{ fontSize: 12.5 }}>
          <strong>Fetch failed</strong>
          <span className="muted">{onlineError}</span>
        </div>
      )}
      {online && (
        online.length === 0
          ? <span className="muted" style={{ fontSize: 12.5 }}>The registry reported no installable distributions.</span>
          : (
            <div className="taglist" role="listbox" aria-label="Installable distributions">
              {online.map((d) => (
                <button key={d.name} role="option" aria-selected={selected === d.name}
                  className={selected === d.name ? "sel" : undefined}
                  onClick={() => setSelected(selected === d.name ? null : d.name)}>
                  <span className="mono">{d.name}</span>
                  <span className="when">{d.friendlyName}</span>
                </button>
              ))}
            </div>
          )
      )}
      {selected && (
        <p className="muted" style={{ fontSize: 12 }}>
          Runs <code>wsl --install {selected} --no-launch</code> — the distribution is downloaded from Microsoft's registry.
        </p>
      )}
    </Modal>
  );
}
