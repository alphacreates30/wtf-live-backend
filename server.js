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
const aiLots = require('./ai_lots');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// -- Stripe webhook needs raw body --
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(cors());
// 60mb to accommodate base64 photo batches on the AI lot endpoints - Express
// only applies the first body parser it hits, so a route-specific limit
// declared later (e.g. on /ai/analyze-lot) never overrides this default.
app.use(express.json({ limit: '60mb' }));

// -- Clients --
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const ADMIN_USERNAME = 'whatthefind';

// -- Email transport (Nodemailer - set SMTP_* env vars or swap for Resend) --
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

// -- Auth middleware --
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

// ------------------------------------------------------------
// REST ENDPOINTS
// ------------------------------------------------------------

app.get('/', (req, res) => res.json({ status: 'WhatTheFind Live is running' }));

// -- Auth --
app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (username.length < 3 || username.length > 30) return res.status(400).json({ error: 'Username must be 3-30 characters' });
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

// -- Profile --
app.post('/auth/change-password', requireAdmin, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ error: 'current_password and new_password required' });
  if (new_password.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const { data: user } = await supabase.from('users').select('*').eq('username', ADMIN_USERNAME).single();
  if (!user) return res.status(404).json({ error: 'Admin user not found' });
  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
  const password_hash = await bcrypt.hash(new_password, 10);
  const { error: updateErr } = await supabase.from('users').update({ password_hash }).eq('username', ADMIN_USERNAME);
  if (updateErr) return res.status(500).json({ error: 'Failed to update password' });
  res.json({ success: true });
});

app.post('/profile', requireAuth, async (req, res) => {
  const { full_name, email, phone, address_line1, address_line2, city, state, zip, country } = req.body;
  if (!full_name || !phone || !address_line1 || !city || !state || !zip) {
    return res.status(400).json({ error: 'full_name, phone, address_line1, city, state, zip are required' });
  }

  // Check if existing profile is already approved/blocked - don't allow edit
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

// -- Stripe: create SetupIntent (save card on file) --
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
      // Store customer ID - profile may not exist yet so use upsert
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

// -- Stripe: charge winner --
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
    // Flag payment failed - buyer stays approved, admin decides next steps
    await supabase.from('profiles').update({ payment_status: 'failed' }).eq('user_id', String(winner.id));
    await sendAdminEmail(
      `Payment failed - ${winner_username}`,
      `Payment failed for auction ${auction_id}.\nWinner: ${winner_username}\nAmount: $${(amount_cents / 100).toFixed(2)}\nError: ${e.message}`
    );
    res.status(402).json({ error: 'Payment failed', detail: e.message });
  }
});

// -- Stripe webhook --
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
        // Flag only - buyer stays approved, admin handles manually
        await supabase.from('profiles').update({ payment_status: 'failed' }).eq('user_id', String(winnerUser.id));
      }
      await sendAdminEmail(
        `Stripe payment failed - ${winner_username}`,
        `Stripe payment_intent.payment_failed\nWinner: ${winner_username}\nAuction: ${auction_id}\nError: ${pi.last_payment_error?.message || 'unknown'}`
      );
    }
  }

  res.json({ received: true });
});

// -- Admin: buyers --
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

// -- Auctions --
// -- My Bids / My Wins --
app.get('/my-bids', requireAuth, async (req, res) => {
  const username = req.user.username

  // Gather this user's activity from BOTH sources:
  // - pre_bids: max bids placed before the auction opened
  // - bids:     actual bids placed while the auction was running
  const [{ data: prebids }, { data: liveBids }] = await Promise.all([
    supabase.from('pre_bids').select('item_id, auction_id, max_amount').eq('buyer_username', username),
    supabase.from('bids').select('item_id, auction_id, amount').eq('username', username).not('item_id', 'is', null),
  ])

  // Highest max per item from pre-bids
  const preByItem = {}
  for (const p of prebids || []) {
    const amt = parseFloat(p.max_amount) || 0
    if (!preByItem[p.item_id] || amt > preByItem[p.item_id]) preByItem[p.item_id] = amt
  }

  // Highest amount per item from live bids
  const liveByItem = {}
  for (const b of liveBids || []) {
    const amt = parseFloat(b.amount) || 0
    if (!liveByItem[b.item_id] || amt > liveByItem[b.item_id]) liveByItem[b.item_id] = amt
  }

  const itemIds = [...new Set([...Object.keys(preByItem), ...Object.keys(liveByItem)])]
  if (!itemIds.length) return res.json([])

  const { data: items, error: itemsErr } = await supabase
    .from('auction_items')
    .select('id, position, title, current_bid, leading_bidder, status, ends_at, auction_id')
    .in('id', itemIds)
  if (itemsErr) return res.status(500).json({ error: 'Failed to load items' })

  const auctionIds = [...new Set((items || []).map(i => i.auction_id))]
  const { data: auctions } = await supabase
    .from('auctions').select('id, title, status, mode').in('id', auctionIds)
  const auctionMap = Object.fromEntries((auctions || []).map(a => [a.id, a]))

  const result = (items || []).map(item => {
    const myMax = Math.max(preByItem[item.id] || 0, liveByItem[item.id] || 0)
    return {
      ...item,
      lot_number: item.position != null ? item.position + 1 : null,
      max_bid: myMax || null,
      won: item.leading_bidder === username,
      closed: item.status === 'sold' || item.status === 'unsold',
      auction: auctionMap[item.auction_id] || null,
    }
  }).sort((a, b) => new Date(b.ends_at) - new Date(a.ends_at))

  res.json(result)
})

