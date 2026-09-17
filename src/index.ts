import type { Env } from './types.ts';
import { parseDevice } from './parse.ts';
import { SETTING, getSetting, getZoomConfig, insertRequestLog, isServingEnabled, listFleet, saveZoomConfig, setSetting } from './db.ts';
import { checkBasicAuth, unauthorizedResponse } from './auth.ts';
import { parseFleetFilter, renderDashboard } from './pages/dashboard.ts';
import { renderZoomPage } from './pages/zoom.ts';
import { renderSettingsPage } from './pages/settings.ts';
import { countZoomDevices } from './zoom.ts';
import { encryptSecret } from './crypto.ts';

type Handler = (request: Request, env: Env, url: URL) => Promise<Response>;

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function redirect(url: URL, path: string): Response {
  return Response.redirect(`${url.origin}${path}`, 303);
}

function sourceIpOf(request: Request): string | null {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) {
    return cfIp;
  }
  const forwarded = request.headers.get('X-Forwarded-For');
  return forwarded ? (forwarded.split(',')[0]?.trim() ?? null) : null;
}

async function captureProvisioningRequest(request: Request, env: Env, url: URL): Promise<Response> {
  const userAgent = request.headers.get('User-Agent');
  const parsed = parseDevice(url.pathname, url.search, userAgent);

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
      responseStatus: 200,
      responseKind: 'accepted',
      responseReason: 'phase1-inert',
    });
  } catch (error) {
    // Never let a logging failure change what the phone sees.
    console.error('failed to log provisioning request', error);
  }

  return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

const dashboard: Handler = async (_request, env, url) => {
  const fleet = await listFleet(env.DB);
  return htmlResponse(renderDashboard(fleet, parseFleetFilter(url.searchParams.get('status'))));
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

const settingsPage: Handler = async (_request, env) => htmlResponse(renderSettingsPage(await isServingEnabled(env.DB)));

const saveSettings: Handler = async (request, env, url) => {
  const form = await request.formData();
  await setSetting(env.DB, SETTING.servingEnabled, form.get('servingEnabled') === 'on' ? '1' : '0');
  return redirect(url, '/admin/settings');
};

/** `"METHOD /path"` -> handler. Every entry is behind Basic Auth. Later tasks add rows here. */
const ADMIN_ROUTES: Record<string, Handler> = {
  'GET /admin': dashboard,
  'GET /admin/zoom': zoomPage,
  'POST /admin/zoom': saveZoomCredentials,
  'GET /admin/settings': settingsPage,
  'POST /admin/settings': saveSettings,
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

    return captureProvisioningRequest(request, env, url);
  },
};
