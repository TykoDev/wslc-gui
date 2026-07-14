// Mirrors of the server payload shapes (kept minimal on purpose).

export interface Capabilities {
  wsl: { present: boolean; version: string | null };
  wslc: {
    present: boolean;
    version: string | null;
    topVerbs: string[];
    containerVerbs: string[];
    imageVerbs: string[];
    /** Parsed from `wslc volume --help` (r9, Package A). Optional on the wire: a server
     * that predates r9 sends no such field, and the UI must degrade to "unsupported"
     * rather than crash on `.includes` of undefined. Always read via `volumeVerbs ?? []`. */
    volumeVerbs?: string[];
    runFlags: string[];
    can: Record<string, boolean>;
  };
  windows: { build: number; win11: boolean };
  wslSettingsApp: { present: boolean; path: string | null };
  probedAt: string;
}

export interface ContainerRow {
  id: string | null;
  name: string | null;
  image: string | null;
  status: string | null;
  ports: string | null;
  raw: Record<string, string>;
}

export interface ContainersSnapshot {
  containers: ContainerRow[];
  headers: string[];
  raw: string[];
  stats?: string | null;
}

export interface ImageRow {
  repository: string | null;
  tag: string | null;
  id: string | null;
  size: string | null;
  raw: Record<string, string>;
}

export interface ImagesSnapshot {
  images: ImageRow[];
  headers: string[];
  raw: string[];
}

export interface DistroInfo {
  name: string;
  state: string;
  version: number;
  isDefault: boolean;
}

export interface DistroStorage {
  name: string;
  guid: string;
  basePath: string;
  vhdxPath: string | null;
  sizeBytes: number | null;
}

export interface SessionInfo {
  id: string;
  creatorPid: string;
  name: string;
}

export interface SessionStorage {
  session: string;
  file: string;
  path: string;
  sizeBytes: number | null;
}

export interface ResourcesSnapshot {
  distros: DistroInfo[];
  running: string[];
  status: Record<string, string>;
  version?: Record<string, string>;
  storage: DistroStorage[];
  sessionStorage: SessionStorage[];
  sessions: SessionInfo[];
  swap: { path: string; sizeBytes: number | null; exists: boolean };
}

export interface TagList {
  source: "hub" | "v2";
  registry: string;
  repository: string;
  total: number | null;
  tags: { name: string; updated: string | null }[];
}

export interface AppConfig {
  theme: "system" | "light" | "dark";
  pollMs: number;
  showStoppedDefault: boolean;
}

export interface WslConfigKeyDef {
  section: "wsl2" | "experimental";
  key: string;
  type: "bool" | "number" | "size" | "path" | "string" | "enum";
  enumValues?: string[];
  default?: string;
  win11Only?: boolean;
  win11_22h2?: boolean;
  deprecatedValue?: string;
  description: string;
}

export interface WslConfigPayload {
  path: string;
  exists: boolean;
  text: string;
  values: Record<string, Record<string, string>>;
  catalog: WslConfigKeyDef[];
}

export interface StackServiceRecord {
  service: string;
  container: string;
  image: string;
  ok: boolean;
  stderr?: string;
}

export interface StackRecord {
  name: string;
  status: "deployed" | "partial" | "down";
  deployedAt: string;
  services: StackServiceRecord[];
  yaml: string;
}

export interface PlanPreview {
  service: string;
  container: string;
  preview: string;
}

/** One service as the compiler hands it back (r8: also what "Open in builder" reads). */
export interface StackServiceSpec {
  image: string;
  ports?: string[];
  command?: string[];
  rm?: boolean;
  env?: string[];
  volumes?: string[];
  memory?: string;
  cpus?: string;
  /** r9 D1: `--entrypoint`. Replaces the image ENTRYPOINT; `command` becomes its args. */
  entrypoint?: string;
}

/** GET /api/volumes (r9 D2, Package A).
 *
 * There is deliberately no size field. `wslc volume inspect` reports neither a size nor a
 * mountpoint (probe P3), so a per-volume byte count cannot be obtained — and is never
 * invented. Volume bytes are already inside the wslc session VHD that the Resources
 * "Container storage" tile totals.
 *
 * `wslc volume list --format json` carries only Driver+Name; `createdAt`/`anonymous`/
 * `labels` come from a per-volume `volume inspect` (Package A does that join). */
export interface VolumeRow {
  name: string;
  driver: string; // wslc reports "guest"
  createdAt: string | null;
  /** `Labels["com.docker.volume.anonymous"]` is present. These are what `volume prune`
   * reclaims by default — hence the badge. */
  anonymous: boolean;
  labels: Record<string, string>;
}

export interface CompiledStack {
  name: string;
  services: Record<string, StackServiceSpec>;
}

/** Detected input format of an imported YAML doc (r8 D3/D6, Package A). */
export type StackSource = "stack" | "compose" | "kubernetes";

export interface CompileResult {
  stack: CompiledStack;
  /** Every "we could not honour this" fact, itemised. Rendered verbatim as a list —
   * never summarised, never truncated, never a toast (r8 brief). May be long. */
  warnings: string[];
  plan: PlanPreview[];
  composeYaml: string;
  source?: StackSource;
}

/** POST /api/system/read-text (r8 D5, Package A). */
export interface ReadTextResult {
  path: string;
  text: string;
}
