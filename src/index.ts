import type { Env } from './types.ts';
import { parseDevice } from './parse.ts';
import { listRecentRequests, renderConsolePage } from './console.ts';
import { SETTING, getSetting, getZoomConfig, insertRequestLog, isServingEnabled, listFleet, saveZoomConfig, setSetting } from './db.ts';
import { checkBasicAuth, unauthorizedResponse } from './auth.ts';
import { parseFleetFilter, renderDashboard } from './pages/dashboard.ts';
import { renderZoomPage } from './pages/zoom.ts';
import { renderSettingsPage } from './pages/settings.ts';
import { renderProfilesPage } from './pages/profiles.ts';
import { countZoomDevices, syncZoomDevices } from './zoom.ts';
import { encryptSecret } from './crypto.ts';
import { isValidZoomUrl, listProfiles, parseVendor, refreshProfiles, saveProfile } from './profiles.ts';
import { classifyRequest, contextErrorDecision, decideResponse, loadServeContext, type ServeContext } from './serve.ts';

type Handler = (request: Request, env: Env, url: URL) => Promise<Response>;

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function redirect(url: URL, path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: `${url.origin}${path}`, 'Cache-Control': 'no-store' },
  });
}

function sourceIpOf(request: Request): string | null {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) {
    return cfIp;
  }
  const forwarded = request.headers.get('X-Forwarded-For');
  return forwarded ? (forwarded.split(',')[0]?.trim() ?? null) : null;
}

async function handleProvisioning(request: Request, env: Env, url: URL): Promise<Response> {
  const userAgent = request.headers.get('User-Agent');
  const parsed = parseDevice(url.pathname, url.search, userAgent);
  const file = classifyRequest(url.pathname);
  let context: ServeContext | null = null;
  let contextFailed = false;
  if (file.mac) {
    try {
      context = await loadServeContext(env.DB, file.mac);
    } catch (error) {
      contextFailed = true;
      console.error('failed to load serve context', error);
    }
  }
  const decision = contextFailed ? contextErrorDecision() : decideResponse(request.method, file, context);

  try {
    await insertRequestLog(env.DB, {
      receivedAt: new Date().toISOString(),
      sourceIp: sourceIpOf(request),
      manufacturer: parsed.manufacturer,
      model: parsed.model,
      firmware: parsed.firmware,
      macAddress: parsed.macAddress,
      httpMethod: request.method,
      path: url.pathname,
      queryString: url.search,
      userAgent,
      headersJson: JSON.stringify(Object.fromEntries(request.headers)),
      responseStatus: decision.status,
      responseKind: decision.kind,
      responseReason: decision.reason,
    });
  } catch (error) {
    // Never let a logging failure change what the phone sees.
    console.error('failed to log provisioning request', error);
  }

  return new Response(decision.body, {
    status: decision.status,
    headers: { 'Content-Type': decision.contentType, 'Cache-Control': 'no-store' },
  });
}

const dashboard: Handler = async (_request, env, url) => {
  const [fleet, servingEnabled, lastZoomSyncAt, zoomDeviceCount] = await Promise.all([
    listFleet(env.DB),
    isServingEnabled(env.DB),
    getSetting(env.DB, SETTING.lastZoomSyncAt),
    countZoomDevices(env.DB),
  ]);
  return htmlResponse(renderDashboard(fleet, parseFleetFilter(url.searchParams.get('status')), { servingEnabled, lastZoomSyncAt, zoomDeviceCount }));
};

const zoomPage: Handler = async (_request, env) => {
  const [config, lastSyncAt, lastSyncResult, deviceCount] = await Promise.all([
    getZoomConfig(env.DB),
    getSetting(env.DB, SETTING.lastZoomSyncAt),
    getSetting(env.DB, SETTING.lastZoomSyncResult),
    countZoomDevices(env.DB),
  ]);
  return htmlResponse(renderZoomPage({ config, lastSyncAt, lastSyncResult, deviceCount }));
};

