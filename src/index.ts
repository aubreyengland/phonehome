import type { Env } from './types.ts';

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  },
};
