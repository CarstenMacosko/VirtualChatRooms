# ADR 0002: Separate collision mesh per room

- **Status:** Accepted
- **Date:** 2026-10-21
- **Plan reference:** D2 in [PLAN.md § 2](../../PLAN.md#2-key-technical-decisions)

## Decision

Every room ships a coarse collision mesh (~20–50k triangles) next to its splat.

## Why

Splats have no surfaces, so physics and navigation need a mesh.

## Alternatives considered

Raycasting splats directly is slow and unreliable.
