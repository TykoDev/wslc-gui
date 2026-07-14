import { useState } from "react";
import { useApp } from "../state.tsx";
import { api, ApiError } from "../lib/api.ts";
import { EmptyState, LoadingLines, SkeletonRows, StatsBar, WslcUnavailableHero } from "../components/bits.tsx";
import { ConfirmModal, Drawer, Modal } from "../components/Modal.tsx";
import { ActionMenu } from "../components/Menu.tsx";
import { Icon } from "../components/icons.tsx";
import type { ImageRow, TagList } from "../lib/types.ts";

function refOf(i: ImageRow): string {
  if (i.repository && i.tag && i.tag !== "<none>") return `${i.repository}:${i.tag}`;
  return i.repository ?? i.id ?? "";
}

/** Sum size strings like "72.99 MB" / "1.2 GiB"; null when nothing parses. */
function totalSize(rows: ImageRow[]): string | null {
  const unit: Record<string, number> = {
    B: 1, KB: 1e3, MB: 1e6, GB: 1e9, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3,
  };
  let bytes: number | null = null;
  for (const r of rows) {
    const m = r.size?.match(/^([\d.]+)\s*([KMG]i?B|B)$/i);
    if (m) bytes = (bytes ?? 0) + parseFloat(m[1]) * (unit[m[2].toUpperCase()] ?? 1);
  }
  if (bytes === null) return null;
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

const PULL_SUGGESTIONS = [
  "nginx:latest", "ubuntu:latest", "alpine:latest", "debian:stable-slim",
  "postgres:16", "redis:7", "mysql:8", "node:22-alpine", "python:3.12-slim",
  "hello-world",
];

export function ImagesPage() {
  const { caps, images, toast } = useApp();
  const [pullOpen, setPullOpen] = useState(false);
  const [pullRef, setPullRef] = useState("");
  const [tags, setTags] = useState<TagList | null>(null);
  const [tagsBusy, setTagsBusy] = useState(false);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ title: string; text: string; loading?: boolean } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: string; onConfirm: () => Promise<void> } | null>(null);

  if (caps === null) {
    return (
      <div className="page">
        <StatsBar stats={[
          { label: "Local images", value: "", loading: true },
          { label: "Total size", value: "", loading: true },
          { label: "Untagged", value: "", loading: true },
        ]} />
        <div className="card tablewrap">
          <table><thead><tr><th>Repository</th><th>Tag</th><th>ID</th><th>Size</th><th className="actions"></th></tr></thead><SkeletonRows cols={5} /></table>
        </div>
      </div>
    );
  }
  if (!caps.wslc.present) return <div className="page"><WslcUnavailableHero /></div>;

  const can = caps.wslc.can;
  const rows = images?.images ?? [];
  const loading = images === null;
  const size = totalSize(rows);
  const untagged = rows.filter((i) => !i.tag || i.tag === "<none>").length;

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

  /** The ref without its :tag part (tag = text after the last colon that
      follows the last slash), so clicked tags replace cleanly. */
  const repoBase = (ref: string): string => {
    const r = ref.trim();
    const lastSlash = r.lastIndexOf("/");
    const lastColon = r.lastIndexOf(":");
    return lastColon > lastSlash ? r.slice(0, lastColon) : r;
  };

  const fetchTags = async () => {
    const base = repoBase(pullRef);
    if (!base) return;
    setTagsBusy(true);
    setTagsError(null);
    setTags(null);
    try {
      setTags(await api<TagList>(`/api/registry/tags?ref=${encodeURIComponent(base)}`));
    } catch (err) {
      setTagsError(err instanceof ApiError ? err.detail : String(err));
    } finally {
      setTagsBusy(false);
    }
  };

  const openPull = () => {
    setTags(null);
    setTagsError(null);
    setPullOpen(true);
  };

  const doPull = async () => {
    const refv = pullRef.trim();
    setBusy("pull");
    try {
      await api("/api/images/pull", { method: "POST", body: { ref: refv } });
      toast("ok", `Pulled ${refv}`);
      setPullOpen(false);
      setPullRef("");
    } catch (err) {
      toast("error", `Pull ${refv} failed`, err instanceof ApiError ? err.detail : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <StatsBar stats={[
        { label: "Local images", value: rows.length, loading },
        { label: "Total size", value: size ?? "—", loading },
        { label: "Untagged", value: untagged, dot: untagged > 0 ? "warn" : "neutral", loading },
      ]} />

      <div className="card">
        <header>
          {rows.length} local image{rows.length === 1 ? "" : "s"}
          <span className="spacer" />
          <button className="small ghost" disabled={busy !== null}
            onClick={() =>
              setConfirm({
                title: "Remove unused images?",
                body: "Runs `wslc image prune`. Unused images are removed permanently.",
                onConfirm: () => act("prune", "Pruned unused images", () => api("/api/images/prune", { method: "POST", body: {} })),
              })}>
            <Icon name="trash" size={13} />
            Prune
          </button>
          <button className="small primary" onClick={openPull}>
            <Icon name="download" size={13} />
            Pull image
          </button>
        </header>
        <div className="tablewrap">
          <table className="responsive">
            <thead>
              <tr>
                <th>Repository</th><th>Tag</th><th>ID</th><th>Size</th>
                <th className="actions"><span style={{ position: "absolute", clip: "rect(0 0 0 0)" }}>Actions</span></th>
              </tr>
            </thead>
            {images === null ? <SkeletonRows cols={5} /> : (
              <tbody>
                {rows.map((i, idx) => {
                  const r = refOf(i);
                  return (
                    <tr key={`${r}:${idx}`}>
                      <td className="mono" data-label="Repository">{i.repository ?? "—"}</td>
                      <td className="mono" data-label="Tag">{i.tag ?? "—"}</td>
                      <td className="mono muted" data-label="ID">{i.id ?? "—"}</td>
                      <td data-label="Size">{i.size ?? "—"}</td>
                      <td className="actions" data-label="Actions">
                        <div className="rowactions">
                          <ActionMenu
                            label={`Actions for ${r}`}
                            items={[
                              {
                                label: "Inspect",
                                icon: "inspect",
                                onSelect: async () => {
                                  // FE-9: open the drawer immediately in a loading state
                                  // instead of stalling with no feedback until the round-trip
                                  // resolves (matches Volume Inspect / Containers).
                                  setDrawer({ title: `Inspect — ${r}`, text: "", loading: true });
                                  try {
                                    const res = await api<{ stdout: string }>(`/api/images/inspect?ref=${encodeURIComponent(r)}`);
                                    setDrawer({ title: `Inspect — ${r}`, text: res.stdout || "(empty)" });
                                  } catch (err) {
                                    setDrawer(null);
                                    toast("error", "Inspect failed", err instanceof ApiError ? err.detail : String(err));
                                  }
                                },
                              },
                              "sep",
                              {
                                label: "Delete…",
                                icon: "trash",
                                danger: true,
                                disabled: !can.rmImage || busy !== null,
                                title: can.rmImage ? undefined : "image rm not exposed by this wslc build",
                                onSelect: () =>
                                  setConfirm({
                                    title: `Delete image ${r}?`,
                                    body: "The image is removed permanently.",
                                    onConfirm: () => act(`rm:${r}`, `Deleted ${r}`, () => api(`/api/images?ref=${encodeURIComponent(r)}`, { method: "DELETE", body: {} })),
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
        {images !== null && rows.length === 0 && (
          <EmptyState
            title="No local images"
            hint="Pull an image — it lands here and becomes runnable from Deploy."
            action={<button className="primary" onClick={openPull}><Icon name="download" size={14} />Pull image</button>}
          />
        )}
      </div>

      {pullOpen && (
        <Modal
          title="Pull image"
          onClose={() => busy !== "pull" && setPullOpen(false)}
          actions={
            <>
              <button onClick={() => setPullOpen(false)} disabled={busy === "pull"}>Cancel</button>
              <button className="primary" disabled={pullRef.trim().length === 0 || busy !== null} onClick={() => void doPull()}>
                {busy === "pull" ? "Pulling… (can take a while)" : "Pull"}
              </button>
            </>
          }
        >
          {!can.pull && (
            <p className="muted" style={{ fontSize: 12.5 }}>
              No explicit pull verb detected — a throwaway <code>wslc run --rm IMAGE true</code> forces the documented auto-pull.
            </p>
          )}
          <label className="field">
            <span className="req">Image reference</span>
            <div className="pickrow">
              <input type="text" value={pullRef} placeholder="nginx:latest or docker.io/library/alpine:latest"
                list="pull-suggest" onChange={(e) => setPullRef(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && pullRef.trim() && busy === null && void doPull()} />
              <button className="small" disabled={repoBase(pullRef).length === 0 || tagsBusy}
                title="List available versions from the registry (public repositories)"
                onClick={() => void fetchTags()}>
                <Icon name="refresh" size={12} />
                {tagsBusy ? "Fetching…" : "Fetch tags"}
              </button>
            </div>
            <datalist id="pull-suggest">
              {[...PULL_SUGGESTIONS, ...rows.map(refOf)]
                .filter((v, i, a) => v && a.indexOf(v) === i)
                .map((r) => <option key={r} value={r} />)}
            </datalist>
          </label>
          {tagsError && (
            <div className="errorbanner" role="alert" style={{ fontSize: 12.5 }}>
              <strong>Tag fetch failed</strong>
              <span className="muted">{tagsError}</span>
            </div>
          )}
          {tags && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>
                {tags.tags.length}{tags.total !== null && tags.total > tags.tags.length ? ` of ${tags.total}` : ""} tags ·{" "}
                {tags.source === "hub" ? "Docker Hub" : tags.registry} · {tags.repository}
              </span>
              {tags.tags.length === 0
                ? <span className="muted" style={{ fontSize: 12.5 }}>The registry reports no tags for this repository.</span>
                : (
                  <div className="taglist" role="listbox" aria-label="Available tags">
                    {tags.tags.map((t) => (
                      <button key={t.name} role="option" aria-selected={pullRef.trim() === `${repoBase(pullRef)}:${t.name}`}
                        onClick={() => setPullRef(`${repoBase(pullRef)}:${t.name}`)}>
                        <span className="mono">{t.name}</span>
                        {t.updated && <span className="when">{new Date(t.updated).toLocaleDateString()}</span>}
                      </button>
                    ))}
                  </div>
                )}
            </div>
          )}
        </Modal>
      )}

      {drawer && (
        <Drawer title={drawer.title} onClose={() => setDrawer(null)}>
          {drawer.loading ? <LoadingLines label={`Loading ${drawer.title}`} /> : <pre className="mono">{drawer.text}</pre>}
        </Drawer>
      )}
      {confirm && (
        <ConfirmModal title={confirm.title} body={<p>{confirm.body}</p>} confirmLabel="Confirm" danger
          onConfirm={confirm.onConfirm} onClose={() => setConfirm(null)} />
      )}
    </div>
  );
}
