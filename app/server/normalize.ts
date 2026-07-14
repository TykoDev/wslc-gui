// Best-effort normalization of wslc table output into stable UI shapes.
// wslc's exact column set is UNVERIFIED on this host (wslc absent) — the UI
// therefore also receives the raw headers/rows to render generically when
// normalization misses (research map §6.4).

import type { Table } from "../adapter/parsers.ts";

function pick(row: Record<string, string>, candidates: string[]): string | null {
  for (const c of candidates) {
    for (const key of Object.keys(row)) {
      if (key.toUpperCase() === c) return row[key];
    }
  }
  return null;
}

export interface ContainerRow {
  id: string | null;
  name: string | null;
  image: string | null;
  status: string | null;
  ports: string | null;
  raw: Record<string, string>;
}

export function normalizeContainers(t: Table): { containers: ContainerRow[]; headers: string[]; raw: string[] } {
  return {
    headers: t.headers,
    raw: t.raw,
    containers: t.rows.map((row) => ({
      id: pick(row, ["CONTAINER ID", "ID"]),
      name: pick(row, ["NAMES", "NAME"]),
      image: pick(row, ["IMAGE"]),
      status: pick(row, ["STATUS", "STATE"]),
      ports: pick(row, ["PORTS"]),
      raw: row,
    })),
  };
}

export interface ImageRow {
  repository: string | null;
  tag: string | null;
  id: string | null;
  size: string | null;
  raw: Record<string, string>;
}

export function normalizeImages(t: Table): { images: ImageRow[]; headers: string[]; raw: string[] } {
  return {
    headers: t.headers,
    raw: t.raw,
    images: t.rows.map((row) => ({
      repository: pick(row, ["REPOSITORY", "REPO", "IMAGE"]),
      tag: pick(row, ["TAG"]),
      id: pick(row, ["IMAGE ID", "ID"]),
      size: pick(row, ["SIZE"]),
      raw: row,
    })),
  };
}

/** The container reference used for stop/start/rm: prefer name, else id. */
export function containerRef(c: ContainerRow): string | null {
  return c.name ?? c.id;
}
