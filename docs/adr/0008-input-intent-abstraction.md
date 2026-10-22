# ADR 0008: Input → intent abstraction

- **Status:** Accepted
- **Date:** 2026-10-21
- **Plan reference:** D8 in [PLAN.md § 2](../../PLAN.md#2-key-technical-decisions)

## Decision

All input devices produce the same intents (move, look, sit, interact…).

## Why

Keyboard, touch, gamepad and VR controllers share one locomotion path, so VR needs no rewrite.

## Alternatives considered

Device-specific controllers.