app.get('/auctions', async (req, res) => {
  const { status } = req.query;
  let query = supabase.from('auctions')
        .select('id,title,description,image_url,category,starting_bid,current_bid,leading_bidder,status,starts_at,ends_at,mode,host_username,created_at')
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
  const { title, description, image_url, category, starting_bid, starts_at, ends_at, mode } = req.body;
    const auctionMode = mode === 'standard' ? 'standard' : 'live';
    if (!title) return res.status(400).json({ error: 'title is required' });
    // Standard auction lots start at $0.00 by design - only reject missing/negative.
    if (starting_bid == null || Number(starting_bid) < 0) return res.status(400).json({ error: 'starting_bid must be 0 or more' });
      if (ends_at && new Date(ends_at) <= new Date()) return res.status(400).json({ error: 'ends_at must be in the future' });
  const { data, error } = await supabase.from('auctions').insert({
    title, description, image_url, category, starting_bid, current_bid: starting_bid,
        status: starts_at && new Date(starts_at) > new Date() ? 'upcoming' : 'live',
        starts_at: starts_at || new Date().toISOString(), ends_at: ends_at || null,
        mode: auctionMode,
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


app.delete('/auction/:id', requireAdmin, async (req, res) => {
  await supabase.from('auction_items').delete().eq('auction_id', req.params.id);
  await supabase.from('bids').delete().eq('auction_id', req.params.id);
  await supabase.from('chat_messages').delete().eq('auction_id', req.params.id);
  await supabase.from('auctions').delete().eq('id', req.params.id);
  res.json({ success: true });
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

// ------------------------------------------------------------
// AUCTION LIFECYCLE
// ------------------------------------------------------------

const viewers = {};
const auctionTimers = {};
const itemTimers = {}; // auctionId -> interval
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
        await createOrderOnWin(auctionId, auction.leading_bidder, auction.current_bid);
        console.log(`- Auction ${auctionId} ended - winner: ${auction.leading_bidder} at $${auction.current_bid}`);
      }
    }
  }, 1000);
}


function startItemTimer(auctionId, seconds) {
  if (itemTimers[auctionId]) { clearInterval(itemTimers[auctionId].interval); delete itemTimers[auctionId]; }
  itemTimers[auctionId] = { remaining: seconds };
  itemTimers[auctionId].interval = setInterval(() => {
    if (!itemTimers[auctionId]) return;
    itemTimers[auctionId].remaining--;
    io.to(auctionId).emit('item_timer_tick', { seconds: itemTimers[auctionId].remaining });
    if (itemTimers[auctionId].remaining <= 0) { clearInterval(itemTimers[auctionId].interval); delete itemTimers[auctionId]; }
  }, 1000);
}

async function resumeLiveAuctions() {
  const { data: liveAuctions } = await supabase.from('auctions').select('id, ends_at').eq('status', 'live');
  if (!liveAuctions) return;
  for (const auction of liveAuctions) {
    console.log(`- Resuming timer for auction ${auction.id}`);
    startAuctionTimer(auction.id, auction.ends_at);
  }
}
// NOTE: superseded by autoCloseStandardItems(), which is now the single
// source of truth for closing standard lots. Kept as a no-op so any stray
// callers don't crash. Do not re-enable: two closers caused a race where
// orders were silently skipped.
async function sweepExpiredStandardItems() { /* intentionally disabled */ }

// ------------------------------------------------------------
// SOCKET.IO
// ------------------------------------------------------------

io.on('connection', (socket) => {
  console.log(`- User connected: ${socket.id}`);

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

    console.log(`- ${socket.id} joined auction ${auctionId} - ${viewers[auctionId].size} watching`);
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
    // Snipe protection: last-second bid adds 5s
    if (itemTimers[auctionId] && itemTimers[auctionId].remaining > 0 && itemTimers[auctionId].remaining <= 5) {
      startItemTimer(auctionId, 5);
      io.to(auctionId).emit('item_timer_tick', { seconds: 5 });
    }
    console.log(`- -  ${user.username} bid $${amount} on auction ${auctionId}`);
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

  // -- Admin: block user mid-auction --
    socket.on('block_user', async ({ targetUserId, targetUsername, auctionId, token }) => {
    const admin = verifySocketToken(token);
    if (!admin || admin.username !== ADMIN_USERNAME) {
      socket.emit('host_error', { message: 'Admin only' }); return;
    }

    // Resolve actual UUID - frontend passes username as targetUserId placeholder
    let resolvedUserId = String(targetUserId);
    if (targetUsername) {
      const { data: targetUser } = await supabase.from('users').select('id').eq('username', targetUsername).single();
      if (targetUser) resolvedUserId = String(targetUser.id);
    }

    // Update profile to blocked
    await supabase.from('profiles')
      .update({ status: 'blocked', reviewed_by: admin.username, reviewed_at: new Date().toISOString() })
      .eq('user_id', resolvedUserId);

    // Flag their recent messages in this auction
    if (targetUsername) {
      await supabase.from('chat_messages').update({ flagged: true }).eq('auction_id', auctionId).eq('username', targetUsername);
      // Tell all clients to hide that user's messages
      io.to(auctionId).emit('messages_flagged', { username: targetUsername });
    }

    // Force-disconnect all their sockets
    const socketIds = userSockets[resolvedUserId];
    if (socketIds) {
      for (const sid of socketIds) {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          s.emit('user_blocked', { message: 'You have been removed from this auction.' });
          s.disconnect(true);
        }
      }
      delete userSockets[resolvedUserId];
    }

    socket.emit('block_success', { targetUserId: resolvedUserId, targetUsername });
    console.log(`- Admin blocked user ${targetUsername} (${resolvedUserId}) from auction ${auctionId}`);
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
    console.log(`- Host ${user.username} started auction ${auctionId}`);
  });

  socket.on('end_auction', async ({ auctionId, token }) => {
    const user = verifySocketToken(token);
    if (!user) return socket.emit('host_error', { message: 'Unauthorized' });
    const { data: auction } = await supabase.from('auctions').select('host_username, leading_bidder, current_bid').eq('id', auctionId).single();
    if (!auction || auction.host_username !== user.username) return socket.emit('host_error', { message: 'Only the host can end this auction' });
    if (auctionTimers[auctionId]) { clearInterval(auctionTimers[auctionId]); delete auctionTimers[auctionId]; }
    await supabase.from('auctions').update({ status: 'ended' }).eq('id', auctionId);
    await createOrderOnWin(auctionId, auction.leading_bidder, auction.current_bid);
    io.to(auctionId).emit('auction_ended', { auctionId, winner: auction.leading_bidder, final_bid: auction.current_bid });
    console.log(`- Host ${user.username} ended auction ${auctionId} early`);
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
    console.log(`- Host ${user.username} extended auction ${auctionId} by ${extraSeconds}s`);
  });


  socket.on('next_item', async ({ auctionId, token, timerSeconds = 60 }) => {
    const user = verifySocketToken(token);
    if (!user || user.username !== ADMIN_USERNAME) return socket.emit('host_error', { message: 'Admin only' });
    await supabase.from('auction_items').update({ status: 'sold' }).eq('auction_id', auctionId).eq('status', 'active');
    const { data: nextItem } = await supabase.from('auction_items').select('*').eq('auction_id', auctionId).eq('status', 'pending').order('position', { ascending: true }).limit(1).single();
    if (!nextItem) { if (itemTimers[auctionId]) { clearInterval(itemTimers[auctionId].interval); delete itemTimers[auctionId]; } io.to(auctionId).emit('items_finished', { auctionId }); return; }
    const { data: preBids } = await supabase.from('pre_bids').select('*').eq('item_id', nextItem.id).order('max_amount', { ascending: false });
    let openingBid = parseFloat(nextItem.starting_bid);
    let openingBidder = null;
    if (preBids && preBids.length) { openingBid = Math.max(openingBid, parseFloat(preBids[0].max_amount)); openingBidder = preBids[0].buyer_username; }
    const { data: activeItem } = await supabase.from('auction_items').update({ status: 'active', current_bid: openingBid, leading_bidder: openingBidder }).eq('id', nextItem.id).select().single();
  await supabase.from('auctions').update({ current_bid: openingBid, leading_bidder: openingBidder || null }).eq('id', auctionId);
    const ts = timerSeconds || 60;
  startItemTimer(auctionId, ts);
  io.to(auctionId).emit('item_timer_tick', { seconds: ts });
  io.to(auctionId).emit('item_activated', { item: activeItem, pre_bid_count: preBids ? preBids.length : 0, timer_seconds: ts });
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
    console.log(`- User disconnected: ${socket.id}`);
  });
});


