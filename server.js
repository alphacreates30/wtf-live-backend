require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { AccessToken } = require('livekit-server-sdk');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ── Stripe webhook needs raw body ──
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json());

// ── Clients ──
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const ADMIN_USERNAME = 'whatthefind';

// ── Email transport (Nodemailer — set SMTP_* env vars or swap for Resend) ──
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendAdminEmail(subject, text) {
  if (!process.env.SMTP_USER) return; // skip if not configured
  try {
    await mailer.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.ADMIN_EMAIL || process.env.SMTP_USER,
      subject,
      text,
    });
  } catch (e) {
    console.error('Email send error:', e.message);
  }
}

// ── Auth middleware ──
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.username !== ADMIN_USERNAME) return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

function verifySocketToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// ════════════════════════════════════════════
// REST ENDPOINTS
// ════════════════════════════════════════════

app.get('/', (req, res) => res.json({ status: 'WhatTheFind Live is running 🔥' }));

// ── Auth ──
app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (username.length < 3 || username.length > 30) return res.status(400).json({ error: 'Username must be 3–30 characters' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const password_hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('users').insert({ username, password_hash }).select('id, username, created_at').single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    return res.status(500).json({ error: 'Registration failed' });
  }
  const token = jwt.sign({ id: data.id, username: data.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: data });
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const { data: user, error } = await supabase.from('users').select('*').eq('username', username).single();
  if (error || !user) return res.status(401).json({ error: 'Invalid credentials' });
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, created_at: user.created_at } });
});

// ── Profile ──
app.post('/profile', requireAuth, async (req, res) => {
  const { full_name, email, phone, address_line1, address_line2, city, state, zip, country } = req.body;
  if (!full_name || !phone || !address_line1 || !city || !state || !zip) {
    return res.status(400).json({ error: 'full_name, phone, address_line1, city, state, zip are required' });
  }

  // Check if existing profile is already approved/blocked — don't allow edit
  const { data: existing } = await supabase.from('profiles').select('status').eq('user_id', req.user.id).single();
  if (existing && (existing.status === 'approved' || existing.status === 'blocked')) {
    return res.status(400).json({ error: `Profile is ${existing.status} and cannot be edited` });
  }

  const profileData = {
    user_id: String(req.user.id),
    full_name, email, phone, address_line1, address_line2,
    city, state, zip, country: country || 'US',
    status: 'pending',
  };

  const { data, error } = await supabase
    .from('profiles')
    .upsert(profileData, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Failed to save profile' });
  res.json(data);
});

app.get('/profile/:userId', requireAuth, async (req, res) => {
  // Users can only fetch their own profile; admin can fetch any
  if (req.user.id !== req.params.userId && req.user.username !== ADMIN_USERNAME) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { data, error } = await supabase.from('profiles').select('*').eq('user_id', req.params.userId).single();
  if (error || !data) return res.status(404).json({ error: 'Profile not found' });
  res.json(data);
});

// Convenience: get own profile
app.get('/profile', requireAuth, async (req, res) => {
  const { data } = await supabase.from('profiles').select('*').eq('user_id', String(req.user.id)).single();
  res.json(data || null);
});

// ── Stripe: create SetupIntent (save card on file) ──
app.post('/create-setup-intent', requireAuth, async (req, res) => {
  try {
    // Get or create Stripe customer
    let customerId;
    const { data: profile } = await supabase.from('profiles').select('stripe_customer_id').eq('user_id', String(req.user.id)).single();

    if (profile?.stripe_customer_id) {
      customerId = profile.stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        metadata: { user_id: String(req.user.id), username: req.user.username },
      });
      customerId = customer.id;
      // Store customer ID — profile may not exist yet so use upsert
      await supabase.from('profiles').upsert({ user_id: String(req.user.id), stripe_customer_id: customerId }, { onConflict: 'user_id' });
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
    });

    res.json({ client_secret: setupIntent.client_secret, customer_id: customerId });
  } catch (e) {
    console.error('SetupIntent error:', e.message);
    res.status(500).json({ error: 'Failed to create setup intent' });
  }
});

