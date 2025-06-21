import express from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { WebSocketServer } from "ws";
import http from "http";
import { v4 as uuid } from 'uuid';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const MAP_LIST = ["res://map1.tscn","res://map2.tscn","res://map3.tscn"];

// ─── SUPABASE CLIENT ─────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── UTILITIES ────────────────────────────────────────
async function broadcastPlayerCount(roomId, roomObj) {
  const count = roomObj.players.size;
  roomObj.players.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "player_count", count }));
    }
  });
}

// Rate limiter per socket
const RATE_WINDOW = 1000; // ms
const MAX_PER_WINDOW = 20;
const counters = new WeakMap();
function canSend(ws) {
  const now = Date.now();
  let data = counters.get(ws) || { time: now, count: 0 };
  if (now - data.time > RATE_WINDOW) data = { time: now, count: 0 };
  data.count += 1;
  counters.set(ws, data);
  return data.count <= MAX_PER_WINDOW;
}

// ─── HTTP ROUTES ─────────────────────────────────────
app.get("/ping", (_req, res) => res.send("pong"));

// Auth: Register
app.post("/auth/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) return res.status(400).json({ error: "Missing fields" });

    const { data: existing, error: selErr } = await supabase
      .from("players")
      .select("*") 
      .eq("email", email)
      .single();
    if (selErr && selErr.code !== "PGRST116") throw selErr;
    if (existing) return res.status(400).json({ error: "Email taken" });

    const hash = await bcrypt.hash(password, 10);
    const { data: user, error: insErr } = await supabase
      .from("players").insert([{ email, username, password_hash: hash }])
      .select("id,username,email,cheese_balance").single();
    if (insErr) throw insErr;

    res.status(201).json({ id: user.id, username: user.username });
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

    const { data: user, error: selErr } = await supabase
      .from("players").select("id,username,password_hash,cheese_balance").eq("email", email).single();
    if (selErr) return res.status(400).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.json({ token: token, username: user?.username ?? "unknown", id: user.id, cheese: user.cheese_balance || 0 });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// cheese: award
app.post("/cheese/award", async (req, res) => {
  const auth = req.headers["authorization"];
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Auth required" });
  const token = auth.split(" ")[1];
  const decoded = jwt.verify(token, process.env.JWT_SECRET);

  const { amount } = req.body;
  if (typeof amount !== "number" || amount <= 0) return res.status(400).json({ error: "Invalid amount" });

  const { data, error } = await supabase.rpc("increment_cheese", {
    player_id: decoded.id,
    amount
  });

  if (error) return res.status(500).json({ error: "Could not update cheese" });

  res.json({ message: "Cheese awarded", new_balance: data });
});

// Rooms: Create
app.post("/rooms", async (req, res) => {
  try {
    const auth = req.headers["authorization"];
    if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Auth required" });
    const token = auth.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { name, max_players } = req.body;
    if (!name || !max_players) return res.status(400).json({ error: "Missing fields" });

    const { data, error } = await supabase
      .from("rooms")
      .insert([{ name, host_id: decoded.id, max_players }])
      .select("id,name,host_id,max_players");
    if (error) throw error;
    res.status(201).json({ room_id: data[0].id, name: data[0].name });
  } catch (err) {
    console.error("CREATE ROOM ERROR:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Rooms: List
app.get("/rooms", async (_req, res) => {
  const { data, error } = await supabase.from("rooms").select("id,name,max_players,host_id");
  if (error) return res.status(500).json({ error: "Could not fetch rooms" });
  res.json(data);
});

// Chat stub
app.post("/chat/:room_id", (req, res) => {
  const { room_id } = req.params;
  const { message } = req.body;
  if (!room_id || !message) return res.status(400).json({ error: "Missing fields" });
  res.json({ room_id, message });
});

// ─── WEBSOCKET + MATCH LIFECYCLE ─────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
// Room state: { players, spectators, state, matchTimer }
const rooms = new Map();

function pickWeightedMap(room) {
  const weights = room.mapWeights;
  const entries = Object.entries(weights);
  const totalWeight = entries.reduce((sum, [_, w]) => sum + w, 0);
  const rand = Math.random() * totalWeight;
  let cum = 0;
  for (const [map, weight] of entries) {
    cum += weight;
    if (rand < cum) return map;
  }
  return MAP_LIST[0]; // fallback
}

function startMatch(roomId) {
  const room = rooms.get(roomId);
  room.state = 'in_match';

  room.expected_total = room.players.size;
  room.left_midmatch = 0;

  const map = pickWeightedMap(room);

  // reset all weights a bit
  for (const m in room.mapWeights) {
    room.mapWeights[m] = Math.max(1, room.mapWeights[m] - 1);
  }
  // give chosen map high weight so it's less likely next time
  room.mapWeights[map] = 100;

  room.currentMap = map;

  room.players.forEach(ws =>
    ws.send(JSON.stringify({ type: 'match_start', map_path: map }))
  );

  room.matchTimer = setTimeout(() => endMatch(roomId), 120000);
}

function endMatch(roomId) {
  const room = rooms.get(roomId);
  room.state = 'waiting';

  delete room.left_midmatch;
  delete room.expected_total;

  room.players.forEach(ws => ws.send(JSON.stringify({ type: 'match_end' })));
  // promote spectators
  room.spectators.forEach(ws => {
    room.players.add(ws);
    ws.send(JSON.stringify({ type: 'player_mode' }));
  });
  room.spectators.clear();
  broadcastPlayerCount(roomId, room);
  for (const m of MAP_LIST) {
    room.mapWeights[m] = 1;
  }
  startMatch(roomId);
}

function maybeEndEarly(roomId) {
  const room = rooms.get(roomId);
  const totalPresent = room.players.size + room.spectators.size;

  // Count only active participants
  if (room.spectators.size >= totalPresent) {
    clearTimeout(room.matchTimer);
    endMatch(roomId);
  }
}

wss.on('connection', (ws) => {
  const id = ws.roomId;
  if (!rooms.has(id)) {
    const mapWeights = {};
    for (const map of MAP_LIST) {
      mapWeights[map] = 1;
    }

    rooms.set(id, {
      players: new Set(),
      spectators: new Set(),
      state: 'waiting',
      matchTimer: null,
      mapWeights: mapWeights
    });
  }
  const room = rooms.get(id);

  // assign role
  ws.playerId = uuid();

  if (room.state === 'in_match') {
    room.spectators.add(ws);
    ws.send(JSON.stringify({ type: 'joined', room_id: id, player_id: ws.playerId }));
    ws.send(JSON.stringify({ type: 'spectator_mode' }));
  } else {
    room.players.add(ws);
    ws.send(JSON.stringify({ type: 'joined', room_id: id, player_id: ws.playerId }));
    ws.send(JSON.stringify({ type: 'player_mode' }));
    broadcastPlayerCount(id, room);
    if (room.players.size === 1) startMatch(id);
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('error', err => console.error('❌ WS error:', err));

  ws.on('message', (data) => {
    if (!canSend(ws)) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'request_first_map') {
      const room = rooms.get(ws.roomId);
      if (!room) return;

      const mapPath = room.currentMap;
      if (!mapPath) return;

      room.currentMap = mapPath;

      ws.send(JSON.stringify({
        type: 'match_start',
        map_path: mapPath
      }));
    }

    if (msg.type === 'finish' && room.state === 'in_match') {
      room.players.delete(ws);
      room.spectators.add(ws);
      ws.send(JSON.stringify({ type: 'spectator_mode' }));
      broadcastPlayerCount(roomId, room);

      maybeEndEarly(roomId); // 👈 Check if everyone’s done
      return;
    }

    if (room.state === 'in_match') {
      room.players.forEach(p => {
        if (p !== ws && p.readyState === ws.OPEN) p.send(data);
      });
    }
  });

  ws.on('close', () => {
    clearTimeout(room.matchTimer);
    room.players.delete(ws);
    room.spectators.delete(ws);

    if (room.state === 'in_match') {
      room.left_midmatch += 1;
    }

    if (room.players.size === 0) {
      rooms.delete(id);
      // Supabase delete wrapped in async IIFE
      (async () => {
        const { error } = await supabase
          .from("rooms")
          .delete()
          .eq("id", id);
        if (error) console.error("DB room delete failed:", error.message);
        else console.log("Room deleted from DB:", id);
      })();
    } else {
      broadcastPlayerCount(id, room);
    }
  });
});

server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const m = url.pathname.match(/^\/rooms\/([^/]+)\/ws$/);
  if (!m) return sock.destroy();
  const rid = m[1];
  const pid = url.searchParams.get("player_id"); // 👈 GET player_id from URL
  if (!pid) return sock.destroy(); // no id = no mercy

  wss.handleUpgrade(req, sock, head, ws => {
    ws.roomId = rid;
    ws.playerId = pid; // 👈 assign to socket
    wss.emit('connection', ws);
  });
});

// Heartbeat & shutdown
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
process.on('SIGINT', () => { clearInterval(interval); wss.clients.forEach(ws => ws.terminate()); server.close(); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Listening on port ${PORT}`));
