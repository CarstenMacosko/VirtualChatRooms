/**
 * Seat claims (ADR 0020): who sits where, keyed by seat id (as a string, like every synced map
 * key) with the sitter's realm session id. The realm never sees the room's layout: clients pick a
 * seat from it, and the realm only makes sure two people never share one and nobody holds two.
 */

/** The part of a MapSchema (or a Map, in tests) the claims need. */
export interface SeatMap {
  get(key: string): string | undefined;
  set(key: string, value: string): unknown;
  delete(key: string): unknown;
  forEach(fn: (value: string, key: string) => void): void;
}

/**
 * Seats `sessionId` on `seatId` if nobody else is there, moving them off any other seat. Returns
 * whether they're now sitting there.
 */
export function claimSeat(seats: SeatMap, seatId: number, sessionId: string): boolean {
  const key = String(seatId);
  const holder = seats.get(key);
  if (holder === sessionId) return true;
  if (holder !== undefined) return false;
  releaseSeats(seats, sessionId);
  seats.set(key, sessionId);
  return true;
}

/** Frees whatever seat `sessionId` holds (they stood up or left). */
export function releaseSeats(seats: SeatMap, sessionId: string) {
  const held: string[] = [];
  seats.forEach((holder, key) => {
    if (holder === sessionId) held.push(key);
  });
  for (const key of held) seats.delete(key);
}
