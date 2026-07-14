import { NavLink, Outlet, useLocation } from "react-router";
import { useApp } from "../state.tsx";
import { hasToken } from "../lib/api.ts";
import { Icon, type IconName } from "./icons.tsx";

const NAV: { to: string; icon: IconName; label: string }[] = [
  { to: "/containers", icon: "box", label: "Containers" },
  { to: "/images", icon: "layers", label: "Images" },
  { to: "/resources", icon: "server", label: "Resources" },
  { to: "/deploy", icon: "deploy", label: "Deploy" },
  { to: "/settings", icon: "settings", label: "Settings" },
];

export function Layout() {
  const { caps, sse, toasts, config, setConfig, toast } = useApp();
  const { pathname } = useLocation();
  const title = NAV.find((n) => pathname.startsWith(n.to))?.label ?? "Dashboard";
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const wslcPill = caps === null
    ? { cls: "", text: "probing…" }
    : caps.wslc.present
    ? { cls: "ok", text: `wslc ${caps.wslc.version ?? ""}`.trim() }
    : { cls: "warn", text: "wslc unavailable" };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/logo.ico" alt="" width={20} height={20} />
          <span>WSL Containers</span>
        </div>
        <nav aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} title={n.label}>
              <Icon name={n.icon} size={16} />
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="foot">
          Windows build {caps?.windows.build ?? "…"}{caps?.windows.win11 === false ? " (Win10)" : ""}
        </div>
      </aside>

      <header className="topbar">
        <h1>{title}</h1>
        <span className="spacer" />
        {!hasToken() && (
          <span className="pill bad" title="Open the app from the URL printed by the exe/headless server">
            no session token
          </span>
        )}
        <span className={`pill ${sse === "open" ? "ok" : sse === "lost" ? "bad" : ""}`}>
          {sse === "open" ? "live" : sse === "lost" ? "reconnecting" : "connecting"}
        </span>
        <span className={`pill ${caps?.wsl.present ? "ok" : "bad"}`}>
          WSL {caps?.wsl.version ?? "…"}
        </span>
        <span className={`pill ${wslcPill.cls}`}>{wslcPill.text}</span>
        <button
          className="icon"
          aria-label="Toggle color theme"
          title="Toggle theme (persisted in Settings)"
          onClick={() => {
            const cur = document.documentElement.getAttribute("data-theme");
            const next = cur === "dark" ? "light" : "dark";
            void setConfig({ ...config, theme: next as "light" | "dark" }).catch((e) =>
              toast("error", "Could not save theme", String(e))
            );
          }}
        >
          <Icon name={dark ? "sun" : "moon"} size={15} />
        </button>
      </header>

      <main className="content">
        <Outlet />
      </main>

      {/* The live region has to be in the DOM *before* a toast lands in it — a role on the
          injected node itself is announced unreliably. Toasts are the only completion
          feedback an irreversible action gets (r9: volume remove/prune), so a screen-reader
          user who hears nothing back has no idea whether their data is gone. */}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
            {t.text}
            {t.detail
              ? (
                <>
                  {/* FE-13: a collapsed <details> is not read by role=alert, so the one
                      sentence that says WHY a destructive action failed never reaches a
                      screen-reader user. Mirror it into an sr-only node the live region
                      announces, while keeping the visual disclosure for sighted users. */}
                  <span className="sronly">{t.detail}</span>
                  <details><summary>Details</summary>{t.detail}</details>
                </>
              )
              : null}
          </div>
        ))}
      </div>
    </div>
  );
}
