# ADR 0013: The realm admits people and mints their media tokens

- **Status:** Accepted
- **Date:** 2026-10-22
- **Plan reference:** [PLAN.md § 4.4](../../PLAN.md#44-calling--sessions)

## Decision

The API decides who may enter a session and with what role, and hands out a short-lived **realm ticket** (a JWT with audience `vcr-realm`, about 10 minutes). The realm server verifies the ticket, applies its own live rules (lock, removals, co-hosts), and only then mints the person's **LiveKit token**, using their realm connection id as their LiveKit identity. Host controls (mute, camera off, remove) are enforced by the realm through LiveKit's server API. When a session ends, the realm tells the API through an internal endpoint authenticated by a realm-signed JWT.

## Why

- **One gate.** If the API minted LiveKit tokens directly, a removed or locked-out person could still hold a valid media token. With the realm minting them, being in the media room implies being admitted to the realm room right now.
- **One identity.** Using the realm connection id as the LiveKit identity means poses, tracks, speaking state and the roster all share a key, with no mapping table.
- **Short tickets, cheap rejoin.** Clients fetch a fresh ticket before every (re)join, so tickets can expire quickly and a ticket can never double as a session token (session tokens carry no audience; the API rejects any token that has one).

## Alternatives considered

- API mints LiveKit tokens (the Phase 0 `/media/token` route, now removed): simpler, but media access then outlives removal and lock.
- Realm queries the API on every join instead of tickets: adds a network hop and couples realm availability to the API.
