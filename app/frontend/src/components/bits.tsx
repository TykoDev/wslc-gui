import { useRef, useState, type ReactNode } from "react";
import { useApp } from "../state.tsx";
import { api } from "../lib/api.ts";
import { Icon } from "./icons.tsx";

/** KPI band (dataviz stat-tile contract): label · semibold value · optional meta.
    Values wear text tokens; the dot is reserved for status. */
export function StatsBar({ stats }: {
  stats: {
    label: string;
    value: ReactNode;
    /** Unit or secondary part rendered small next to the value. */
    unit?: string;
    meta?: string;
    dot?: "ok" | "warn" | "bad" | "neutral";
    /** Render a skeleton while the backing snapshot is loading. */
    loading?: boolean;
  }[];
}) {
  return (
    <div className="stats">
      {stats.map((s) => (
        <div key={s.label} className="stat">
          <span className="label">
            {s.dot && <span className={`dot ${s.dot === "neutral" ? "" : s.dot}`} />}
            {s.label}
          </span>
          {s.loading
            ? <span className="skeleton" style={{ width: "50%", height: 18, margin: "5px 0" }} />
            : (
              <span className="value">
                {s.value}
                {s.unit && <small>{s.unit}</small>}
              </span>
            )}
          {s.meta && !s.loading && <span className="meta">{s.meta}</span>}
        </div>
      ))}
    </div>
  );
}

export function SkeletonRows({ cols, rows = 4 }: { cols: number; rows?: number }) {
  return (
    <tbody>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <td key={c}><span className="skeleton" style={{ width: `${60 + ((r + c) % 3) * 15}%` }} /></td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{hint}</p>
      {action}
    </div>
  );
}

export function ErrorBanner({ message, detail, onRetry }: { message: string; detail?: string; onRetry?: () => void }) {
  return (
    <div className="errorbanner" role="alert">
      <strong>{message}</strong>
      {detail ? <details><summary>Details</summary><pre className="mono">{detail}</pre></details> : null}
      {onRetry ? <div><button onClick={onRetry}>Retry</button></div> : null}
    </div>
  );
}

/** Full-page state when wslc is missing on this host (interface-design §2.4). */
export function WslcUnavailableHero() {
  const { caps, toast } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <div className="card">
      <div className="hero">
        <h3>WSL containers are not available on this host</h3>
        <p>
          The <code>wslc</code> CLI ships with newer WSL releases and was not found.
          Detected WSL: <strong>{caps?.wsl.version ?? "unknown"}</strong> on Windows build{" "}
          <strong>{caps?.windows.build ?? "?"}</strong>.
        </p>
        <p>
          Update WSL from PowerShell, then re-check: <code>wsl --update</code>
        </p>
        <div className="actions">
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api("/api/capabilities?force=1");
                toast("info", "Re-checked wslc availability");
              } catch (err) {
                toast("error", "Re-check failed", String(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Checking…" : "Re-check"}
          </button>
          <button onClick={() => navigator.clipboard.writeText("wsl --update")}>
            Copy "wsl --update"
          </button>
        </div>
        <p className="muted" style={{ marginTop: 12 }}>
          The Resources and Settings pages work fully without wslc.
        </p>
      </div>
    </div>
  );
}

export interface PickSpec {
  kind: "file-open" | "file-save" | "folder";
  title?: string;
  filters?: [string, string][];
  defExt?: string;
}

/** Native file/folder picker button (server-hosted dialog via /api/system/pick). */
export function PickButton({ spec, onPick, label = "Browse…", className = "small", disabled }: {
  spec: PickSpec;
  onPick: (path: string) => void;
  label?: string;
  /** Defaults to a compact inline button; empty-state CTAs pass e.g. "primary". */
  className?: string;
  disabled?: boolean;
}) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={busy || disabled}
      aria-label={spec.kind === "folder" ? "Browse for folder" : "Browse for file"}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await api<{ path?: string; cancelled?: boolean }>("/api/system/pick", {
            method: "POST",
            body: spec,
          });
          if (typeof r.path === "string" && r.path.length > 0) onPick(r.path);
        } catch (err) {
          toast("error", "File dialog failed", String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="folder" size={13} />
      {busy ? "…" : label}
    </button>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  // FE-11: the clipboard write can reject (permission, insecure context, no API). Await it
  // and only claim "Copied" on success — otherwise say so, so the user does not paste stale
  // content believing the copy landed.
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  return (
    <button
      className="small ghost"
      aria-label={`${label || "Copy"} to clipboard`}
      title={state === "fail" ? "Copy failed — select the text and copy manually" : `${label || "Copy"} to clipboard`}
      onClick={async () => {
        let ok = false;
        try {
          await navigator.clipboard.writeText(text);
          ok = true;
        } catch {
          ok = false;
        }
        setState(ok ? "done" : "fail");
        setTimeout(() => setState("idle"), ok ? 1500 : 3000);
      }}
    >
      <Icon name={state === "done" ? "check" : state === "fail" ? "x" : "copy"} size={13} />
      {state === "done" ? "Copied" : state === "fail" ? "Copy failed" : label}
    </button>
  );
}

/** Placeholder lines for a panel whose content is still loading (FE-9). Announced politely
 * so a screen-reader user hears that something is on the way, mirroring InspectVolumeModal. */
export function LoadingLines({ label = "Loading…" }: { label?: string }) {
  return (
    <div aria-live="polite" aria-busy="true">
      <span className="sronly">{label}</span>
      <span className="skeleton" style={{ width: "70%" }} />
      <span className="skeleton" style={{ width: "50%", marginTop: 6 }} />
      <span className="skeleton" style={{ width: "60%", marginTop: 6 }} />
    </div>
  );
}

/** WAI-ARIA tabs: roving tabindex + arrow/Home/End with focus following selection, and a
 * real `aria-controls` link to each panel (FE-6). Callers render the panels and give each
 * one `role="tabpanel"`, `id` = the tab's `controls`, and `aria-labelledby` = the tab's id. */
export function Tablist<T extends string>({ label, tabs, value, onChange, className = "seg", idBase }: {
  label: string;
  tabs: { value: T; label: ReactNode; id?: string; controls?: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  idBase: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tabId = (v: T) => tabs.find((t) => t.value === v)?.id ?? `${idBase}-tab-${v}`;
  const panelId = (v: T) => tabs.find((t) => t.value === v)?.controls ?? `${idBase}-panel-${v}`;
  const onKey = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.value === value);
    if (i < 0) return;
    let n = i;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        n = (i + 1) % tabs.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        n = (i - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        n = 0;
        break;
      case "End":
        n = tabs.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const next = tabs[n].value;
    onChange(next);
    // Focus follows selection (automatic activation) — the roving tabindex the render
    // applies would otherwise leave focus on the now -1 tab.
    refs.current[next]?.focus();
  };
  return (
    <div className={className} role="tablist" aria-label={label} onKeyDown={onKey}>
      {tabs.map((t) => {
        const selected = t.value === value;
        return (
          <button
            key={t.value}
            ref={(el) => {
              refs.current[t.value] = el;
            }}
            role="tab"
            id={tabId(t.value)}
            aria-controls={panelId(t.value)}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.value)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function fmtBytes(n: number | null): string {
  if (n === null) return "—";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}
