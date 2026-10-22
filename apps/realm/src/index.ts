import { defineRoom, defineServer } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { REALM_ROOM_NAME } from "@vcr/protocol";
import { env } from "./env";
import { SessionRoom } from "./SessionRoom";

const server = defineServer({
  transport: new WebSocketTransport(),
  greet: false,
  rooms: {
    [REALM_ROOM_NAME]: defineRoom(SessionRoom).filterBy(["sessionId"]),
  },
});

await server.listen(env.REALM_PORT);
console.log(`realm listening on ws://localhost:${env.REALM_PORT}`);
