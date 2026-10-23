import { useEffect, useRef, useState } from "react";
import {
  CLUSTER_DEFAULTS,
  type Clusters,
  clusterPeople,
  joinSpot,
  type Placed,
  type RoomLayout,
  type Vec3,
} from "@vcr/engine";
import type { RealmSession } from "../lib/realm";
import type { SpatialAudio } from "./SpatialAudio";

/**
 * Side conversations (PLAN.md § 4.5): people standing together form a group. You hear your group
 * normally and everyone else as background voices (never silent, so nobody is cut off), and you
 * can listen in on another group as if you were standing with them. The group sees you listening.
 */

export interface Group {
  /** Stays the same while its members do. */
  id: string;
  /** Realm session ids, you first if you're in it. */
  members: string[];
  mine: boolean;
  /** You're listening in on it. */
  listening: boolean;
  /** People from other groups listening in on it. */
  listeners: string[];
}

export interface Groups {
  /** False in small calls, where everyone is one conversation. */
  active: boolean;
  /** Yours first, then bigger groups first. */
  groups: Group[];
  /** Where to stand to join a group from the video grid (see `joinSpot`). */
  spotToJoin(groupId: string, bounds: RoomLayout["bounds"]): { position: Vec3; yaw: number } | null;
}

export const MIN_PEOPLE_FOR_GROUPS = CLUSTER_DEFAULTS.minPeople;

const BACKGROUND_KEY = "vcr.backgroundVoices";
/** Other groups never go fully quiet. */
export const BACKGROUND_MIN = 0.1;
const BACKGROUND_DEFAULT = 0.35;
const REFRESH_MS = 500;

export function rememberedBackgroundLevel() {
  try {
    const value = Number(localStorage.getItem(BACKGROUND_KEY));
    return value >= BACKGROUND_MIN && value <= 1 ? value : BACKGROUND_DEFAULT;
  } catch {
    return BACKGROUND_DEFAULT;
  }
}

export function rememberBackgroundLevel(value: number) {
  try {
    localStorage.setItem(BACKGROUND_KEY, String(value));
  } catch {
    // fine: not remembered
  }
}

export function useGroups(
  realm: RealmSession,
  audio: SpatialAudio,
  setFocus: (ids: ReadonlySet<string>) => void,
): Groups {
  // The latest positions and groups, for working out where to stand.
  const placed = useRef({
    where: new Map<string, Vec3>(),
    labels: new Map<string, string>(),
    selfId: "",
  });
  const [groups, setGroups] = useState<Groups>(() => ({
    active: false,
    groups: [],
    spotToJoin: (groupId, bounds) => {
      const { where, labels, selfId } = placed.current;
      const members: Placed[] = [];
      const others: Placed[] = [];
      for (const [id, label] of labels) {
        const feet = where.get(id);
        if (id === selfId || !feet) continue;
        (label === groupId ? members : others).push({ id, x: feet[0], z: feet[2] });
      }
      const spot = joinSpot(members, others, bounds);
      if (!spot) return null;
      const floor = where.get(members[0]!.id)![1];
      return { position: [spot.x, floor, spot.z], yaw: spot.yaw };
    },
  }));
  const latest = useRef({ realm, setFocus });
  useEffect(() => {
    latest.current = { realm, setFocus };
  });

  useEffect(() => {
    audio.setBackgroundLevel(rememberedBackgroundLevel());
    let previous: Clusters | null = null;
    let signature = "";
    let clearedListen = "";

    const tick = () => {
      const { realm: session, setFocus: focus } = latest.current;
      const { participants, selfId, poseHub } = session;
      if (!selfId) return;
      const now = performance.now();
      const self = poseHub.selfPose()?.position ?? null;
      const where = new Map<string, Vec3>();
      const people: Placed[] = participants.map((p) => {
        const at = p.id === selfId ? self : (poseHub.sample(p.id, now)?.position ?? null);
        // No avatar yet: counts as standing with you, so nobody starts out in the background.
        const feet = at ?? self ?? [0, 0, 0];
        where.set(p.id, feet);
        return { id: p.id, x: feet[0], z: feet[2] };
      });
      previous = clusterPeople(people, previous);
      const { labels } = previous;

      const mine = labels.get(selfId);
      const me = participants.find((p) => p.id === selfId);
      let listenLabel = me?.listeningTo ? labels.get(me.listeningTo) : undefined;
      if (me?.listeningTo && listenLabel === mine && clearedListen !== me.listeningTo) {
        // You walked into the group you were listening to: you're simply in it now.
        clearedListen = me.listeningTo;
        session.listenTo(null);
      }
      if (listenLabel === mine) listenLabel = undefined;

      const near = new Set<string>();
      for (const p of participants) {
        if (p.id === selfId) continue;
        const label = labels.get(p.id);
        if (label === listenLabel) near.add(p.id);
        audio.route(p.id, label === mine || label === listenLabel ? "conversation" : "background");
      }
      audio.setNear(near);
      focus(near);

      // The map: who's with whom, and who's listening in where.
      const byLabel = new Map<string, string[]>();
      for (const p of participants) {
        const label = labels.get(p.id)!;
        byLabel.set(label, [...(byLabel.get(label) ?? []), p.id]);
      }
      placed.current = { where, labels, selfId };
      const list: Group[] = [...byLabel].map(([id, members]) => {
        const listeners = participants
          .filter(
            (p) => p.listeningTo && labels.get(p.listeningTo) === id && labels.get(p.id) !== id,
          )
          .map((p) => p.id);
        return {
          id,
          members: members.includes(selfId)
            ? [selfId, ...members.filter((m) => m !== selfId)]
            : members,
          mine: id === mine,
          listening: id === listenLabel,
          listeners,
        };
      });
      list.sort((a, b) => Number(b.mine) - Number(a.mine) || b.members.length - a.members.length);
      const active = participants.length >= MIN_PEOPLE_FOR_GROUPS;
      // Positions change constantly; only re-render when the groups themselves do.
      const nextSignature = JSON.stringify([active, list]);
      if (nextSignature !== signature) {
        signature = nextSignature;
        setGroups((current) => ({ ...current, active, groups: list }));
      }
    };
    tick();
    const timer = setInterval(tick, REFRESH_MS);
    return () => clearInterval(timer);
  }, [audio]);

  return groups;
}
