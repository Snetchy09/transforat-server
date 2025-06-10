// index.js
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();

app.get("/ping", (_req, res) => {
  return res.status(200).send("pong");
});

// ─── MIDDLEWARE ──────────────────────────────────
app.use(cors());
app.use(express.json());
// ^─── This line is crucial: it lets Express parse JSON bodies on routes.

// ─── SUPABASE CLIENT (example) ───────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ─── AUTH ROUTES ──────────────────────────────────
// REGISTER
app.post("/auth/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email || !username || !password) {
      return res.status(400).send({ error: "Missing fields" });
    }

    // Example: Check if user already exists
    const { data: existing, error: selectErr } = await supabase
      .from("players")
      .select("*")
      .eq("email", email)
      .single();

    if (selectErr && selectErr.code !== "PGRST116") {
      // a DB error other than “no rows found”
      throw selectErr;
    }

    if (existing) {
      return res.status(400).send({ error: "Email already registered" });
    }

    // Hash the password
    const hash = await bcrypt.hash(password, 10);
    // Insert new user
    const { data: newUser, error: insertErr } = await supabase
      .from("players")
      .insert([
        { email, username, password_hash: hash }
      ])
      .select("id, username, email")
      .single();

    if (insertErr) {
      throw insertErr;
    }

    return res.status(201).send({
      message: "Registered!",
      id: newUser.id,
      username: newUser.username
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    return res.status(500).send({ error: "Internal server error" });
  }
});

// LOGIN
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).send({ error: "Missing fields" });
    }

    // Find user by email
    const { data: user, error: selectErr } = await supabase
      .from("players")
      .select("id, username, password_hash")
      .eq("email", email)
      .single();

    if (selectErr) {
      return res.status(400).send({ error: "Invalid email or password" });
    }

    // Compare password hash
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(400).send({ error: "Invalid email or password" });
    }

    // Issue a JWT token (payload just contains user id)
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
      expiresIn: "7d"
    });

    return res.status(200).send({
      token,
      username: user.username
    });
  } catch (err) {
    console.error("LOGIN ERROR:", err);
    return res.status(500).send({ error: "Internal server error" });
  }
});

// ─── ROOMS ROUTES ──────────────────────────────────
app.post("/rooms", async (req, res) => {
  // 1) Grab the JWT from the “Authorization” header
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authorization required" });
  }
  const token = auth.split(" ")[1];

  // 2) Verify the token and extract user ID
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
  const hostId = decoded.id; // that is the player’s UUID

  // 3) Now read name and max_players from the JSON body
  const { name, max_players } = req.body;
  if (!name || !max_players) {
    return res.status(400).json({ error: "Name and max_players required" });
  }

  // 4) Insert into Supabase with host_id included
  const { data, error } = await supabase
    .from("rooms")
    .insert({
      name,
      host_id: hostId,
      max_players,
    })
    .select("id,name,host_id,max_players"); // return whichever columns you need

  if (error) {
    console.error("CREATE ROOM ERROR:", error);
    return res.status(500).json({ error: "Could not create room" });
  }

  // 5) Return the newly created room’s ID (and any other info)
  return res.status(201).json({ room_id: data[0].id, name: data[0].name });
});

// ─── GET /rooms ─── Return a list of all rooms ─────────────────
app.get("/rooms", async (req, res) => {
  const { data, error } = await supabase
    .from("rooms")
    .select("id,name,max_players,host_id");
  if (error) {
    console.error("LIST ROOMS ERROR:", error);
    return res.status(500).json({ error: "Could not fetch rooms" });
  }
  return res.status(200).json(data);
});

// ─── CHAT ROUTE ───────────────────────────────────
app.post("/chat/:room_id", async (req, res) => {
  try {
    const { room_id } = req.params;
    const { message } = req.body;
    if (!room_id || !message) {
      return res.status(400).send({ error: "Missing fields" });
    }
    // You can either store chat in DB or broadcast via WS here
    // For now, just echo a success:
    return res.status(200).send({ room_id, message });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    return res.status(500).send({ error: "Internal server error" });
  }
});

// ─── UPGRADE TO WEBSOCKET ─────────────────────────
import { WebSocketServer } from "ws";
import http from "http";

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const rooms = new Map();

httpServer.on("upgrade", (req, socket, head) => {
  const match = req.url.match(/^\/rooms\/([^/]+)\/ws$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const roomId = match[1];
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.roomId = roomId;
    wss.emit("connection", ws);
  });
});

wss.on("connection", (ws) => {
  if (!rooms.has(ws.roomId)) {
    rooms.set(ws.roomId, new Set());
  }
  const roomSet = rooms.get(ws.roomId);
  roomSet.add(ws);

  ws.send(JSON.stringify({ type: "joined", room_id: ws.roomId }));

ws.on("message", raw => {
  const msg = JSON.parse(raw);
  if (msg.type === "request_first_map") {
    // Choose a random map server‐side:
    const maps = ["res://map1.tscn","res://map2.tscn","res://map3.tscn"];
    const mapPath = maps[Math.floor(Math.random() * maps.length)];

    // Broadcast the map to everyone in that room set:
    const roomSet = rooms.get(ws.roomId);
    roomSet.forEach(client => {
      client.send(JSON.stringify({
        type:     "map_changed",
        map_path: mapPath
      }));
    });
  }
  // … handle other message types (move, chat, request_next_map) …
});

ws.on("close", () => {
  const roomSet = rooms.get(ws.roomId);
  if (roomSet) {
    roomSet.delete(ws);
    // If nobody is left in that set, delete the room entry entirely:
    if (roomSet.size === 0) {
      rooms.delete(ws.roomId);
      // ALSO delete (or “close”) the DB row so GET /rooms no longer returns it:
      supabase
        .from('rooms')
        .delete()
        .eq('id', ws.roomId)
        .then(({ error }) => {
          if (error) console.error("DELETE ROOM ERROR:", error);
        });
    } else {
      // otherwise, send updated player count to remaining peers:
      broadcastPlayerCount(ws.roomId, roomSet);
    }
  }
});

    // Broadcast to other peers in the same room
    for (const peer of roomSet) {
      if (peer !== ws && peer.readyState === WebSocketServer.OPEN) {
        let out = {};
        switch (msg.type) {
          case "move":
            out = { type: "move_update", ...msg };
            break;
          case "chat":
            out = { type: "chat", ...msg };
            break;
          // … handle other types …
        }
        peer.send(JSON.stringify(out));
      }
    }
  });

  ws.on("close", () => {
    roomSet.delete(ws);
  });
});

// ─── LISTEN ───────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});	
