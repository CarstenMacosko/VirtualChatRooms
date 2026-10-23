# VirtualChatRooms: Build Plan

**Vision:** a metaverse built only for hanging out with friends and family. It has the avatars, shared spaces and presence of a Horizon-style metaverse, but it's focused on calls and time together rather than public worlds, commerce or strangers.

This document covers how to build the MVP and how to structure it so the planned post-MVP features (side conversations, mini-games, VR, sitting) can be added without a rewrite. The guiding rule is **buy or reuse before building**. Every major subsystem is built on an existing service or library, and only the glue and the social experience are custom.

**Contents**

1. [Goals & non-goals](#1-goals--non-goals)
2. [Key technical decisions](#2-key-technical-decisions)
3. [System architecture](#3-system-architecture)
4. [Subsystem designs](#4-subsystem-designs)
5. [Future-proofing: seams built into the MVP](#5-future-proofing-seams-built-into-the-mvp)
6. [Phased roadmap](#6-phased-roadmap)
7. [Quality: testing & performance budgets](#7-quality-testing--performance-budgets)
8. [Deployment & operations](#8-deployment--operations)
9. [Risks & mitigations](#9-risks--mitigations)
10. [Product decisions](#10-product-decisions)
11. [Post-MVP roadmap](#11-post-mvp-roadmap)

---

## 1. Goals & non-goals

### MVP goals

1. **Room from video.** A user records or uploads a video of a room and gets back a walkable, photoreal 3D space.
2. **Personal 3D avatar.** A user creates a stylized, expressive avatar in the spirit of Snapchat Bitmoji / Meta avatars that resembles them, and moves it around the space.
3. **Group calls.** A user rings any or all of their contacts, or shares a guest link. The MVP target is **25 concurrent people per session**, with an architectural path to 100+.
4. **Video sidebar.** A FaceTime-style strip of live webcam tiles beside the 3D view, for anyone who turns their camera on. Video never appears inside the 3D scene.
5. **Extensible foundation.** The client engine, network protocol, audio graph and data model all include the extension points listed in § 5.

Product decisions behind these goals are recorded in § 10.

### MVP success criteria

| Metric                               | Target                                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| Video upload → room ready            | ≤ 15 min (p50), ≤ 30 min (p95)                                     |
| Click invite link → standing in room | ≤ 20 s on broadband                                                |
| Voice mouth-to-ear latency           | ≤ 250 ms (p95)                                                     |
| Frame rate, mid-range laptop         | ≥ 60 fps with 25 avatars                                           |
| Frame rate, recent phone             | ≥ 30 fps with 25 avatars                                           |
| Remote avatar motion                 | No visible teleporting/jitter at 150 ms RTT and 2% packet loss     |
| Video sidebar                        | 25 people with cameras on, laptop stays ≥ 60 fps and ≤ 4 Mbps down |

### Non-goals for MVP

- VR headsets (designed for, not shipped)
- Mini-games, side conversations, sitting (designed for, not shipped)
- Photoreal "digital twin" avatars (MVP avatars are stylized-but-recognizable)
- Webcam video inside the 3D scene (video lives only in the sidebar)
- Phone-optimized UI (phones can join, talk and move, but the design targets desktop)
- Accounts for users under 13
- Native mobile apps

---

## 2. Key technical decisions

Each decision gets a short ADR in `docs/adr/` during Phase 0.

| #   | Decision                                                                                                                                                                                                                                   | Why                                                                                                                                                                                                  | Alternatives considered                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **3D Gaussian Splatting** for rooms                                                                                                                                                                                                        | Photoreal results from casual phone video, renders in real time in the browser, and the tooling is mature (gsplat, Spark, `.spz` compression).                                                       | Photogrammetry meshes (look worse indoors, blotchy textures). NeRF (too slow to render).                                                                                                                                                                                            |
| D2  | **Separate collision mesh** alongside each splat                                                                                                                                                                                           | Splats have no surfaces, so physics and navigation need a mesh. A coarse mesh (~20–50k tris) is enough.                                                                                              | Raycasting splats directly (slow and unreliable).                                                                                                                                                                                                                                   |
| D3  | **Three.js + React Three Fiber**                                                                                                                                                                                                           | Biggest web 3D ecosystem. Spark renders splats on top of it, `three-vrm` handles avatars, and `@react-three/xr` gives WebXR almost for free.                                                         | Babylon.js (also strong, with native splats; a reasonable choice, but a smaller React and VRM ecosystem). Unity WebGL (heavy builds, poor mobile web).                                                                                                                              |
| D4  | **VRM 1.0** avatar format                                                                                                                                                                                                                  | Open standard with a fixed humanoid skeleton and standard expression set. Avoids lock-in to an avatar vendor (several have shut down or changed terms). Works with IK for VR.                        | Vendor avatar SDKs (lock-in risk). Custom rigs.                                                                                                                                                                                                                                     |
| D5  | **LiveKit SFU** for voice                                                                                                                                                                                                                  | Open source, self-hostable, scales to large rooms, supports selective subscription and server-side subscription control (needed for private groups), offers E2EE, and has low-latency data channels. | mediasoup (more DIY). P2P mesh (falls over beyond ~6 people). Agora/Twilio (closed, costly).                                                                                                                                                                                        |
| D6  | **Two realtime channels**: LiveKit data for high-rate avatar pose, Colyseus for authoritative state                                                                                                                                        | Pose data is high-frequency and loss-tolerant, so it fits a lossy SFU channel. Groups, seats, permissions and game state must be authoritative and reliable, so they need a game server.             | All state over one channel (either pose floods the game server, or game state goes over a lossy channel).                                                                                                                                                                           |
| D7  | **Spatial audio on the client** via a per-person Web Audio graph, with **privacy enforced on the server** through LiveKit subscriptions                                                                                                    | Client-side mixing gives per-listener panning and the tunable background volume. Server enforcement means a modified client can't eavesdrop.                                                         | Server-side mixing (loses per-listener spatialization, costs more).                                                                                                                                                                                                                 |
| D8  | **Input → Intent abstraction**                                                                                                                                                                                                             | Keyboard, touch, gamepad and VR controllers all produce the same intents (`move`, `look`, `sit`, `interact`, …), so locomotion code doesn't change when VR arrives.                                  | Device-specific controllers (rewrite for VR).                                                                                                                                                                                                                                       |
| D9  | **Versioned room manifest**                                                                                                                                                                                                                | A JSON manifest ties together the splat, collision mesh, floor, scale, spawn points, seats and zones. New features add fields without breaking older rooms.                                          | Loose asset files with metadata baked into code.                                                                                                                                                                                                                                    |
| D10 | **Use an existing scanning service, don't build one.** The KIRI Engine 3DGS API is the primary path. Users can also upload splat files from free scanning apps (Scaniverse, Polycam, KIRI). Both sit behind a `CaptureProvider` interface. | KIRI's API takes a room video (≤ 1080p, ≤ 3 min), returns a Gaussian splat (PLY) and can also return a mesh (GLB), which gives us the collision mesh too. This removes all GPU/ML work from the MVP. | Building our own pipeline with gsplat/nerfstudio on serverless GPUs (kept as Plan B behind the same interface). World Labs Marble (generative, so it may invent details; better for imagined rooms later). Apple RoomPlan (iOS LiDAR only, outputs boxes and walls, not photoreal). |
| D11 | **Video sidebar on LiveKit simulcast + adaptive stream**                                                                                                                                                                                   | Same SFU and the same subscription rules as voice. Each viewer receives only the tiles visible to them, at tile resolution, so 25 cameras don't overwhelm anyone's connection.                       | A separate video provider (two media stacks, two permission systems).                                                                                                                                                                                                               |
| D12 | **Room assets served only through short-lived signed URLs**                                                                                                                                                                                | Rooms are only open during the owner's (or a co-host's) live session, so asset access must expire with the session rather than live at a permanent public URL.                                       | Public CDN URLs (anyone with the link could download a scan of someone's home).                                                                                                                                                                                                     |

---

## 3. System architecture

### 3.1 Components

| Component            | Responsibility                                                                                                                                                   | Tech                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `apps/web`           | UI shell, 3D scene, input, audio graph, video sidebar, avatar creator, capture upload                                                                            | React, Vite, R3F, Spark, three-vrm, Rapier, Zustand, LiveKit client SDK |
| `apps/api`           | Auth/session validation, age gate, users, contacts, invites, rooms, avatars, capture jobs, LiveKit token minting, signed asset URLs, push notifications          | Fastify, Drizzle, Postgres, Redis                                       |
| `apps/realm`         | One Colyseus room per live session: presence, roster, host controls, conversation groups*, seat claims*, game instances*                                         | Colyseus (Node)                                                         |
| LiveKit              | Voice tracks, lossy data channel for avatar pose, subscription enforcement                                                                                       | LiveKit Cloud → self-host                                               |
| `services/capture`   | Sends videos to the capture provider, imports user-uploaded splats, post-processes (compress, LOD, floor/scale, crop, spawn), writes manifest. CPU only, no GPU. | Python, FFmpeg, Open3D, spz tools; KIRI Engine API                      |
| Object storage + CDN | Room assets, avatar `.vrm` files, thumbnails, source videos (short retention)                                                                                    | R2/S3 + CDN                                                             |

\* Schema and handlers are stubbed in the MVP and implemented later.

### 3.2 Data model (Postgres)

```
User            id, displayName, authProviderId, avatarId?, ageConfirmed13PlusAt, createdAt
Contact         userId, contactUserId, label ("Mom", "College friends"), status (pending|accepted|blocked)
ContactGroup    id, ownerId, name                 -- "Family", for "call everyone in Family"
ContactGroupMember  groupId, userId
Avatar          id, ownerId, vrmUrl, thumbnailUrl, recipe(JSON), version
Room            id, ownerId, name, manifestKey?, status, createdAt
                -- no standing access list: a room is reachable only through a live Session (§ 4.4)
CaptureJob      id, roomId, source (video|splat_upload), provider (kiri|byo|self_hosted), providerTaskId?,
                sourceKey, status (queued|uploading|reconstructing|postprocessing|ready|failed),
                progress, error?, providerCost?, startedAt, finishedAt
Session         id, roomId, hostId, coHostIds[], status (ringing|live|ended), livekitRoomName, realmRoomId,
                startedAt, endedAt
SessionInvite   sessionId, inviteeUserId?, guestToken?, status (ringing|accepted|declined|missed)
Participant     sessionId, userId?/guestName, joinedAt, leftAt
-- future, created now so manifests and FKs exist early:
Seat            id, roomId, position, yaw, height, kind (chair|sofa|bench|floor), source (auto|user)
Zone            id, roomId, kind (conversation|game|quiet), shape(JSON)
GameDefinition  id, version, minPlayers, maxPlayers, bundleUrl
```

**As built in Phase 2:**

- `users.friendCode` is added.
- Guest links are their own `guest_links` table (token, session, expiry), not columns on invites.
- Co-hosts live in the realm room rather than the database, because they only matter while the session is live.
- The session id doubles as the LiveKit room name.
- `Participant` history isn't recorded yet.

`Avatar.recipe` stores the creator's parameters (morph weights, colors, hair/outfit choices), so avatars can be regenerated when the base model improves.

### 3.3 Room manifest (versioned contract)

```jsonc
{
  "manifestVersion": 1,
  "roomId": "rm_123",
  "splat": {
    "key": "rooms/rm_123/room.spz",
    "count": 1450000,
    "lods": [{ "key": "rooms/rm_123/room_lod1.spz", "count": 400000 }],
  },
  "collision": { "key": "rooms/rm_123/collision.glb", "triangles": 38000 },
  "navmesh": null, // added in a later version
  "transform": { "metersPerUnit": 1.0, "up": [0, 1, 0], "floorY": 0.0 },
  "bounds": { "min": [-4, 0, -5], "max": [4, 2.7, 5] },
  "spawnPoints": [{ "position": [0, 0, 1.5], "yaw": 3.14 }],
  "seats": [], // filled by seat detection later
  "zones": [], // conversation/game areas later
  "lighting": { "ambientColor": "#ffffff", "intensity": 1.0 }, // for lighting avatars to match the room
}
```

Clients ignore fields they don't know about, and `manifestVersion` controls migrations. The manifest stores storage keys, not URLs. When someone joins a session, the API turns each key into a signed URL that expires when the session ends.

**As built in Phase 4 (manifest v2):**

- The splat and the collision mesh stay in the coordinates of the uploaded file.
- `transform` gains an explicit file-to-world `rotation` (quaternion) and `translation`: world = translation + metersPerUnit · rotation(file). It also records where the scale came from (`scaleSource`). Bounds, spawn points, seats and zones are in world space (meters, +Y up, floor at 0).
- `splat.format` (`ply`/`spz`) and `collision.format` (`glb`) are new.
- Version 1 manifests are migrated on parse.
- Rescaling a room rewrites only the manifest, never the collision mesh.

### 3.4 Realtime protocol (`packages/protocol`)

**Pose stream** goes over the LiveKit lossy data channel at 15 Hz while moving and 2 Hz while idle, about 40 bytes per packet, binary-packed:

```ts
type AvatarPose = {
  seq: uint16;
  t: uint32; // sender clock, ms
  pos: [int16, int16, int16]; // cm, room-relative
  yaw: int16; // quantized
  loco: uint8; // idle | walk | run | jump | fall | sit | stand-up | ...
  seatId?: uint16; // future: sitting
  head?: QuatQ; // look direction now; VR head later
  handL?: PoseQ;
  handR?: PoseQ; // future: VR controllers/hand tracking
  face?: Uint8Array; // optional: 52 ARKit blendshapes, 0–255, sent at 15 Hz if webcam on
};
```

Optional fields are signaled with a presence bitmask, so a VR client simply sends more fields. Older clients ignore the extras.

**Authoritative state** lives in a Colyseus schema with delta sync and reliable delivery:

```ts
SessionState {
  participants: Map<id, { name, avatarUrl, role: owner|cohost|member|guest, muted, cameraOn,
                          groupId?, seatId? }>
  groups:  Map<id, { members[], privacy: open|private }>     // future
  seats:   Map<seatId, occupantId?>                            // future
  games:   Map<id, GameInstanceState>                          // future
  settings: { locked, allowGuests }
}
Messages: join, leave, hostMute, hostRemove, hostDisableCamera, lock, promoteCoHost, emote,
          groupCreate/Join/Leave (future), seatClaim/Release (future), game:* (future)
```

### 3.5 Client engine layers (`packages/engine`)

```
┌────────────────────────────────────────────────────────────┐
│ UI (React DOM): lobby, contacts, call controls, settings,  │
│   video sidebar                                            │
├────────────────────────────────────────────────────────────┤
│ Scene (R3F)                                                │
│   RoomRenderer (Spark splat + hidden collision mesh)       │
│   AvatarRenderer (VRM, animation mixer, expressions, IK)   │
│   GameLayer (plugin mount point; empty in MVP)             │
├────────────────────────────────────────────────────────────┤
│ Simulation                                                 │
│   InputSystem → Intents → LocomotionSystem (Rapier KCC)    │
│   RemoteAvatarSystem (snapshot interpolation buffer)       │
│   InteractionSystem (seats, objects; stub in MVP)          │
├────────────────────────────────────────────────────────────┤
│ Services                                                   │
│   NetClient (LiveKit data + Colyseus)  AudioGraph          │
│   AssetLoader (cache, LOD choice)      DeviceProfile       │
└────────────────────────────────────────────────────────────┘
```

- Use `renderer.setAnimationLoop`, not `requestAnimationFrame`, so WebXR can take over the loop later.
- Physics runs at a fixed 60 Hz. Rendering interpolates between physics steps.
- `DeviceProfile` measures GPU capability at startup and picks a splat LOD, shadow quality and maximum number of fully animated avatars.

---

## 4. Subsystem designs

### 4.1 Room capture pipeline

**Client side (capture UX)**

- The guided recorder (`MediaRecorder` in the browser, or a file upload) shows on-screen guidance: move slowly, keep lights on, sweep the room at two heights, 30–90 seconds, avoid filming mirrors head-on.
- Before uploading, a client-side check samples frames to catch videos that are too dark, too blurry or too short.
- Uploads go straight to object storage through a pre-signed URL and are resumable (tus or multipart).

**Two ways in, both through a `CaptureProvider` interface**

```ts
interface CaptureProvider {
  submit(job: {
    sourceKey: string;
    kind: "video" | "splat_upload";
  }): Promise<{ providerTaskId: string }>;
  status(
    providerTaskId: string,
  ): Promise<{ state: "running" | "done" | "failed"; progress?: number }>;
  fetchResult(providerTaskId: string): Promise<{ splatPly: Buffer; mesh?: Buffer /* GLB */ }>;
}
// Implementations: KiriProvider (MVP), ByoSplatProvider (MVP), SelfHostedGsplatProvider (Plan B)
```

1. **Record a video in our app (default).** The worker sends it to the **KIRI Engine 3DGS API** (`POST /api/v1/open/3dgs/video`). Settings: `isMesh=1`, `fileFormat=glb`, and `isMask=0`, because masking is for single objects, not rooms. Completion arrives through KIRI's webhooks, with polling as a fallback. Constraints: ≤ 1920×1080 and ≤ 3 minutes, so the client downscales before upload.
2. **Upload a scan you already made.** Accept `.ply` / `.spz` files exported from free apps like **Scaniverse** (on-device, free), **Polycam** or the **KIRI app**. Nothing to train. If no mesh is included, generate an approximate collision mesh from the splat positions (see stage 3).

**Worker stages (CPU only).** Each stage reports progress to `CaptureJob`, and the UI shows the progress live over a WebSocket or SSE.

| Stage                  | What happens                                                                                                                                                         | Tools           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1. Prepare             | Video: downscale to ≤ 1080p, trim to ≤ 3 min, submit to KIRI. Upload: validate file and splat count.                                                                 | FFmpeg          |
| 2. Reconstruct         | **Done by the provider.** KIRI returns splat PLY + GLB mesh. Uploads skip this.                                                                                      | KIRI Engine API |
| 3. Collision mesh      | Use the provider's mesh, decimated to ~40k tris. If there isn't one: splat centers → point cloud → outlier removal → Poisson reconstruction → decimate.              | Open3D          |
| 4. Orientation & scale | Fit the floor plane (RANSAC) to set "up" and `floorY`. Estimate scale from ceiling height and door heights (assume ~2.4–2.7 m ceilings), then confirm with the user. | Open3D          |
| 5. Cleanup             | Auto-crop floaters outside the room bounds                                                                                                                           | custom          |
| 6. Package             | Convert to `.spz`, build a mobile LOD (~400k splats), thumbnail, spawn point (largest open floor area), write manifest                                               | spz tools       |

**Before committing to KIRI** (first week of Phase 4), run the same ~20 test room videos through KIRI, Polycam (manually) and Scaniverse (manually), and check:

- Quality: does it look good indoors, and is the mesh usable for collision?
- Turnaround time
- Price per scan (not published in their docs; get a quote)
- Data retention and deletion terms, and whether KIRI will sign a data processing agreement. These are videos of people's homes.

If KIRI fails on quality, price or privacy, switch the default provider. The interface keeps that a contained change.

**After processing**, a short room setup screen in the editor lets the user:

- Confirm the floor and scale ("does this doorway look about 2 m tall?") with a slider
- Adjust the crop box
- Drag the spawn point
- (Later) confirm or add auto-detected seats

**While waiting**, users can start a session in a built-in sample room. When their room is ready they get a notification, and the host can switch the session's room.

**Cost control:** per-user quota on captures, provider cost recorded on each job, uploaded splats encouraged as the free path, and source videos deleted from our storage and the provider's after 7 days, unless the user opts to keep them.

### 4.2 Avatar system

**Style direction**

Aim for the feel of Snapchat Bitmoji and Meta's avatars:

- Full-body, slightly exaggerated proportions (larger head and eyes, simplified hands)
- Clean toon-ish shading
- Bright, saturated colors
- Big readable expressions
- Lots of personality through hair, outfits and accessories

Everything stays recognizably _you_ but friendly, with no uncanny valley. All base meshes, outfits and art must be **original or properly licensed**. Match the feel, never copy Snap's or Meta's assets, characters or trademarks. A short art-direction brief with references and a style frame is a Phase 0 deliverable, so the artist and the 3D engineer agree on the look before any assets are built.

Rendering notes for this style:

- Avatars use a toon/MToon material (VRM's standard toon shader), lit by the room's `lighting` values from the manifest, so they sit naturally inside photoreal splat rooms.
- A soft rim light and contact shadow keep avatars from looking pasted onto the scene.
- Expressions are tuned to be big and readable at a distance.
- An emote set (wave, laugh, heart, thumbs-up, dance) ships in the MVP, because expressive avatars are the core of this style.

**Creation (MVP)**

1. Start from a **base VRM** model with a library of face/body morph targets plus swappable hair, outfits and accessories (commissioned or CC0 assets).
2. **Selfie assist:** run MediaPipe Face Landmarker in the browser, map landmark ratios to face morph weights, and sample skin, hair and eye colors. Nothing leaves the device for this step.
3. **Editor:** sliders and swatches to refine the result. Output: a `recipe` JSON plus a baked `.vrm` uploaded to storage.
4. An `AvatarProvider` interface lets a photo-to-avatar vendor or a future in-house realistic generator be swapped in, as long as it outputs VRM.

**Runtime**

- **Animation:** a shared retargetable clip library (idle, walk, run, turn, jump, wave, sit-down/sit-idle/stand-up). A blend-tree state machine is driven by speed and `loco`.
- **Face:** if the webcam is on, Face Landmarker produces 52 blendshapes, which map to VRM expressions and stream in `AvatarPose.face`. If the webcam is off, audio-driven visemes plus procedural blinks and head micro-motion keep the avatar looking alive.
- **Look-at:** heads turn toward whoever is talking nearby.
- **LOD:** avatars beyond 15 m, or past the device's limit, drop to a lower-poly model with a reduced animation rate.

### 4.3 Movement

- **Character controller:** Rapier kinematic character controller (capsule) against the room collision mesh. Handles slopes, steps up to ~25 cm, and sliding along walls.
- **Controls:**
  - Desktop: WASD + mouse look (pointer lock) or click-to-move
  - Mobile: virtual joystick + drag-look
  - Gamepad supported
- **Cameras:** third-person orbit with collision-aware spring arm (so it doesn't clip into walls), and first-person.
- **Remote avatars:** keep a snapshot buffer ~100 ms behind real time and interpolate between snapshots. Briefly extrapolate (≤ 250 ms) if packets stop arriving. Turn speed is smoothed, and foot-planting IK prevents sliding feet.
- **Fluid movement prep:** locomotion is a state machine (`grounded`, `airborne`, `seated`, `transitioning`), so sitting and VR teleport become additional states rather than special cases.

### 4.4 Calling & sessions

**Flow**

1. Host picks a room and invites individuals, a contact group ("Family"), or everyone.
2. The API creates a `Session` and `SessionInvite`s and sends rings:
   - **in-app**, over a presence WebSocket with a ringing UI
   - **Web Push**, when the app is closed
   - **shareable guest link** for anyone without an account
3. Invitee accepts → API issues a short-lived realm ticket carrying their role. The realm server admits them (checking lock and removals) and mints their LiveKit token, scoped to that session's media room ([ADR 0013](docs/adr/0013-realm-mints-media-tokens.md)).
4. Join screen: mic check with level meter, echo-cancellation tips (headphones recommended), avatar preview.
5. Spawn at the room's spawn point. Late joiners can join any time while the session is live.

**Host controls:** mute someone, turn off someone's camera, remove someone, lock the session, promote a co-host, transfer host.

**Room access rule (decided).** A room is open only while its owner, or someone the owner made co-host, is in a live session there. Enforcement:

- Only the room owner can start a session in that room.
- Invitees get signed asset URLs scoped to that session. Those URLs expire when the session ends.
- If the owner and all co-hosts leave, everyone else gets a 2-minute "host left" grace period, then the session ends.
- There are no drop-in visits when the owner is away. Owner-granted drop-in access could be added later as a per-room permission.

**Age rule (decided).** Account sign-up is 13+ only, using a date-of-birth age gate. The record keeps only the confirmation (`ageConfirmed13PlusAt`), never the date of birth.

Younger family members can join a guest link on a parent's device. The guest flow:

- asks only for a display name
- stores nothing after the session
- runs face tracking on the device only

This guest flow needs a legal review before launch to confirm it's acceptable under COPPA/GDPR-K.

**Scaling plan**

- Audio only: 25 Opus streams cost ~0.8 Mbps down, which is fine on any device.
- **Interest management:** each client subscribes only to the audio of the N closest or loudest people within hearing range (default 20, within 20 m). The rest are unsubscribed, which saves bandwidth and decoding and is already the mechanism side conversations will use.
- For 100+ participants: the same interest management applies to pose data (split the data channel by region of the room), and LiveKit Cloud or a multi-node self-hosted cluster takes over.

### 4.5 Spatial audio graph (built to support side conversations)

```
remote track ─▶ <audio muted> (Chrome quirk: required for WebRTC → WebAudio)
             └▶ MediaStreamSource ─▶ personGain ─▶ PannerNode(HRTF, inverse distance)
                                                        │
                    ┌───────────────────────────────────┴───────────┐
                    ▼                                               ▼
             conversationBus (gain 1.0)                   ambientBus (gain = user slider)
                    │                                    └─ lowpass filter (muffled "across the room")
                    └──────────────────────┬────────────────────────┘
                                           ▼
                                   masterGain ─▶ compressor ─▶ destination
```

- **MVP:** every voice is routed to `conversationBus`, and the panner handles distance falloff (ref 1 m, rolloff tuned so people are effectively silent at ~15 m).
- **Side conversations (later):** the realm server tracks group membership. Members of your group route to `conversationBus`. Everyone else routes to `ambientBus`, whose volume is the **"background voices" slider** (0–100%), with optional low-pass for a muffled effect. Switching buses crossfades over 300 ms.
- **Privacy:** when a group is `private`, the realm server tells LiveKit (server API `UpdateSubscriptions` / track permissions) to block non-members from subscribing to members' tracks. Outsiders get no audio at all, not just audio at zero volume.
- **Per-person volume:** right-click (or long-press) an avatar to set that person's gain, for example to boost a quiet grandparent.

### 4.6 Video sidebar (FaceTime-style)

**Layout**

- A collapsible vertical strip on the right edge of the screen: rounded video tiles with name labels, a speaking-glow border and mute icons.
- Your own self-view sits pinned at the top.
- Below that, ordering favors whoever is speaking, then people near you in the room, then everyone else.
- Clicking a tile pins it bigger. Double-clicking walks your avatar over to that person.
- People with their camera off show a live **avatar headshot** tile instead: a small render of their avatar's face with expressions. The sidebar always lists everyone in the session, not just people with video.

**Camera behavior**

- The camera is off by default. One button toggles "show my video."
- One `getUserMedia` track feeds both MediaPipe (avatar expressions) and LiveKit (sidebar video). Users can run face tracking without publishing video, but never publish video without seeing their self-view.

**Media**

- Publish with simulcast: 180p, 360p and 720p layers.
- Viewers use LiveKit **adaptive stream**, so a tile only receives video while visible, at the layer matching its size. Collapsing the sidebar stops all incoming video.
- At 25 cameras, visible tiles are capped (about 8 on screen, scroll for more) to keep bandwidth ≤ 4 Mbps down.

**Privacy**

- Video tracks follow the same server-enforced subscription rules as audio. When private side conversations arrive, outsiders won't get those members' video either.
- Host can turn off a participant's camera.

**Seam:** the tile component takes any `MediaStreamTrack`, so the same video tracks can later appear in-world (a floating panel, or a VR "window") without changes to the media layer.

---

## 5. Future-proofing: seams built into the MVP

| Future feature                              | What the MVP builds now                                                                                                                                                          | What gets added later                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Side conversations + tunable background** | Audio graph with two buses; server-side subscription control (covers audio and video tracks); `groupId` in participant state; `zones` in manifest                                | Group UI (walk into a circle or invite into a group), group handlers in realm, background-volume slider, conversation zones in room editor                                  |
| **Mini-games**                              | `packages/games-sdk` interface; `GameLayer` mount point in scene; `games` map in realm state; `GameDefinition` table                                                             | Individual games, lobby UI, game zones                                                                                                                                      |
| **VR (WebXR)**                              | R3F + `setAnimationLoop`; intent-based input; VRM humanoid rig; optional `head`/`hand` fields in pose protocol; metric-scale rooms (VR needs correct scale); performance budgets | `@react-three/xr` session entry, controller/hand mappings to intents, VR IK (head + hands → full body), comfort options (snap turn, vignette, teleport), Quest-specific LOD |
| **Sitting**                                 | `seated` locomotion state; sit/stand clips in the animation library; `Seat` table + `seats` in manifest + `seatId` in pose and realm state                                       | Seat detection in capture pipeline (detect chairs/sofas → seat anchors), seat claiming, sit IK aligned to the seat                                                          |
| **Fluid movement**                          | Fixed-step physics, snapshot interpolation, locomotion state machine, foot IK                                                                                                    | Motion matching or richer blend trees, emotes, gestures, hand-holding                                                                                                       |
| **Realistic avatars**                       | `AvatarProvider` interface; VRM as the canonical output; `recipe` versioning                                                                                                     | Photo-to-Gaussian-head avatars or a vendor integration                                                                                                                      |
| **In-world video / VR video**               | Video tile component takes any `MediaStreamTrack`; simulcast layers already published                                                                                            | Floating video panels in the scene; video windows in VR                                                                                                                     |
| **Drop-in room access**                     | Signed-URL asset access tied to sessions; `coHostIds`                                                                                                                            | Per-room drop-in permission list chosen by the owner                                                                                                                        |
| **Accounts for under-13s**                  | Age confirmation on `User`; guest flow stores nothing                                                                                                                            | Parent-managed child accounts with verifiable parental consent                                                                                                              |

**Games SDK contract (defined in Phase 0, implemented post-MVP):**

```ts
export interface GameModule<S, M> {
  id: string;
  version: string;
  name: string;
  players: { min: number; max: number };
  server: {
    createState(ctx: GameContext): S;
    onJoin(state: S, player: PlayerRef): void;
    onLeave(state: S, player: PlayerRef): void;
    onMessage(state: S, player: PlayerRef, msg: M): void;
    tick?(state: S, dtMs: number): void; // optional fixed-rate loop
  };
  client: {
    Scene: React.FC<GameSceneProps<S>>; // 3D, mounted in GameLayer
    Hud?: React.FC<GameHudProps<S>>; // 2D overlay
    intents?: IntentBinding[]; // extra inputs while playing
  };
}
```

---

## 6. Phased roadmap

**Team assumption:** about 3 engineers: one 3D/graphics, one realtime/full-stack, one backend/infra, plus a part-time 3D character artist for the Bitmoji/Meta-style base avatar, outfits and emotes. No ML specialist is needed, because room reconstruction is bought (D10). Timelines are rough estimates. **MVP: about 20–24 weeks.** The video sidebar adds about 2 weeks, and using an existing scanning service saves about 4 weeks.

### Phase 0: Foundations (weeks 1–2)

**Status (2026-10-21):** scaffolded and passing CI checks locally.

**Update (2026-10-22):** real accounts use Clerk with email and Google sign-in ([ADR 0015](docs/adr/0015-clerk-accounts-exchanged-for-our-session.md)). The development sign-in remains when no Clerk keys are set, and is always off in production. The avatar art brief became the procedural style in Phase 3.

- Monorepo (pnpm, Turborepo), TypeScript configs, lint/format, CI (typecheck, test, build)
- `infra/docker-compose.yml`: Postgres, Redis, LiveKit (dev mode), SeaweedFS (S3; MinIO no longer ships images)
- Auth provider integration with 13+ age gate; `User`, `Contact` tables; Drizzle migrations
- `packages/protocol` skeleton with Zod schemas and binary pose codec plus tests
- ADRs for D1–D12; games SDK interface stub
- Avatar art-direction brief (references, style frame, proportions, shading) signed off
- **Exit:** `pnpm dev` runs everything; a signed-in user sees an empty lobby.

### Phase 1: Shared space, single player → multiplayer (weeks 3–6)

**Status (2026-10-21):** built and verified locally: 11 people (1 browser + 10 bots) moving in the sample room with zero dropped packets; 121 fps on a laptop with the full-density room and one avatar. Frame rate with 10+ avatars, and on phones, is still to be measured. Two deliberate interim choices:

- **Pose stream goes through the realm server for now** (binary relay with the sender's id), behind a `PoseHub` interface. LiveKit isn't part of the local stack until voice arrives, so Phase 2 moves poses onto LiveKit's lossy data channel as ADR 0006 specifies. Nothing outside `PoseHub`/the realm hook changes. _(Done in Phase 2.)_
- **The sample room is procedural** (built from shapes in `packages/engine/src/room/sampleRoom.ts`) rather than a downloaded scan, so every client generates identical splats, collision matches exactly, and there's no third-party asset license. Scanned rooms load through `SplatMesh({ url })` in Phase 4.
- **The avatar is a generated CC0 VRM 1.0 mannequin** with procedural animation (`ProceduralAnimator`); Phase 3 swaps in real avatars and a clip library without touching the rest of the engine.

- R3F scene with Spark rendering one **sample splat room** plus a hand-made collision mesh
- Input → Intent system; Rapier character controller; third/first-person cameras
- Placeholder VRM avatar with idle/walk/run blend tree
- Realm server: join/leave, roster. Pose stream over LiveKit data; snapshot interpolation.
- `DeviceProfile` + splat LOD selection; mobile touch controls
- **Exit:** 10 browser tabs/bots walk around the same room smoothly; 60 fps desktop / 30 fps phone.

### Phase 2: Voice, video sidebar & calling (weeks 7–12)

**Status (2026-10-22):** built and verified locally, except with real cameras and microphones (the test browser blocks them). What works end to end:

- **Contacts:** friend codes, requests, labels, groups, live presence.
- **Calling:** start a gathering by everyone, groups or people. Contacts ring in-app over `GET /events` (server-sent events) with a chime, plus a browser notification if the tab is in the background. Answering, declining, a 45 s miss timeout, and the host seeing each answer all work. Missed calls can still join from "Live now".
- **Guest links:** for people without accounts. Only a display name is asked for and nothing is stored.
- **Realm:** tickets with roles, co-hosts, lock, remove (no rejoin), mute and camera-off (enforced through LiveKit's server API), end for everyone, and the host-left grace period (2 min, or 5 min for the owner's first arrival), which reports back to the API.
- **Media:** LiveKit voice and video run through a spatial audio graph (HRTF panner per person following their avatar, per-person volume). Audio subscriptions go to the nearest 20 people within 20 m. Poses go over the LiveKit data channel, with the realm relay as fallback (ADR 0006 note). Speaking indicators work.
- **Video sidebar:** you first, then pinned, then recent speakers, then nearest. Camera-off people show a live headshot of their avatar (Phase 3). Pinning shows the person large over the room (720p capture for it). Double-clicking walks your avatar over to them. The sidebar collapses, and only the first 8 tiles carry video.
- **Web Push:** people without the app open get calls as system notifications. These are withdrawn when the call is answered elsewhere, declined, missed, or the gathering ends. `pnpm dev` generates the VAPID keys into `.env`.
- **Host controls:** besides the above, the owner can hand the host role to someone else.
- **Verification:** `pnpm smoke` (24 checks) covers the whole flow. In the browser, host and invitee were checked with LiveKit connected and poses arriving only over LiveKit, plus a guest and 5 guest-link bots in one room.

Not done yet, or not measured:

- **The background bus is built but unused:** every voice still goes to the conversation bus until side conversations route people to it.
- **Single API instance only:** live events and ring timers are in memory. Running several needs Redis pub/sub behind `LiveHub`.
- **Real devices:** voice, video and push haven't been tested with real cameras and microphones (the test browser blocks them).
- **Exit criteria not yet measured:** 25 cameras at ≤ 4 Mbps, ≥ 60 fps with 25 people, and invite-to-joined time with real devices.

Planned scope:

- LiveKit audio publish/subscribe; token minting in API
- Spatial audio graph (two buses, MVP routing); per-person volume; speaking indicators
- Interest-managed subscriptions (N nearest/loudest)
- Contacts, contact groups, invites, ringing (in-app + Web Push), guest links
- Session-scoped room access: owner-only session start, co-hosts, signed asset URLs, host-left grace period
- Join screen with mic/camera check; host controls (mute, camera off, remove, lock, co-host)
- Video sidebar (§ 4.6): simulcast publish, adaptive-stream tiles, speaker/proximity ordering, self-view, pin, avatar-headshot tiles for camera-off people
- **Exit:** 25-person session (mix of humans and bots) with clear spatial voice and 25 cameras on at ≤ 4 Mbps down and ≥ 60 fps; invite-to-joined in ≤ 20 s.

### Phase 3: Avatar creator (weeks 9–15, overlaps Phase 2)

**Status (2026-10-22):** built and verified in the browser, except live face tracking with a real webcam. What works:

- **Avatars are recipes** ([ADR 0014](docs/adr/0014-avatars-are-recipes.md)). `packages/avatar` turns a recipe of about 400 bytes into a VRM 1.0 file with MToon toon shading. The look is Bitmoji-spirited: big head and eyes, mitten hands, ink outlines. It has 10 hair styles, facial hair, 4 tops, 3 bottoms, glasses, hats, and face and body sliders. Everything is original procedural geometry, so there are no third-party assets.
- **Expressions:** blink (each eye), five visemes (aa, ih, ou, ee, oh), and happy, angry, sad, surprised and relaxed are face morph targets wired to VRM expression presets.
- **Creator:** `/avatar` and the guest join flow have a live orbitable preview, buttons to try expressions and emotes, "Surprise me", and swatches and sliders. New accounts land in the creator once. The API stores the recipe; guests keep theirs on their device.
- **Selfie assist:** on-device MediaPipe Face Landmarker. Face proportions, measured relative to face width, set the shape sliders. Sampled skin, hair and eye colors snap to the palettes. The photo is never uploaded or stored.
- **In the room:**
  - Recipes ride in realm tickets and room state, so everyone builds everyone's avatar locally. Live edits use `setAvatar`.
  - With face tracking on (it follows your camera, or toggles on its own without publishing video), the 52 ARKit blendshapes and head rotation stream in the pose packet.
  - Without tracking, mouths follow each person's voice level, and avatars blink on their own.
  - Emotes are body animations with matching faces.
  - Camera-off tiles show live headshots of the avatar.

Not done yet:

- **Look-at** (heads turning toward whoever is talking) and **avatar LOD**.
- **Baked VRM upload:** waits for Phase 4's object storage. Every client builds from the recipe meanwhile, about 20 ms per avatar.
- **Face tracking with a real webcam** is unverified: the model loads, but the test browser blocks cameras. Head rotation direction in particular needs a check.
- **Exit criteria** need people: "recognizable in under 3 minutes" and "testers rate it fun / like Bitmoji".

Planned scope:

- Stylized base VRM (per art brief) with morph library; hair/outfit/accessory sets; MToon shading tuned for splat rooms
- Selfie assist (on-device Face Landmarker → morphs + colors); editor UI; recipe save; VRM bake + upload
- Live expressions from webcam (`face` in pose stream); audio visemes fallback; look-at; emote set; avatar LOD
- **Exit:** a new user creates a recognizable avatar in under 3 minutes; expressions and emotes visible to others; testers rate the style "fun / like Bitmoji."

### Phase 4: Room capture integration (weeks 7–12, runs in parallel, backend/infra owner)

- Week 7: provider bake-off on 20 test videos (KIRI API vs. Polycam vs. Scaniverse exports); get KIRI pricing and data-processing terms; confirm the choice
- Weeks 8–9: `CaptureProvider` interface, `KiriProvider` (submit, webhook, fetch) and `ByoSplatProvider` (file upload); job queue; progress reporting; storage
- Weeks 10–11: CPU post-processing: collision mesh (provider mesh or fallback), floor/scale, crop, spawn, `.spz` + mobile LOD, manifest
- Week 12: guided recorder, pre-upload checks, resumable upload, room setup screen (floor/scale/crop/spawn), "import a scan" flow with how-to guides for Scaniverse and Polycam
- **Exit:** ≥ 80% of test videos produce a room rated "good enough to hang out in"; p50 ≤ 15 min.

**Status (2026-10-23): importing a scan works end to end.** It's verified in the browser with synthetic scans, but no real phone scan has been tried yet. What works:

- **Import:** on Home, **Your rooms → Add a room from a scan** takes a `.ply` (standard 3DGS, or SuperSplat's compressed PLY) or an `.spz` (versions 1–3), up to 500 MB. It comes with how-to notes for Scaniverse, Polycam and KIRI, a progress bar, and live status ("getting it ready… 60%", ready, or failed with a reason).
  - Uploads go in 16 MB parts straight to storage through signed URLs, three at a time, and a failed part is retried.
  - A sample room is kept as the default, and only ready rooms appear in the gathering's room picker.
  - Each person can have up to 10 scanned rooms.
- **Storage** (`apps/api/src/storage`): one `ObjectStorage` interface with two backends.
  - The local disk (`apps/api/.data/storage`), served by HMAC-signed API routes. Download links are tied to a session and stop working the moment it ends (ADR 0012).
  - S3-compatible stores (R2, SeaweedFS): `STORAGE_DRIVER=s3` with the `S3_*` settings. Their presigned links can't be revoked, so they last at most 1 hour, and every rejoin issues fresh ones.
- **Rooms API:**
  - `POST /rooms/scans` and `POST /rooms/:id/upload/complete` upload a scan. The file's name and size are checked up front, and its contents after upload.
  - `PATCH /rooms/:id` renames a room, fixes its height (scale) or says which way is up. A new up axis re-runs the processing.
  - `DELETE /rooms/:id` deletes the files too, and ends a live gathering in that room first.
  - Join responses (members and guests) carry the manifest plus signed URLs (`JoinSessionResponse.scene`), and `rooms-changed` live events keep Home current.
  - Jobs are rows in `capture_jobs`.
- **Post-processing:** TypeScript, CPU only, in-process (`apps/api/src/capture`), not the Python/Open3D worker § 3.1 plans. A 2.6M-splat, 177 MB scan takes about 1 s; the file is streamed and subsampled, never loaded whole.
  - **Up axis:** the biggest flat layer at the low end of an axis, favoring the shortest dimension, content sitting low, and Y.
  - **Tilt:** removed with a RANSAC floor-plane fit.
  - **Walls squared to the axes:** a yaw search.
  - **Scale:** taken as meters if the room is 1.9–4.5 units tall, otherwise from an assumed 2.5 m ceiling.
  - **Collision:** an occupancy grid (floor present, nothing at body height) gives the largest walkable area. Walls, furniture (to their measured height), unscanned space and raised floors around it become merged boxes, written as a GLB in file space.
  - **Spawn points:** up to four, where there's the most open floor.
- **Tests:**
  - Synthetic scans of the sample room stored Y-up, Y-down, Z-up and tilted 3°, in meters, at half scale and in centimeters, with and without a ceiling, with floaters. Each recovers the floor, the walls and the 8 × 6 m size.
  - A Rapier character can't run or jump out of an imported room.
  - API tests cover upload, permissions, tampered and expired links, session-scoped asset links, rescaling, re-orienting and deletion.
  - `pnpm smoke` imports a scan and hosts a gathering in it.
  - `pnpm make-test-scan` writes a synthetic scan.
- **In the browser:**
  - A synthetic PLY (upside down, half scale, turned 25°) and an SPZ both render upright at the right size.
  - Walking and jumping into every wall stops at the wall.
  - A guest joining by link sees the same room and the host's avatar, with voice on LiveKit Cloud.
- **Video capture:** the `CaptureProvider` interface exists, with `ByoSplatProvider` and a `KiriProvider` stub. The stub says "needs `KIRI_API_KEY`" and never calls out (`POST /rooms/videos` answers 503). Even with a key it declines until the bake-off confirms KIRI.

Not done yet:

- **Real scans:** a real Scaniverse, Polycam or KIRI export hasn't been tried. The thresholds were tuned on synthetic rooms, and real scans have sparse blank walls, mirrors and open doorways. The **Adjust** fallback (height slider, up axis) covers wrong guesses, but not a bad collision layout.
- **Packaging:**
  - No `.spz` conversion or mobile LOD: the file is served as uploaded, and `useMobileLod` is unused.
  - No floater cropping (floaters are only ignored for collision), no thumbnails, and no lighting estimate.
- **Room setup screen:** no 3D view for the floor, crop box or spawn point. A room can only be seen inside a gathering.
- **Storage and jobs:**
  - The S3 backend is untested against a live bucket (there's no Docker on the dev machine). It needs bucket CORS for PUT/GET and an exposed `ETag` header.
  - Upload parts can't be re-signed after their 6 h expiry.
  - Post-processing runs in the API process, one job at a time, and blocks the event loop for up to ~0.6 s on a big scan. It should move to a worker.
- **Not started:** the guided recorder, pre-upload checks, the KIRI integration and its bake-off, and switching a live session's room (Phase 5).

### Phase 5: Integration, hardening, beta (weeks 16–22)

- Switching a session's room; deletion flows (room, video, avatar, account)
- Load tests (§ 7); network resilience (reconnect, ICE restarts, poor-network mode that drops video before audio)
- Accessibility pass (captions are a stretch goal; keyboard-only nav; color contrast; reduced motion)
- Legal review of the age gate and the guest flow for kids; privacy policy; abuse reporting
- Observability (§ 8); cost dashboards (scan fees, egress, LiveKit minutes)
- Closed beta with ~10 real families → fix top issues
- **Exit:** MVP success criteria in § 1 met in beta.

```
Week:        1   3   5   7   9   11  13  15  17  19  21  23
Phase 0    ███
Phase 1        ████████
Phase 2                ████████████
Phase 3                    ██████████████
Phase 4                ████████████
Phase 5                                  ██████████████
```

---

## 7. Quality: testing & performance budgets

**Testing**

- **Unit (Vitest):** protocol codec round-trips, interpolation math, audio routing logic, intent mapping, game SDK contract
- **Integration:** API + realm + LiveKit in docker-compose; session lifecycle; subscription-permission enforcement (a non-member must not receive a private group's audio or video); room asset URLs stop working after the session ends; a non-owner can't start a session in someone else's room
- **E2E (Playwright):** Chromium launched with `--use-fake-device-for-media-stream` and `--use-fake-ui-for-media-stream`; two-browser call tests; invite flow
- **Load:** LiveKit `lk load-test` for media plus headless bot clients that walk random paths and send pose and fake audio, at 25 / 50 / 100 participants
- **Capture regression set:** fixed suite of ~30 videos, re-run monthly and on any provider change (visual rating, collision mesh sanity, scale error, turnaround time, cost per scan)
- **Device lab:** at least one low-end Android, one older iPhone, one integrated-GPU laptop, and a Quest (from the VR phase on)

**Performance budgets (mid-range laptop / phone)**

| Budget                                | Laptop  | Phone                             |
| ------------------------------------- | ------- | --------------------------------- |
| Splats rendered                       | ≤ 1.5M  | ≤ 400k                            |
| Fully animated avatars                | 25      | 12 (rest at low LOD)              |
| Draw calls                            | ≤ 300   | ≤ 150                             |
| JS main-thread per frame              | ≤ 6 ms  | ≤ 10 ms                           |
| Initial download before entering room | ≤ 40 MB | ≤ 20 MB (stream higher LOD after) |

---

## 8. Deployment & operations

| Piece               | Start with                                                                                        | Scale to                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Web client          | Static hosting on CDN (Cloudflare Pages / Vercel)                                                 | —                                                                                            |
| API + realm         | Containers on Fly.io/Render. Realm instances are sticky per session.                              | Kubernetes; Colyseus with Redis presence for multi-node                                      |
| Media               | LiveKit Cloud                                                                                     | Self-hosted LiveKit cluster when cost justifies it                                           |
| Room reconstruction | KIRI Engine API (managed). Post-processing worker runs as a CPU container next to the API.        | Self-hosted gsplat on serverless GPUs (Modal/RunPod) if volume makes per-scan fees expensive |
| Data                | Managed Postgres (Neon/Supabase/RDS), managed Redis                                               | Read replicas                                                                                |
| Storage             | Cloudflare R2 + CDN                                                                               | —                                                                                            |
| Observability       | OpenTelemetry traces, Sentry (client + server), LiveKit analytics, client-reported FPS/RTT/jitter | Grafana dashboards, SLO alerts                                                               |

Environments: `local` → `preview` (per pull request) → `staging` → `production`.

**While prototyping (2026-10-22):** `pnpm share` puts the running dev server on a temporary public link, so friends can try changes the moment they're saved and join calls ([ADR 0016](docs/adr/0016-prototype-by-sharing-the-dev-server.md)). The deployed setup above comes later, when there should be an always-on address.

---

## 9. Risks & mitigations

| Risk                                                           | Impact                                           | Mitigation                                                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bad capture videos (dark, fast, mirrors, blank walls)          | Ugly or broken rooms, users churn                | Guided recorder, pre-upload checks, clear "re-record" guidance, "import from Scaniverse/Polycam" as an alternative, sample rooms always available                                 |
| Capture vendor dependency (price change, shutdown, quality)    | Room creation stops working                      | `CaptureProvider` interface, BYO-splat path that needs no vendor, self-hosted gsplat as Plan B, monthly regression run                                                            |
| Sending home videos to a third party                           | Trust, legal                                     | Pick a vendor that will sign a data processing agreement and delete on request; disclose it in the privacy policy and at capture time; delete from the vendor after processing    |
| Wrong room scale (provider output scale is arbitrary)          | Avatars look like giants or ants; VR feels wrong | Floor plane + ceiling/door height heuristics + user scale confirmation. Use phone AR depth data if a native capture app is built later.                                           |
| Splat files too heavy for phones                               | Slow loads, crashes                              | `.spz` compression, mobile LOD, progressive loading, device profiling                                                                                                             |
| Echo/feedback with open speakers                               | Unusable calls                                   | Browser AEC/NS/AGC constraints, headphone nudges, push-to-talk option, auto-duck on detected echo                                                                                 |
| Per-scan provider cost                                         | Margin                                           | Per-user quotas, cost tracking per job, promote the free BYO-splat path, re-negotiate or self-host at volume                                                                      |
| Privacy of home scans                                          | Trust, legal                                     | Private by default, encryption at rest, short video retention, one-click deletion, no public rooms in MVP                                                                         |
| Children using the app                                         | Legal (COPPA/GDPR-K), safety                     | 13+ account age gate; under-13s only as guests on a parent's device, with nothing stored; invite-only sessions; no public discovery; legal review of the guest flow before launch |
| 25 webcams on one call                                         | Bandwidth and CPU spikes, choppy 3D view         | Simulcast + adaptive stream, cap on visible tiles, video off when sidebar collapsed, poor-network mode drops video before voice                                                   |
| Avatar style too close to Bitmoji/Meta                         | IP/trademark complaints                          | Original art made from an internal brief; review assets before launch                                                                                                             |
| Browser audio quirks (Safari autoplay, Chrome WebRTC→WebAudio) | Silent participants                              | "Tap to join audio" gesture gate, hidden muted `<audio>` sink, cross-browser E2E tests                                                                                            |
| Scope creep from future features                               | MVP slips                                        | Future features exist only as interfaces and schema fields until post-MVP                                                                                                         |

---

## 10. Product decisions

Decided on 2026-10-21:

| Question       | Decision                                                                                                                                                                | Where it shows up          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| Primary device | **Desktop-first.** Phones can join, talk and move with fewer splats rendered.                                                                                           | § 1 non-goals, § 7 budgets |
| Avatar look    | **Stylized, in the spirit of Snapchat Bitmoji / Meta avatars:** expressive, full-body, bright. Original art only. Realistic avatars possible later.                     | § 4.2, Phase 3             |
| Session size   | **Up to 25 people** at launch, with an architectural path to 100+.                                                                                                      | § 1, § 4.4                 |
| Video          | **Avatars in the 3D scene, plus a FaceTime-style video sidebar** for anyone who turns their camera on.                                                                  | § 4.6, D11, Phase 2        |
| Children       | **13+ accounts only at launch.** Younger kids can join as guests on a parent's device, with nothing stored. Needs legal review.                                         | § 4.4, Phase 0/5, § 9      |
| Hosting        | **Managed services** (LiveKit Cloud, KIRI Engine API, managed Postgres/Redis). Self-hosting is a later cost optimization.                                               | § 8                        |
| Room access    | **Only during the owner's (or a co-host's) live session.** No drop-in visits.                                                                                           | § 4.4, D12, data model     |
| Room capture   | **Use existing scanning software rather than building it:** KIRI Engine API for in-app video, plus import of Scaniverse/Polycam/KIRI scans. Building our own is Plan B. | D10, § 4.1, Phase 4        |

Still open, to settle before the phase that needs them:

- KIRI Engine pricing per scan, data retention and DPA. Not in their public docs; needed in Phase 4 week 1.
- Who makes the avatar art: an in-house artist, a contractor, or a licensed asset pack as the starting point? Needed by Phase 0's art brief.
- Default "host left" grace period: 2 minutes is a placeholder.

---

## 11. Post-MVP roadmap

Roughly in suggested order:

1. **Side conversations & background volume slider.** Highest social value; most groundwork already exists (§ 4.5).
2. **Sitting.** Seat detection in the capture pipeline, plus seat claiming and transitions.
3. **Mini-games v1.** Two or three simple games (trivia, charades with emotes, a tabletop card game), built on the SDK to prove it out.
4. **VR.** WebXR entry, controller/hand intents, VR IK, comfort settings, Quest performance tuning.
5. **Richer avatars.** Realistic head generation, more outfits, gestures, emotes.
6. **Room features.** Multi-room homes (stitch several captures), shared media screens, furniture-aware decoration, and imagined or fantasy rooms generated from a photo or prompt (for example with World Labs Marble, which exports `.spz` splats and meshes).
7. **Native capture helper app.** Uses ARKit/ARCore poses and depth for faster, better-scaled captures. Apple RoomPlan could supply wall and furniture layout for seat detection.
