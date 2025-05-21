// routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');              // <— bcryptjs instead of bcrypt
const jwt = require('jsonwebtoken');
const router = express.Router();

router.post('/register', async (req, res) => {
  const { email, username, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);  // same API as bcrypt
  const { error } = await req.app
    .get('supabase')
    .from('players')
    .insert([{ email, username, password: hashed }]);
  if (error) return res.status(400).json(error);
  res.sendStatus(201);
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { data: user, error } = await req.app
    .get('supabase')
    .from('players')
    .select('*')
    .eq('email', email)
    .single();
  if (error || !user) return res.sendStatus(400);
  const valid = await bcrypt.compare(password, user.password); // same compare API
  if (!valid) return res.sendStatus(403);
  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET);
  res.json({ token, username: user.username });
});

module.exports = router;