// Called with the confirmed payment method ID after SetupIntent confirms
app.post('/save-payment-method', requireAuth, async (req, res) => {
  const { payment_method_id, customer_id } = req.body;
  if (!payment_method_id) return res.status(400).json({ error: 'payment_method_id required' });
  try {
    // Attach to customer if needed
    await stripe.paymentMethods.attach(payment_method_id, { customer: customer_id });
    await stripe.customers.update(customer_id, { invoice_settings: { default_payment_method: payment_method_id } });

    await supabase.from('profiles').update({ stripe_payment_method_id: payment_method_id, payment_status: 'ok' })
      .eq('user_id', String(req.user.id));

    res.json({ success: true });
  } catch (e) {
    console.error('Save payment method error:', e.message);
    res.status(500).json({ error: 'Failed to save payment method' });
  }
});

// ── Stripe: charge winner ──
app.post('/charge-winner', requireAuth, async (req, res) => {
  const { auction_id, winner_username, amount_cents } = req.body;
  if (!auction_id || !winner_username || !amount_cents) {
    return res.status(400).json({ error: 'auction_id, winner_username, amount_cents required' });
  }

  // Must be admin or host
  const { data: auction } = await supabase.from('auctions').select('host_username').eq('id', auction_id).single();
  if (!auction) return res.status(404).json({ error: 'Auction not found' });
  if (req.user.username !== ADMIN_USERNAME && req.user.username !== auction.host_username) {
    return res.status(403).json({ error: 'Not authorized to charge' });
  }

  // Get winner's user_id
  const { data: winner } = await supabase.from('users').select('id').eq('username', winner_username).single();
  if (!winner) return res.status(404).json({ error: 'Winner not found' });

  const { data: profile } = await supabase.from('profiles').select('stripe_customer_id, stripe_payment_method_id').eq('user_id', String(winner.id)).single();
  if (!profile?.stripe_payment_method_id) {
    return res.status(400).json({ error: 'Winner has no payment method on file' });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount_cents,
      currency: 'usd',
      customer: profile.stripe_customer_id,
      payment_method: profile.stripe_payment_method_id,
      confirm: true,
      off_session: true,
      metadata: { auction_id, winner_username },
    });

    await supabase.from('profiles').update({ payment_status: 'ok' }).eq('user_id', String(winner.id));
    res.json({ success: true, payment_intent_id: paymentIntent.id });
  } catch (e) {
    console.error('Charge error:', e.message);
    // Flag payment failed — buyer stays approved, admin decides next steps
    await supabase.from('profiles').update({ payment_status: 'failed' }).eq('user_id', String(winner.id));
    await sendAdminEmail(
      `⚠️ Payment failed — ${winner_username}`,
      `Payment failed for auction ${auction_id}.\nWinner: ${winner_username}\nAmount: $${(amount_cents / 100).toFixed(2)}\nError: ${e.message}`
    );
    res.status(402).json({ error: 'Payment failed', detail: e.message });
  }
});

// ── Stripe webhook ──
app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  if (event.type === 'payment_intent.payment_failed') {
    const pi = event.data.object;
    const { winner_username, auction_id } = pi.metadata;
    if (winner_username) {
      const { data: winnerUser } = await supabase.from('users').select('id').eq('username', winner_username).single();
      if (winnerUser) {
        // Flag only — buyer stays approved, admin handles manually
        await supabase.from('profiles').update({ payment_status: 'failed' }).eq('user_id', String(winnerUser.id));
      }
      await sendAdminEmail(
        `⚠️ Stripe payment failed — ${winner_username}`,
        `Stripe payment_intent.payment_failed\nWinner: ${winner_username}\nAuction: ${auction_id}\nError: ${pi.last_payment_error?.message || 'unknown'}`
      );
    }
  }

  res.json({ received: true });
});

// ── Admin: buyers ──
app.get('/admin/buyers', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.patch('/admin/buyers/:userId', requireAdmin, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'approved', 'rejected', 'blocked'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const { data, error } = await supabase
    .from('profiles')
    .update({ status, reviewed_at: new Date().toISOString(), reviewed_by: req.user.username })
    .eq('user_id', req.params.userId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ error: 'Profile not found' });

  // If blocking, force-disconnect their active sockets
  if (status === 'blocked') {
    const socketIds = userSockets[req.params.userId];
    if (socketIds) {
      for (const sid of socketIds) {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          s.emit('user_blocked', { message: 'You have been removed from this auction.' });
          s.disconnect(true);
        }
      }
      delete userSockets[req.params.userId];
    }
  }

  res.json(data);
});

