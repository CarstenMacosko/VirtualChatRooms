# ADR 0020: Sitting: detected seats, realm claims, scripted sit and stand

- **Status:** Accepted
- **Date:** 2026-10-23
- **Plan reference:** [PLAN.md § 4.3](../../PLAN.md#43-movement), [§ 5](../../PLAN.md#5-future-proofing-seams-built-into-the-mvp)

## Context

The plan kept room for sitting from the start: the manifest has `seats`, the pose has an optional `seatId` and sit/stand loco states, and the intents include `interact`. Rooms had no seats yet, though. Nobody marks seats by hand, so a scanned room needs suggestions. Two people must not sit on the same cushion. And a seated avatar has to look right to everyone else, even though poses arrive late and jittery over a lossy channel.

## Decision

- **Detection suggests seats and tables** (`apps/api/src/capture/furniture.ts`). Post-processing builds a height map from the room's points and finds flat patches at seat height (0.3 to 0.6 m) and table height. A patch is a seat when it has a backrest on one side and open floor in front. Long patches become several sofa seats, one per 0.6 m. A table needs floor visible under most of its top, no wall or backrest along it, and an open side. Detection is conservative and capped (24 seats, 6 tables). Everything it finds has `source: "auto"`, so the room-setup editor can show it as a suggestion and the host can delete or move it.
- **The realm owns seat claims.** `SessionState.seats` maps seat id to session id. A `sit` message is checked with zod and answered with `SitResult`: ok, or refused when someone else is there. Each person holds one seat at most. Claims are released on `stand`, when the person leaves, and all at once when the host changes the room.
- **Sitting is scripted, not simulated.** Pressing E (or tapping Sit) asks the realm first and sits only once the claim succeeds. The character controller then turns its capsule off and runs `approach → lower → seated`, gliding to the seat and turning to face its way. Moving, jumping or pressing E again stands you up: you rise to the first open spot in front of the seat where the capsule fits, or go back where you came from.
- **Others are drawn on the seat from their own layout.** The pose carries `seatId` and `loco: seated`. Each client places a seated person at its own copy of the seat, not at the pose's position, so jitter never slides anyone off the cushion. The procedural animator lowers the hips to the seat height and bends the knees. Floor seats (under 0.25 m) sit cross-legged. While you're seated, the camera drops and moves closer.

## Consequences

- Sitting works in any room with seats, including the sample room and scans uploaded before this change once they are processed again. Without a realm (offline), you can still sit; nobody else sees the claim.
- Detection misses things. On the user's living room scan it finds 5 seats (three on the L-shaped sectional, two armchairs), the coffee table and the dining table. It misses the sectional's corner seat and the dining chairs, whose seats are too small and too cluttered in the scan. The editor is where people fix this.
- E now means "interact" whenever a seat is offered. It turns right only when nothing is offered.
- Seat claims are not kept anywhere. If the realm restarts, the client claims your seat again while it's free and stands you up if someone else took it.
