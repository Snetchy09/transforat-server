// enet_server.js
import enet from "enet";
import dotenv from "dotenv";
dotenv.config();

const HOST      = "0.0.0.0";
const PORT      = process.env.ENET_PORT || 7777;
const MAX_PEERS = 32;
const CHANNELS  = 2;  // number of channels

// Create the ENet host (server)
const server = new enet.Host(HOST, PORT, MAX_PEERS, CHANNELS);
console.log(`ENet server listening on ${HOST}:${PORT}`);

server.on("connect", (peer) => {
  console.log("Client connected:", peer.address);

  peer.on("disconnect", () => {
    console.log("Client disconnected:", peer.address);
  });

  peer.on("receive", (packet) => {
    try {
      const msg = JSON.parse(packet.data.toString());
      if (msg.type === "move") {
        const out = JSON.stringify({
          type:      "move_update",
          player_id: msg.player_id,
          x:         msg.x,
          y:         msg.y
        });
        // Broadcast on channel 0
        server.broadcast(0, Buffer.from(out));
      }
      // …handle other message types here…
    } catch (err) {
      console.error("ENet parse error:", err);
    }
  });
});
