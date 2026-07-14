// Live slice-1 smoke: exercise the adapter against THIS machine and print
// a JSON summary. Read-only wsl/reg calls only — no mutations.
import { getCapabilities } from "../adapter/capabilities.ts";
import * as wsl from "../adapter/wsl.ts";
import { distroStorage, swapInfo } from "../adapter/registry.ts";
import { readWslConfig } from "../adapter/wslconfig.ts";

const caps = await getCapabilities(true);
const [distros, running, status, cfg, storage] = await Promise.all([
  wsl.listDistros(),
  wsl.listRunning(),
  wsl.status(),
  readWslConfig(),
  distroStorage(),
]);
const swap = await swapInfo(cfg.values["wsl2"]?.["swapFile"] ?? null);

console.log(JSON.stringify(
  {
    capabilities: {
      wsl: caps.wsl,
      wslcPresent: caps.wslc.present,
      windows: caps.windows,
      wslSettingsApp: caps.wslSettingsApp.present,
    },
    distros,
    running,
    statusKeys: Object.keys(status),
    wslconfig: { path: cfg.path, exists: cfg.exists, sections: Object.keys(cfg.values) },
    storage: storage.map((s) => ({
      name: s.name,
      vhdx: s.vhdxPath !== null,
      sizeMB: s.sizeBytes === null ? null : Math.round(s.sizeBytes / 1024 / 1024),
    })),
    swap: { path: swap.path, exists: swap.exists },
  },
  null,
  2,
));
