# Deploying: Fly.io backend, Cloudflare Pages front door

The app runs as **one always-on Fly.io machine** that holds the API, the realm (call server), the database and uploaded room scans. Your **Cloudflare Pages site is the address people use**. It serves the web app and forwards `/api` and `/realm` to Fly, so the browser only ever talks to one origin. Voice and video go through **LiveKit Cloud**.

```
phone / laptop ──► https://<project>.pages.dev  (Cloudflare Pages: the web app)
                     ├─ /api/*   ─┐  Pages Functions forward these
                     └─ /realm/* ─┴─► https://<app>.fly.dev  (API + realm + database + scans)
                media ─────────────► LiveKit Cloud
```

The Fly address works on its own too, since it serves the same web app.

## 1. Fly.io (about 15 minutes)

1. Install the CLI and sign in. Fly needs a card on file; one small machine costs about $0–5 a month.

   ```bash
   brew install flyctl
   ```

   ```bash
   fly auth login
   ```

2. Create the app and its data volume. Pick a name: it becomes `<name>.fly.dev`. Update `app` in `fly.toml` if it isn't `virtualchatrooms`.

   ```bash
   fly apps create virtualchatrooms
   ```

   ```bash
   fly volumes create vcr_data --region iad --size 3
   ```

3. Set the secrets: LiveKit from your `.env`, a fresh session secret, and an admin token. The admin token lets you make your first sign-in link before Clerk is set up.

   ```bash
   fly secrets set SESSION_TOKEN_SECRET="$(openssl rand -base64 33)" ADMIN_TOKEN="$(openssl rand -hex 24)" LIVEKIT_URL="wss://…livekit.cloud" LIVEKIT_API_KEY="…" LIVEKIT_API_SECRET="…"
   ```

   Optional, for calls while the app is closed: copy `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` from `.env` the same way.

4. In `fly.toml`, set `WEB_ORIGIN` to every address the app is opened at: your Pages site and the Fly address, comma-separated.

5. Deploy. Later deploys are the same command.

   ```bash
   fly deploy
   ```

   Check that it answers:

   ```bash
   curl https://virtualchatrooms.fly.dev/api/health
   ```

## 2. Cloudflare Pages (about 5 minutes)

In the Cloudflare dashboard, open the Pages project that serves the landing page, then go to **Settings → Builds & deployments** and change it to build the app:

| Setting                | Value                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Root directory         | `apps/web`                                                                                                                  |
| Build command          | `cd ../.. && (command -v pnpm \|\| npm i -g pnpm@9.15.9) && pnpm install --frozen-lockfile && pnpm --filter @vcr/web build` |
| Build output directory | `dist`                                                                                                                      |

Under **Settings → Environment variables** (production, and the same for preview so branch builds work too):

| Variable                     | Value                                                 |
| ---------------------------- | ----------------------------------------------------- |
| `NODE_VERSION`               | `24`                                                  |
| `SKIP_DEPENDENCY_INSTALL`    | `1` (the build command installs with pnpm itself)     |
| `BACKEND_ORIGIN`             | `https://virtualchatrooms.fly.dev`                    |
| `VITE_CLERK_PUBLISHABLE_KEY` | your Clerk publishable key (once you have one; see 4) |

The build image already ships pnpm, so the command only installs it when it's missing (`npm i -g` over an existing pnpm fails with `EEXIST`). Check variable names for stray spaces or tabs when pasting; a name like `VITE_CLERK_PUBLISHABLE_KEY⇥` is silently ignored by the build.

Pages deploys from the branch it watches (usually `main`), so the new setup goes live once this work is merged and pushed. `apps/web/functions/` holds the two forwarding functions. Without `BACKEND_ORIGIN` they answer "not connected yet".

## 3. Your first sign-in (before Clerk)

Ask the server for a sign-in link with the admin token from step 1 (`fly secrets list` shows only names, so keep the token):

```bash
curl -X POST https://virtualchatrooms.fly.dev/api/admin/sign-in-link -H "authorization: Bearer <ADMIN_TOKEN>" -H "content-type: application/json" -d '{"displayName":"Carsten"}'
```

Open `https://<project>.pages.dev` plus the `path` it returns (for example `/link/abc…`) within 10 minutes. You're signed in. From there:

- **Use on your phone** (top right) shows a QR code that signs your phone in as you.
- **Contacts → Add people** makes an invite link. Friends who open it create an account and become your contacts.
- **Your call link** lets anyone call you without an account.

## 4. Real accounts with Clerk (when you're ready)

1. Create an application at [dashboard.clerk.com](https://dashboard.clerk.com) with Email and Google, and add your Pages domain under **Domains**.
2. Set the secret key on Fly:

   ```bash
   fly secrets set CLERK_SECRET_KEY="sk_live_…"
   ```

3. Put the publishable key in Pages' `VITE_CLERK_PUBLISHABLE_KEY` and redeploy Pages. If you also use the Fly address directly, run `fly deploy --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_live_…`.

With Clerk on, invite links ask people to sign in with Clerk first, then connect them to you. Accounts made earlier through links keep working.

## What's where

- **Database:** embedded PGlite at `/data/pglite` on the Fly volume (one machine only). For managed Postgres (Neon), set the `DATABASE_URL` secret.
- **Room scans:** `/data/storage` on the same volume. For Cloudflare R2, set `STORAGE_DRIVER=s3` and the `S3_*` secrets (see `.env.example`).
- **Why one machine:** live events, ringing and the realm keep their state in memory. Running two needs Redis (PLAN.md § 8).
- **Why 2 GB:** the API with embedded Postgres (PGlite) uses about 700 MB, the realm about 150 MB, and creating the database on a fresh volume briefly needs about 1.2 GB. On 1 GB the API is killed for running out of memory. Pointing `DATABASE_URL` at a hosted Postgres (Neon, Fly Postgres) removes most of that.
