// SSE event hub — periodic snapshots pushed to all clients (architecture §5).
// Snapshots, not deltas: client reducers stay idempotent. Pollers only run
// while at least one client is connected; wslc pollers only when present.

import { getCapabilities } from "../adapter/capabilities.ts";
import * as wsl from "../adapter/wsl.ts";
import * as wslc from "../adapter/wslc.ts";
import { distroStorage, swapInfo, wslcSessionStorage } from "../adapter/registry.ts";
import { readWslConfig } from "../adapter/wslconfig.ts";
import { normalizeContainers, normalizeImages } from "./normalize.ts";
import type { AppConfig } from "./app_config.ts";

type Client = {
  send: (event: string, data: unknown) => void;
  close: () => void;
};

/** I6: a hard ceiling on concurrent SSE clients — a renderer that reconnects in a loop
 * cannot grow the set without bound. Loopback single-user needs only a handful. */
export const MAX_SSE_CLIENTS = 64;

export function sseAtCapacity(currentCount: number): boolean {
  return currentCount >= MAX_SSE_CLIENTS;
}

/** m7: run `fn` for `channel` unless a prior call for that channel is still running — a
 * slow wslc probe that outlasts its interval skips the next tick instead of stacking a
 * second probe behind the first. Returned closure is what the periodic timers call. */
export function makeInFlightGuard(): (channel: string, fn: () => Promise<void>) => void {
  const running = new Set<string>();
  return (channel, fn) => {
    if (running.has(channel)) return;
    running.add(channel);
    fn().finally(() => running.delete(channel));
  };
}

export class EventHub {
  private clients = new Set<Client>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private getConfig: () => AppConfig;
  // m7: guards the periodic pushers only. poke() and the on-connect snapshots call the
  // push methods directly (unguarded) so a mutation/new client always gets fresh data.
  private tick = makeInFlightGuard();

  constructor(getConfig: () => AppConfig) {
    this.getConfig = getConfig;
  }

  start(): void {
    this.stop();
    const cfg = this.getConfig();
    this.timers = [
      setInterval(() => this.tick("containers", () => this.pushContainers()), cfg.pollMs),
      setInterval(() => this.tick("resources", () => this.pushResources()), 8_000),
      setInterval(() => this.tick("images", () => this.pushImages()), 30_000),
      // Volumes change rarely and cost two wslc calls (list + inspect) — image cadence.
      setInterval(() => this.tick("volumes", () => this.pushVolumes()), 30_000),
      setInterval(() => this.tick("capabilities", () => this.pushCapabilities()), 60_000),
      setInterval(() => this.broadcastRaw(":hb\n\n"), 25_000),
    ];
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  restart(): void {
    this.start();
  }

  private broadcastRaw(_frame: string): void {
    for (const c of this.clients) c.send("hb", {});
  }

  private broadcast(event: string, data: unknown): void {
    for (const c of this.clients) c.send(event, data);
  }

  async pushCapabilities(force = false): Promise<void> {
    if (this.clients.size === 0) return;
    try {
      this.broadcast("capabilities", await getCapabilities(force));
    } catch (err) {
      this.broadcast("error", { scope: "capabilities", message: String(err) });
    }
  }

  async pushContainers(): Promise<void> {
    if (this.clients.size === 0) return;
    try {
      const caps = await getCapabilities();
      if (!caps.wslc.present) return;
      const [list, stats] = await Promise.all([
        wslc.listContainers(true),
        wslc.stats().catch(() => null),
      ]);
      this.broadcast("containers", {
        ...normalizeContainers(list),
        stats: stats && stats.code === 0 ? stats.stdout : null,
      });
    } catch (err) {
      this.broadcast("error", { scope: "containers", message: String(err) });
    }
  }

  async pushImages(): Promise<void> {
    if (this.clients.size === 0) return;
    try {
      const caps = await getCapabilities();
      if (!caps.wslc.present) return;
      this.broadcast("images", normalizeImages(await wslc.listImages()));
    } catch (err) {
      this.broadcast("error", { scope: "images", message: String(err) });
    }
  }

  /** r9 D2. Gated on the detected verb, so a wslc without `volume list` is polled for
   * nothing and the card simply stays empty rather than showing an error every tick. */
  async pushVolumes(): Promise<void> {
    if (this.clients.size === 0) return;
    try {
      const caps = await getCapabilities();
      if (!caps.wslc.present || !caps.wslc.can.volumes) return;
      this.broadcast("volumes", { volumes: await wslc.listVolumes() });
    } catch (err) {
      this.broadcast("error", { scope: "volumes", message: String(err) });
    }
  }

  async pushResources(): Promise<void> {
    if (this.clients.size === 0) return;
    try {
      const cfg = await readWslConfig();
      const caps = await getCapabilities();
      const [distros, running, status, version, storage, sessionStorage, sessions] = await Promise.all([
        wsl.listDistros(),
        wsl.listRunning(),
        wsl.status(),
        wsl.version(),
        distroStorage(),
        wslcSessionStorage(),
        caps.wslc.present ? wslc.listSessions() : Promise.resolve([]),
      ]);
      const swap = await swapInfo(cfg.values["wsl2"]?.["swapFile"] ?? null);
      this.broadcast("resources", { distros, running, status, version, storage, sessionStorage, sessions, swap });
    } catch (err) {
      this.broadcast("error", { scope: "resources", message: String(err) });
    }
  }

  /** Immediate refresh after a mutation. */
  poke(kind: "containers" | "images" | "resources" | "capabilities" | "volumes"): void {
    if (kind === "containers") void this.pushContainers();
    else if (kind === "images") void this.pushImages();
    else if (kind === "resources") void this.pushResources();
    else if (kind === "volumes") void this.pushVolumes();
    else void this.pushCapabilities(true);
  }

  handleRequest(_req: Request): Response {
    // I6: refuse beyond the ceiling rather than growing the client set without bound.
    if (sseAtCapacity(this.clients.size)) {
      return new Response("too many event-stream clients", { status: 503 });
    }
    const encoder = new TextEncoder();
    let client: Client;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        client = {
          send: (event, data) => {
            try {
              if (event === "hb") {
                controller.enqueue(encoder.encode(":hb\n\n"));
              } else {
                controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
              }
            } catch {
              this.clients.delete(client);
            }
          },
          close: () => {
            try {
              controller.close();
            } catch {
              // already closed
            }
          },
        };
        this.clients.add(client);
        // Immediate snapshots so the UI never waits a full interval.
        void this.pushCapabilities();
        void this.pushResources();
        void this.pushContainers();
        void this.pushImages();
        void this.pushVolumes();
      },
      cancel: () => {
        this.clients.delete(client);
      },
    });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-accel-buffering": "no",
      },
    });
  }
}