// ── Auctions ──
app.get('/auctions', async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('auctions')
    .select('id,title,description,image_url,category,starting_bid,current_bid,leading_bidder,status,starts_at,ends_at,host_username,created_at')
    .order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.get('/auction/:id', async (req, res) => {
  const { data, error } = await supabase.from('auctions').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Auction not found' });
  res.json(data);
});

app.post('/auction', requireAuth, async (req, res) => {
  const { title, description, image_url, category, starting_bid, starts_at, ends_at } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  if (!starting_bid || starting_bid < 1) return res.status(400).json({ error: 'starting_bid must be at least 1' });
  if (!ends_at) return res.status(400).json({ error: 'ends_at is required' });
  if (new Date(ends_at) <= new Date()) return res.status(400).json({ error: 'ends_at must be in the future' });

  const { data, error } = await supabase.from('auctions').insert({
    title, description, image_url, category, starting_bid, current_bid: starting_bid,
    status: starts_at && new Date(starts_at) > new Date() ? 'upcoming' : 'live',
    starts_at: starts_at || new Date().toISOString(), ends_at,
    host_username: req.user.username
  }).select().single();

  if (error) return res.status(500).json({ error: 'Failed to create auction' });
  res.status(201).json(data);
});

app.get('/auction/:id/token', requireAuth, async (req, res) => {
  const { data: auction } = await supabase.from('auctions').select('host_username').eq('id', req.params.id).single();
  if (!auction) return res.status(404).json({ error: 'Auction not found' });
  const isHost = auction.host_username === req.user.username;
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity: req.user.username, ttl: '4h' });
  at.addGrant({ roomJoin: true, room: 'auction-' + req.params.id, canPublish: isHost, canSubscribe: true, canPublishData: true });
  res.json({ token: await at.toJwt(), room: 'auction-' + req.params.id, url: process.env.LIVEKIT_URL, isHost });
});

