require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

// ── Supabase client ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

// ── Auth middleware ──
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── Helper: verify socket token ──
function verifySocketToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ════════════════════════════════════════════
// REST ENDPOINTS
// ════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'WhatTheFind Live is running 🔥' });
});

// ── Auth: register ──
app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  if (username.length < 3 || username.length > 30) {
    return res.status(400).json({ error: 'Username must be 3–30 characters' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const password_hash = await bcrypt.hash(password, 10);

  const { data, error } = await supabase
    .from('users')
    .insert({ username, password_hash })
    .select('id, username, created_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Username already taken' });
    }
    return res.status(500).json({ error: 'Registration failed' });
  }

  const token = jwt.sign({ id: data.id, username: data.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: data });
});

// ── Auth: login ──
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('username', username)
    .single();

  if (error || !user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, created_at: user.created_at } });
});

// ── Get all live/upcoming auctions ──
app.get('/auctions', async (req, res) => {
  const { status } = req.query;
  let query = supabase
    .from('auctions')
    .select('id, title, description, image_url, category, starting_bid, current_bid, leading_bidder, status, starts_at, ends_at, host_username, created_at')
    .order('created_at', { ascending: false });

  if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// ── Get single auction ──
app.get('/auction/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('auctions')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Auction not found' });
  res.json(data);
});

