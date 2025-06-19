#!/data/data/com.termux/files/usr/bin/bash

# === CONFIG ===
BASE_URL="http://localhost:3000"  # Change this if you're using Render
EMAIL="you@example.com"
PASSWORD="your_password"
USERNAME="your_name"
ROOM_NAME="TermuxRoom"
MAX_PLAYERS=10

# === STEP 1: Login & Get JWT ===
TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" | jq -r .token)

# === STEP 2: Create Room ===
ROOM_ID=$(curl -s -X POST "$BASE_URL/rooms" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$ROOM_NAME\",\"max_players\":$MAX_PLAYERS}" | jq -r .room_id)

# === OUTPUT ===
echo ""
echo "✅ JWT Token:"
echo "$TOKEN"
echo ""
echo "🏠 Room ID:"
echo "$ROOM_ID"
echo ""
echo "📡 WebSocket URL:"
echo "ws://localhost:3000/rooms/$ROOM_ID/ws"
