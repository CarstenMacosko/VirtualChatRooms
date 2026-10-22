# VirtualChatRooms

> Working title. A metaverse built only for friends and family. You hang out and video-call as 3D avatars, inside real rooms you've scanned with your own phone, in the browser.

**Status:** Phases 1–3 are working:

- **The room:** walk around a Gaussian-splat living room with physics, cameras and touch controls.
- **Your avatar:** a Bitmoji-style avatar you make yourself, starting from a selfie if you like. It copies your expressions from your webcam, or moves its mouth with your voice.
- **Calling:** add family by friend code and start a gathering that rings them, even when their app is closed.
- **Voice and video:** spatial voice comes from each person's avatar, with a FaceTime-style video sidebar beside the room.
- **Host controls:** mute, camera off, remove, lock, co-hosts and hand-over.
- **Guests:** kids without accounts join by guest link.

Room scanning (Phase 4) comes next. The full technical design and build roadmap are in [PLAN.md](PLAN.md).

---

## What it does (MVP)

| Feature                | What the user experiences                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scan a room**        | Record a 30–90 second walk-through video of any room, or import a scan you already made in a free app like Scaniverse or Polycam. A few minutes later it shows up as a photoreal 3D space you can walk around in.                                                                           |
| **Create your avatar** | A selfie-assisted creator builds a fun, expressive avatar in the spirit of Snapchat Bitmoji / Meta avatars that looks like you, which you can then adjust. With your webcam on (optional), the avatar copies your facial expressions. Without it, the avatar still lip-syncs to your voice. |
| **Move around**        | Walk with WASD/arrow keys, a touch joystick, or click-to-move. Switch between first- and third-person cameras. You can't walk through walls or furniture.                                                                                                                                   |
| **Call everyone**      | Ring your contacts, or share a link with family members who don't have an account. Up to 25 people can be in one space at once. Voice is **spatial**: people near you sound louder, and you hear them from the direction they're standing in.                                               |
| **Video sidebar**      | A FaceTime-style strip of live video tiles beside the 3D view for anyone who turns their camera on. People with their camera off show as a live avatar headshot.                                                                                                                            |

## Built to support later

The MVP architecture includes the extension points these features need, so adding them later won't require a rewrite (details in [PLAN.md § 5](PLAN.md#5-future-proofing-seams-built-into-the-mvp)):

- **Side conversations.** Step into a small group and talk at full volume while hearing the rest of the room quietly in the background, with a slider for how loud that background is. Private groups are enforced on the server, not just muted on the client.
- **Mini-games.** A plugin SDK where each game is a server module plus a client module.
- **VR.** WebXR on Quest and other headsets, using the same scene, avatars and network protocol.
- **Sitting and fluid movement.** Seats detected in scanned rooms, smooth transitions between sitting and standing, IK-driven poses.

## How it works

```mermaid
flowchart LR
  subgraph Client["Browser (React + Three.js)"]
    UI[App UI] --> Engine
    Engine[3D engine<br/>splat room · avatars · physics · input]
    Audio[Spatial audio graph<br/>Web Audio API]
  end

  Client -- REST / auth<br/>live events (rings) --> API[API server<br/>Fastify + Postgres]
  Client -- authoritative state<br/>presence, seats, groups, games --> Realm[Realm server<br/>Colyseus]
  Client <-- voice + avatar pose stream --> SFU[LiveKit SFU<br/>WebRTC]
  API -- realm tickets --> Realm
  Realm -- media tokens, host controls,<br/>subscription rules --> SFU

  Client -- upload room video<br/>or existing scan --> Storage[(Object storage<br/>+ CDN)]
  API -- enqueue job --> Queue[(Redis queue)]
  Queue --> Capture[Capture worker CPU<br/>post-process + manifest]
  Capture <-- video → splat + mesh --> KIRI[KIRI Engine<br/>3DGS API]
  Capture --> Storage
  Storage -- signed, session-scoped URLs --> Client
```

1. **Rooms** are **3D Gaussian Splats**, currently the best way to get photoreal, real-time-renderable scenes from ordinary phone video. We don't build the reconstruction ourselves. Videos go to the [KIRI Engine](https://www.kiriengine.app) 3DGS API, which returns a splat and a mesh. Users can also import splats from free apps like Scaniverse or Polycam. A small CPU worker then makes the collision mesh, finds the floor, sets real-world scale, compresses the result and writes a room manifest. The browser renders it with [Spark](https://sparkjs.dev) on top of Three.js.
2. **Avatars** use the open **VRM** humanoid standard (glTF-based). Every avatar shares one skeleton, which keeps animation, sitting and VR IK consistent.
3. **Voice and sidebar video** go through a **LiveKit** SFU, which scales to large rooms. Video uses simulcast, so each viewer only downloads the tiles they can see. Each remote voice runs through a per-person Web Audio chain (gain → HRTF panner → conversation/ambient bus), which is also what side conversations will plug into.
4. **Avatar motion** (position, animation state, facial blendshapes, and VR head/hands later) streams over LiveKit's low-latency data channel. **Authoritative state** (who's in the session, seats, conversation groups, game state) lives in a **Colyseus** server.

