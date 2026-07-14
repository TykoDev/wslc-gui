import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { api, sseUrl } from "./lib/api.ts";
import type {
  AppConfig, Capabilities, ContainersSnapshot, ImagesSnapshot, ResourcesSnapshot, StackRecord,
} from "./lib/types.ts";

export interface Toast {
  id: number;
  kind: "ok" | "error" | "info";
  text: string;
  detail?: string;
}

interface State {
  caps: Capabilities | null;
  containers: ContainersSnapshot | null;
  images: ImagesSnapshot | null;
  resources: ResourcesSnapshot | null;
  config: AppConfig;
  stacks: StackRecord[];
  /** Bumped on every server `volumes` SSE poke (r9). Deliberately a counter, not a
   * snapshot: the Volumes card owns its own GET /api/volumes, so this only has to say
   * "something changed" — which keeps it correct whatever payload the poke carries, and
   * harmless on a server that never emits the channel. */
  volumesTick: number;
  sse: "connecting" | "open" | "lost";
  toasts: Toast[];
}

type Action =
  | { type: "caps"; v: Capabilities }
  | { type: "containers"; v: ContainersSnapshot }
  | { type: "images"; v: ImagesSnapshot }
  | { type: "resources"; v: ResourcesSnapshot }
  | { type: "config"; v: AppConfig }
  | { type: "stacks"; v: StackRecord[] }
  | { type: "volumesTick" }
  | { type: "sse"; v: State["sse"] }
  | { type: "toast"; v: Toast }
  | { type: "untoast"; id: number };

const initial: State = {
  caps: null,
  containers: null,
  images: null,
  resources: null,
  config: { theme: "system", pollMs: 2500, showStoppedDefault: false },
  stacks: [],
  volumesTick: 0,
  sse: "connecting",
  toasts: [],
};

let toastId = 1;

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "caps": return { ...s, caps: a.v };
    case "containers": return { ...s, containers: a.v };
    case "images": return { ...s, images: a.v };
    case "resources": return { ...s, resources: a.v };
    case "config": return { ...s, config: a.v };
    case "stacks": return { ...s, stacks: a.v };
    case "volumesTick": return { ...s, volumesTick: s.volumesTick + 1 };
    case "sse": return { ...s, sse: a.v };
    // id is assigned at the dispatch site (FE-1 fix): the dismissal timer must capture the
    // toast's OWN id, which a reducer-assigned id cannot give it without a race.
    case "toast": return { ...s, toasts: [...s.toasts, a.v].slice(-5) };
    case "untoast": return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) };
  }
}

interface Ctx extends State {
  toast: (kind: Toast["kind"], text: string, detail?: string) => void;
  refreshStacks: () => Promise<void>;
  setConfig: (cfg: AppConfig) => Promise<void>;
}

const AppCtx = createContext<Ctx | null>(null);

function applyTheme(theme: AppConfig["theme"]): void {
  const dark = theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  localStorage.setItem("wslc-theme", theme);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);

  useEffect(() => {
    let es: EventSource | null = null;
    let retry = 0;
    let closed = false;

    const connect = () => {
      if (closed) return;
      es = new EventSource(sseUrl());
      es.onopen = () => {
        retry = 0;
        dispatch({ type: "sse", v: "open" });
      };
      es.onerror = () => {
        dispatch({ type: "sse", v: "lost" });
        es?.close();
        if (!closed) setTimeout(connect, Math.min(15_000, 1_000 * 2 ** retry++));
      };
      for (const kind of ["capabilities", "containers", "images", "resources"] as const) {
        es.addEventListener(kind, (e) => {
          // FE-16: guard the parse like the error channel below — a malformed frame drops
          // this one snapshot rather than throwing out of the listener and killing updates.
          try {
            const v = JSON.parse((e as MessageEvent).data);
            dispatch({ type: kind === "capabilities" ? "caps" : kind, v } as Action);
          } catch { /* malformed data frame — drop this snapshot */ }
        });
      }
      // Package A pokes this channel on volume create/remove/prune. The payload is not
      // read on purpose (see State.volumesTick) — a volume can also appear with no poke
      // at all, because `wslc run -v name:/path` auto-creates one (probe P2).
      es.addEventListener("volumes", () => dispatch({ type: "volumesTick" }));
      es.addEventListener("error", (e) => {
        const data = (e as MessageEvent).data;
        if (typeof data === "string") {
          try {
            const p = JSON.parse(data);
            // DD3/FE-14: auto-dismiss like every other toast. Reuse the r9 FE-1 mechanism —
            // assign the id at the dispatch site and capture that same id in the timer, so an
            // error toast expires on its own (error tier = 10s, matching ctx.toast).
            const id = toastId++;
            dispatch({ type: "toast", v: { kind: "error", text: `${p.scope} refresh failed`, detail: p.message, id } });
            setTimeout(() => dispatch({ type: "untoast", id }), 10_000);
          } catch { /* transport error, handled by onerror */ }
        }
      });
    };
    connect();

    void api<AppConfig>("/api/config").then((cfg) => {
      dispatch({ type: "config", v: cfg });
      applyTheme(cfg.theme);
    }).catch(() => {/* headless dev without token — banner handles it */});
    void api<StackRecord[]>("/api/stacks").then((v) => dispatch({ type: "stacks", v })).catch(() => {});

    return () => {
      closed = true;
      es?.close();
    };
  }, []);

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => state.config.theme === "system" && applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [state.config.theme]);

  const ctx = useMemo<Ctx>(() => ({
    ...state,
    toast: (kind, text, detail) => {
      const id = toastId++;
      dispatch({ type: "toast", v: { kind, text, detail, id } });
      setTimeout(() => dispatch({ type: "untoast", id }), kind === "error" ? 10_000 : 5_000);
    },
    refreshStacks: async () => {
      dispatch({ type: "stacks", v: await api<StackRecord[]>("/api/stacks") });
    },
    setConfig: async (cfg) => {
      const saved = await api<AppConfig>("/api/config", { method: "PUT", body: cfg });
      dispatch({ type: "config", v: saved });
      applyTheme(saved.theme);
    },
  }), [state]);

  return <AppCtx.Provider value={ctx}>{children}</AppCtx.Provider>;
}

export function useApp(): Ctx {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp outside provider");
  return ctx;
}