// ── Create auction (auth required) ──
app.post('/auction', requireAuth, async (req, res) => {
  const { title, description, image_url, category, starting_bid, starts_at, ends_at } = req.body;

  if (!title) return res.status(400).json({ error: 'title is required' });
  if (!starting_bid || starting_bid < 1) return res.status(400).json({ error: 'starting_bid must be at least 1' });
  if (!ends_at) return res.status(400).json({ error: 'ends_at is required' });
  if (new Date(ends_at) <= new Date()) return res.status(400).json({ error: 'ends_at must be in the future' });

  const { data, error } = await supabase
    .from('auctions')
    .insert({
      title,
      description,
      image_url,
      category,
      starting_bid,
      current_bid: starting_bid,
      status: starts_at && new Date(starts_at) > new Date() ? 'upcoming' : 'live',
      starts_at: starts_at || new Date().toISOString(),
      ends_at,
      host_username: req.user.username
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Failed to create auction' });
  res.status(201).json(data);
});

// ── Get bid history for an auction ──
app.get('/auction/:id/bids', async (req, res) => {
  const { data, error } = await supabase
    .from('bids')
    .select('*')
    .eq('auction_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// ── Get chat history for an auction ──
app.get('/auction/:id/chat', async (req, res) => {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('auction_id', req.params.id)
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// ════════════════════════════════════════════
// AUCTION LIFECYCLE — SERVER-SIDE TIMER
// ════════════════════════════════════════════

const viewers = {};
const auctionTimers = {};

function startAuctionTimer(auctionId, endsAt) {
  if (auctionTimers[auctionId]) return;

  auctionTimers[auctionId] = setInterval(async () => {
    const remaining = Math.max(0, Math.floor((new Date(endsAt) - Date.now()) / 1000));
    io.to(auctionId).emit('time_remaining', { auctionId, seconds: remaining });

    if (remaining <= 0) {
      clearInterval(auctionTimers[auctionId]);
      delete auctionTimers[auctionId];

      const { data: auction } = await supabase
        .from('auctions')
        .update({ status: 'ended' })
        .eq('id', auctionId)
        .eq('status', 'live')
        .select()
        .single();

      if (auction) {
        io.to(auctionId).emit('auction_ended', {
          auctionId,
          winner: auction.leading_bidder,
          final_bid: auction.current_bid
        });
        console.log(`🏁 Auction ${auctionId} ended — winner: ${auction.leading_bidder} at $${auction.current_bid}`);
      }
    }
  }, 1000);
}

async function resumeLiveAuctions() {
  const { data: liveAuctions } = await supabase
    .from('auctions')
    .select('id, ends_at')
    .eq('status', 'live');

  if (!liveAuctions) return;
  for (const auction of liveAuctions) {
    console.log(`⏱ Resuming timer for auction ${auction.id}`);
    startAuctionTimer(auction.id, auction.ends_at);
  }
}

// ════════════════════════════════════════════
// SOCKET.IO
// ════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  socket.on('join_auction', async (auctionId) => {
    socket.join(auctionId);
    socket.auctionId = auctionId;

    if (!viewers[auctionId]) viewers[auctionId] = new Set();
    viewers[auctionId].add(socket.id);
    io.to(auctionId).emit('viewer_count', viewers[auctionId].size);

    const { data: auction } = await supabase
      .from('auctions').select('*').eq('id', auctionId).single();

    if (auction) {
      socket.emit('auction_state', auction);
      if (auction.status === 'live' && auction.ends_at) {
        startAuctionTimer(auctionId, auction.ends_at);
      }
    }

    const { data: bids } = await supabase
      .from('bids').select('*').eq('auction_id', auctionId)
      .order('created_at', { ascending: false }).limit(20);
    if (bids) socket.emit('bid_history', bids);

    const { data: chatHistory } = await supabase
      .from('chat_messages').select('*').eq('auction_id', auctionId)
      .order('created_at', { ascending: true }).limit(50);
    if (chatHistory) socket.emit('chat_history', chatHistory);

    console.log(`👁 ${socket.id} joined auction ${auctionId} — ${viewers[auctionId].size} watching`);
  });

  socket.on('place_bid', async ({ auctionId, amount, token }) => {
    const user = verifySocketToken(token);
    if (!user) {
      socket.emit('bid_error', { message: 'You must be logged in to bid' });
      return;
    }

    const { data, error } = await supabase.rpc('place_bid', {
      p_auction_id: auctionId,
      p_username: user.username,
      p_amount: amount
    });

    if (error || !data.success) {
      socket.emit('bid_error', { message: (data && data.error) || 'Failed to place bid' });
      return;
    }

    io.to(auctionId).emit('new_bid', data.bid);
    io.to(auctionId).emit('new_chat', {
      type: 'bid',
      text: `💰 ${user.username} bid $${amount}`,
      auction_id: auctionId,
      created_at: new Date().toISOString()
    });
    console.log(`💰 ${user.username} bid $${amount} on auction ${auctionId}`);
  });

  socket.on('send_chat', async ({ auctionId, text, token }) => {
    const user = verifySocketToken(token);
    if (!user) {
      socket.emit('chat_error', { message: 'You must be logged in to chat' });
      return;
    }
    if (!text || !text.trim()) return;
    const clean = text.trim().slice(0, 200);

    let role = 'viewer';
    const { data: auction } = await supabase
      .from('auctions').select('host_username, leading_bidder').eq('id', auctionId).single();
    if (auction) {
      if (auction.host_username === user.username) role = 'host';
      else if (auction.leading_bidder === user.username) role = 'bidder';
    }

    const { data: msg, error } = await supabase
      .from('chat_messages')
      .insert({ auction_id: auctionId, username: user.username, text: clean, role })
      .select().single();

    if (error) { console.error('Chat save error:', error); return; }

    io.to(auctionId).emit('new_chat', {
      id: msg.id, type: 'msg', auction_id: auctionId,
      username: user.username, text: clean, role, created_at: msg.created_at
    });
  });

  socket.on('start_auction', async ({ auctionId, token }) => {
    const user = verifySocketToken(token);
    if (!user) return socket.emit('host_error', { message: 'Unauthorized' });

    const { data: auction } = await supabase
      .from('auctions').select('host_username, status, ends_at').eq('id', auctionId).single();

    if (!auction || auction.host_username !== user.username)
      return socket.emit('host_error', { message: 'Only the host can start this auction' });
    if (auction.status !== 'upcoming')
      return socket.emit('host_error', { message: 'Auction is already live or ended' });

    await supabase.from('auctions').update({ status: 'live', starts_at: new Date().toISOString() }).eq('id', auctionId);
    io.to(auctionId).emit('auction_started', { auctionId });
    startAuctionTimer(auctionId, auction.ends_at);
    console.log(`▶️ Host ${user.username} started auction ${auctionId}`);
  });

  socket.on('end_auction', async ({ auctionId, token }) => {
    const user = verifySocketToken(token);
    if (!user) return socket.emit('host_error', { message: 'Unauthorized' });

    const { data: auction } = await supabase
      .from('auctions').select('host_username, leading_bidder, current_bid').eq('id', auctionId).single();

    if (!auction || auction.host_username !== user.username)
      return socket.emit('host_error', { message: 'Only the host can end this auction' });

    if (auctionTimers[auctionId]) { clearInterval(auctionTimers[auctionId]); delete auctionTimers[auctionId]; }
    await supabase.from('auctions').update({ status: 'ended' }).eq('id', auctionId);
    io.to(auctionId).emit('auction_ended', { auctionId, winner: auction.leading_bidder, final_bid: auction.current_bid });
    console.log(`🛑 Host ${user.username} ended auction ${auctionId} early`);
  });

  socket.on('extend_auction', async ({ auctionId, extraSeconds, token }) => {
    const user = verifySocketToken(token);
    if (!user) return socket.emit('host_error', { message: 'Unauthorized' });

    const { data: auction } = await supabase
      .from('auctions').select('host_username, ends_at, status').eq('id', auctionId).single();

    if (!auction || auction.host_username !== user.username)
      return socket.emit('host_error', { message: 'Only the host can extend this auction' });
    if (auction.status !== 'live')
      return socket.emit('host_error', { message: 'Can only extend a live auction' });

    const newEndsAt = new Date(new Date(auction.ends_at).getTime() + extraSeconds * 1000).toISOString();
    await supabase.from('auctions').update({ ends_at: newEndsAt }).eq('id', auctionId);

    if (auctionTimers[auctionId]) { clearInterval(auctionTimers[auctionId]); delete auctionTimers[auctionId]; }
    startAuctionTimer(auctionId, newEndsAt);

    io.to(auctionId).emit('auction_extended', { auctionId, new_ends_at: newEndsAt });
    console.log(`⏩ Host ${user.username} extended auction ${auctionId} by ${extraSeconds}s`);
  });

  socket.on('disconnect', () => {
    const auctionId = socket.auctionId;
    if (auctionId && viewers[auctionId]) {
      viewers[auctionId].delete(socket.id);
      io.to(auctionId).emit('viewer_count', viewers[auctionId].size);
    }
    console.log(`❌ User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  console.log(`🚀 WhatTheFind Live server running on port ${PORT}`);
  await resumeLiveAuctions();
});
