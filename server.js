require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
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

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

app.get('/', (req, res) => {
  res.json({ status: 'WhatTheFind Live is running 🔥' });
});

app.get('/auction/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('auctions')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Auction not found' });
  res.json(data);
});

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

const viewers = {};

io.on('connection', (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  socket.on('join_auction', async (auctionId) => {
    socket.join(auctionId);
    socket.auctionId = auctionId;
    if (!viewers[auctionId]) viewers[auctionId] = new Set();
    viewers[auctionId].add(socket.id);
    io.to(auctionId).emit('viewer_count', viewers[auctionId].size);

    const { data: auction } = await supabase.from('auctions').select('*').eq('id', auctionId).single();
    if (auction) socket.emit('auction_state', auction);

    const { data: bids } = await supabase.from('bids').select('*').eq('auction_id', auctionId).order('created_at', { ascending: false }).limit(20);
    if (bids) socket.emit('bid_history', bids);

    const { data: chatHistory } = await supabase.from('chat_messages').select('*').eq('auction_id', auctionId).order('created_at', { ascending: true }).limit(50);
    if (chatHistory) socket.emit('chat_history', chatHistory);
  });

  socket.on('place_bid', async ({ auctionId, amount, username }) => {
    const { data: auction, error: auctionError } = await supabase.from('auctions').select('current_bid, status, ends_at').eq('id', auctionId).single();
    if (auctionError || !auction) { socket.emit('bid_error', { message: 'Auction not found' }); return; }
    if (auction.status !== 'live') { socket.emit('bid_error', { message: 'Auction is not live' }); return; }
    if (amount <= auction.current_bid) { socket.emit('bid_error', { message: `Bid must be higher than $${auction.current_bid}` }); return; }

    const { data: bid, error: bidError } = await supabase.from('bids').insert({ auction_id: auctionId, amount, username }).select().single();
    if (bidError) { socket.emit('bid_error', { message: 'Failed to place bid' }); return; }

    await supabase.from('auctions').update({ current_bid: amount, leading_bidder: username }).eq('id', auctionId);

    io.to(auctionId).emit('new_bid', { id: bid.id, auction_id: auctionId, amount, username, created_at: bid.created_at });
    io.to(auctionId).emit('new_chat', { type: 'bid', text: `💰 ${username} bid $${amount}`, auction_id: auctionId, created_at: new Date().toISOString() });
  });

  socket.on('send_chat', async ({ auctionId, username, text, role }) => {
    if (!text || !text.trim()) return;
    const clean = text.trim().slice(0, 200);
    const { data: msg, error } = await supabase.from('chat_messages').insert({ auction_id: auctionId, username, text: clean, role: role || 'viewer' }).select().single();
    if (error) { console.error('Chat save error:', error); return; }
    io.to(auctionId).emit('new_chat', { id: msg.id, type: 'msg', auction_id: auctionId, username, text: clean, role: role || 'viewer', created_at: msg.created_at });
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
server.listen(PORT, () => {
  console.log(`🚀 WhatTheFind Live server running on port ${PORT}`);
});
