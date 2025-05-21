// websocket.js
const WebSocket = require('ws');

module.exports = (server) => {
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    ws.on('message', (msg) => {
      let data;
      try { data = JSON.parse(msg); } catch { return; }

      switch (data.type) {
        case 'join':
          ws.roomId = data.roomId;
          ws.send(JSON.stringify({ type: 'joined', roomId: data.roomId }));
          break;
        case 'move':
        case 'jump':
        case 'cheese':
        case 'death':
        case 'win':
          // broadcast to all in the same room
          wss.clients.forEach((client) => {
            if (client !== ws && client.roomId === ws.roomId) {
              client.send(msg);
            }
          });
          break;
      }
    });
  });
};
