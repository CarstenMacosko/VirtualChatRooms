# ADR 0012: Session-scoped signed asset URLs

- **Status:** Accepted
- **Date:** 2026-10-21
- **Plan reference:** D12 in [PLAN.md § 2](../../PLAN.md#2-key-technical-decisions)

## Decision

Room assets are only reachable through short-lived signed URLs issued to participants of a live session.

## Why

Rooms are only open during the owner's (or a co-host's) session, so access must expire with it.

## Alternatives considered

Public CDN URLs.
