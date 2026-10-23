# ADR 0018: Rooms can be textured meshes as well as splats

- **Status:** Accepted
- **Date:** 2026-10-23
- **Amends:** [ADR 0001](0001-gaussian-splatting-for-rooms.md)
- **Plan reference:** [PLAN.md § 4.1](../../PLAN.md#41-room-capture-pipeline)

## Context

ADR 0001 chose Gaussian splats because photogrammetry meshes tend to look worse indoors. The first real room scan said otherwise. It was a Scaniverse mesh scan, and the textured mesh looked far better on the phone than anything we could draw from its exports. The only splat-like export of a mesh scan is a point cloud: one color every 2.5 cm, a small fraction of the detail in the mesh's photo textures. Turning those points into splats (surfels.ts) fills the gaps, but it can't bring back detail the export dropped.

## Decision

A room is either splats or a textured mesh. People can upload a `.glb` scan, alongside `.ply` and `.spz`:

- **Manifest v3** sets exactly one of `splat` and `mesh` (a GLB in file space, like the splat). v1 and v2 manifests are migrated on parse, and every v2 room is splats.
- **Post-processing** reads the GLB's triangles (all node transforms applied) and samples points evenly over their area. Floor, walls, scale and spawn points then come from the same analysis splats use. The collision mesh is still the coarse one from that analysis (ADR 0002).
- **The client** draws the GLB as uploaded, with unlit materials and no tone mapping: the photos already hold the room's light, so it looks the way it did on the phone.

## Consequences

- Mesh scans keep their full texture detail. Splat captures stay the photoreal option, with view-dependent highlights and reflections.
- Clients built for v2 show "newer than this client supports" for every newly processed room, so the API and web app ship together.
- Compressed GLBs (Draco, meshopt) are refused with a clear message until a room needs them.
- Textured GLBs can be tens of MB. Phones may need a smaller-texture version later (the mesh equivalent of splat LODs).
