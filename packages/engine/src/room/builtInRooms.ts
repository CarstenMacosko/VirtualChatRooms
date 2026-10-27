import type { BuiltInRoomId } from "@vcr/protocol";
import { type BuiltInRoom, builtInRoomLayout } from "./builtInRoom";
import { OVAL_OFFICE } from "./ovalOffice";
import { PRESENTATION_ROOM } from "./presentationRoom";
import type { RoomLayout } from "./scannedRoom";

/** Every built-in room, by id. */
export const BUILT_IN_ROOMS: Record<BuiltInRoomId, BuiltInRoom> = {
  "oval-office": OVAL_OFFICE,
  presentation: PRESENTATION_ROOM,
};

/** A built-in room by id; the Oval Office for none (a server from before there were several). */
export function builtInRoom(id: BuiltInRoomId | null | undefined): BuiltInRoom {
  return (id && BUILT_IN_ROOMS[id]) || OVAL_OFFICE;
}

const layouts = new Map<BuiltInRoom, RoomLayout>();

/** A built-in room's layout, the same object every time. */
export function builtInLayout(id: BuiltInRoomId | null | undefined): RoomLayout {
  const room = builtInRoom(id);
  let layout = layouts.get(room);
  if (!layout) layouts.set(room, (layout = builtInRoomLayout(room)));
  return layout;
}
