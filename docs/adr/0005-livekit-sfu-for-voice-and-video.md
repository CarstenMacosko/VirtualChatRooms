# ADR 0005: LiveKit SFU for voice and video

- **Status:** Accepted
- **Date:** 2026-10-21
- **Plan reference:** D5 in [PLAN.md § 2](../../PLAN.md#2-key-technical-decisions)

## Decision

Voice and sidebar video go through LiveKit.

## Why

Open source and self-hostable, scales to large rooms, server-side subscription control, E2EE, low-latency data channels.

## Alternatives considered

mediasoup (more DIY); P2P mesh (fails beyond ~6 people); Agora/Twilio (closed, costly).
