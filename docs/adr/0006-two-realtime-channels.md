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
