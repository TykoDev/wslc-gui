import { useState } from "react";
import { useApp } from "../state.tsx";
import { api, ApiError } from "../lib/api.ts";
import { EmptyState, LoadingLines, SkeletonRows, StatsBar, WslcUnavailableHero } from "../components/bits.tsx";
import { ConfirmModal, Drawer } from "../components/Modal.tsx";
import { ActionMenu } from "../components/Menu.tsx";
import { FloatWindow } from "../components/FloatWindow.tsx";
import { Icon } from "../components/icons.tsx";
import type { ContainerRow } from "../lib/types.ts";
import { NavLink } from "react-router";

function ref(c: ContainerRow): string {
  return c.name ?? c.id ?? "";
}

function isRunning(c: ContainerRow): boolean {
  return /up|running/i.test(c.status ?? "");
}

/** Best-effort parse of `wslc stats` table output (columns split on 2+ spaces).
    Returns per-container CPU/MEM keyed by id and name plus the full grid for
    the usage card; null when unparseable. */
function parseStats(text: string | null | undefined): {
  byKey: Map<string, { cpu: string | null; mem: string | null }>;
  cpuTotal: number | null;
  memTotal: string | null;
  grid: { header: string[]; rows: string[][] };
} | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return null;
  const header = lines[0].trim().split(/\s{2,}/).map((h) => h.toUpperCase());
  const cpuIdx = header.findIndex((h) => h.includes("CPU"));
  const memIdx = header.findIndex((h) => h.includes("MEM"));
  const idIdx = header.findIndex((h) => h.includes("ID") || h.includes("CONTAINER"));
  const nameIdx = header.findIndex((h) => h === "NAME" || h === "NAMES");
  if (cpuIdx < 0 && memIdx < 0) return null;

  const byKey = new Map<string, { cpu: string | null; mem: string | null }>();
  const gridRows: string[][] = [];
  let cpuTotal: number | null = null;
  let memBytes: number | null = null;
  // FE-10: ONE base — binary — for both parse and format, so the total matches the per-row
  // MEM cells shown in the table. `wslc stats` is docker-derived and reports binary units
  // (KiB/MiB/GiB); the scale letter is read case-insensitively and the optional `i` ignored,
  // so a build printing `MB` is still treated as the binary quantity it actually is. The old
  // table mixed decimal parse (MB=1e6) with binary format (÷1024²), running the total ~4.8%
  // low under a mislabelled unit.
  const scale: Record<string, number> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  for (const line of lines.slice(1)) {
    const cells = line.trim().split(/\s{2,}/);
    gridRows.push(cells);
    const cpu = cpuIdx >= 0 ? cells[cpuIdx] ?? null : null;
    const mem = memIdx >= 0 ? (cells[memIdx] ?? null)?.split("/")[0].trim() ?? null : null;
    const entry = { cpu, mem };
    if (idIdx >= 0 && cells[idIdx]) byKey.set(cells[idIdx], entry);
    if (nameIdx >= 0 && cells[nameIdx]) byKey.set(cells[nameIdx], entry);
    const cpuNum = cpu ? parseFloat(cpu.replace("%", "")) : NaN;
    if (!Number.isNaN(cpuNum)) cpuTotal = (cpuTotal ?? 0) + cpuNum;
    const m = mem?.match(/^([\d.]+)\s*([KMGT]?)i?B$/i);
    if (m) memBytes = (memBytes ?? 0) + parseFloat(m[1]) * scale[m[2].toUpperCase()];
  }
  const memTotal = memBytes === null ? null : memBytes >= 1024 ** 3
    ? `${(memBytes / 1024 ** 3).toFixed(1)} GiB`
    : `${Math.round(memBytes / 1024 ** 2)} MiB`;
  return { byKey, cpuTotal, memTotal, grid: { header: lines[0].trim().split(/\s{2,}/), rows: gridRows } };
}

/** Compact status pill: first word colored by state, full text on hover. */
function StatusPill({ status }: { status: string | null }) {
  if (!status) return <>—</>;
  const word = status.split(/\s+/)[0].toLowerCase();
  const cls = /up|running/i.test(status) ? "ok" : /exit|dead|stop/i.test(status) ? "" : "warn";
  return <span className={`pill ${cls}`} title={status}>{word}</span>;
}

