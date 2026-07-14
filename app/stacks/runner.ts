// Sequential stack execution with honest per-service results (architecture §6).

import * as wslc from "../adapter/wslc.ts";
import type { Capabilities } from "../adapter/capabilities.ts";
import { loadStacks, saveStacks, type StackRecord, type StackServiceRecord } from "../server/app_config.ts";
import { compilePlan, toComposeYaml } from "./compile.ts";
import type { Stack } from "./schema.ts";

/** BE MINOR-5 / D3: on redeploy, a container the PRIOR record managed but the new stack no
 * longer defines is carried into the new record flagged `orphaned` (with a warning), so the
 * user can still Down/Delete it. It is NEVER auto-stopped — a redeploy must not silently
 * kill a container. Pure so the carry-over rule is tested without a live wslc or disk IO. */
export function carryOrphans(
  deployed: StackServiceRecord[],
  prior: StackRecord | undefined,
): { services: StackServiceRecord[]; warnings: string[] } {
  const services = [...deployed];
  const warnings: string[] = [];
  if (prior) {
    const now = new Set(deployed.map((s) => s.container));
    for (const svc of prior.services) {
      if (!now.has(svc.container)) {
        services.push({ ...svc, orphaned: true });
        warnings.push(
          `${svc.container}: kept as an orphaned container — it was deployed by a previous version of ` +
            `stack "${prior.name}" but is not in it any more. It was NOT stopped; use Down to remove it.`,
        );
      }
    }
  }
  return { services, warnings };
}

export async function deployStack(stack: Stack): Promise<StackRecord> {
  const plan = compilePlan(stack);
  const deployed: StackServiceRecord[] = [];
  for (const step of plan) {
    // ServiceSpec is a RunSpec subset; the compiled container name/image win.
    const res = await wslc.runContainer({
      ...stack.services[step.service],
      image: step.image,
      name: step.container,
    });
    deployed.push({
      service: step.service,
      container: step.container,
      image: step.image,
      ok: res.code === 0 && !res.timedOut,
      stderr: res.code === 0 ? undefined : (res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`),
    });
  }
  const existing = await loadStacks();
  const prior = existing.find((s) => s.name === stack.name);
  const { services, warnings } = carryOrphans(deployed, prior);
  const record: StackRecord = {
    name: stack.name,
    // Status reflects THIS deploy: orphans (not deployed now) do not make it "partial".
    status: deployed.every((s) => s.ok) ? "deployed" : "partial",
    deployedAt: new Date().toISOString(),
    services,
    yaml: toComposeYaml(stack),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  const all = existing.filter((s) => s.name !== stack.name);
  all.push(record);
  await saveStacks(all);
  return record;
}

/** Stop every member container; remove them too when the verb exists. */
export async function downStack(
  name: string,
  caps: Capabilities,
): Promise<{ record: StackRecord | null; results: { container: string; action: string; ok: boolean; stderr?: string }[] }> {
  const all = await loadStacks();
  const record = all.find((s) => s.name === name) ?? null;
  if (!record) return { record: null, results: [] };
  const rmVerb = caps.wslc.containerVerbs.find((v) => ["rm", "remove", "delete"].includes(v));
  const results: { container: string; action: string; ok: boolean; stderr?: string }[] = [];
  for (const svc of record.services) {
    const stop = await wslc.stopContainer(svc.container);
    results.push({
      container: svc.container,
      action: "stop",
      ok: stop.code === 0,
      stderr: stop.code === 0 ? undefined : stop.stderr.trim(),
    });
    if (rmVerb && caps.wslc.can.rmContainer) {
      const rm = await wslc.removeContainer(svc.container, rmVerb);
      results.push({
        container: svc.container,
        action: rmVerb,
        ok: rm.code === 0,
        stderr: rm.code === 0 ? undefined : rm.stderr.trim(),
      });
    }
  }
  record.status = "down";
  await saveStacks(all);
  return { record, results };
}

export async function deleteStackRecord(name: string): Promise<boolean> {
  const all = await loadStacks();
  const next = all.filter((s) => s.name !== name);
  if (next.length === all.length) return false;
  await saveStacks(next);
  return true;
}
