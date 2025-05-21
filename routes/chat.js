// routes/chat.js
const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

// reuse same auth middleware
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

// Post a chat message
router.post('/:roomId', auth, async (req, res) => {
  const { roomId } = req.params;
  const { message } = req.body;
  const { data, error } = await req.app
    .get('supabase')
    .from('chat')
    .insert([{ room_id: roomId, player_id: req.user.id, message }])
    .select()
    .single();
  if (error) return res.status(400).json(error);
  res.json(data);
});

module.exports = router;
