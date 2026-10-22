# ADR 0014: Avatars are recipes, generated on every client

- **Status:** Accepted
- **Date:** 2026-10-22
- **Plan reference:** D4 and [PLAN.md § 4.2](../../PLAN.md#42-avatar-system)

## Decision

An avatar is stored and sent as a small recipe (`AvatarRecipe` in `@vcr/protocol`, about 400 bytes of JSON). `@vcr/avatar` turns a recipe into a VRM 1.0 file in the browser (MToon materials, a VRM humanoid skeleton, face morph targets bound to VRM expression presets), and three-vrm loads it like any other VRM. The geometry is original and procedural, so there are no third-party base meshes or outfits to license.

## Why

- **Small and live.** Recipes fit in a realm ticket and in room state, so everyone gets everyone's avatar at join time, and edits apply mid-gathering. There's no per-avatar download.
- **VRM stays the contract.** Runtime code only sees VRM, so a commissioned base model, a photo-to-avatar vendor or the planned `AvatarProvider` can replace the generator without touching animation, expressions, VR IK or the network.
- **Regenerable.** A better generator re-renders every existing avatar from its recipe; `GENERATOR_VERSION` keys caches.

## Costs

- Each client builds each distinct avatar once (about 20 ms) instead of downloading it.
- The look is limited to what procedural geometry does well. Commissioned art can still be added as recipe options (new hair or outfit meshes) when it exists.

## Alternatives considered

- Baking each avatar to a `.vrm` in object storage and sharing URLs: still planned as a cache once storage exists (Phase 4), but not required for the avatar to work.
- A vendor avatar SDK: rejected in D4 (lock-in, vendors shutting down).
