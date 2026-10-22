# ADR 0011: Video sidebar on LiveKit simulcast + adaptive stream

- **Status:** Accepted
- **Date:** 2026-10-21
- **Plan reference:** D11 in [PLAN.md § 2](../../PLAN.md#2-key-technical-decisions)

## Decision

Webcam tiles use simulcast publishing and adaptive-stream subscription.

## Why

Same SFU and permission rules as voice; viewers only download visible tiles at tile size.

## Alternatives considered

A separate video provider.
