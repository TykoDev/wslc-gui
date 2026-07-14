// Registry tag discovery for the Pull dialog (intake r6-d3). Public repos only:
// docker.io refs use the Docker Hub API (rich, newest-first, live-probed
// 2026-07-13); everything else uses the OCI v2 /tags/list with an anonymous
// bearer token. Pure helpers are exported for tests; network stays in fetchTags.

import { ValidationError } from "../adapter/validate.ts";

const TAG_CAP = 60;
const TIMEOUT_MS = 15_000;
// I6: never read a registry answer unbounded — a hostile/broken registry could stream
// gigabytes into `res.json()`. 2 MB is far above any real /tags/list or Hub page.
const RESPONSE_CAP_BYTES = 2 * 1024 * 1024;

export class TagFetchError extends Error {
  kind: "unreachable" | "not_found" | "bad_response";
  constructor(kind: TagFetchError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** D1 (M2 SSRF): block ONLY the link-local range `169.254.0.0/16` — the cloud-metadata
 * vector (`169.254.169.254`). Loopback and RFC1918 are deliberately ALLOWED: this is a
 * local-first container GUI, so a private registry at `localhost:5000`, `192.168.x`,
 * `10.x` or `172.16–31.x` is a legitimate target, not an attack. Only an IPv4 literal
 * can be link-local here; a DNS name is out of scope for this control (per D1). */
export function isLinkLocalHost(host: string): boolean {
  let bare = host.trim();
  const bracket = bare.match(/^\[(.+?)\](?::\d+)?$/); // [addr] or [addr]:port
  if (bracket) bare = bracket[1];
  else bare = bare.replace(/:\d+$/, ""); // strip a trailing :port on the plain form
  const m = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return Number(m[1]) === 169 && Number(m[2]) === 254;
}

/** Refuse a registry host in the blocked range → ValidationError (→ HTTP 400 at the route). */
export function assertRegistryHostAllowed(host: string): void {
  if (isLinkLocalHost(host)) {
    throw new ValidationError(
      `registry host "${host}" is link-local (169.254.0.0/16) and is blocked to prevent SSRF into cloud metadata`,
    );
  }
}

/** Read a JSON response body with a hard byte ceiling (I6). Cancels the stream and throws
 * `bad_response` the moment the cap is crossed, so nothing unbounded is ever buffered. */
export async function readCappedJson(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > RESPONSE_CAP_BYTES) {
    await res.body?.cancel();
    throw new TagFetchError("bad_response", `registry response ${declared} bytes exceeds the 2 MB cap`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new TagFetchError("bad_response", "empty registry response");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > RESPONSE_CAP_BYTES) {
      await reader.cancel();
      throw new TagFetchError("bad_response", "registry response exceeds the 2 MB cap");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new TagFetchError("bad_response", "registry returned invalid JSON");
  }
}

export interface ParsedRef {
  registry: string; // "docker.io" or an explicit host
  repository: string; // hub-style path, e.g. "library/nginx"
  tag: string | null;
}

/** Split an image ref into registry/repository/tag (docker shortname rules:
 * a first segment with a dot, colon, or "localhost" is a registry host). */
export function parseImageRef(raw: string): ParsedRef {
  let rest = raw.trim();
  let tag: string | null = null;
  // strip @digest first, then :tag (the last colon after the final slash)
  const at = rest.indexOf("@");
  if (at >= 0) rest = rest.slice(0, at);
  const lastSlash = rest.lastIndexOf("/");
  const lastColon = rest.lastIndexOf(":");
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1) || null;
    rest = rest.slice(0, lastColon);
  }
  const segs = rest.split("/").filter((s) => s.length > 0);
  if (segs.length === 0) return { registry: "docker.io", repository: "", tag };
  const first = segs[0];
  const explicitHost = segs.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  if (explicitHost) {
    return { registry: first, repository: segs.slice(1).join("/"), tag };
  }
  const repository = segs.length === 1 ? `library/${segs[0]}` : segs.join("/");
  return { registry: "docker.io", repository, tag };
}

/** Parse a `WWW-Authenticate: Bearer realm="…",service="…"` challenge. */
export function parseWwwAuthenticate(header: string): { realm: string; service: string | null } | null {
  if (!/^Bearer\s/i.test(header)) return null;
  const get = (key: string): string | null => {
    const m = header.match(new RegExp(`${key}="([^"]*)"`, "i"));
    return m ? m[1] : null;
  };
  const realm = get("realm");
  return realm ? { realm, service: get("service") } : null;
}