export function ContainersPage() {
  const { caps, containers, images, resources, toast, config } = useApp();
  const [showStopped, setShowStopped] = useState(config.showStoppedDefault);
  const [busy, setBusy] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ title: string; text: string; loading?: boolean } | null>(null);
  const [logWin, setLogWin] = useState<{ title: string; text: string; loading?: boolean } | null>(null);
  const [execFor, setExecFor] = useState<string | null>(null);
  const [execCmd, setExecCmd] = useState("");
  const [execBusy, setExecBusy] = useState(false);
  const [execResult, setExecResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; danger: boolean; onConfirm: () => Promise<void> } | null>(null);

  if (caps === null) {
    return (
      <div className="page">
        <StatsBar stats={[
          { label: "Running", value: "", loading: true },
          { label: "Stopped", value: "", loading: true },
          { label: "Images", value: "", loading: true },
          { label: "CPU", value: "", loading: true },
          { label: "Memory", value: "", loading: true },
        ]} />
        <div className="card tablewrap">
          <table className="responsive">
            <thead><tr><th>Name</th><th>Image</th><th>Status</th><th>Ports</th><th className="actions">Actions</th></tr></thead>
            <SkeletonRows cols={5} />
          </table>
        </div>
      </div>
    );
  }
  if (!caps.wslc.present) {
    return <div className="page"><WslcUnavailableHero /></div>;
  }

  const all = containers?.containers ?? [];
  const rows = showStopped ? all : all.filter(isRunning);
  const can = caps.wslc.can;
  const runningCount = all.filter(isRunning).length;
  const stats = parseStats(containers?.stats);
  const loading = containers === null;

  const act = async (key: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
      toast("ok", label);
    } catch (err) {
      toast("error", `${label} failed`, err instanceof ApiError ? err.detail : String(err));
    } finally {
      setBusy(null);
    }
  };

  const openText = async (title: string, path: string, target: "drawer" | "window" = "drawer") => {
    // FE-9: open the panel immediately in a loading state (like Volume Inspect) so the click
    // gets instant feedback, instead of nothing until the round-trip resolves.
    const setter = target === "window" ? setLogWin : setDrawer;
    setter({ title, text: "", loading: true });
    try {
      const res = await api<{ stdout: string }>(path);
      setter({ title, text: res.stdout || "(empty)" });
    } catch (err) {
      // The fetch failed, so there is nothing to show — close the panel and report it.
      setter(null);
      toast("error", `${title} failed`, err instanceof ApiError ? err.detail : String(err));
    }
  };

  return (
    <div className="page">
      <StatsBar stats={[
        { label: "Running", value: runningCount, dot: runningCount > 0 ? "ok" : "neutral", loading },
        { label: "Stopped", value: all.length - runningCount, loading },
        { label: "Images", value: images?.images.length ?? "—", loading: images === null },
        {
          label: "CPU",
          value: stats?.cpuTotal !== null && stats?.cpuTotal !== undefined ? stats.cpuTotal.toFixed(1) : "—",
          unit: stats?.cpuTotal !== null && stats?.cpuTotal !== undefined ? "%" : undefined,
          meta: stats ? "all containers" : "no stats reported",
          loading,
        },
        {
          label: "Memory",
          value: stats?.memTotal ?? "—",
          meta: stats?.memTotal ? "all containers" : "no stats reported",
          loading,
        },
      ]} />

      {containers?.stats && (
        <div className="card">
          <header>Resource usage (wslc stats)</header>
          {stats && stats.grid.rows.length > 0 ? (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>{stats.grid.header.map((h) => <th key={h}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {stats.grid.rows.map((row, i) => (
                    <tr key={i}>
                      {stats.grid.header.map((_, c) => <td key={c} className="mono">{row[c] ?? "—"}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="body"><pre className="mono" style={{ margin: 0, overflowX: "auto" }}>{containers.stats}</pre></div>
          )}
        </div>
      )}

      <div className="card">
        <header>
          {rows.length} {showStopped ? (rows.length === 1 ? "container" : "containers") : "running"}
          <span className="spacer" />
          <label className="checkline">
            <input type="checkbox" checked={showStopped} onChange={(e) => setShowStopped(e.target.checked)} />
            Show stopped
          </label>
          <button
            className="small ghost"
            disabled={busy !== null}
            onClick={() =>
              setConfirm({
                title: "Remove all stopped containers?",
                body: "Runs `wslc container prune`. Stopped containers are removed permanently.",
                danger: true,
                onConfirm: () => act("prune", "Pruned stopped containers", () => api("/api/containers/prune", { method: "POST", body: {} })),
              })}
          >
            <Icon name="trash" size={13} />
            Prune
          </button>
        </header>
        <div className="tablewrap">
          <table className="responsive">
            <thead>
              <tr>
                <th>Name</th><th>Image</th><th>Status</th><th>Ports</th>
                {stats && <th>CPU</th>}
                {stats && <th>Mem</th>}
                <th className="actions"><span style={{ position: "absolute", clip: "rect(0 0 0 0)" }}>Actions</span></th>
              </tr>
            </thead>
            {containers === null ? <SkeletonRows cols={stats ? 7 : 5} /> : (
              <tbody>
                {rows.map((c) => {
                  const r = ref(c);
                  const running = isRunning(c);
                  const st = stats?.byKey.get(c.id ?? "") ?? stats?.byKey.get(c.name ?? "");
                  return (
                    <tr key={r}>
                      <td className="mono" data-label="Name">{c.name ?? <span className="muted">{c.id}</span>}</td>
                      <td className="mono" data-label="Image">{c.image ?? "—"}</td>
                      <td data-label="Status"><StatusPill status={c.status} /></td>
                      <td className="mono" data-label="Ports">{c.ports || "—"}</td>
                      {stats && <td className="mono" data-label="CPU">{st?.cpu ?? "—"}</td>}
                      {stats && <td className="mono" data-label="Mem">{st?.mem ?? "—"}</td>}
                      <td className="actions" data-label="Actions">
                        <div className="rowactions">
                          {running ? (
                            <button className="icon small" disabled={busy !== null} aria-label={`Stop container ${r}`}
                              title={`Stop ${r}`}
                              onClick={() => act(`stop:${r}`, `Stopped ${r}`, () => api(`/api/containers/${r}/stop`, { method: "POST", body: {} }))}>
                              {busy === `stop:${r}` ? "…" : <Icon name="stop" size={14} />}
                            </button>
                          ) : (
                            <button className="icon small" disabled={!can.start || busy !== null}
                              title={can.start ? `Start ${r}` : "container start not exposed by this wslc build"}
                              aria-label={`Start container ${r}`}
                              onClick={() => act(`start:${r}`, `Started ${r}`, () => api(`/api/containers/${r}/start`, { method: "POST", body: {} }))}>
                              {busy === `start:${r}` ? "…" : <Icon name="play" size={14} />}
                            </button>
                          )}
                          <ActionMenu
                            label={`Actions for ${r}`}
                            items={[
                              { label: "Logs", icon: "logs", onSelect: () => void openText(`Logs — ${r}`, `/api/containers/${r}/logs`, "window") },
                              { label: "Inspect", icon: "inspect", onSelect: () => void openText(`Inspect — ${r}`, `/api/containers/${r}/inspect`) },
                              { label: "Exec…", icon: "terminal", onSelect: () => { setExecFor(r); setExecCmd(""); setExecResult(null); setExecBusy(false); } },
                              "sep",
                              {
                                label: "Delete…",
                                icon: "trash",
                                danger: true,
                                disabled: !can.rmContainer || busy !== null,
                                title: can.rmContainer ? undefined : "container rm not exposed by this wslc build",
                                onSelect: () =>
                                  setConfirm({
                                    title: `Delete container ${r}?`,
                                    body: "The container is removed permanently.",
                                    danger: true,
                                    onConfirm: () => act(`rm:${r}`, `Deleted ${r}`, () => api(`/api/containers/${r}`, { method: "DELETE", body: {} })),
                                  }),
                              },
                            ]}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            )}
          </table>
        </div>
        {containers !== null && rows.length === 0 && (
          <EmptyState
            title={showStopped ? "No containers" : "No running containers"}
            hint="Run your first container from the Deploy page."
            action={<NavLink to="/deploy"><button className="primary"><Icon name="deploy" size={14} />Go to Deploy</button></NavLink>}
          />
        )}
      </div>

      {(resources?.running.length ?? 0) > 0 && (
        <div className="card">
          <header>Running WSL distributions <span className="badge" title="Full lifecycle on the Resources page">VMs</span></header>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th><th>State</th><th>WSL</th>
                  <th className="actions"><span style={{ position: "absolute", clip: "rect(0 0 0 0)" }}>Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {(resources?.distros ?? []).filter((d) => d.state === "Running").map((d) => (
                  <tr key={d.name}>
                    <td className="mono">{d.name} {d.isDefault && <span className="badge">default</span>}</td>
                    <td><span className="pill ok">running</span></td>
                    <td>{d.version}</td>
                    <td className="actions">
                      <div className="rowactions">
                        <button className="icon small" disabled={busy !== null}
                          title={`Terminate ${d.name}`} aria-label={`Terminate ${d.name}`}
                          onClick={() => act(`vmstop:${d.name}`, `Terminated ${d.name}`, () => api(`/api/distros/${d.name}/terminate`, { method: "POST", body: {} }))}>
                          {busy === `vmstop:${d.name}` ? "…" : <Icon name="stop" size={14} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {drawer && (
        <Drawer title={drawer.title} onClose={() => setDrawer(null)}>
          {drawer.loading ? <LoadingLines label={`Loading ${drawer.title}`} /> : <pre className="mono">{drawer.text}</pre>}
        </Drawer>
      )}
      {logWin && (
        <FloatWindow title={logWin.title} onClose={() => setLogWin(null)}>
          {logWin.loading ? <LoadingLines label={`Loading ${logWin.title}`} /> : <pre className="mono">{logWin.text}</pre>}
        </FloatWindow>
      )}

      {execFor && (
        <Drawer title={`Exec in ${execFor}`} onClose={() => setExecFor(null)}>
          <div className="formrow">
            <label className="field" style={{ flex: 1 }}>
              <span>Command (tokens split on spaces)</span>
              <input type="text" value={execCmd} placeholder="cat /etc/os-release" list="exec-suggest"
                disabled={execBusy}
                onChange={(e) => setExecCmd(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && document.getElementById("exec-run")?.click()} />
              <datalist id="exec-suggest">
                {["cat /etc/os-release", "ps aux", "env", "ls -la /", "df -h", "uname -a", "ip addr"].map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <button id="exec-run" className="primary" disabled={execCmd.trim().length === 0 || execBusy}
              onClick={async () => {
                // FE-8: disable while in flight so Enter/click cannot double-submit the exec.
                setExecBusy(true);
                try {
                  const res = await api<{ stdout: string }>(`/api/containers/${execFor}/exec`, {
                    method: "POST",
                    body: { command: execCmd.trim().split(/\s+/) },
                  });
                  setExecResult({ ok: true, text: res.stdout || "(no output)" });
                } catch (err) {
                  setExecResult({ ok: false, text: err instanceof ApiError ? err.detail : String(err) });
                } finally {
                  setExecBusy(false);
                }
              }}>
              <Icon name="play" size={13} />
              {execBusy ? "Running…" : "Run"}
            </button>
          </div>
          {/* FE-8: a failed exec (nonzero exit / stderr) is shown distinctly — labelled and on
              the danger surface — never merged into the same <pre> as a successful stdout. */}
          {execResult && (execResult.ok
            ? <pre className="mono">{execResult.text}</pre>
            : (
              <div className="execerr" role="alert">
                <strong style={{ color: "var(--danger)" }}>Command failed (stderr)</strong>
                <pre className="mono" style={{ margin: "6px 0 0", background: "var(--danger-soft)", borderRadius: 8, padding: 12, whiteSpace: "pre-wrap" }}>{execResult.text}</pre>
              </div>
            ))}
        </Drawer>
      )}

      {confirm && (
        <ConfirmModal
          title={confirm.title}
          body={<p>{confirm.body}</p>}
          confirmLabel="Confirm"
          danger={confirm.danger}
          onConfirm={confirm.onConfirm}
          onClose={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
