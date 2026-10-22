import { describe, expect, it } from "vitest";
import { type AvatarPose, decodePose, LocoState } from "@vcr/protocol";
import { RemotePoseBuffer } from "../src/net/PoseBuffer";
import { PoseSender } from "../src/net/PoseSender";

const pose = (seq: number, t: number, x: number, extra: Partial<AvatarPose> = {}): AvatarPose => ({
  seq,
  t,
  position: [x, 0, 0],
  yaw: 0,
  loco: LocoState.walk,
  ...extra,
});

/** Simulates a sender whose clock is 5000 ms behind ours and a 40 ms network delay. */
const feed = (buf: RemotePoseBuffer, poses: AvatarPose[]) =>
  poses.forEach((p) => buf.push(p, p.t + 5000 + 40));

describe("RemotePoseBuffer", () => {
  it("returns nothing before the first packet", () => {
    expect(new RemotePoseBuffer().sample(0)).toBeNull();
  });

  it("interpolates between snapshots ~100 ms in the past", () => {
    const buf = new RemotePoseBuffer({ delayMs: 100 });
    feed(buf, [pose(0, 0, 0), pose(1, 100, 1), pose(2, 200, 2)]);
    // Our clock for sender t=150 is 5190; rendering 100 ms behind means sampling at now=5290.
    const s = buf.sample(5290)!;
    expect(s.position[0]).toBeCloseTo(1.5, 5);
    expect(s.speed).toBeCloseTo(10, 5); // 1 m per 100 ms
    expect(s.stale).toBe(false);
  });

  it("extrapolates briefly when packets stop, then holds", () => {
    const buf = new RemotePoseBuffer({ delayMs: 100, maxExtrapolateMs: 250 });
    feed(buf, [pose(0, 0, 0), pose(1, 100, 1)]);
    // Offset is 5040 and the delay 100 ms, so now = 5340 renders sender time 200: 100 ms past the last.
    expect(buf.sample(5340)!.position[0]).toBeCloseTo(2, 5);
    expect(buf.sample(5340 + 10_000)!.position[0]).toBeCloseTo(3.5, 5); // capped at 250 ms
  });

  it("snaps instead of sliding across a teleport", () => {
    const buf = new RemotePoseBuffer({ delayMs: 100, snapDistance: 4 });
    feed(buf, [pose(0, 0, 0), pose(1, 100, 50)]);
    expect(buf.sample(5240 + 50)!.position[0]).toBe(50);
  });

  it("ignores duplicate and out-of-order packets", () => {
    const buf = new RemotePoseBuffer({ delayMs: 100 });
    feed(buf, [pose(5, 0, 0), pose(6, 100, 1), pose(6, 100, 99), pose(4, 50, 99)]);
    expect(buf.sample(5190)!.position[0]).toBeCloseTo(0.5, 5); // sender time 50
  });

  it("takes the shortest way around when interpolating yaw", () => {
    const buf = new RemotePoseBuffer({ delayMs: 100 });
    feed(buf, [pose(0, 0, 0, { yaw: 3.0 }), pose(1, 100, 0, { yaw: -3.0 })]);
    const yaw = buf.sample(5190)!.yaw; // halfway
    expect(Math.abs(Math.abs(yaw) - Math.PI)).toBeLessThan(0.05);
  });

  it("keeps a stable timeline when one packet arrives late", () => {
    const buf = new RemotePoseBuffer({ delayMs: 100 });
    buf.push(pose(0, 0, 0), 5040);
    buf.push(pose(1, 100, 1), 5140);
    buf.push(pose(2, 200, 2), 5540); // 400 ms late
    buf.push(pose(3, 300, 3), 5340);
    expect(buf.sample(5290)!.position[0]).toBeCloseTo(1.5, 1);
  });

  it("marks the avatar stale after a long silence", () => {
    const buf = new RemotePoseBuffer({ staleAfterMs: 5000 });
    feed(buf, [pose(0, 0, 0)]);
    expect(buf.sample(5040 + 6000)!.stale).toBe(true);
  });
});

describe("PoseSender", () => {
  it("sends at 15 Hz while moving and 2 Hz while idle", () => {
    const sent: AvatarPose[] = [];
    const sender = new PoseSender((b) => sent.push(decodePose(b)));
    const walking = {
      position: [0, 0, 0] as [number, number, number],
      yaw: 0,
      loco: LocoState.walk,
    };
    for (let t = 0; t <= 1000; t += 16) {
      sender.update(t, { ...walking, position: [t / 1000, 0, 0] });
    }
    expect(sent.length).toBeGreaterThanOrEqual(14);
    expect(sent.length).toBeLessThanOrEqual(16);

    sent.length = 0;
    const idle = { position: [1, 0, 0] as [number, number, number], yaw: 0, loco: LocoState.idle };
    for (let t = 2000; t <= 3000; t += 16) sender.update(t, idle);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.length).toBeLessThanOrEqual(3);
  });

  it("sends immediately when the locomotion state changes", () => {
    const sent: AvatarPose[] = [];
    const sender = new PoseSender((b) => sent.push(decodePose(b)));
    const base = { position: [0, 0, 0] as [number, number, number], yaw: 0 };
    sender.update(0, { ...base, loco: LocoState.walk });
    sender.update(10, { ...base, loco: LocoState.jump });
    expect(sent.map((p) => p.loco)).toEqual([LocoState.walk, LocoState.jump]);
    expect(sent.map((p) => p.seq)).toEqual([0, 1]);
  });
});

describe("PoseHub", () => {
  it("routes relayed packets per sender and forgets people who left", async () => {
    const { PoseHub } = await import("../src/net/PoseHub");
    const { encodePose, encodeRelayedPose } = await import("@vcr/protocol");
    const hub = new PoseHub();
    const packet = (from: string, x: number) => encodeRelayedPose(from, encodePose(pose(1, 0, x)));
    hub.ingest(packet("alice", 1), 1000);
    hub.ingest(packet("bob", 2), 1000);
    hub.ingest(new Uint8Array([3, 1]), 1000); // garbage
    expect(hub.sample("alice", 1000)!.position[0]).toBe(1);
    expect(hub.sample("bob", 1000)!.position[0]).toBe(2);
    expect(hub.dropped).toBe(1);
    hub.retain(new Set(["alice"]));
    expect(hub.sample("bob", 1000)).toBeNull();
  });

  it("accepts the same pose from LiveKit and the realm relay once", async () => {
    const { PoseHub } = await import("../src/net/PoseHub");
    const { encodePose, encodeRelayedPose } = await import("@vcr/protocol");
    const hub = new PoseHub();
    hub.ingestPose("alice", encodePose(pose(1, 0, 1)), 1000);
    // Same sequence number via the fallback path: a duplicate, so its contents are ignored.
    hub.ingest(encodeRelayedPose("alice", encodePose(pose(1, 0, 99))), 1010);
    hub.ingestPose("alice", new Uint8Array([9]), 1010); // garbage
    expect(hub.dropped).toBe(1);
    expect(hub.sample("alice", 1010)!.position[0]).toBe(1);
  });
});
