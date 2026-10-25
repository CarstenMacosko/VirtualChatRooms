# ADR 0019: Owners set up rooms in an editor; walkways cut the collision on the client

- **Status:** Accepted
- **Date:** 2026-10-23
- **Amends:** [ADR 0002](0002-separate-collision-mesh-per-room.md)
- **Plan reference:** [PLAN.md § 4.1](../../PLAN.md#41-room-capture-pipeline)

## Context

The collision boxes come from an occupancy grid over the scan (ADR 0002). Scan clutter (a chair half-captured in a doorway, noise blobs) blocks places people should walk, and nothing in the scan says where people can sit or where a game can be played. Manifest v3 has `walkways`, `seats` and `tables` for this, saved with `PUT /rooms/:id/setup`; owners need a way to fill them in.

## Decision

- **An editor in the web app.** A ready scan room's "Set up" opens a full-screen editor: the room as it renders in a gathering (mesh or splats), an orbit camera and a top view, and tools for walkways (drag a rectangle on the floor), seats (tap a cushion; or drag along a couch for one seat every 60 cm), and tables (tap a tabletop). Things are edited with handles in the room and fields in a side panel; suggested (`source: "auto"`) seats and tables are drawn dashed with Keep/Remove, and editing one makes it the owner's. Saving replaces the room's setup.
- **Picking hits the collision boxes**, loaded into an invisible mesh, so it works for splat and mesh rooms alike. Mesh rooms are also hit-tested against the visible mesh when a tap places something (about 15 ms for a 220k-triangle scan on a laptop, so no BVH); drags use the boxes only. Splat rooms hide splats near the ceiling so the room can be seen from above.
- **Walkways are applied on the client** when colliders are built. A walkway removes collision above 5 cm inside its rectangle. Post-processing writes the collision mesh as world-axis-aligned boxes (8 vertices and 36 indices each), so the client reads the boxes back, subtracts each walkway's prism (a box becomes at most the part below the cut plus four pieces around the rectangle) and adds box colliders. A collision mesh that isn't boxes keeps its triangles, minus those whose centroid is inside a walkway.
- **Walkways are cut out wider than drawn, and what they cut through moves to their edge.** The cut is widened by the character's radius, so you pass however tight the gap. Where that cut goes all the way through a box reaching past a side of the drawn walkway (the walls are only two grid cells thick), the box is put back as a 2 cm wall along the cut's edge on that side. You can't step off a walkway through a wall. Overlapping walkways open each other's edge walls, so the walls surround the whole shape. A walkway drawn across a wall still opens a doorway; you can walk through it, but not off the walkway sideways inside the wall.
- The editor draws the collision boxes as faint lines, clipped live, exactly as people will meet them, so the owner sees what a walkway opened.

## Consequences

- The collision file stays exactly what post-processing made; changing walkways doesn't reprocess the scan, and older clients just ignore them.
- Setup changes reach people when they join or rejoin a gathering, not live.
- The trimesh fallback is coarse (whole triangles), which is fine for today's box meshes and good enough until a provider ships a real mesh.
- If the owner later changes the room's scale or up axis, walkways, seats and tables stay where they were in world space and may need setting up again.
