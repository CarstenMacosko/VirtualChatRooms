import { Ear, Headphones, Users } from "lucide-react";
import { useState } from "react";
import type { ParticipantView } from "@vcr/protocol";
import {
  BACKGROUND_MIN,
  type Group,
  type Groups,
  MIN_PEOPLE_FOR_GROUPS,
  rememberBackgroundLevel,
  rememberedBackgroundLevel,
} from "../media/useGroups";
import type { SpatialAudio } from "../media/SpatialAudio";
import { Avatar } from "./ui";

/**
 * Who's talking with whom: one circle while everyone's together, smaller circles as people drift
 * into groups. Listen in on a group or go and join it.
 */
export function GroupsMap(props: {
  groups: Groups;
  participants: ParticipantView[];
  selfId: string | null;
  speaking: ReadonlySet<string>;
  audio: SpatialAudio;
  onListen(group: Group | null): void;
  onJoin(group: Group): void;
}) {
  const { groups } = props;
  const [background, setBackground] = useState(rememberedBackgroundLevel);
  const nameOf = (id: string) =>
    id === props.selfId ? "You" : (props.participants.find((p) => p.id === id)?.name ?? "Someone");
  const userIdOf = (id: string) => props.participants.find((p) => p.id === id)?.userId ?? id;

  return (
    <div className="panel-body groups">
      {groups.active ? (
        <p className="groups-hint">
          People standing together in the room talk as a group. You still hear everyone else, just
          quieter.
        </p>
      ) : (
        <p className="groups-hint">
          Everyone is in one conversation. With {MIN_PEOPLE_FOR_GROUPS} or more people, those
          standing together in the room form smaller groups, and you still hear the others quietly.
        </p>
      )}
      <div className="group-map">
        {groups.groups.map((g) => (
          <GroupCircle
            key={g.id}
            group={g}
            active={groups.active}
            nameOf={nameOf}
            userIdOf={userIdOf}
            speaking={props.speaking}
            onListen={() => props.onListen(g.listening ? null : g)}
            onJoin={() => props.onJoin(g)}
          />
        ))}
      </div>
      {groups.active && (
        <label className="background-level">
          <span>
            <Headphones size={18} /> Other groups' volume
          </span>
          <input
            type="range"
            min={BACKGROUND_MIN * 100}
            max={100}
            step={5}
            value={Math.round(background * 100)}
            onChange={(e) => {
              const value = Number(e.target.value) / 100;
              setBackground(value);
              props.audio.setBackgroundLevel(value);
              rememberBackgroundLevel(value);
            }}
          />
          <span className="muted">{Math.round(background * 100)}%</span>
        </label>
      )}
    </div>
  );
}

const BUBBLE = 44;

function GroupCircle(props: {
  group: Group;
  active: boolean;
  nameOf(id: string): string;
  userIdOf(id: string): string;
  speaking: ReadonlySet<string>;
  onListen(): void;
  onJoin(): void;
}) {
  const { group } = props;
  const n = group.members.length;
  const size = Math.min(230, Math.max(120, 70 + n * 24));
  const radius = n === 1 ? 0 : size / 2 - BUBBLE / 2 - 6;
  const names = group.members.map(props.nameOf);
  const listenerNames = group.listeners.map(props.nameOf);
  const title = group.mine
    ? props.active
      ? "Your group"
      : "Everyone"
    : n === 1
      ? names[0]!
      : `${names[0]} and ${n - 1} more`;
  return (
    <section
      className={`group-circle${group.mine ? " mine" : ""}${group.listening ? " listening" : ""}`}
      aria-label={`${title}: ${names.join(", ")}`}
    >
      <div className="ring" style={{ width: size, height: size }}>
        {group.members.map((id, i) => {
          // Around the circle from the top; a pair sits side by side.
          const angle = (i / n) * Math.PI * 2 + (n === 2 ? Math.PI : -Math.PI / 2);
          return (
            <span
              key={id}
              className={`group-member${props.speaking.has(id) ? " speaking" : ""}`}
              style={{
                left: size / 2 + Math.cos(angle) * radius - BUBBLE / 2,
                top: size / 2 + Math.sin(angle) * radius - BUBBLE / 2,
              }}
              title={props.nameOf(id)}
            >
              <Avatar name={props.nameOf(id)} id={props.userIdOf(id)} size={BUBBLE} />
            </span>
          );
        })}
      </div>
      <h3>
        {group.mine && <Users size={16} />} {title}
      </h3>
      {group.listeners.length > 0 && (
        <p className="listeners">
          <Ear size={16} /> {listenerNames.join(", ")}{" "}
          {listenerNames.length === 1 && listenerNames[0] !== "You" ? "is" : "are"} listening
        </p>
      )}
      {!group.mine && props.active && (
        <div className="group-actions">
          <button className={group.listening ? "on" : ""} onClick={props.onListen}>
            <Ear size={16} /> {group.listening ? "Stop listening" : "Listen in"}
          </button>
          <button className="primary" onClick={props.onJoin}>
            Join
          </button>
        </div>
      )}
    </section>
  );
}
