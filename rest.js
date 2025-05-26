// index.js
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const setupWebsocket = require('./websocket');
require('dotenv').config();

const app = express();
app.use(express.json());

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
app.set('supabase', supabase);

// Import routes
app.use('/auth', require('./routes/auth'));
app.use('/rooms', require('./routes/rooms'));
app.use('/chat', require('./routes/chat'));

// Start HTTP server
const server = app.listen(process.env.PORT || 3000, () =>
  console.log(`Transforat server listening on port ${process.env.PORT || 3000}`)
);

// Attach WebSocket server for real-time sync
setupWebsocket(server);

// Prevent Replit/Render from sleeping
const http = require('http');
setInterval(() => http.get(`http://localhost:${process.env.PORT || 3000}`), 60000);

