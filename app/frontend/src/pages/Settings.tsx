import { useEffect, useState } from "react";
import { useApp } from "../state.tsx";
import { api, ApiError } from "../lib/api.ts";
import { ConfirmModal } from "../components/Modal.tsx";
import { PickButton, Tablist } from "../components/bits.tsx";
import { parseSize, SizeInput } from "../components/SizeInput.tsx";
import { Icon } from "../components/icons.tsx";
import type { WslConfigPayload } from "../lib/types.ts";

export function SettingsPage() {
  const { config, setConfig, toast, caps, resources } = useApp();
  const [sub, setSub] = useState<"app" | "wsl">("app");
  const [confirmShutdown, setConfirmShutdown] = useState(false);
  const [shuttingDown, setShuttingDown] = useState(false);
  const running = resources?.running ?? [];

  return (
    <div className="page">
      {/* r8.2 — Shutdown is a WSL-platform action, not a storage one: it terminates the VM
          and every distribution. It lives in the page header rather than a card so it is
          reachable from both tabs and never reads as a sibling of a benign card action. */}
      <div className="pagehead">
        <Tablist
          label="Settings section"
          idBase="settings"
          value={sub}
          onChange={setSub}
          tabs={[
            { value: "app", label: "Application" },
            { value: "wsl", label: "WSL" },
          ]}
        />
        <span className="spacer" />
        <button className="small danger" disabled={shuttingDown}
          aria-label="Shut down WSL (terminates all distributions)"
          onClick={() => setConfirmShutdown(true)}>
          <Icon name="power" size={13} />
          {shuttingDown ? "Shutting down…" : "Shutdown WSL"}
        </button>
      </div>

      {confirmShutdown && (
        <ConfirmModal
          title="Shut down WSL?"
          body={
            <p>
              {running.length > 0
                ? `Immediately terminates ALL running distributions (${running.join(", ")}) and the WSL 2 VM. Unsaved work in them is lost.`
                : "Terminates the WSL 2 utility VM. No distributions are currently running."}
            </p>
          }
          confirmLabel="Shut down WSL"
          danger
          onConfirm={async () => {
            setShuttingDown(true);
            try {
              await api("/api/wsl/shutdown", { method: "POST", body: { confirm: true } });
              toast("ok", "WSL shut down");
            } catch (err) {
              toast("error", "Shutdown failed", err instanceof ApiError ? err.detail : String(err));
            } finally {
              setShuttingDown(false);
            }
          }}
          onClose={() => setConfirmShutdown(false)}
        />
      )}

      <div role="tabpanel" id={`settings-panel-${sub}`} aria-labelledby={`settings-tab-${sub}`}>
        {sub === "app" ? (
        <>
          <div className="card">
            <header>Appearance</header>
            <div className="body formrow" role="radiogroup" aria-label="Theme">
              {(["system", "light", "dark"] as const).map((t) => (
                <label key={t} className="checkline">
                  <input type="radio" name="theme" checked={config.theme === t}
                    onChange={() => void setConfig({ ...config, theme: t }).catch((e) => toast("error", "Save failed", String(e)))} />
                  {t[0].toUpperCase() + t.slice(1)}
                </label>
              ))}
            </div>
          </div>
          <div className="card">
            <header>Behavior</header>
            <div className="body formrow">
              <label className="field">
                <span>Container refresh interval</span>
                <select value={config.pollMs}
                  onChange={(e) => void setConfig({ ...config, pollMs: Number(e.target.value) }).catch((err) => toast("error", "Save failed", String(err)))}>
                  <option value={2500}>2.5 s (default)</option>
                  <option value={5000}>5 s</option>
                  <option value={10000}>10 s</option>
                </select>
              </label>
              <label className="checkline">
                <input type="checkbox" checked={config.showStoppedDefault}
                  onChange={(e) => void setConfig({ ...config, showStoppedDefault: e.target.checked }).catch((err) => toast("error", "Save failed", String(err)))} />
                Show stopped containers by default
              </label>
            </div>
          </div>
          {/* Moved from Resources (r8 D8): the platform's identity is a property of the
              installation, not a live resource. The Mount/Unmount/Shutdown *actions* stayed
              behind on Resources → Storage. */}
          <div className="card">
            <header>WSL platform</header>
            <div className="body">
              {resources?.version ? (
                <table>
                  <tbody>
                    {Object.entries(resources.version).map(([k, v]) => (
                      <tr key={k}><th style={{ width: 160, textTransform: "capitalize" }}>{k}</th><td className="mono">{v}</td></tr>
                    ))}
                  </tbody>
                </table>
              ) : <span className="skeleton" style={{ width: "40%" }} />}
            </div>
          </div>
        </>
        ) : (
          <WslSettings win11={caps?.windows.win11 ?? false} appPresent={caps?.wslSettingsApp.present ?? false} />
        )}
      </div>
    </div>
  );
}