const saveZoomCredentials: Handler = async (request, env, url) => {
  const form = await request.formData();
  const clientId = String(form.get('clientId') ?? '').trim();
  const clientSecret = String(form.get('clientSecret') ?? '');
  const accountId = String(form.get('accountId') ?? '').trim();
  if (!clientId || !clientSecret || !accountId) {
    return new Response('clientId, clientSecret, and accountId are all required', { status: 400 });
  }
  await saveZoomConfig(env.DB, {
    clientId,
    clientSecretEncrypted: await encryptSecret(clientSecret, env.ENCRYPTION_KEY),
    accountId,
    updatedAt: new Date().toISOString(),
  });
  return redirect(url, '/admin/zoom');
};

const syncZoom: Handler = async (_request, env, url) => {
  await syncZoomDevices(env);
  return redirect(url, '/admin/zoom');
};

const settingsPage: Handler = async (_request, env) => htmlResponse(renderSettingsPage(await isServingEnabled(env.DB)));

const saveSettings: Handler = async (request, env, url) => {
  const form = await request.formData();
  await setSetting(env.DB, SETTING.servingEnabled, form.get('servingEnabled') === 'on' ? '1' : '0');
  return redirect(url, '/admin/settings');
};

const consolePage: Handler = async (_request, env) => htmlResponse(renderConsolePage(await listRecentRequests(env.DB, {})));

const requestsFeed: Handler = async (_request, env, url) => {
  const after = Number(url.searchParams.get('after') ?? 0);
  const rows = await listRecentRequests(env.DB, { after: Number.isFinite(after) ? after : 0 });
  return new Response(JSON.stringify({ rows }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};

const profilesPage: Handler = async (_request, env) => htmlResponse(renderProfilesPage(await listProfiles(env.DB)));

const refreshProfilesRoute: Handler = async (_request, env, url) => {
  await refreshProfiles(env.DB, new Date().toISOString());
  return redirect(url, '/admin/profiles');
};

const saveProfiles: Handler = async (request, env, url) => {
  const form = await request.formData();
  const now = new Date().toISOString();
  const inputs = (await listProfiles(env.DB)).map((p) => ({
    model: p.model,
    vendor: parseVendor(form.get(`vendor:${p.model}`) as string | null),
    zoomUrl: String(form.get(`zoom_url:${p.model}`) ?? '').trim() || null,
    enabled: form.get(`enabled:${p.model}`) === 'on',
  }));
  const bad = inputs.find((i) => i.zoomUrl !== null && !isValidZoomUrl(i.zoomUrl));
  if (bad) {
    return new Response(`Zoom URL for "${bad.model}" must start with https://`, {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  for (const input of inputs) {
    await saveProfile(env.DB, input, now);
  }
  return redirect(url, '/admin/profiles');
};

/** `"METHOD /path"` -> handler. Every entry is behind Basic Auth. Later tasks add rows here. */
const ADMIN_ROUTES: Record<string, Handler> = {
  'GET /admin': dashboard,
  'GET /admin/console': consolePage,
  'GET /admin/api/requests': requestsFeed,
  'GET /admin/zoom': zoomPage,
  'POST /admin/zoom': saveZoomCredentials,
  'POST /admin/zoom/sync': syncZoom,
  'GET /admin/settings': settingsPage,
  'POST /admin/settings': saveSettings,
  'GET /admin/profiles': profilesPage,
  'POST /admin/profiles': saveProfiles,
  'POST /admin/profiles/refresh': refreshProfilesRoute,
};

function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (isAdminPath(url.pathname)) {
      if (!checkBasicAuth(request, env.ADMIN_USER, env.ADMIN_PASSWORD)) {
        return unauthorizedResponse();
      }
      const handler = ADMIN_ROUTES[`${request.method} ${url.pathname}`];
      return handler
        ? handler(request, env, url)
        : new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }

    return handleProvisioning(request, env, url);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(syncZoomDevices(env));
  },
};
