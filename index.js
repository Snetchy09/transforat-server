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

// ─── SUPABASE CLIENT ─────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── UTILITIES ────────────────────────────────────────
async function broadcastPlayerCount(roomId, roomObj) {
  const count = roomObj.players.size;
  roomObj.players.forEach(ws => {
    if (ws.readyState === ws.OPEN) {
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
      .from("players").select()* .eq("email", email).single();
    if (selErr && selErr.code !== "PGRST116") throw selErr;
    if (existing) return res.status(400).json({ error: "Email taken" });

    const hash = await bcrypt.hash(password, 10);
    const { data: user, error: insErr } = await supabase
      .from("players").insert([{ email, username, password_hash: hash }])
      .select("id,username,email").single();
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
      .from("players").select("id,username,password_hash").eq("email", email).single();
    if (selErr) return res.status(400).json({ error: "Invalid credentials" });

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
  try {
    const auth = req.headers["authorization"];
    if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "Auth required" });
    const token = auth.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { name, max_players } = req.body;
    if (!name || !max_players) return res.status(400).json({ error: "Missing fields" });

    const { data, error } = await supabase
      .from("rooms").insert([{ name, host_id: decoded.id, max_players }])
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

function startMatch(roomId) {
  const room = rooms.get(roomId);
  room.state = 'in_match';
  const map = ["res://map1.tscn","res://map2.tscn","res://map3.tscn"][
    Math.floor(Math.random() * 3)
  ];
  room.players.forEach(ws => ws.send(JSON.stringify({ type: 'match_start', map_path: map })));
  room.matchTimer = setTimeout(() => endMatch(roomId), 60000);
}

function endMatch(roomId) {
  const room = rooms.get(roomId);
  room.state = 'waiting';
  room.players.forEach(ws => ws.send(JSON.stringify({ type: 'match_end' })));
  // promote spectators
  room.spectators.forEach(ws => room.players.add(ws));
  room.spectators.clear();
  broadcastPlayerCount(roomId, room);
  room.matchTimer = setTimeout(() => startMatch(roomId), 10000);
}

wss.on('connection', (ws) => {
  const id = ws.roomId;
  if (!rooms.has(id)) {
    rooms.set(id, { players: new Set(), spectators: new Set(), state: 'waiting', matchTimer: null });
  }
  const room = rooms.get(id);

  // assign role
  if (room.state === 'in_match') {
    room.spectators.add(ws);
    ws.send(JSON.stringify({ type: 'spectator_mode' }));
  } else {
    room.players.add(ws);
    ws.send(JSON.stringify({ type: 'joined', room_id: id, player_id: ws.playerId }));
    broadcastPlayerCount(id, room);
    if (room.players.size === 1) startMatch(id);
  }

  ws.on('message', (data) => {
    if (!canSend(ws)) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'request_first_map') return;
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
    if (room.players.size === 0) rooms.delete(id);
    else broadcastPlayerCount(id, room);
  });
});

server.on('upgrade', (req, sock, head) => {
  const m = req.url.match(/^\/rooms\/([^/]+)\/ws$/);
  if (!m) return sock.destroy();
  const rid = m[1];
  wss.handleUpgrade(req, sock, head, ws => {
    ws.roomId = rid;
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
