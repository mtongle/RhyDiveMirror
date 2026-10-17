/**
 * RhyDive mirror worker.
 *
 *   chart downloads  -> served from R2 (kept in sync with the official API)
 *   everything else  -> forwarded to the official API untouched
 *
 * See ../docs/ARCHITECTURE.md for the full design and configuration.
 */
import { handleAdmin } from './admin';
import { type Env, resolveConfig } from './config';
import { globalFetch, type FetchLike } from './fetch';
import { applyCors, json, preflight } from './http';
import { classify, type Route } from './layout';
import { originUrls, sourceUrls } from './official';
import { serveAsset, serveObject } from './mirror';
import { proxyRequest } from './proxy';
import { createBulkStore, type BulkStore } from './storage';
import { runSync, type SyncResult } from './sync';

/**
 * The whole request pipeline, with `fetch` injected so tests can drive it with
 * a fake official origin.
 */
export async function handleRequest(request: Request, env: Env, fetchImpl: FetchLike = globalFetch): Promise<Response> {
  const config = resolveConfig(env);
  const url = new URL(request.url);
  // A misconfigured storage tier must not take down /__health or /__admin.
  let store: BulkStore | null = null;
  let storeError: string | null = null;
  try {
    store = createBulkStore(env, config, fetchImpl);
  } catch (error) {
    storeError = error instanceof Error ? error.message : String(error);
  }

  if (request.method === 'OPTIONS') {
    if (url.pathname === '/__admin' || url.pathname.startsWith('/__admin/')) {
      return new Response(null, { status: 403 });
    }
    return preflight(request, 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
  }

  if (url.pathname === '/__health') {
    return json(
      {
        ok: storeError === null,
        service: 'rhydive-mirror',
        ...(storeError ? { error: storeError } : {}),
        mirror: {
          apiPrefix: config.apiPrefix,
          assetMode: config.assetMode,
          storageLayout: config.storageLayout,
          officialOrigin: config.officialOrigin,
          officialCdnOrigin: config.officialCdnOrigin,
        },
      },
      storeError ? { status: 500 } : {},
    );
  }

  if (url.pathname === '/' && isReadMethod(request.method)) {
    return json({
      ok: true,
      service: 'rhydive-mirror',
      endpoints: {
        catalog: `${config.apiPrefix}/library`,
        manifest: `${config.apiPrefix}/library/:id/download`,
        archive: `${config.apiPrefix}/library/:id/archive`,
        asset: `${config.apiPrefix}/assets/:id/*`,
        cdn: '/rhydive/beatmap/...',
        passthrough: 'every other path is proxied to the official API',
      },
    });
  }

  if (url.pathname === '/__admin' || url.pathname.startsWith('/__admin/')) {
    return handleAdmin(request, env, config, fetchImpl);
  }

  // Writes are never mirrored: they always go upstream untouched.
  if (!isReadMethod(request.method)) {
    return forward(request, config, url.pathname, fetchImpl);
  }

  const route = classify(url.pathname, { apiPrefix: config.apiPrefix });
  if (route) {
    if (storeError !== null) {
      return applyCors(
        json({ success: false, message: `storage unavailable: ${storeError}` }, { status: 500 }),
        request,
      );
    }
    const response = await serveRoute(request, store!, config, route);
    if (response) return applyCors(response, request);
    return applyCors(await onMirrorMiss(request, config, url.pathname, route, fetchImpl), request);
  }

  // A path that *looks* like a mirrored resource but failed validation (traversal,
  // disallowed extension, ...) must not be laundered upstream.
  if (isAssetLikePath(url.pathname, config)) {
    return applyCors(json({ success: false, message: 'invalid asset path' }, { status: 400 }), request);
  }

  return forward(request, config, url.pathname, fetchImpl);
}

export async function handleScheduled(env: Env, fetchImpl: FetchLike = globalFetch): Promise<SyncResult> {
  const config = resolveConfig(env);
  return runSync(env, config, {}, fetchImpl);
}

function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

async function forward(request: Request, config: ReturnType<typeof resolveConfig>, pathname: string, fetchImpl: FetchLike): Promise<Response> {
  const target = pathname.startsWith('/rhydive/') ? config.officialCdnOrigin : config.officialOrigin;
  const response = await proxyRequest(request, { target, host: new URL(request.url).host }, fetchImpl);
  return applyCors(response, request);
}

async function serveRoute(
  request: Request,
  store: BulkStore,
  config: ReturnType<typeof resolveConfig>,
  route: Route,
): Promise<Response | null> {
  switch (route.kind) {
    case 'catalog':
    case 'manifest':
      return serveObject(request, store, route.key!, { fallbackType: 'application/json; charset=utf-8' });
    case 'archive':
      if (config.archiveMode === 'proxy') return null;
      return serveObject(request, store, route.key!, { fallbackType: 'application/zip' });
    case 'asset':
      return serveAsset(request, store, config, route.songId!, route.assetName!);
    default:
      return null;
  }
}

/**
 * Nothing mirrored -> the request still has to succeed for an unseeded or
 * partially seeded mirror (and for archives in `proxy` mode).
 *
 * The fallback is resolved through the configured source, so it lands on the
 * real artifact whether that source is the API origin or the download site:
 * the download site has no `/api/rhydive/...` namespace to proxy to.
 *
 *  - API surface: always proxy — an unseeded mirror behaves as a pass-through.
 *  - download-site surface: 404 by default (the official client then falls back
 *    to the API itself) or proxy when `MIRROR_FALLBACK_PROXY` is on.
 */
async function onMirrorMiss(
  request: Request,
  config: ReturnType<typeof resolveConfig>,
  pathname: string,
  route: Route,
  fetchImpl: FetchLike,
): Promise<Response> {
  const host = new URL(request.url).host;
  const urls = originUrls(config);
  const target =
    route.kind === 'catalog'
      ? urls.catalog
      : route.kind === 'manifest' && route.songId
        ? urls.manifest(route.songId)
        : route.kind === 'archive' && route.songId
          ? urls.archive(route.songId)
          : route.kind === 'asset' && route.songId && route.assetName
            ? urls.asset(route.songId, route.assetName)
            : null;

  const onApiSurface = pathname.startsWith(`${config.apiPrefix}/`);
  if (target && (onApiSurface || config.mirrorFallbackProxy)) {
    const res = await proxyRequest(request, { url: target, host }, fetchImpl);
    // If upstream primary source returned 520, 522, 526, or 5xx, try the fallback source
    if (res.status >= 500 && config.syncSource === 'cdn') {
      const fallbackUrls = sourceUrls(config, 'api');
      const altTarget =
        route.kind === 'catalog'
          ? fallbackUrls.catalog
          : route.kind === 'manifest' && route.songId
            ? fallbackUrls.manifest(route.songId)
            : route.kind === 'archive' && route.songId
              ? fallbackUrls.archive(route.songId)
              : route.kind === 'asset' && route.songId && route.assetName
                ? fallbackUrls.asset(route.songId, route.assetName)
                : null;
      if (altTarget) {
        return proxyRequest(request, { url: altTarget, host }, fetchImpl);
      }
    }
    return res;
  }
  return json(
    { success: false, message: `not mirrored yet: ${route.songId ?? pathname}` },
    { status: 404, headers: { 'cache-control': 'no-store' } },
  );
}

function isAssetLikePath(pathname: string, config: ReturnType<typeof resolveConfig>): boolean {
  return (
    pathname.startsWith(`${config.apiPrefix}/assets/`) ||
    pathname.startsWith('/rhydive/beatmap/')
  );
}

export default {
  fetch: (request: Request, env: Env): Promise<Response> => handleRequest(request, env, globalFetch),
  scheduled: async (_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> => {
    ctx.waitUntil(
      handleScheduled(env, globalFetch)
        .then(({ run }) => {
          console.log(
            JSON.stringify({
              event: 'sync',
              processed: run.processed,
              failed: run.failed,
              catalogFetched: run.catalogFetched,
              catalogChanged: run.catalogChanged,
              errors: run.errors.slice(0, 3),
            }),
          );
        })
        .catch((error: unknown) => {
          console.error(JSON.stringify({ event: 'sync.error', message: String(error) }));
        }),
    );
  },
} satisfies ExportedHandler<Env>;