/** The catalog's documented default is prose for most keys ("50% of Windows memory") but a
 * raw byte count for `defaultVhdSize` ("1099511627776 (1TB)"). Only the latter can seed the
 * number field — and it seeds it as 1024 GB, never as bytes. */
function sizePlaceholder(def?: string): string | undefined {
  const m = /^(\d+)(?:\s*\(.*\))?$/.exec((def ?? "").trim());
  if (!m) return undefined;
  const p = parseSize(m[1], ["MB", "GB"], true);
  return p.kind === "value" ? p.num : undefined;
}

function WslSettings({ win11, appPresent }: { win11: boolean; appPresent: boolean }) {
  const { toast } = useApp();
  const [payload, setPayload] = useState<WslConfigPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState("");
  const [saved, setSaved] = useState<{ backupPath: string; applyHint: string } | null>(null);
  const [confirmShutdown, setConfirmShutdown] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const p = await api<WslConfigPayload>("/api/wslconfig");
      setPayload(p);
      setRawText(p.text);
      setEdits({});
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : String(err));
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editKey = (section: string, key: string) => `${section}.${key}`;
  const currentValue = (section: string, key: string): string =>
    edits[editKey(section, key)] ?? payload?.values[section]?.[key] ?? "";

  const dirty = Object.keys(edits).length > 0;

  const save = async () => {
    setBusy(true);
    try {
      const body = rawMode
        ? { text: rawText }
        : {
          changes: Object.entries(edits).map(([k, value]) => {
            const [section, key] = k.split(".");
            return { section, key, value: value === "" ? null : value };
          }),
        };
      const res = await api<{ backupPath: string; applyHint: string }>("/api/wslconfig", { method: "PUT", body });
      setSaved({ backupPath: res.backupPath, applyHint: res.applyHint });
      toast("ok", ".wslconfig saved");
      await load();
    } catch (err) {
      toast("error", "Save failed", err instanceof ApiError ? err.detail : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="card">
        <header>Native WSL configuration</header>
        <div className="body formrow">
          <button disabled={!appPresent}
            title={appPresent ? "Launches the WSL Settings app that ships with WSL" : "WSL Settings app not found in this WSL build"}
            onClick={async () => {
              try {
                await api("/api/system/open-wsl-settings", { method: "POST", body: {} });
                toast("ok", "WSL Settings launched");
              } catch (err) {
                toast("error", "Launch failed", err instanceof ApiError ? err.detail : String(err));
              }
            }}>
            <Icon name="open" size={13} />
            WSL Settings app
          </button>
          <button onClick={async () => {
            try {
              await api("/api/system/open-wslconfig", { method: "POST", body: {} });
              toast("ok", ".wslconfig opened");
            } catch (err) {
              toast("error", "Open failed", err instanceof ApiError ? err.detail : String(err));
            }
          }}>
            <Icon name="edit" size={13} />
            Open .wslconfig
          </button>
          {payload && <span className="muted mono" style={{ alignSelf: "center" }}>{payload.path}{payload.exists ? "" : " (will be created)"}</span>}
        </div>
      </div>

      <div className="card">
        <header>
          .wslconfig editor
          <span className="spacer" />
          <label className="checkline">
            <input type="checkbox" checked={rawMode} onChange={(e) => setRawMode(e.target.checked)} /> Raw file mode
          </label>
          <button className="primary" disabled={busy || (!rawMode && !dirty)} onClick={() => void save()}>
            {busy ? "Saving…" : "Save (backs up first)"}
          </button>
        </header>
        <div className="body">
          {error && <p className="errorbanner" role="alert">{error}</p>}
          {!payload ? <span className="skeleton" style={{ width: "60%" }} /> : rawMode ? (
            <textarea className="mono" style={{ width: "100%", minHeight: 260 }} value={rawText}
              onChange={(e) => setRawText(e.target.value)} aria-label=".wslconfig raw content" />
          ) : (
            <div>
              {(["wsl2", "experimental"] as const).map((section) => {
                const defs = payload.catalog.filter((d) => d.section === section);
                if (defs.length === 0) return null;
                return (
                  <section key={section} className="setgroup">
                    <h4>[{section}] {section === "wsl2" ? "— virtual machine" : "— preview features"}</h4>
                    {defs.map((def) => {
                      const gated = (def.win11Only || def.win11_22h2) && !win11;
                      const k = editKey(def.section, def.key);
                      const control = def.type === "bool" ? (
                        <select disabled={gated} value={currentValue(def.section, def.key)}
                          aria-label={`${def.section} ${def.key}`}
                          onChange={(e) => setEdits({ ...edits, [k]: e.target.value })}>
                          <option value="">default{def.default ? ` (${def.default})` : ""}</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : def.type === "enum" ? (
                        <select disabled={gated} value={currentValue(def.section, def.key)}
                          aria-label={`${def.section} ${def.key}`}
                          onChange={(e) => setEdits({ ...edits, [k]: e.target.value })}>
                          <option value="">default{def.default ? ` (${def.default})` : ""}</option>
                          {def.enumValues?.map((v) => <option key={v} value={v}>{v}</option>)}
                        </select>
                      ) : def.type === "path" ? (
                        <div className="pickrow">
                          <input type="text" disabled={gated} value={currentValue(def.section, def.key)}
                            aria-label={`${def.section} ${def.key}`}
                            placeholder={def.default ?? ""} onChange={(e) => setEdits({ ...edits, [k]: e.target.value })} />
                          {!gated && (
                            <PickButton
                              spec={{ kind: "file-open", title: `Select ${def.key}` }}
                              onPick={(p) => setEdits({ ...edits, [k]: p.replaceAll("\\", "\\\\") })}
                              label=""
                            />
                          )}
                        </div>
                      ) : def.type === "size" ? (
                        /* DD2: the control never rewrites what it cannot represent — an
                           existing `50%` or an odd byte count falls back to a raw text input
                           and is passed through untouched. Only edited keys are written. */
                        <SizeInput
                          label={`${def.section} ${def.key}`}
                          value={currentValue(def.section, def.key)}
                          onChange={(v) => setEdits({ ...edits, [k]: v })}
                          suffix="long"
                          integersOnly
                          disabled={gated}
                          placeholder={sizePlaceholder(def.default)}
                          zeroHint={def.key === "swap" ? "no swap file" : undefined}
                        />
                      ) : (
                        <input type="text" disabled={gated} value={currentValue(def.section, def.key)}
                          aria-label={`${def.section} ${def.key}`}
                          placeholder={def.default ?? ""} onChange={(e) => setEdits({ ...edits, [k]: e.target.value })} />
                      );
                      return (
                        <div key={k} className={`setrow${gated ? " gated" : ""}`}
                          title={gated ? "Requires Windows 11 — this host is Windows 10" : undefined}>
                          <div className="setinfo">
                            <span className="setkey">
                              {def.key}
                              {edits[k] !== undefined && <span className="badge" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>modified</span>}
                              {def.win11Only && <span className="badge">Win11{def.win11_22h2 ? " 22H2+" : ""}</span>}
                              {def.deprecatedValue && <span className="badge warn">“{def.deprecatedValue}” deprecated</span>}
                            </span>
                            <span className="setdesc">
                              {def.description}
                              {def.type === "size" && def.default && !sizePlaceholder(def.default)
                                ? ` Default: ${def.default}.`
                                : ""}
                            </span>
                          </div>
                          <div className="setctl">{control}</div>
                        </div>
                      );
                    })}
                  </section>
                );
              })}
            </div>
          )}
          {saved && (
            <div className="errorbanner okbanner" style={{ marginTop: 12 }} role="status">
              <strong>Saved.</strong> {saved.applyHint}
              {saved.backupPath && <span className="muted mono">Backup: {saved.backupPath}</span>}
              <div className="formrow">
                <button className="danger" onClick={() => setConfirmShutdown(true)}>Shutdown WSL now</button>
                <button onClick={() => setSaved(null)}>Later</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {confirmShutdown && (
        <ConfirmModal
          title="Shut down WSL to apply settings?"
          body={<p>All running distributions terminate immediately; unsaved work inside them is lost. WSL restarts on next use with the new settings.</p>}
          confirmLabel="Shut down WSL"
          danger
          onConfirm={async () => {
            await api("/api/wsl/shutdown", { method: "POST", body: { confirm: true } });
            toast("ok", "WSL shut down — settings apply on next start");
            setSaved(null);
          }}
          onClose={() => setConfirmShutdown(false)}
        />
      )}
    </>
  );
}
