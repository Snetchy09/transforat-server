import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { WebSocketServer } from "ws";
import http from "http";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Utility: broadcast current player count in a room
async function broadcastPlayerCount(roomId, roomSet) {
  const count = roomSet.size;
  for (const client of roomSet) {
    client.send(JSON.stringify({ type: "player_count", count }));
  }
}

// Rate-limiter per socket
const rateLimitWindow = 1000; // ms
const maxMessagesPerWindow = 20;
const messageCounters = new WeakMap();

function canSend(ws) {
  const now = Date.now();
  let counter = messageCounters.get(ws) || { time: now, count: 0 };
  if (now - counter.time > rateLimitWindow) {
    counter = { time: now, count: 0 };
  }
  counter.count += 1;
  messageCounters.set(ws, counter);
  return counter.count <= maxMessagesPerWindow;
}

// HTTP Routes
app.get("/ping", (_req, res) => res.status(200).send("pong"));

// Auth: Register
app.post("/auth/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) {
      return res.status(400).json({ error: "Missing fields" });
    }
    const { data: existing, error: selectErr } = await supabase
      .from("players")
      .select("*")
      .eq("email", email)
      .single();
    if (selectErr && selectErr.code !== "PGRST116") throw selectErr;
    if (existing) return res.status(400).json({ error: "Email taken" });
    const hash = await bcrypt.hash(password, 10);
    const { data: newUser, error: insertErr } = await supabase
      .from("players")
      .insert([{ email, username, password_hash: hash }])
      .select("id,username,email")
      .single();
    if (insertErr) throw insertErr;
    res.status(201).json({ id: newUser.id, username: newUser.username });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Auth: Login
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Missing fields" });
    const { data: user, error: selectErr } = await supabase
      .from("players")
      .select("id,username,password_hash")
      .eq("email", email)
      .single();
    if (selectErr) return res.status(400).json({ error: "Invalid credentials" });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ error: "Invalid credentials" });
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, username: user.username });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Rooms: Create
app.post("/rooms", async (req, res) => {
  const auth = req.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Auth required" });
  let decoded;
  try { decoded = jwt.verify(auth.split(" ")[1], process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: "Invalid token" }); }
  const { name, max_players } = req.body;
  if (!name || !max_players) return res.status(400).json({ error: "Missing fields" });
  const { data, error } = await supabase
    .from("rooms")
    .insert([{ name, host_id: decoded.id, max_players }])
    .select("id,name,host_id,max_players");
  if (error) {
    console.error("CREATE ROOM ERROR:", error);
    return res.status(500).json({ error: "Could not create room" });
  }
  res.status(201).json({ room_id: data[0].id, name: data[0].name });
});

// Rooms: List
app.get("/rooms", async (_req, res) => {
  const { data, error } = await supabase
    .from("rooms")
    .select("id,name,max_players,host_id");
  if (error) {
    console.error("LIST ROOMS ERROR:", error);
    return res.status(500).json({ error: "Could not fetch rooms" });
  }
  res.json(data);
});

// Chat stub
app.post("/chat/:room_id", (req, res) => {
  const { room_id } = req.params;
  const { message } = req.body;
  if (!room_id || !message) return res.status(400).json({ error: "Missing fields" });
  res.json({ room_id, message });
});

// HTTP → WebSocket
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const rooms = new Map();

httpServer.on("upgrade", (req, socket, head) => {
  const match = req.url.match(/^\/rooms\/([^/]+)\/ws$/);
  if (!match) return socket.destroy();
  const roomId = match[1];
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.roomId = roomId;
    wss.emit("connection", ws);
  });
});

wss.on("connection", (ws) => {
  // Setup room
  if (!rooms.has(ws.roomId)) rooms.set(ws.roomId, new Set());
  const roomSet = rooms.get(ws.roomId);
  roomSet.add(ws);
  ws.isAlive = true;

  // Heartbeat
  ws.on("pong", () => { ws.isAlive = true; });

  // Notify join
  ws.send(JSON.stringify({ type: "joined", room_id: ws.roomId }));
  broadcastPlayerCount(ws.roomId, roomSet);

  ws.on("message", (raw) => {
    if (!canSend(ws)) return;
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" })); }

// Handle map request
    if (msg.type === "request_first_map") {
      const maps = ["res://map1.tscn", "res://map2.tscn", "res://map3.tscn"];
      const mapPath = maps[Math.floor(Math.random() * maps.length)];
      roomSet.forEach(client => client.send(JSON.stringify({ type: "map_changed", map_path: mapPath })));
    }

    // Broadcast moves & chat
    for (const peer of roomSet) {
      if (peer !== ws && peer.readyState === ws.OPEN) {
        let out = {};
        switch (msg.type) {
          case "move": out = { type: "move_update", ...msg }; break;
          case "chat": out = { type: "chat", ...msg }; break;
          default: continue;
        }
        peer.send(JSON.stringify(out));
      }
    }
  });

  ws.on("close", async () => {
    roomSet.delete(ws);
    if (roomSet.size === 0) {
      rooms.delete(ws.roomId);
      const { error } = await supabase.from('rooms').delete().eq('id', ws.roomId);
      if (error) console.error("DELETE ROOM ERROR:", error);
    } else {
      broadcastPlayerCount(ws.roomId, roomSet);
    }
  });
});

// Heartbeat interval for all connections
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Graceful shutdown
process.on('SIGINT', () => {
  clearInterval(interval);
  wss.clients.forEach(ws => ws.terminate());
  httpServer.close(() => process.exit());
});

// Start server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`Listening on port ${PORT}`));
