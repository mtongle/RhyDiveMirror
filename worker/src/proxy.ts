/**
 * Transparent reverse proxy.
 *
 * Every request that is not a chart download is forwarded to the official
 * origin **unmodified**: same method, same path, same query, same body, same
 * status. The only adjustments are the ones a reverse proxy must make —
 * hop-by-hop headers, and `Set-Cookie` domain scoping so an upstream cookie
 * issued for `sta.lunprin.com` is stored for the mirror host instead.
 */
import { globalFetch, type FetchLike } from './fetch';
import { setCookieValues, splitSetCookie, stripHopByHop } from './http';

export interface ProxyOptions {
  /** Origin to forward to, preserving the incoming path and query. */
  target?: string;
  /** Absolute destination URL; wins over `target` when present. */
  url?: string;
  /** Host that cookies should be scoped to (the mirror's own host). */
  host?: string;
}

export async function proxyRequest(
  request: Request,
  options: ProxyOptions,
  fetchImpl: FetchLike = globalFetch,
): Promise<Response> {
  const incoming = new URL(request.url);
  let target: URL;
  if (options.url) {
    target = new URL(options.url);
  } else {
    const baseOrigin = options.target ?? incoming.origin;
    target = new URL(baseOrigin);
    // Sanitize pathname so protocol-relative URLs (e.g. //attacker.com)
    // cannot change target.origin, preventing open-proxy / SSRF attacks.
    target.pathname = incoming.pathname.replace(/^\/+/, '/');
    target.search = incoming.search;
    if (options.target && target.origin !== new URL(options.target).origin) {
      return new Response(JSON.stringify({ success: false, message: 'invalid proxy destination' }), {
        status: 400,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
  }

  const headers = stripHopByHop(request.headers);
  // Ask upstream for an identity body so the response we pass through is exactly
  // what the client receives; Cloudflare's edge re-compresses for the client.
  headers.delete('accept-encoding');
  headers.set('accept-encoding', 'identity');
  headers.set('x-forwarded-host', incoming.host);
  headers.set('x-forwarded-proto', incoming.protocol.replace(':', ''));
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) headers.set('x-forwarded-for', clientIp);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers,
    redirect: 'manual',
  };
  if (hasBody && request.body) {
    init.body = request.body;
    init.duplex = 'half';
  }

  const upstream = await fetchImpl(target.toString(), init);

  // Strip hop-by-hop headers from upstream response (RFC 9110 §7.6.1)
  const responseHeaders = stripHopByHop(upstream.headers);
  responseHeaders.delete('set-cookie');
  for (const cookie of setCookieValues(upstream.headers)) {
    responseHeaders.append('set-cookie', scopeCookie(cookie, options.host));
  }
  // If upstream sent compressed body and fetch decompressed it, remove content-encoding & content-length
  // so downstream clients do not fail on decompressed bodies with a gzip header.
  if (upstream.headers.has('content-encoding')) {
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');
  }

  // 204, 304, and HEAD responses must have a null body in WHATWG Fetch
  const nullBody = upstream.status === 204 || upstream.status === 304 || request.method === 'HEAD';
  return new Response(nullBody ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/**
 * Strip the `Domain` attribute so the cookie belongs to whichever host served
 * it. Cookies the upstream scoped to `sta.lunprin.com` must not be rejected by
 * a browser talking to the mirror.
 */
export function scopeCookie(cookie: string, host?: string): string {
  const parts = cookie.split(';');
  const kept = [parts[0]!.trim()];
  for (const raw of parts.slice(1)) {
    const attr = raw.trim();
    const name = attr.split('=')[0]!.trim().toLowerCase();
    if (name === 'domain') continue;
    if (name === 'secure' && host && isLoopback(host)) continue;
    kept.push(attr);
  }
  return kept.join('; ');
}

function isLoopback(host: string): boolean {
  const name = host.split(':')[0] ?? host;
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]' || name === '::1';
}

export { splitSetCookie };
