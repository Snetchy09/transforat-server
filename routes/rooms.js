// routes/rooms.js
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

// simple JWT auth middleware
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.sendStatus(401);
  const token = header.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.sendStatus(403);
  }
}

// Create a room
router.post('/', auth, async (req, res) => {
  const { name, max_players } = req.body;
  const { data, error } = await req.app
    .get('supabase')
    .from('rooms')
    .insert([{ name, host_id: req.user.id, max_players }])
    .select()
    .single();
  if (error) return res.status(400).json(error);
  res.json(data);
});

// List active rooms
router.get('/', async (req, res) => {
  const { data, error } = await req.app
    .get('supabase')
    .from('rooms')
    .select('*')
    .eq('active', true);
  if (error) return res.status(400).json(error);
  res.json(data);
});

module.exports = router;
