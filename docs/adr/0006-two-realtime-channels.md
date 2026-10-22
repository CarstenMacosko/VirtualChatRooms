# ADR 0006: Two realtime channels

- **Status:** Accepted
- **Date:** 2026-10-21
- **Plan reference:** D6 in [PLAN.md § 2](../../PLAN.md#2-key-technical-decisions)

## Decision

High-rate avatar pose goes over the LiveKit lossy data channel; authoritative state goes through Colyseus.

## Why

Pose data is frequent and loss-tolerant; groups, seats, permissions and games must be reliable and authoritative.

## Alternatives considered

One channel for everything (either floods the game server or puts game state on a lossy path).

## Note (2026-10-21)

Phase 1 relays poses through the realm server (`RealmMessage.pose`, binary, with a sender-id envelope) because LiveKit isn't in the local stack yet. The `PoseHub` abstraction keeps the switch to LiveKit's lossy data channel in Phase 2 local to the transport.

## Note (2026-10-22)

Phase 2 moved poses onto LiveKit's lossy data channel (topic `pose`). The realm relay stays as a fallback: a client also sends through it while it isn't on LiveKit itself, or while anyone else in the session isn't (each participant reports this as `onMedia` in realm state). Receivers accept both paths; pose sequence numbers drop the duplicates.
