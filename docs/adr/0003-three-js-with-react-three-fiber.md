# ADR 0003: Three.js with React Three Fiber

- **Status:** Accepted
- **Date:** 2026-10-21
- **Plan reference:** D3 in [PLAN.md § 2](../../PLAN.md#2-key-technical-decisions)

## Decision

The client renders with Three.js through React Three Fiber.

## Why

Largest web 3D ecosystem; Spark, three-vrm and @react-three/xr (WebXR) all build on it.

## Alternatives considered

Babylon.js (viable, smaller React/VRM ecosystem); Unity WebGL (heavy, poor mobile web).
