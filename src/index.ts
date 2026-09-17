import type { Env } from './types.ts';
import { parseDevice } from './parse.ts';
import { getZoomConfig, insertRequestLog, listFleet, saveZoomConfig } from './db.ts';
import { checkBasicAuth, unauthorizedResponse } from './auth.ts';
import { parseFleetFilter, renderDashboard } from './dashboard.ts';
import { encryptSecret } from './crypto.ts';

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
    });
  } catch (error) {
    // Never let a logging failure change what the phone sees.
    console.error('failed to log provisioning request', error);
  }

  return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

async function renderAdmin(env: Env, url: URL): Promise<Response> {
  const [fleet, zoomConfig] = await Promise.all([listFleet(env.DB), getZoomConfig(env.DB)]);
  const html = renderDashboard(fleet, parseFleetFilter(url.searchParams.get('status')), zoomConfig);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function saveSettings(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  }

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

  return Response.redirect(`${url.origin}/admin`, 303);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/admin' || url.pathname === '/admin/settings') {
      if (!checkBasicAuth(request, env.ADMIN_USER, env.ADMIN_PASSWORD)) {
        return unauthorizedResponse();
      }
      return url.pathname === '/admin' ? renderAdmin(env, url) : saveSettings(request, env, url);
    }

    return captureProvisioningRequest(request, env, url);
  },
};