app.get('/auction/:id/bids', async (req, res) => {
  const { data, error } = await supabase.from('bids').select('*').eq('auction_id', req.params.id).order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.get('/auction/:id/chat', async (req, res) => {
  const { data, error } = await supabase.from('chat_messages').select('*').eq('auction_id', req.params.id).eq('flagged', false).order('created_at', { ascending: true }).limit(100);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// ════════════════════════════════════════════
// AUCTION LIFECYCLE
// ════════════════════════════════════════════

const viewers = {};
const auctionTimers = {};
const userSockets = {}; // userId (string) -> Set of socket IDs

function startAuctionTimer(auctionId, endsAt) {
  if (auctionTimers[auctionId]) return;
  auctionTimers[auctionId] = setInterval(async () => {
    const remaining = Math.max(0, Math.floor((new Date(endsAt) - Date.now()) / 1000));
    io.to(auctionId).emit('time_remaining', { auctionId, seconds: remaining });
    if (remaining <= 0) {
      clearInterval(auctionTimers[auctionId]);
      delete auctionTimers[auctionId];
      const { data: auction } = await supabase.from('auctions').update({ status: 'ended' }).eq('id', auctionId).eq('status', 'live').select().single();
      if (auction) {
        io.to(auctionId).emit('auction_ended', { auctionId, winner: auction.leading_bidder, final_bid: auction.current_bid });
        console.log(`🏁 Auction ${auctionId} ended — winner: ${auction.leading_bidder} at $${auction.current_bid}`);
      }
    }
  }, 1000);
}

async function resumeLiveAuctions() {
  const { data: liveAuctions } = await supabase.from('auctions').select('id, ends_at').eq('status', 'live');
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

  socket.on('join_auction', async ({ auctionId, token } = {}) => {
    // Support legacy string-only calls
    if (typeof auctionId === 'string' && !token) { /* auctionId already set */ }

    const user = token ? verifySocketToken(token) : null;

    // Check approval status for authenticated users
    if (user) {
      socket.userId = String(user.id);
      socket.username = user.username;

      // Track socket by userId for force-disconnect
      if (!userSockets[socket.userId]) userSockets[socket.userId] = new Set();
      userSockets[socket.userId].add(socket.id);

      // Hosts (whatthefind) skip the buyer approval check
      if (user.username !== ADMIN_USERNAME) {
        const { data: profile } = await supabase.from('profiles').select('status').eq('user_id', socket.userId).single();
        if (!profile) {
          socket.emit('auction_error', { code: 'no_profile', message: 'You must complete your buyer profile before joining an auction.' });
          return;
        }
        if (profile.status === 'blocked') {
          socket.emit('auction_error', { code: 'blocked', message: 'You have been removed from this auction.' });
          return;
        }
        if (profile.status !== 'approved') {
          socket.emit('auction_error', { code: 'pending', message: 'Your account is pending admin approval before you can participate.' });
          return;
        }
      }
    }

    socket.join(auctionId);
    socket.auctionId = auctionId;

    if (!viewers[auctionId]) viewers[auctionId] = new Set();
    viewers[auctionId].add(socket.id);
    io.to(auctionId).emit('viewer_count', viewers[auctionId].size);

    const { data: auction } = await supabase.from('auctions').select('*').eq('id', auctionId).single();
    if (auction) {
      socket.emit('auction_state', auction);
      if (auction.status === 'live' && auction.ends_at) startAuctionTimer(auctionId, auction.ends_at);
    }

    const { data: bids } = await supabase.from('bids').select('*').eq('auction_id', auctionId).order('created_at', { ascending: false }).limit(20);
    if (bids) socket.emit('bid_history', bids);

    const { data: chatHistory } = await supabase.from('chat_messages').select('*').eq('auction_id', auctionId).eq('flagged', false).order('created_at', { ascending: true }).limit(50);
    if (chatHistory) socket.emit('chat_history', chatHistory);

    console.log(`👁 ${socket.id} joined auction ${auctionId} — ${viewers[auctionId].size} watching`);
  });

  socket.on('place_bid', async ({ auctionId, amount, token }) => {
    const user = verifySocketToken(token);
    if (!user) { socket.emit('bid_error', { message: 'You must be logged in to bid' }); return; }

    // Re-check approval
    if (user.username !== ADMIN_USERNAME) {
      const { data: profile } = await supabase.from('profiles').select('status').eq('user_id', String(user.id)).single();
      if (!profile || profile.status !== 'approved') {
        socket.emit('bid_error', { message: 'Your account must be approved to bid' }); return;
      }
    }

    const { data, error } = await supabase.rpc('place_bid', { p_auction_id: auctionId, p_username: user.username, p_amount: amount });
    if (error || !data.success) { socket.emit('bid_error', { message: (data && data.error) || 'Failed to place bid' }); return; }

    io.to(auctionId).emit('new_bid', data.bid);
    io.to(auctionId).emit('new_chat', { type: 'bid', text: `💰 ${user.username} bid $${amount}`, auction_id: auctionId, created_at: new Date().toISOString() });
    console.log(`💰 ${user.username} bid $${amount} on auction ${auctionId}`);
  });

  socket.on('send_chat', async ({ auctionId, text, token }) => {
    const user = verifySocketToken(token);
    if (!user) { socket.emit('chat_error', { message: 'You must be logged in to chat' }); return; }
    if (!text || !text.trim()) return;
    const clean = text.trim().slice(0, 200);

    let role = 'viewer';
    const { data: auction } = await supabase.from('auctions').select('host_username, leading_bidder').eq('id', auctionId).single();
    if (auction) {
      if (auction.host_username === user.username) role = 'host';
      else if (auction.leading_bidder === user.username) role = 'bidder';
    }

    const { data: msg, error } = await supabase.from('chat_messages').insert({ auction_id: auctionId, username: user.username, text: clean, role }).select().single();
    if (error) { console.error('Chat save error:', error); return; }

    io.to(auctionId).emit('new_chat', { id: msg.id, type: 'msg', auction_id: auctionId, username: user.username, text: clean, role, created_at: msg.created_at });
  });

  // ── Admin: block user mid-auction ──
  socket.on('block_user', async ({ targetUserId, targetUsername, auctionId, token }) => {
    const admin = verifySocketToken(token);
    if (!admin || admin.username !== ADMIN_USERNAME) {
      socket.emit('host_error', { message: 'Admin only' }); return;
    }

    // Update profile to blocked
    await supabase.from('profiles')
      .update({ status: 'blocked', reviewed_by: admin.username, reviewed_at: new Date().toISOString() })
      .eq('user_id', String(targetUserId));

    // Flag their recent messages in this auction
    if (targetUsername) {
      await supabase.from('chat_messages').update({ flagged: true }).eq('auction_id', auctionId).eq('username', targetUsername);
      // Tell all clients to hide that user's messages
      io.to(auctionId).emit('messages_flagged', { username: targetUsername });
    }

    // Force-disconnect all their sockets
    const socketIds = userSockets[String(targetUserId)];
    if (socketIds) {
      for (const sid of socketIds) {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          s.emit('user_blocked', { message: 'You have been removed from this auction.' });
          s.disconnect(true);
        }
      }
      delete userSockets[String(targetUserId)];
    }

    socket.emit('block_success', { targetUserId, targetUsername });
    console.log(`🚫 Admin blocked user ${targetUsername} (${targetUserId}) from auction ${auctionId}`);
  });

  socket.on('start_auction', async ({ auctionId, token }) => {
    const user = verifySocketToken(token);
    if (!user) return socket.emit('host_error', { message: 'Unauthorized' });
    const { data: auction } = await supabase.from('auctions').select('host_username, status, ends_at').eq('id', auctionId).single();
    if (!auction || auction.host_username !== user.username) return socket.emit('host_error', { message: 'Only the host can start this auction' });
    if (auction.status !== 'upcoming') return socket.emit('host_error', { message: 'Auction is already live or ended' });
    await supabase.from('auctions').update({ status: 'live', starts_at: new Date().toISOString() }).eq('id', auctionId);
    io.to(auctionId).emit('auction_started', { auctionId });
    startAuctionTimer(auctionId, auction.ends_at);
    console.log(`▶️ Host ${user.username} started auction ${auctionId}`);
  });

  socket.on('end_auction', async ({ auctionId, token }) => {
    const user = verifySocketToken(token);
    if (!user) return socket.emit('host_error', { message: 'Unauthorized' });
    const { data: auction } = await supabase.from('auctions').select('host_username, leading_bidder, current_bid').eq('id', auctionId).single();
    if (!auction || auction.host_username !== user.username) return socket.emit('host_error', { message: 'Only the host can end this auction' });
    if (auctionTimers[auctionId]) { clearInterval(auctionTimers[auctionId]); delete auctionTimers[auctionId]; }
    await supabase.from('auctions').update({ status: 'ended' }).eq('id', auctionId);
    io.to(auctionId).emit('auction_ended', { auctionId, winner: auction.leading_bidder, final_bid: auction.current_bid });
    console.log(`🛑 Host ${user.username} ended auction ${auctionId} early`);
  });

  socket.on('extend_auction', async ({ auctionId, extraSeconds, token }) => {
    const user = verifySocketToken(token);
    if (!user) return socket.emit('host_error', { message: 'Unauthorized' });
    const { data: auction } = await supabase.from('auctions').select('host_username, ends_at, status').eq('id', auctionId).single();
    if (!auction || auction.host_username !== user.username) return socket.emit('host_error', { message: 'Only the host can extend this auction' });
    if (auction.status !== 'live') return socket.emit('host_error', { message: 'Can only extend a live auction' });
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
    // Clean up userSockets tracking
    if (socket.userId && userSockets[socket.userId]) {
      userSockets[socket.userId].delete(socket.id);
      if (userSockets[socket.userId].size === 0) delete userSockets[socket.userId];
    }
    console.log(`❌ User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, async () => {
  console.log(`🚀 WhatTheFind Live server running on port ${PORT}`);
  await resumeLiveAuctions();
});