// ------------------------------------------------------------
// ORDERS & SHIPPO
// ------------------------------------------------------------

const SHIPPO_API_KEY = process.env.SHIPPO_API_KEY;

async function shippoFetch(method, path, body) {
  const res = await fetch('https://api.goshippo.com' + path, {
    method,
    headers: {
      'Authorization': 'ShippoToken ' + SHIPPO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function createOrderOnWin(auctionId, winnerUsername, finalBid, itemId) {
  if (!winnerUsername) return;
  try {
    // Idempotency: never create a second order for the same lot
    if (itemId) {
      const { data: existing } = await supabase
        .from('orders').select('id').eq('item_id', itemId).limit(1);
      if (existing && existing.length) return;
    }

    const { data: winner } = await supabase.from('users').select('id').eq('username', winnerUsername).single();
    if (!winner) return;
    const { data: profile } = await supabase.from('profiles').select('*').eq('user_id', String(winner.id)).single();
    const { data: auction } = await supabase.from('auctions').select('title, description').eq('id', auctionId).single();
    if (!auction) return;

    // Use the actual LOT title/description when we have an item; fall back to the auction
    let itemTitle = auction.title;
    let itemDescription = auction.description || '';
    if (itemId) {
      const { data: lot } = await supabase
        .from('auction_items').select('title, description, position').eq('id', itemId).single();
      if (lot) {
        const lotNo = lot.position != null ? `Lot ${lot.position + 1}: ` : '';
        itemTitle = `${lotNo}${lot.title}`;
        itemDescription = lot.description || '';
      }
    }

    await supabase.from('orders').insert({
      auction_id: auctionId,
      item_id: itemId || null,
      buyer_username: winnerUsername,
      buyer_user_id: String(winner.id),
      item_title: itemTitle,
      item_description: itemDescription,
      final_bid: finalBid || 0,
      ship_name: profile?.full_name || '',
      ship_address1: profile?.address_line1 || '',
      ship_address2: profile?.address_line2 || '',
      ship_city: profile?.city || '',
      ship_state: profile?.state || '',
      ship_zip: profile?.zip || '',
      ship_country: profile?.country || 'US',
      status: 'pending',
    });
    console.log('Order created for ' + winnerUsername + ' - auction ' + auctionId + (itemId ? ' item ' + itemId : ''));
  } catch (e) {
    console.error('Order creation error:', e.message);
  }
}

app.get('/admin/orders', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/admin/orders/label', requireAdmin, async (req, res) => {
  const { order_ids } = req.body;
  if (!order_ids?.length) return res.status(400).json({ error: 'order_ids required' });

  const { data: orders } = await supabase.from('orders').select('*').in('id', order_ids);
  if (!orders?.length) return res.status(404).json({ error: 'Orders not found' });

  const o = orders[0];
  const itemsSummary = orders.map(x => x.item_title).join(', ');

  if (!SHIPPO_API_KEY) return res.status(500).json({ error: 'SHIPPO_API_KEY not configured' });

  try {
    const shipment = await shippoFetch('POST', '/shipments/', {
      address_from: {
        name: process.env.SHIP_FROM_NAME || 'WhatTheFind',
        street1: process.env.SHIP_FROM_STREET1 || '',
        city: process.env.SHIP_FROM_CITY || '',
        state: process.env.SHIP_FROM_STATE || '',
        zip: process.env.SHIP_FROM_ZIP || '',
        country: process.env.SHIP_FROM_COUNTRY || 'US',
      },
      address_to: {
        name: o.ship_name,
        street1: o.ship_address1,
        street2: o.ship_address2 || '',
        city: o.ship_city,
        state: o.ship_state,
        zip: o.ship_zip,
        country: o.ship_country || 'US',
      },
      parcels: [{
        length: '12', width: '10', height: '6',
        distance_unit: 'in',
        weight: '2',
        mass_unit: 'lb',
      }],
      async: false,
      metadata: itemsSummary,
    });

    if (!shipment.rates?.length) {
      return res.status(400).json({ error: 'No shipping rates available', detail: shipment.messages });
    }

    const rate = shipment.rates.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))[0];
    const transaction = await shippoFetch('POST', '/transactions/', {
      rate: rate.object_id,
      label_file_type: 'PDF',
      async: false,
    });

    if (transaction.status !== 'SUCCESS') {
      return res.status(400).json({ error: 'Label generation failed', detail: transaction.messages });
    }

    const groupId = orders[0].group_id || orders[0].id;
    await supabase.from('orders').update({
      status: 'label_created',
      group_id: groupId,
      shippo_transaction_id: transaction.object_id,
      label_url: transaction.label_url,
      tracking_number: transaction.tracking_number,
      tracking_carrier: transaction.tracking_carrier_account,
    }).in('id', order_ids);

    res.json({
      label_url: transaction.label_url,
      tracking_number: transaction.tracking_number,
    });
  } catch (e) {
    console.error('Shippo error:', e.message);
    res.status(500).json({ error: 'Shippo request failed', detail: e.message });
  }
});

app.post('/admin/orders/group', requireAdmin, async (req, res) => {
  const { order_ids } = req.body;
  if (!order_ids?.length) return res.status(400).json({ error: 'order_ids required' });
  const groupId = require('crypto').randomUUID();
  await supabase.from('orders').update({ group_id: groupId }).in('id', order_ids);
  res.json({ group_id: groupId });
});

app.post('/admin/orders/:id/ungroup', requireAdmin, async (req, res) => {
  await supabase.from('orders').update({ group_id: null }).eq('id', req.params.id);
  res.json({ success: true });
});

app.patch('/admin/orders/:id/status', requireAdmin, async (req, res) => {
  const { status } = req.body;
  const valid = ['pending', 'label_created', 'shipped', 'delivered'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const { data, error } = await supabase.from('orders').update({ status }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/webhook/shippo', async (req, res) => {
  try {
    const event = req.body;
    if (event.event === 'track_updated') {
      const tracking_number = event.data?.tracking_number;
      const shippoStatus = event.data?.tracking_status?.status;
      let status;
      if (shippoStatus === 'TRANSIT' || shippoStatus === 'PRE_TRANSIT') status = 'shipped';
      if (shippoStatus === 'DELIVERED') status = 'delivered';
      if (status && tracking_number) {
        await supabase.from('orders').update({ status }).eq('tracking_number', tracking_number);
        console.log('- Tracking update: ' + tracking_number + ' -> ' + status);
      }
    }
  } catch (e) {
    console.error('Shippo webhook error:', e.message);
  }
  res.json({ received: true });
});


// AUCTION ITEMS AND PRE-BIDS

app.get('/auction/:id/items', async (req, res) => {
  const { data, error } = await supabase
    .from('auction_items').select('*').eq('auction_id', req.params.id).order('position', { ascending: true });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.post('/auction/:id/items', requireAdmin, async (req, res) => {
  const { title, description, image_url, starting_bid, ends_at } = req.body;
      if (!title) return res.status(400).json({ error: 'title is required' });
      const { data: ex } = await supabase.from('auction_items').select('position').eq('auction_id', req.params.id).order('position', { ascending: false }).limit(1);
      const position = ex && ex.length ? ex[0].position + 1 : 0;
      const { data: auctionRow } = await supabase.from('auctions').select('mode').eq('id', req.params.id).single();
      const isStandard = auctionRow && auctionRow.mode === 'standard';
      const { data, error } = await supabase.from('auction_items').insert({ auction_id: req.params.id, title, description, image_url, starting_bid: starting_bid ?? 0, position, status: isStandard ? 'open' : 'pending', current_bid: isStandard ? (starting_bid ?? 0) : null, ends_at: isStandard ? (ends_at || null) : null }).select().single();
      if (error) return res.status(500).json({ error });
  res.status(201).json(data);
});

app.patch('/auction/:id/items/:itemId', requireAdmin, async (req, res) => {
  const { title, description, image_url, starting_bid, position, ends_at } = req.body;
  const u = {};
  if (title !== undefined) u.title = title;
  if (description !== undefined) u.description = description;
  if (image_url !== undefined) u.image_url = image_url;
  if (starting_bid !== undefined) u.starting_bid = starting_bid;
  if (position !== undefined) u.position = position;
      if (ends_at !== undefined) u.ends_at = ends_at;
  const { data, error } = await supabase.from('auction_items').update(u).eq('id', req.params.itemId).eq('auction_id', req.params.id).select().single();
  if (error || !data) return res.status(404).json({ error: 'Item not found' });
  res.json(data);
});

app.delete('/auction/:id/items/:itemId', requireAdmin, async (req, res) => {
  await supabase.from('auction_items').delete().eq('id', req.params.itemId).eq('auction_id', req.params.id);
  res.json({ success: true });
});

app.post('/auction/:id/items/:itemId/prebid', requireAuth, async (req, res) => {
  const { max_amount } = req.body;
  if (!max_amount || max_amount < 1) return res.status(400).json({ error: 'max_amount required' });
  const { data: item } = await supabase.from('auction_items').select('status').eq('id', req.params.itemId).single();
  if (!item) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'pending') return res.status(400).json({ error: 'Pre-bidding closed' });
  const { data, error } = await supabase.from('pre_bids').upsert({ item_id: req.params.itemId, auction_id: req.params.id, buyer_username: req.user.username, buyer_user_id: String(req.user.id), max_amount }, { onConflict: 'item_id,buyer_username' }).select().single();
  if (error) return res.status(500).json({ error });
  const { data: all } = await supabase.from('pre_bids').select('max_amount').eq('item_id', req.params.itemId);
  const top = all ? Math.max(...all.map(b => parseFloat(b.max_amount))) : max_amount;
  await supabase.from('auction_items').update({ pre_bid_count: all ? all.length : 1, top_pre_bid: top }).eq('id', req.params.itemId);
  res.json({ success: true, pre_bid: data });
});

app.get('/auction/:id/items/:itemId/prebid', requireAuth, async (req, res) => {
  const { data } = await supabase.from('pre_bids').select('max_amount').eq('item_id', req.params.itemId).eq('buyer_username', req.user.username).single();
  res.json(data || null);
});

app.delete('/auction/:id/items/:itemId/prebid', requireAuth, async (req, res) => {
  await supabase.from('pre_bids').delete().eq('item_id', req.params.itemId).eq('buyer_username', req.user.username);
  const { data: all } = await supabase.from('pre_bids').select('max_amount').eq('item_id', req.params.itemId);
  const top = all && all.length ? Math.max(...all.map(b => parseFloat(b.max_amount))) : null;
  await supabase.from('auction_items').update({ pre_bid_count: all ? all.length : 0, top_pre_bid: top }).eq('id', req.params.itemId);
  res.json({ success: true });
});

// STANDARD AUCTION: proxy (max) bidding via place_standard_bid RPC
// Soft close: the RPC extends ends_at atomically inside its own
// transaction/row lock when a bid lands inside this window. Passed
// through so the window value lives in one place.
const SOFT_CLOSE_MINUTES = 2;

// Lots open at $0.00, so "current bid + increment" would allow a $0 opening
// bid. This is the floor for the first bid on a lot; every bid after it
// follows the normal increment tiers.
const OPENING_BID_MIN = 1;

app.post('/auction/:id/items/:itemId/bid', requireAuth, async (req, res) => {
  const { max_amount } = req.body;
  if (!max_amount || max_amount < 1) return res.status(400).json({ error: 'max_amount required' });

  // Server-side bid increment validation
  const { data: bidItem } = await supabase
    .from('auction_items')
    .select('current_bid,starting_bid,bid_count,leading_bidder,status,ends_at')
    .eq('id', req.params.itemId).single();
  if (!bidItem) return res.status(404).json({ error: 'Item not found' });
  if (bidItem.status === 'sold' || bidItem.status === 'unsold') return res.status(400).json({ error: 'Lot is closed' });
  if (bidItem.ends_at && new Date(bidItem.ends_at) <= new Date()) return res.status(400).json({ error: 'Lot has closed' });

  const floor = Number(bidItem.current_bid ?? bidItem.starting_bid ?? 0);
  const minInc = floor < 50 ? 1 : floor < 100 ? 2 : floor < 200 ? 5 : floor < 500 ? 10 : floor < 1000 ? 25 : 50;
  const isLeader = bidItem.leading_bidder === req.user.username;
  // Lots start at $0.00, so the opening bid can't just be the floor - it would
  // be $0. OPENING_BID_MIN is the smallest first bid on a lot with no bids yet.
  const minBid = isLeader
    ? floor
    : (bidItem.bid_count > 0 ? floor + minInc : Math.max(floor, OPENING_BID_MIN));
  if (max_amount < minBid) return res.status(400).json({ error: `Min bid: $${minBid.toFixed(2)}` });

  const { data, error } = await supabase.rpc('place_standard_bid', {
    p_item_id: req.params.itemId,
    p_user_id: String(req.user.id),
    p_username: req.user.username,
    p_max_amount: max_amount,
    p_opening_min: OPENING_BID_MIN,
    p_soft_close_minutes: SOFT_CLOSE_MINUTES
  });
  if (error) return res.status(400).json({ error: error.message || 'Bid failed' });

  // The RPC already extended ends_at atomically if this bid landed inside
  // the soft-close window. Detect it by comparing to the pre-call read
  // instead of doing a second write.
  const prevEndsAt = bidItem.ends_at ? new Date(bidItem.ends_at).getTime() : null;
  const newEndsAt = data.ends_at ? new Date(data.ends_at).getTime() : null;
  const extended = prevEndsAt !== null && newEndsAt !== null && newEndsAt !== prevEndsAt;
  if (extended) {
    io.to(req.params.id).emit('item_extended', { item_id: req.params.itemId, ends_at: data.ends_at });
    console.log(`Soft close: lot ${req.params.itemId} extended to ${data.ends_at}`);
  }
  res.json({ ...data, extended });
});

app.get('/auction/:id/items/standard-status', async (req, res) => {
  const { data, error } = await supabase.from('auction_items').select('*').eq('auction_id', req.params.id).order('position', { ascending: true });
  if (error) return res.status(500).json({ error: 'Failed to load items' });
  res.json(data);
});

const PORT = process.env.PORT || 3001;

// ---------------------------------------------------------------------------
// AI bulk lot creation
//
// Grouping and analysis are stateless: the browser holds the photos and sends
// base64 straight to these endpoints. Nothing is written to storage or the DB
// until the host confirms and calls the bulk-create endpoint below, so an
// abandoned batch costs a couple of API calls and no cleanup.
// ---------------------------------------------------------------------------

// JSON bodies of base64 photos are far larger than the default 100kb limit.
const aiJson = express.json({ limit: '60mb' });

// Step 1: which photos belong to the same lot. Thumbnails only - small and
// cheap, since this pass only needs to tell items apart, not read maker marks.
app.post('/ai/group-photos', requireAdmin, aiJson, async (req, res) => {
    const thumbnails = req.body?.thumbnails;
    if (!Array.isArray(thumbnails) || !thumbnails.length) {
        return res.status(400).json({ error: 'thumbnails array is required' });
    }
    if (thumbnails.length > aiLots.PHOTO_SOFT_CAP) {
        return res.status(400).json({
            error: `That's ${thumbnails.length} photos - please keep batches at or under ` +
                   `${aiLots.PHOTO_SOFT_CAP} and split the rest into another batch.`
        });
    }
    try {
        const groups = await aiLots.groupPhotos(thumbnails);
        res.json({ groups, photo_count: thumbnails.length, lot_count: groups.length });
    } catch (e) {
        console.error('AI grouping failed:', e.message);
        res.status(502).json({ error: `AI grouping failed: ${e.message}` });
    }
});

// Step 2: catalogue one confirmed group. Higher-resolution images than step 1,
// because this pass reads labels, signatures and damage.
app.post('/ai/analyze-lot', requireAdmin, aiJson, async (req, res) => {
    const { images, condition } = req.body || {};
    if (!Array.isArray(images) || !images.length) {
        return res.status(400).json({ error: 'images array is required' });
    }
    try {
        const analysis = await aiLots.analyzeLot(images, condition || '');
        res.json(analysis);
    } catch (e) {
        console.error('AI analysis failed:', e.message);
        res.status(502).json({ error: `AI analysis failed: ${e.message}` });
    }
});

// Step 2b: host corrected a wrong title and wants the body rewritten to match.
// Text-only - no photos, so it is fast and cheap.
app.post('/ai/regenerate-description', requireAdmin, async (req, res) => {
    const { title, condition } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title is required' });
    try {
        const result = await aiLots.regenerateDescription(title, condition || '');
        res.json(result);
    } catch (e) {
        console.error('AI regeneration failed:', e.message);
        res.status(502).json({ error: `AI regeneration failed: ${e.message}` });
    }
});

// Step 3: commit the reviewed lots. Images must already be uploaded via
// /upload-image - this takes URLs, not base64, so the payload stays small.
//
// Partial success is deliberate: on a 200-lot batch, failing everything
// because lot 147 had a bad field would be worse than reporting which ones
// failed and keeping the rest.
app.post('/auction/:id/items/bulk', requireAdmin, express.json({ limit: '10mb' }), async (req, res) => {
    const lots = req.body?.lots;
    if (!Array.isArray(lots) || !lots.length) {
        return res.status(400).json({ error: 'lots array is required' });
    }

    const { data: auction } = await supabase.from('auctions').select('id, mode').eq('id', req.params.id).single();
    if (!auction) return res.status(404).json({ error: 'Auction not found' });

    // Append after any lots already on this auction.
    const { data: existing } = await supabase
        .from('auction_items').select('position').eq('auction_id', req.params.id)
        .order('position', { ascending: false }).limit(1);
    let position = existing && existing.length ? (existing[0].position + 1) : 0;

    const created = [];
    const failed = [];

    for (let i = 0; i < lots.length; i++) {
        const lot = lots[i] || {};
        if (!lot.title) { failed.push({ index: i, error: 'title is required' }); continue; }
        try {
            const { data: item, error } = await supabase.from('auction_items').insert({
                auction_id: req.params.id,
                title: lot.title,
                description: lot.description || null,
                condition: lot.condition || null,
                starting_bid: 0,           // every lot opens at $0.00
                current_bid: 0,
                reserve_price: lot.reserve_price != null && lot.reserve_price !== ''
                    ? Number(lot.reserve_price) : null,
                image_url: (lot.image_urls && lot.image_urls[0]) || null,
                position: position++,
                status: 'open',
                ends_at: lot.ends_at || null,
            }).select().single();

            if (error) { failed.push({ index: i, title: lot.title, error: error.message }); continue; }

            // Remaining photos become gallery images for the lot.
            const extra = (lot.image_urls || []).slice(1);
            for (let p = 0; p < extra.length; p++) {
                await supabase.from('item_images').insert({ item_id: item.id, url: extra[p], position: p + 1 });
            }
            created.push({ index: i, id: item.id, title: item.title, position: item.position });
        } catch (e) {
            failed.push({ index: i, title: lot.title, error: e.message });
        }
    }

    res.status(created.length ? 201 : 400).json({
        created_count: created.length,
        failed_count: failed.length,
        created,
        failed,
    });
});

// -- Item Images --
app.get('/auction/:auctionId/items/:itemId/images', async (req, res) => {
    const { data, error } = await supabase
          .from('item_images')
          .select('id, url, position, created_at')
          .eq('item_id', req.params.itemId)
          .order('position', { ascending: true });
    if (error) return res.status(500).json({ error });
    res.json(data || []);
});

app.post('/auction/:auctionId/items/:itemId/images', requireAuth, async (req, res) => {
    const { url, position } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const { data: auction } = await supabase.from('auctions').select('host_username').eq('id', req.params.auctionId).single();
    if (!auction || auction.host_username !== req.user.username) return res.status(403).json({ error: 'Not authorized' });
    const { data, error } = await supabase.from('item_images').insert({ item_id: req.params.itemId, url, position: position ?? 0 }).select().single();
    if (error) return res.status(500).json({ error: 'Failed to add image' });
    res.status(201).json(data);
});

app.delete('/item-image/:imageId', requireAuth, async (req, res) => {
    // Verify the caller actually hosts the auction this image belongs to
    const { data: img } = await supabase
      .from('item_images').select('item_id').eq('id', req.params.imageId).single();
    if (!img) return res.status(404).json({ error: 'Image not found' });

    const { data: item } = await supabase
      .from('auction_items').select('auction_id').eq('id', img.item_id).single();
    if (!item) return res.status(404).json({ error: 'Item not found' });

    const { data: auction } = await supabase
      .from('auctions').select('host_username').eq('id', item.auction_id).single();
    if (!auction) return res.status(404).json({ error: 'Auction not found' });

    if (req.user.username !== ADMIN_USERNAME && req.user.username !== auction.host_username) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { error } = await supabase.from('item_images').delete().eq('id', req.params.imageId);
    if (error) return res.status(500).json({ error: 'Failed to delete image' });
    res.status(204).send();
});

// -- Image upload --
async function initStorage() {
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.some(b => b.name === 'item-images')) {
      await supabase.storage.createBucket('item-images', { public: true, fileSizeLimit: 5242880 });
      console.log('Created item-images bucket');
    }
  } catch (e) { console.error('Storage init error:', e.message); }
}

app.post('/upload-image', requireAuth, express.raw({ type: 'image/*', limit: '5mb' }), async (req, res) => {
  try {
    const mimeType = (req.headers['content-type'] || 'image/jpeg').split(';')[0];
    const buffer = req.body;
    if (!buffer || !buffer.length) return res.status(400).json({ error: 'No image data' });
    const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
    const filePath = `items/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from('item-images')
      .upload(filePath, buffer, { contentType: mimeType, upsert: false });
    if (upErr) return res.status(500).json({ error: upErr.message });
    const { data: { publicUrl } } = supabase.storage.from('item-images').getPublicUrl(filePath);
    res.json({ url: publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

server.keepAliveTimeout = 61000; // keep connections open longer than Railway's proxy timeout
server.headersTimeout = 65000;

// Auto-close standard auction items when their ends_at passes
async function autoCloseStandardItems() {
  try {
    const now = new Date().toISOString()

    // Step 1: Close any items whose ends_at has passed and aren't already closed.
    // This is the ONLY place standard lots get closed - see note on
    // sweepExpiredStandardItems above.
    const { data: expiredItems } = await supabase
      .from('auction_items')
      .select('id, auction_id, bid_count, leading_bidder, current_bid, reserve_price')
      .lt('ends_at', now)
      .not('status', 'in', '("sold","unsold")')

    if (expiredItems?.length) {
      for (const item of expiredItems) {
        const hasWinner = !!item.leading_bidder && item.bid_count > 0

        // Respect a reserve price if one is set
        const reserve = item.reserve_price != null ? parseFloat(item.reserve_price) : null
        const metReserve = reserve == null || parseFloat(item.current_bid || 0) >= reserve

        const sold = hasWinner && metReserve
        const newStatus = sold ? 'sold' : 'unsold'

        const { error: updErr } = await supabase
          .from('auction_items').update({ status: newStatus }).eq('id', item.id)
        if (updErr) { console.error('Close item failed:', item.id, updErr.message); continue }

        // Create the order for the winner. createOrderOnWin is idempotent.
        if (sold) {
          await createOrderOnWin(item.auction_id, item.leading_bidder, item.current_bid, item.id)
        }
        console.log(`Standard item ${item.id} closed: ${newStatus}`)
      }
    }

    // Step 2: End any standard live auctions where ALL items are now closed
    const { data: liveAuctions } = await supabase
      .from('auctions')
      .select('id')
      .eq('mode', 'standard')
      .eq('status', 'live')
    if (!liveAuctions?.length) return

    for (const auction of liveAuctions) {
      const { data: openItems } = await supabase
        .from('auction_items')
        .select('id')
        .eq('auction_id', auction.id)
        .not('status', 'in', '("sold","unsold")')
      if (!openItems?.length) {
        const { data: allItems } = await supabase
          .from('auction_items').select('id').eq('auction_id', auction.id)
        if (allItems?.length > 0) {
          await supabase.from('auctions').update({ status: 'ended' }).eq('id', auction.id)
          console.log('Auto-ended standard auction:', auction.id)
        }
      }
    }
  } catch (e) {
    console.error('autoCloseStandardItems error:', e)
  }
}
setInterval(autoCloseStandardItems, 30000)
autoCloseStandardItems()


server.listen(PORT, async () => {
  console.log(`WhatTheFind Live server running on port ${PORT}`);
  await resumeLiveAuctions();
  initStorage();
});
