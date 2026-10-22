# ADR 0010: Use an existing room-scanning service

- **Status:** Accepted
- **Date:** 2026-10-21
- **Plan reference:** D10 in [PLAN.md § 2](../../PLAN.md#2-key-technical-decisions)

## Decision

Room reconstruction uses the KIRI Engine 3DGS API, plus import of Scaniverse/Polycam/KIRI exports, behind a `CaptureProvider` interface.

## Why

Removes all GPU/ML work from the MVP; KIRI returns both splat and mesh.

## Alternatives considered

Self-hosted gsplat pipeline (Plan B); World Labs Marble (generative); Apple RoomPlan (LiDAR-only, not photoreal).
