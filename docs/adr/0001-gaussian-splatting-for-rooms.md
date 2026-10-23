# ADR 0001: Gaussian splatting for rooms

- **Status:** Accepted; amended by [ADR 0018](0018-textured-mesh-rooms.md) (rooms can also be textured meshes)
- **Date:** 2026-10-21
- **Plan reference:** D1 in [PLAN.md § 2](../../PLAN.md#2-key-technical-decisions)

## Decision

Rooms are rendered as 3D Gaussian splats.

## Why

Photoreal results from casual phone video, real-time in the browser, mature tooling (Spark, `.spz`).

## Alternatives considered

Photogrammetry meshes look worse indoors; NeRFs render too slowly.
