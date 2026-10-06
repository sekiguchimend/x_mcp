import dns from "dns";
import net from "net";

// Media fetching + SSRF protection for remote-hosted media (media_url).
//
// Anything that pulls bytes from a user-supplied URL is an SSRF risk, so this
// module enforces: https only, public-IP-only (DNS resolved and every address
// range-checked), redirects validated per hop, a hard size cap per media kind,
// and a wall-clock timeout.

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 60_000;

export type MediaKind = "image" | "gif" | "video";

// Upload size ceilings enforced both while streaming a download and for base64
// input. Matches X's documented limits.
export const SIZE_LIMITS: Record<MediaKind, number> = {
  image: 5 * 1024 * 1024, // 5 MB
  gif: 15 * 1024 * 1024, // 15 MB
  video: 512 * 1024 * 1024, // 512 MB
};

const EXTENSION_MIME: Record<string, string> = {
  gif: "image/gif",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

export interface FetchedMedia {
  buffer: Buffer;
  mimeType: string;
}

export interface ResolvedMedia {
  buffer: Buffer;
  mimeType: string;
  category: string;
}

/** Classify a MIME type into the coarse media kind, or null if unsupported. */
export function kindFromMime(mime: string): MediaKind | null {
  const m = mime.toLowerCase();
  if (m === "image/gif") return "gif";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("image/")) return "image";
  return null;
}

/** X media_category for a MIME type. */
export function categoryFromMime(mime: string): string {
  const kind = kindFromMime(mime);
  if (kind === "gif") return "tweet_gif";
  if (kind === "video") return "tweet_video";
  return "tweet_image";
}

function mimeFromExtension(urlStr: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(urlStr).pathname;
  } catch {
    pathname = urlStr;
  }
  const dot = pathname.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = pathname.slice(dot + 1).toLowerCase();
  return EXTENSION_MIME[ext] ?? null;
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // malformed → treat as unsafe
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 ("this host")
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isPrivateV6(ip: string): boolean {
  const addr = ip.toLowerCase();
  if (addr === "::1" || addr === "::") return true; // loopback / unspecified
  // IPv4-mapped or -embedded (e.g. ::ffff:192.168.0.1) → check the embedded v4.
  const v4 = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) return isPrivateV4(v4[1]);
  const first = parseInt(addr.split(":")[0] || "0", 16);
  if (Number.isNaN(first)) return true;
  const high = first >> 8;
  if (high === 0xfc || high === 0xfd) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (high === 0xff) return true; // ff00::/8 multicast
  return false;
}

function isPrivateIp(ip: string): boolean {
  const type = net.isIP(ip);
  if (type === 4) return isPrivateV4(ip);
  if (type === 6) return isPrivateV6(ip);
  return true; // not a recognizable IP → unsafe
}

/**
 * Throw unless `urlStr` is an https URL whose host resolves exclusively to
 * public IP addresses. Called for the original URL and every redirect hop.
 */
async function assertPublicHttpsUrl(urlStr: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error(`invalid media_url: ${urlStr}`);
  }
  if (u.protocol !== "https:") {
    throw new Error(`media_url must use https (got ${u.protocol.replace(":", "")})`);
  }
  const host = u.hostname;
  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    const resolved = await dns.promises.lookup(host, { all: true });
    addresses = resolved.map((r) => r.address);
    if (addresses.length === 0) {
      throw new Error(`could not resolve host ${host}`);
    }
  }
  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new Error(
        `refusing to fetch ${host}: resolves to private/internal address ${addr}`,
      );
    }
  }
}

/**
 * Fetch media bytes from a public https URL, following redirects (each hop
 * re-validated), detecting the MIME type, and aborting if the stream exceeds
 * the size limit for its kind or the timeout elapses.
 */
export async function fetchMediaFromUrl(
  rawUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<FetchedMedia> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = rawUrl;
    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicHttpsUrl(url);
      const res = await fetch(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "x-mcp-media-fetch/1.0" },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) {
          throw new Error(`redirect (HTTP ${res.status}) from ${url} without a Location header`);
        }
        url = new URL(location, url).toString();
        continue;
      }
      response = res;
      break;
    }
    if (!response) {
      throw new Error(`too many redirects (>${MAX_REDIRECTS}) fetching media`);
    }
    if (!response.ok) {
      throw new Error(`failed to fetch media_url (HTTP ${response.status})`);
    }

    let mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!mimeType || mimeType === "application/octet-stream" || mimeType === "binary/octet-stream") {
      mimeType = mimeFromExtension(url) || mimeType;
    }
    const kind = kindFromMime(mimeType);
    if (!kind) {
      throw new Error(
        `unsupported media type ${mimeType || "(unknown)"} — only images and videos are allowed`,
      );
    }
    const limit = SIZE_LIMITS[kind];

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > limit) {
      throw new Error(
        `media too large: ${contentLength} bytes exceeds the ${limit}-byte limit for ${kind}`,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > limit) {
        throw new Error(`media too large: ${buffer.length} bytes exceeds the ${limit}-byte limit for ${kind}`);
      }
      return { buffer, mimeType };
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(
          `media exceeds the ${limit}-byte limit for ${kind}; download aborted`,
        );
      }
      chunks.push(Buffer.from(value));
    }
    return { buffer: Buffer.concat(chunks), mimeType };
  } catch (e: unknown) {
    if ((e as Error).name === "AbortError") {
      throw new Error(`fetching media_url timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalize the two media input modes (remote `media_url` or inline
 * base64 `media_data` + `mime_type`) into the buffer, MIME type, and X
 * media_category needed to upload. Enforces "exactly one mode" and size caps.
 */
export async function resolveMediaInput(opts: {
  media_url?: string;
  media_data?: string;
  mime_type?: string;
  media_category?: string;
}): Promise<ResolvedMedia> {
  let buffer: Buffer;
  let mimeType: string;

  if (opts.media_url) {
    const fetched = await fetchMediaFromUrl(opts.media_url);
    buffer = fetched.buffer;
    mimeType = (opts.mime_type || fetched.mimeType).toLowerCase();
  } else if (opts.media_data) {
    if (!opts.mime_type) {
      throw new Error("mime_type is required when using media_data");
    }
    buffer = Buffer.from(opts.media_data, "base64");
    mimeType = opts.mime_type.toLowerCase();
  } else {
    throw new Error("provide either media_url, or media_data together with mime_type");
  }

  const kind = kindFromMime(mimeType);
  if (!kind) {
    throw new Error(`unsupported media type ${mimeType} — only images and videos are allowed`);
  }
  const limit = SIZE_LIMITS[kind];
  if (buffer.length > limit) {
    throw new Error(`media too large: ${buffer.length} bytes exceeds the ${limit}-byte limit for ${kind}`);
  }

  return {
    buffer,
    mimeType,
    category: opts.media_category || categoryFromMime(mimeType),
  };
}