/** "latest" first, then version-aware descending, then alpha descending. */
export function sortTagsDesc(tags: string[]): string[] {
  const chunks = (s: string): (number | string)[] =>
    s.split(/(\d+)/).filter((c) => c.length > 0).map((c) => (/^\d+$/.test(c) ? Number(c) : c));
  return [...tags].sort((a, b) => {
    if (a === "latest") return -1;
    if (b === "latest") return 1;
    const ca = chunks(a);
    const cb = chunks(b);
    for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
      const x = ca[i];
      const y = cb[i];
      if (x === undefined) return 1; // "1.27" sorts after its more specific "1.27.2"
      if (y === undefined) return -1;
      if (x === y) continue;
      if (typeof x === "number" && typeof y === "number") return y - x;
      if (typeof x === "number") return -1; // numeric outranks text: versions before "alpine"
      if (typeof y === "number") return 1;
      return y.localeCompare(x);
    }
    return 0;
  });
}

export interface TagList {
  source: "hub" | "v2";
  registry: string;
  repository: string;
  total: number | null;
  tags: { name: string; updated: string | null }[];
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new TagFetchError("unreachable", `registry unreachable: ${err instanceof Error ? err.message : err}`);
  }
}

async function fetchHubTags(repository: string): Promise<TagList> {
  const url = `https://hub.docker.com/v2/repositories/${repository}/tags?page_size=${TAG_CAP}&ordering=last_updated`;
  const res = await get(url);
  if (res.status === 404) {
    await res.body?.cancel();
    throw new TagFetchError("not_found", `repository ${repository} not found on Docker Hub (private repos are not supported)`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new TagFetchError("bad_response", `Docker Hub answered HTTP ${res.status}`);
  }
  const data = await readCappedJson(res) as { count?: number; results?: { name?: string; last_updated?: string }[] };
  if (!Array.isArray(data.results)) throw new TagFetchError("bad_response", "unexpected Docker Hub payload");
  return {
    source: "hub",
    registry: "docker.io",
    repository,
    total: typeof data.count === "number" ? data.count : null,
    tags: data.results
      .filter((r): r is { name: string; last_updated?: string } => typeof r.name === "string")
      .map((r) => ({ name: r.name, updated: r.last_updated ?? null })),
  };
}

async function fetchV2Tags(registry: string, repository: string): Promise<TagList> {
  // D1 (M2): the registry host is user-controlled — refuse the link-local range before
  // any request leaves the process. https is already forced by the URL scheme below.
  assertRegistryHostAllowed(registry);
  // /tags/list has no ordering; fetch a large page so sortTagsDesc sees the
  // newest tags too (repos beyond 1000 tags may still truncate — recorded limitation).
  const url = `https://${registry}/v2/${repository}/tags/list?n=1000`;
  let res = await get(url);
  if (res.status === 401) {
    const challenge = parseWwwAuthenticate(res.headers.get("www-authenticate") ?? "");
    await res.body?.cancel();
    if (!challenge) throw new TagFetchError("bad_response", `${registry} requires auth without a Bearer challenge`);
    // D1 (M2): the realm comes from the registry's own header — it is a redirect target,
    // so apply the SAME controls to it: https only, and never a link-local host.
    let realmUrl: URL;
    try {
      realmUrl = new URL(challenge.realm);
    } catch {
      throw new TagFetchError("bad_response", `${registry} sent an unparseable auth realm`);
    }
    if (realmUrl.protocol !== "https:") {
      throw new ValidationError(`registry auth realm must be https, got "${realmUrl.protocol}//" from ${registry}`);
    }
    assertRegistryHostAllowed(realmUrl.hostname);
    const tokenUrl = `${challenge.realm}?${challenge.service ? `service=${encodeURIComponent(challenge.service)}&` : ""}scope=${encodeURIComponent(`repository:${repository}:pull`)}`;
    const tokenRes = await get(tokenUrl);
    if (!tokenRes.ok) {
      await tokenRes.body?.cancel();
      throw new TagFetchError("not_found", `anonymous access to ${repository} denied (private repos are not supported)`);
    }
    const tokenData = await readCappedJson(tokenRes) as { token?: string; access_token?: string };
    const token = tokenData.token ?? tokenData.access_token;
    if (!token) throw new TagFetchError("bad_response", "token endpoint returned no token");
    res = await get(url, { authorization: `Bearer ${token}` });
  }
  if (res.status === 404) {
    await res.body?.cancel();
    throw new TagFetchError("not_found", `repository ${repository} not found on ${registry}`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new TagFetchError("bad_response", `${registry} answered HTTP ${res.status}`);
  }
  const data = await readCappedJson(res) as { tags?: string[] };
  if (!Array.isArray(data.tags)) throw new TagFetchError("bad_response", `unexpected /tags/list payload from ${registry}`);
  return {
    source: "v2",
    registry,
    repository,
    total: data.tags.length,
    tags: sortTagsDesc(data.tags).slice(0, TAG_CAP).map((name) => ({ name, updated: null })),
  };
}

/** Fetch up to 60 tags for a public image ref, newest/most-relevant first. */
export function fetchTags(refRaw: string): Promise<TagList> {
  const ref = parseImageRef(refRaw);
  if (!ref.repository) throw new TagFetchError("bad_response", "empty repository in ref");
  return ref.registry === "docker.io" ? fetchHubTags(ref.repository) : fetchV2Tags(ref.registry, ref.repository);
}
