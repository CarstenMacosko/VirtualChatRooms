import { describe, expect, it } from "vitest";
import { clusterPeople, joinSpot } from "../src/media/clusters";

const at = (id: string, x: number, z = 0) => ({ id, x, z });

describe("clusterPeople", () => {
  it("keeps a small call as one conversation however spread out", () => {
    const groups = clusterPeople([at("a", 0), at("b", 10), at("c", 20)]).labels;
    expect(new Set(groups.values())).toEqual(new Set(["a"]));
  });

  it("splits people standing apart into groups, labelled by their smallest id", () => {
    const groups = clusterPeople([at("a", 0), at("b", 1), at("c", 10), at("d", 11)]).labels;
    expect(Object.fromEntries(groups)).toEqual({ a: "a", b: "a", c: "c", d: "c" });
  });

  it("chains neighbours into one circle", () => {
    const groups = clusterPeople([at("a", 0), at("b", 2), at("c", 4), at("d", 6)]).labels;
    expect(new Set(groups.values()).size).toBe(1);
  });

  it("someone standing alone is a group of one", () => {
    const groups = clusterPeople([at("a", 0), at("b", 1), at("c", 2), at("d", 20)]).labels;
    expect(groups.get("d")).toBe("d");
    expect(groups.get("c")).toBe("a");
  });

  it("doesn't split a group when someone takes a step back", () => {
    const people = [at("a", 0), at("b", 1), at("c", 10), at("d", 11)];
    const before = clusterPeople(people);
    const stepped = [at("a", 0), at("b", 3), at("c", 10), at("d", 11)];
    expect(clusterPeople(stepped, before).labels.get("b")).toBe("a");
    expect(clusterPeople(stepped).labels.get("b")).toBe("b");
  });

  it("splits once they really walk away", () => {
    const before = clusterPeople([at("a", 0), at("b", 1), at("c", 10), at("d", 11)]);
    const after = clusterPeople([at("a", 0), at("b", 4), at("c", 10), at("d", 11)], before);
    expect(after.labels.get("b")).toBe("b");
  });

  it("lets someone leave a big circle they were only part of through others", () => {
    // a-b-c-d in a line, 2 m apart: one group, though a and d are 6 m apart.
    const line = clusterPeople([at("a", 0), at("b", 2), at("c", 4), at("d", 6)]);
    expect(new Set(line.labels.values()).size).toBe(1);
    // d steps 3.2 m from c: past the leave distance from their only neighbour.
    const after = clusterPeople([at("a", 0), at("b", 2), at("c", 4), at("d", 7.2)], line);
    expect(after.labels.get("d")).toBe("d");
    // c steps back 2.8 m from b: still held by that direct link.
    const held = clusterPeople([at("a", 0), at("b", 2), at("c", 4.8), at("d", 20)], line);
    expect(held.labels.get("c")).toBe("a");
  });
});

describe("joinSpot", () => {
  const bounds = { min: [-4, 0, -3], max: [4, 3, 3] };

  it("stands at the edge of the group, away from everyone else", () => {
    const spot = joinSpot([at("c", 0), at("d", 1)], [at("a", -3), at("b", -3, 1)], bounds)!;
    expect(spot.x).toBeGreaterThan(1.4);
    expect(Math.hypot(spot.x - 0.5, spot.z)).toBeLessThan(2.5);
  });

  it("stays inside the room when the group is against a wall", () => {
    const spot = joinSpot([at("c", -3.5)], [at("a", 2)], bounds)!;
    expect(spot.x).toBeGreaterThanOrEqual(-3.6);
    expect(Math.hypot(spot.x + 3.5, spot.z)).toBeLessThan(2.5);
  });
});
