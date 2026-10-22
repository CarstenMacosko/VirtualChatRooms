# ADR 0009: Versioned room manifest

- **Status:** Accepted
- **Date:** 2026-10-21
- **Plan reference:** D9 in [PLAN.md § 2](../../PLAN.md#2-key-technical-decisions)

## Decision

A versioned JSON manifest ties together a room's splat, collision mesh, floor, scale, spawn points, seats and zones. See `packages/protocol/src/manifest.ts`.

## Why

New features add fields without breaking older rooms or clients.

## Alternatives considered

Loose asset files with metadata in code.
