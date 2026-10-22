# ADR 0007: Client-side spatial audio, server-enforced privacy

- **Status:** Accepted
- **Date:** 2026-10-21
- **Plan reference:** D7 in [PLAN.md § 2](../../PLAN.md#2-key-technical-decisions)

## Decision

Each listener mixes voices in a Web Audio graph; privacy is enforced by LiveKit subscription permissions.

## Why

Per-listener panning and a tunable background bus need client mixing; a modified client must not be able to eavesdrop.

## Alternatives considered

Server-side mixing (loses per-listener spatialization, costs more).
