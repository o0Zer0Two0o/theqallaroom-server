import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const PORT = Number(process.env.PORT || 3000);
const INVITE_CODE = (process.env.INVITE_CODE || '').trim();

const app = express();
app.use(cors());
app.get('/health', (_req, res) => res.json({ ok: true, app: 'TheQallaRoom Server', port: PORT }));

// --- Stickers upload + hosting (v1) ---
const stickerDir = path.join(process.cwd(), 'uploads', 'stickers');
fs.mkdirSync(stickerDir, { recursive: true });

const upload = multer({
  dest: stickerDir,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (_req, file, cb) => {
    const ok = ['image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
    cb(ok ? null : new Error('Invalid file type'), ok);
  }
});

app.use('/stickers', express.static(stickerDir));

app.post('/api/stickers/upload', upload.single('sticker'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No file uploaded' });
  // For simplicity v1 uses multer's generated filename.
  // Client should prefix with the server origin when rendering.
  return res.json({ ok: true, url: `/stickers/${req.file.filename}` });
});

const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: true, methods: ["GET","POST"] } });

function safeStr(v, max=200){
  if(typeof v !== 'string') return '';
  v = v.trim();
  if(v.length > max) v = v.slice(0, max);
  return v;
}

function safeHexColor(v){
  if(typeof v !== 'string') return '#5865F2';
  v = v.trim();
  if(/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  return '#5865F2';
}

const channels = [
  { id: 'general', name: 'general' },
  { id: 'gaming', name: 'gaming' },
  { id: 'music', name: 'music' },
  { id: 'memes', name: 'memes' }
];

const history = new Map();
for(const c of channels) history.set(c.id, []);

// --- Presence ---
const usersBySocket = new Map(); // socket.id -> {id,name,color}

// --- Voice (WebRTC signaling) ---
const voiceRooms = new Map(); // room -> Set(socket.id)
function getVoiceSet(room){
  if(!voiceRooms.has(room)) voiceRooms.set(room, new Set());
  return voiceRooms.get(room);
}

function pushHistory(channelId, msg){
  const list = history.get(channelId) || [];
  list.push(msg);
  if(list.length > 200) list.splice(0, list.length - 200);
  history.set(channelId, list);
}

io.on('connection', (socket) => {
  socket.data.user = { name: 'Guest', color: '#5865F2', channelId: 'general' };

  socket.on('hello', (payload = {}) => {
    const name = safeStr(payload.name || 'Guest', 32) || 'Guest';
    const color = safeHexColor(payload.color || '#5865F2');
    const invite = safeStr(payload.invite || '', 64);

    if(INVITE_CODE && invite !== INVITE_CODE){
      socket.emit('auth:error', { message: 'Invalid invite code.' });
      socket.disconnect(true);
      return;
    }

    socket.data.user.name = name;
    socket.data.user.color = color;
    socket.emit('channels', channels);
    socket.emit('history', { channelId: socket.data.user.channelId, messages: history.get(socket.data.user.channelId) || [] });
    socket.emit('auth:ok', { name, color, channelId: socket.data.user.channelId });

    // Presence broadcast
    usersBySocket.set(socket.id, { id: socket.id, name, color });
    io.emit('presence:list', Array.from(usersBySocket.values()));
  });

  socket.on('join', (payload = {}) => {
    const channelId = safeStr(payload.channelId || 'general', 32) || 'general';
    if(!history.has(channelId)) return;
    socket.data.user.channelId = channelId;
    socket.emit('history', { channelId, messages: history.get(channelId) || [] });
  });

  socket.on('message', (payload = {}) => {
    const type = safeStr(payload.type || 'text', 16) || 'text';
    const text = safeStr(payload.text || '', 2000);
    const url = safeStr(payload.url || '', 400);

    if(type === 'text' && !text) return;
    if(type === 'sticker' && !url) return;

    const channelId = socket.data.user.channelId || 'general';
    if(!history.has(channelId)) return;

    const msg = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      channelId,
      user: socket.data.user.name || 'Guest',
      color: socket.data.user.color || '#5865F2',
      type,
      text: type === 'text' ? text : '',
      url: type === 'sticker' ? url : '',
      ts: Date.now()
    };
    pushHistory(channelId, msg);
    io.emit('message', msg);
  });

  socket.on('disconnect', () => {
    usersBySocket.delete(socket.id);
    io.emit('presence:list', Array.from(usersBySocket.values()));

    // Cleanup voice rooms membership
    for (const [room, set] of voiceRooms.entries()) {
      if (set.delete(socket.id)) {
        socket.to(`voice:${room}`).emit('rtc:peer_left', { room, peerId: socket.id });
      }
      if (set.size === 0) voiceRooms.delete(room);
    }
  });
  socket.on('rtc:join', ({ room } = {}) => {
    room = safeStr(room || 'general', 32) || 'general';
    const set = getVoiceSet(room);
    if(set.size >= 4){
      socket.emit('rtc:join_denied', { reason: 'Room full (max 4)' });
      return;
    }
    set.add(socket.id);
    socket.join(`voice:${room}`);
    const peers = Array.from(set).filter(id => id !== socket.id);
    socket.emit('rtc:peers', { room, peers });
    socket.to(`voice:${room}`).emit('rtc:peer_joined', { room, peerId: socket.id });
  });

  socket.on('rtc:leave', ({ room } = {}) => {
    room = safeStr(room || 'general', 32) || 'general';
    const set = getVoiceSet(room);
    set.delete(socket.id);
    socket.leave(`voice:${room}`);
    socket.to(`voice:${room}`).emit('rtc:peer_left', { room, peerId: socket.id });
    if(set.size === 0) voiceRooms.delete(room);
  });

  socket.on('rtc:offer', ({ to, room, sdp } = {}) => {
    if(!to || !sdp) return;
    io.to(to).emit('rtc:offer', { from: socket.id, room: safeStr(room || '', 32), sdp });
  });
  socket.on('rtc:answer', ({ to, room, sdp } = {}) => {
    if(!to || !sdp) return;
    io.to(to).emit('rtc:answer', { from: socket.id, room: safeStr(room || '', 32), sdp });
  });
  socket.on('rtc:ice', ({ to, room, candidate } = {}) => {
    if(!to || !candidate) return;
    io.to(to).emit('rtc:ice', { from: socket.id, room: safeStr(room || '', 32), candidate });
  });
});

server.listen(PORT, () => {
  console.log(`TheQallaRoom server running on http://localhost:${PORT}`);
  if(INVITE_CODE) console.log('Invite-only enabled (INVITE_CODE set).');
});
