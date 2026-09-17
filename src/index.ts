import type { Env } from './types.ts';
import { parseDevice } from './parse.ts';
import { insertRequestLog } from './db.ts';

function sourceIpOf(request: Request): string | null {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) {
    return cfIp;
  }
  const forwarded = request.headers.get('X-Forwarded-For');
  return forwarded ? (forwarded.split(',')[0]?.trim() ?? null) : null;
}

async function captureProvisioningRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return captureProvisioningRequest(request, env);
  },
};
