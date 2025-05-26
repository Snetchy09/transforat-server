import http    from "http";
import express from "express";
import { WebSocketServer } from "ws";             // npm install ws

const app = express();
// … your existing HTTP routes …

// 1) Create HTTP server and attach Express
const server = http.createServer(app);

// 2) Create WebSocket server on top of it
const wss = new WebSocketServer({ noServer: true });

// 3) Track rooms → Map<roomId, Set<ws>>
const rooms = new Map();

// 4) Upgrade HTTP connections to WS
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const match = url.pathname.match(/^\/rooms\/([^/]+)\/ws$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const roomId = match[1];
  wss.handleUpgrade(request, socket, head, (socketClient) => {
    socketClient.roomId = roomId;
    wss.emit("connection", socketClient, request);
  });
});

// 5) On WS connection
wss.on("connection", (socketClient) => {
  const roomId = socketClient.roomId;
  // Add to room set
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  rooms.get(roomId).add(socketClient);

  // Send welcome
  socketClient.send(JSON.stringify({
    type: "joined",
    room_id: roomId,
    // you could parse token from query or cookie to get user ID
    player_id: socketClient.playerId || "unknown"
  }));

  // On message from client
  socketClient.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) { return; }
    // Broadcast to all in room except sender
    const peers = rooms.get(roomId);
    for (let peer of peers) {
      if (peer !== socketClient && peer.readyState === ws.OPEN) {
        // If client sent type:"move", broadcast as "move_update"
        if (msg.type === "move") {
          peer.send(JSON.stringify({
            type: "move_update",
            player_id: msg.player_id,
            x: msg.x,
            y: msg.y
          }));
        }
        // TODO: handle other types: cheese_collected, etc.
      }
    }
  });

  // Clean up on close
  socketClient.on("close", () => {
    rooms.get(roomId).delete(socketClient);
  });
});

// 6) Finally, start listening
server.listen(process.env.PORT || 3000, () => {
  console.log("HTTP+WS server listening");
});
