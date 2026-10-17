/**
 * Small HTTP helpers shared by the mirror, the proxy and the admin surface.
 */

/**
 * Headers that must never be forwarded between hops (RFC 9110 §7.6.1).
 * `content-length` is intentionally absent: it is an end-to-end header that the
 * proxy forwards unchanged so clients keep seeing the upstream length.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

export function json(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function text(body: string, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set('content-type', 'text/plain; charset=utf-8');
  return new Response(body, { status, headers: h });
}

const TRUSTED_ORIGIN_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/\[::1\](:\d+)?$/,
  /^rhydive:\/\/app$/,
  /^https?:\/\/([^/]+\.)?lunprin\.com$/,
];

export function isTrustedOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return TRUSTED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

/**
 * CORS handling: allow credentials ONLY for trusted origins (localhost, client app scheme,
 * and official server domains). Arbitrary third-party websites receive wildcard origin
 * without credentials, preventing cross-origin session hijacking.
 */
export function applyCors(response: Response, request: Request): Response {
  const origin = request.headers.get('origin');
  const headers = new Headers(response.headers);
  if (origin && isTrustedOrigin(origin)) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-credentials', 'true');
  } else {
    headers.set('access-control-allow-origin', '*');
    headers.delete('access-control-allow-credentials');
  }
  const vary = headers.get('vary');
  headers.set('vary', vary ? mergeVary(vary, 'Origin') : 'Origin');
  headers.set('access-control-expose-headers', 'content-length, content-range, etag, last-modified');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function mergeVary(current: string, added: string): string {
  const parts = current.split(',').map((part) => part.trim().toLowerCase());
  if (parts.includes(added.toLowerCase())) return current;
  return `${current}, ${added}`;
}

export function preflight(request: Request, allow: string): Response {
  const headers = new Headers();
  headers.set('access-control-allow-methods', allow);
  headers.set(
    'access-control-allow-headers',
    request.headers.get('access-control-request-headers') ?? 'content-type, range, accept',
  );
  headers.set('access-control-max-age', '86400');
  const origin = request.headers.get('origin');
  if (origin && isTrustedOrigin(origin)) {
    headers.set('access-control-allow-origin', origin);
    headers.set('access-control-allow-credentials', 'true');
  } else {
    headers.set('access-control-allow-origin', '*');
  }
  headers.set('vary', 'Origin');
  return new Response(null, { status: 204, headers });
}

export function stripHopByHop(headers: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of headers) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue;
    out.append(name, value);
  }
  return out;
}

/**
 * Copy a `Set-Cookie` list verbatim. `Headers` iteration merges repeated
 * `set-cookie` values on some runtimes, so the dedicated accessor is preferred.
 */
export function setCookieValues(headers: Headers): string[] {
  const withAccessor = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withAccessor.getSetCookie === 'function') return withAccessor.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? splitSetCookie(single) : [];
}

/** Split a merged `set-cookie` header on the commas that separate cookies. */
export function splitSetCookie(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === ',') {
      const rest = value.slice(i + 1, i + 12).toLowerCase();
      if (!rest.trimStart().startsWith('expires=') && !inExpires) {
        out.push(value.slice(start, i).trim());
        start = i + 1;
        continue;
      }
    }
    if (ch === ';') {
      const rest = value.slice(i + 1, i + 12).toLowerCase().trimStart();
      inExpires = rest.startsWith('expires=');
    }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}

export interface ByteRange {
  offset: number;
  length: number;
}

/**
 * Parse a `Range` header against a known total size per RFC 7233 / RFC 9110.
 *
 *  - Unknown range units (e.g. `items=0-10`) or multi-ranges (containing `,`) MUST
 *    be ignored per RFC 7233 §3.1 and §4.4 (returns `null` -> server responds 200 OK with full body).
 *  - Valid byte ranges return `{ offset, length }`.
 *  - Out-of-bounds byte ranges return `'unsatisfiable'` (-> server responds 416).
 */
export function parseRange(header: string | null, size: number): ByteRange | null | 'unsatisfiable' {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith('bytes=')) return null;
  if (trimmed.includes(',')) return null;
  const match = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(trimmed);
  if (!match) return 'unsatisfiable';
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return 'unsatisfiable';
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'unsatisfiable';
    const length = Math.min(suffix, size);
    if (length === 0) return 'unsatisfiable';
    return { offset: size - length, length };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return 'unsatisfiable';
  const end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) return 'unsatisfiable';
  const last = Math.min(end, size - 1);
  return { offset: start, length: last - start + 1 };
}

/**
 * Constant-time string comparison without early length exit,
 * preventing side-channel character length leakage.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    const charA = i < a.length ? a.charCodeAt(i) : 0;
    const charB = i < b.length ? b.charCodeAt(i) : 0;
    diff |= charA ^ charB;
  }
  return diff === 0;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buffer = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest('SHA-256', buffer as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
