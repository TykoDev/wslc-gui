// App config + stack records under %APPDATA%\wslc-gui (security.md §4:
// schema-validated on read; corrupt files renamed aside, never crash-loop).

export interface AppConfig {
  theme: "system" | "light" | "dark";
  pollMs: number;
  showStoppedDefault: boolean;
}

const DEFAULTS: AppConfig = { theme: "system", pollMs: 2500, showStoppedDefault: false };

export interface StackServiceRecord {
  service: string;
  container: string;
  image: string;
  ok: boolean;
  stderr?: string;
  // BE MINOR-5/D3: a container carried over from a prior deploy that the current stack no
  // longer defines. It is kept in the record (so Down/Delete can still reach it) and NEVER
  // auto-stopped.
  orphaned?: boolean;
}

export interface StackRecord {
  name: string;
  status: "deployed" | "partial" | "down";
  deployedAt: string;
  services: StackServiceRecord[];
  yaml: string;
  // Non-fatal notices from the last deploy (e.g. orphaned containers carried over).
  warnings?: string[];
}

function configDir(): string {
  const appData = Deno.env.get("APPDATA");
  if (!appData) throw new Error("APPDATA not set");
  return `${appData}\\wslc-gui`;
}

async function readJsonFile<T>(path: string, validate: (v: unknown) => T | null): Promise<T | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    const valid = validate(parsed);
    if (valid !== null) return valid;
  } catch {
    // fall through to quarantine
  }
  try {
    await Deno.rename(path, `${path}.corrupt.${Date.now()}`);
  } catch {
    // keep going with defaults
  }
  return null;
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await Deno.mkdir(configDir(), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
}

export function validateConfig(v: unknown): AppConfig | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const theme = o.theme === "light" || o.theme === "dark" || o.theme === "system" ? o.theme : DEFAULTS.theme;
  const pollMs = typeof o.pollMs === "number" && o.pollMs >= 1000 && o.pollMs <= 60000 ? o.pollMs : DEFAULTS.pollMs;
  const showStoppedDefault = typeof o.showStoppedDefault === "boolean" ? o.showStoppedDefault : DEFAULTS.showStoppedDefault;
  return { theme, pollMs, showStoppedDefault };
}

export async function loadConfig(): Promise<AppConfig> {
  const found = await readJsonFile(`${configDir()}\\config.json`, validateConfig);
  return found ?? { ...DEFAULTS };
}

export async function saveConfig(cfg: AppConfig): Promise<AppConfig> {
  const valid = validateConfig(cfg) ?? { ...DEFAULTS };
  await writeJsonFile(`${configDir()}\\config.json`, valid);
  return valid;
}

function validateStacks(v: unknown): StackRecord[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((r): r is StackRecord =>
    typeof r === "object" && r !== null &&
    typeof (r as StackRecord).name === "string" &&
    Array.isArray((r as StackRecord).services)
  );
}

export async function loadStacks(): Promise<StackRecord[]> {
  return (await readJsonFile(`${configDir()}\\stacks.json`, validateStacks)) ?? [];
}

export async function saveStacks(stacks: StackRecord[]): Promise<void> {
  await writeJsonFile(`${configDir()}\\stacks.json`, stacks);
}