## Tech stack

| Layer               | Choice                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Language            | TypeScript everywhere except the capture worker (Python)                                                                             |
| Monorepo            | pnpm workspaces + Turborepo                                                                                                          |
| Web client          | React, Vite, React Three Fiber, `@react-three/xr` (for VR later), Zustand                                                            |
| Splat rendering     | Spark (`@sparkjsdev/spark`), assets in `.spz` (compressed) format                                                                    |
| Avatars             | `@pixiv/three-vrm`, MediaPipe Face Landmarker (expression tracking)                                                                  |
| Physics / movement  | Rapier (`@dimforge/rapier3d-compat`) kinematic character controller                                                                  |
| Media               | LiveKit (Cloud to start, self-hostable later)                                                                                        |
| Realtime state      | Colyseus                                                                                                                             |
| API                 | Fastify, Drizzle ORM, PostgreSQL, Redis, Zod-validated contracts                                                                     |
| Auth                | Clerk (email and Google sign-in), exchanged for our own session token; guest links for invitees                                      |
| Room reconstruction | KIRI Engine 3DGS API (video → splat + mesh), plus import of Scaniverse / Polycam / KIRI app exports. Self-hosted `gsplat` is Plan B. |
| Capture worker      | Python, FFmpeg, Open3D (collision mesh, floor/scale), spz tools. CPU only.                                                           |
| Storage / CDN       | S3-compatible (Cloudflare R2, chosen for low egress cost on large room files)                                                        |
| Testing             | Vitest, Playwright (fake media devices), LiveKit load tester, headless bot clients                                                   |

## Repository layout

`services/capture` and `packages/ui` are planned and get created in the phase that needs them.

```
apps/
  web/              React + R3F client
  api/              REST API: auth, contacts, rooms, sessions, ringing (server-sent events), guest links
  realm/            Colyseus server: session state, host controls, LiveKit tokens; later groups, seats, games
services/
  capture/          Python CPU worker: capture provider calls, post-processing, manifest
packages/
  engine/           3D runtime: input intents, physics/locomotion, cameras, pose interpolation,
                    procedural animation and emotes, face animation, sample room, device profile
  avatar/           Avatar recipe → VRM 1.0 generator, palettes, selfie measurements
  protocol/         Shared message types and Zod schemas (client ⇄ servers)
  games-sdk/        Mini-game plugin interface (post-MVP, but defined early)
  ui/               Shared React UI components
tools/
  livekit/          Starts `livekit-server --dev` during `pnpm dev` when it's installed
infra/
  docker-compose.yml   Postgres, Redis, LiveKit, SeaweedFS (S3) for local dev
scripts/
  smoke.ts          End-to-end check against running servers
  bots.ts           Walking bots for multiplayer/load testing
docs/
  adr/              Architecture decision records
```

## Local development

**Prerequisites:** Node 22.12+ (the repo pins 24 in `.nvmrc`). pnpm comes from Node's built-in corepack, so turn it on once:

```bash
corepack enable pnpm
```

