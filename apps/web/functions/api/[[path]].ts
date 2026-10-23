/**
 * Cloudflare Pages Function: the Pages site is the app's front door and forwards /api/* to the
 * always-on backend (Fly.io) named by BACKEND_ORIGIN, so the browser only ever talks to one
 * origin. Method, headers and body pass through (upload parts stream), and so do WebSocket
 * upgrades. Static files are served by Pages itself.
 */
interface Env {
  /** e.g. https://virtualchatrooms.fly.dev */
  BACKEND_ORIGIN?: string;
}

export async function onRequest({ request, env }: { request: Request; env: Env }) {
  if (!env.BACKEND_ORIGIN) {
    return Response.json(
      { error: "not_configured", message: "The backend isn't connected yet (BACKEND_ORIGIN)." },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.BACKEND_ORIGIN);
  return fetch(new Request(target, request));
}
