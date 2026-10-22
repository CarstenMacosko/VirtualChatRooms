# ADR 0016: Prototype by sharing the dev server; deploy later

- **Status:** Accepted
- **Date:** 2026-10-22
- **Plan reference:** [PLAN.md § 8](../../PLAN.md#8-deployment--operations)

## Context

We want others to try changes as soon as they're made and to join calls, without buying a domain. Cloudflare Pages can host the web app for free, but the API, the realm (long-lived WebSockets for the whole call), Postgres and LiveKit (media over UDP) can't run there. A split across five providers would turn every change into a multi-step deploy.

## Decision

While prototyping, share the dev server itself. `pnpm share` opens a Cloudflare quick tunnel (no account, no domain) to the Vite dev server. The dev server is the app's single origin: it forwards `/api` to the API and `/realm` (including WebSockets) to the realm, and Vite's live reload works through the tunnel. Visitors see edits within seconds, without reloading.

Safety rules for a dev server on the internet:

- The name-only development sign-in and the bots' newest-gathering shortcut only answer local requests (no Cloudflare headers, a localhost Host header).
- Visitors join through guest links, or through Clerk accounts when Clerk keys are configured. Clerk sign-ins from `*.trycloudflare.com` are accepted only in development.
- Voice and video for visitors use LiveKit Cloud (free tier), since a LiveKit server on a home network isn't reachable.

## Later: an always-on deployment

When an always-on address matters more than instant edits: run the web app, API and realm on one Node host that supports WebSockets and gives a free subdomain (Fly.io or Railway, deploying on push to `main`), with managed Postgres (Neon) and LiveKit Cloud. The single-origin setup carries over: the host serves the built web app and forwards `/api` and `/realm`, so no code changes are needed. Cloudflare Pages remains an option for the web app alone, but then the browser must be told the API's address, and cross-origin requests configured.

## Alternatives considered

- **Cloudflare Pages + four other providers now:** free, but slow to iterate and complex to keep in sync.
- **ngrok or Tailscale Funnel instead of a quick tunnel:** stable addresses, but each needs an account, and ngrok's free tier shows visitors an interstitial page.