Docker is optional for now. Without it the API uses embedded [PGlite](https://pglite.dev) (Postgres in-process, stored in `apps/api/.data/`).

For voice and video, install the LiveKit server once. `pnpm dev` starts it in dev mode when it's on your PATH, and runs everything else without voice and video when it isn't:

```bash
brew install livekit
```

Install dependencies:

```bash
pnpm install
```

Start the web client, API, realm server and LiveKit together. The first run creates `.env` from `.env.example`.

```bash
pnpm dev
```

Then open http://localhost:5173 and sign in. Without Clerk keys (the default), the development sign-in asks for any name and an adult birth date. New accounts start in the avatar creator. To try calling, sign in as a second person in a private window (or at http://gran.localhost:5173, which keeps a separate sign-in). Add each other by friend code (top right), then click **Start and ring**. The other window rings; answer it, check your mic and camera, and join. In the gathering, **Invite → Copy guest link** gives a link for someone without an account.

To fill your gathering with walking bots, start one in the app and run this. With no link, the bots join the most recently started live gathering:

```bash
pnpm bots 10
```

Add a number of seconds to keep them longer (`pnpm bots 24 300`), or a copied guest link to pick a specific gathering.

**Real accounts (Clerk).** To sign in with email or Google instead of the development sign-in:

1. Create an application at [dashboard.clerk.com](https://dashboard.clerk.com) with **Email** and **Google** turned on.
2. Copy its keys into `.env`: the publishable key into `VITE_CLERK_PUBLISHABLE_KEY` and the secret key into `CLERK_SECRET_KEY`.
3. Restart `pnpm dev`.

The first time someone signs in, the app asks for their name and date of birth. Under-13 sign-ups are refused, and their Clerk account is deleted. Clerk only accepts sign-ins from `WEB_ORIGIN` (http://localhost:5173 by default), so use that address, not `127.0.0.1` or a `*.localhost` name. The development sign-in keeps working for `pnpm smoke` and `pnpm bots` as long as `NODE_ENV` isn't `production`.

| Control              | Desktop                                             | Phone / tablet                |
| -------------------- | --------------------------------------------------- | ----------------------------- |
| Move                 | WASD or arrow keys                                  | Left-thumb joystick           |
| Run                  | Hold Shift                                          | Push the joystick all the way |
| Look                 | Drag with the mouse, or Q / E                       | Drag on the right side        |
| Jump                 | Space                                               | Jump button                   |
| Zoom                 | Scroll wheel                                        | —                             |
| First / third person | V                                                   | —                             |
| Gamepad              | Left stick move, right stick look, A jump, Y camera | —                             |

URL options: `?debug` for FPS and network stats (including which transport poses arrive on), `?quality=low|high` to override the automatic device profile. Use headphones when two windows on one computer both have their mics on, or you'll hear echo.

| Service | URL                   | Notes                                                                                                        |
| ------- | --------------------- | ------------------------------------------------------------------------------------------------------------ |
| Web     | http://localhost:5173 | Proxies `/api` to the API                                                                                    |
| API     | http://127.0.0.1:3001 | Auth, `/contacts`, `/contact-groups`, `/rooms`, `/sessions`, `/guest/:token`, `/events` (server-sent events) |
| Realm   | ws://localhost:2567   | Colyseus `session` room; mints LiveKit tokens and enforces host controls                                     |
| LiveKit | ws://localhost:7880   | `livekit-server --dev` (key `devkey`, secret `secret`)                                                       |

**Share with friends while you build.** With `pnpm dev` running, run this in a second terminal:

```bash
pnpm share
```

It prints a free, temporary `https://….trycloudflare.com` link (a Cloudflare quick tunnel: no account and no domain; one-time setup: `brew install cloudflared`). Anyone with the link reaches your dev server: they see your changes the moment you save, and can join your gatherings.

- **You:** keep using http://localhost:5173. Copied guest links point at the public link automatically, and home shows a "Sharing live" banner.
- **Visitors:** join with a guest link (no account needed). With Clerk keys set, they can also make real accounts at the link. The name-only development sign-in never works through the link, so nobody can sign in as you.
- **Voice and video for visitors:** put LiveKit Cloud keys (free tier) in `.env` as `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET`, then restart `pnpm dev`. Your local LiveKit server can't be reached from outside your network.
- **Limits:** the link changes every time you start sharing, and only works while your computer and `pnpm dev` are running. For an always-on address, see [ADR 0016](docs/adr/0016-prototype-by-sharing-the-dev-server.md).

With the servers running, check everything end to end:

```bash
pnpm smoke
```

Other commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format`, `pnpm build`, and `pnpm db:generate` after changing `apps/api/src/db/schema.ts`.

**Full local infrastructure** (Postgres, Redis, LiveKit, S3 storage) needs Docker:

```bash
pnpm infra:up
```

Then set `DATABASE_URL=postgres://vcr:vcr@localhost:5432/vcr` in `.env` to use real Postgres. The compose file also runs LiveKit, in place of the Homebrew one. Room capture (Phase 4) needs storage and, optionally, a KIRI Engine API key.

## Platform support targets

| Platform                                            | MVP                                         | Later                                |
| --------------------------------------------------- | ------------------------------------------- | ------------------------------------ |
| Desktop Chrome / Edge / Firefox / Safari (latest 2) | ✅ Full                                     | —                                    |
| Mobile Safari (iOS 17+), Android Chrome             | ✅ Join, talk, move (fewer splats rendered) | Room capture recorded in the browser |
| Meta Quest Browser / other WebXR headsets           | —                                           | ✅ Immersive VR                      |

## Privacy & safety principles

- **Room scans show people's homes.** A room can only be entered during a live session hosted by its owner (or a co-host they picked). Asset links expire when the session ends. Scans are stored encrypted and can be deleted at any time; deleting a scan also deletes the source video, both from our storage and from the scanning provider's.
- **Background listening respects consent.** People in a private side conversation can't be heard or seen by anyone outside it. That's enforced by the media server, not by client volume.
- **Built for families.** Accounts are 13+ only at launch. Younger family members can join as guests on a parent's device, and nothing about them is stored. Host controls cover mute, camera off, remove and lock. Sessions are invite-only.

## Documentation

- [PLAN.md](PLAN.md): architecture, subsystem designs, phased roadmap, risks, product decisions
