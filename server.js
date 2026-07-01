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

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Stripe webhook needs raw body ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json());

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Clients ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const ADMIN_USERNAME = 'whatthefind';

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Email transport (Nodemailer ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ set SMTP_* env vars or swap for Resend) ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
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

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Auth middleware ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
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

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
// REST ENDPOINTS
// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ

app.get('/', (req, res) => res.json({ status: 'WhatTheFind Live is running ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ¥' }));

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Auth ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
app.post('/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (username.length < 3 || username.length > 30) return res.status(400).json({ error: 'Username must be 3ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ30 characters' });
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

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Profile ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
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

  // Check if existing profile is already approved/blocked ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ don't allow edit
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

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Stripe: create SetupIntent (save card on file) ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
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
      // Store customer ID ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ profile may not exist yet so use upsert
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

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Stripe: charge winner ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
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
    // Flag payment failed ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ buyer stays approved, admin decides next steps
    await supabase.from('profiles').update({ payment_status: 'failed' }).eq('user_id', String(winner.id));
    await sendAdminEmail(
      `ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ÃÂÃÂ¯ÃÂÃÂ¸ÃÂÃÂ Payment failed ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ${winner_username}`,
      `Payment failed for auction ${auction_id}.\nWinner: ${winner_username}\nAmount: $${(amount_cents / 100).toFixed(2)}\nError: ${e.message}`
    );
    res.status(402).json({ error: 'Payment failed', detail: e.message });
  }
});

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Stripe webhook ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
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
        // Flag only ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ buyer stays approved, admin handles manually
        await supabase.from('profiles').update({ payment_status: 'failed' }).eq('user_id', String(winnerUser.id));
      }
      await sendAdminEmail(
        `ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ÃÂÃÂ¯ÃÂÃÂ¸ÃÂÃÂ Stripe payment failed ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ${winner_username}`,
        `Stripe payment_intent.payment_failed\nWinner: ${winner_username}\nAuction: ${auction_id}\nError: ${pi.last_payment_error?.message || 'unknown'}`
      );
    }
  }

  res.json({ received: true });
});

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Admin: buyers ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
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

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Auctions ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
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
    if (!starting_bid || starting_bid < 1) return res.status(400).json({ error: 'starting_bid must be at least 1' });
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

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
// AUCTION LIFECYCLE
// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ

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
        console.log(`ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ Auction ${auctionId} ended ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ winner: ${auction.leading_bidder} at $${auction.current_bid}`);
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
    console.log(`ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ± Resuming timer for auction ${auction.id}`);
    startAuctionTimer(auction.id, auction.ends_at);
  }
}
async function sweepExpiredStandardItems() {
    try {
          const { data: expired, error } = await supabase.rpc('get_expired_standard_items');
          if (error) { console.error('Sweep error:', error.message); return; }
          if (!expired || !expired.length) return;
          for (const item of expired) {
                  const { data: bidRows } = await supabase.from('bids').select('username, amount').eq('item_id', item.id).order('amount', { ascending: false }).limit(1);
                  const winner = bidRows && bidRows.length ? bidRows[0] : null;
                  const newStatus = winner ? 'sold' : 'unsold';
                  await supabase.from('auction_items').update({ status: newStatus }).eq('id', item.id);
                  if (winner) {
                            await createOrderOnWin(item.auction_id, winner.username, winner.amount);
                  }
                  console.log(`... Standard item ${item.id} closed: ${newStatus}`);
          }
    } catch (e) {
          console.error('Sweep exception:', e.message);
    }
}

// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
// SOCKET.IO
// ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ

io.on('connection', (socket) => {
  console.log(`ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ User connected: ${socket.id}`);

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

    console.log(`ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ ${socket.id} joined auction ${auctionId} ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ${viewers[auctionId].size} watching`);
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
    console.log(`ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ° ${user.username} bid $${amount} on auction ${auctionId}`);
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

  // ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Admin: block user mid-auction ÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂ
    socket.on('block_user', async ({ targetUserId, targetUsername, auctionId, token }) => {
    const admin = verifySocketToken(token);
    if (!admin || admin.username !== ADMIN_USERNAME) {
      socket.emit('host_error', { message: 'Admin only' }); return;
    }

    // Resolve actual UUID — frontend passes username as targetUserId placeholder
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
    console.log(`🚫 Admin blocked user ${targetUsername} (${resolvedUserId}) from auction ${auctionId}`);
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
    console.log(`ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ¶ÃÂÃÂ¯ÃÂÃÂ¸ÃÂÃÂ Host ${user.username} started auction ${auctionId}`);
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
    console.log(`ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ Host ${user.username} ended auction ${auctionId} early`);
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
    console.log(`ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ© Host ${user.username} extended auction ${auctionId} by ${extraSeconds}s`);
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
    console.log(`ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ User disconnected: ${socket.id}`);
  });
});


// ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ
// ORDERS & SHIPPO
// ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ

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

async function createOrderOnWin(auctionId, winnerUsername, finalBid) {
  if (!winnerUsername) return;
  try {
    const { data: winner } = await supabase.from('users').select('id').eq('username', winnerUsername).single();
    if (!winner) return;
    const { data: profile } = await supabase.from('profiles').select('*').eq('user_id', String(winner.id)).single();
    const { data: auction } = await supabase.from('auctions').select('title, description').eq('id', auctionId).single();
    if (!auction) return;
    await supabase.from('orders').insert({
      auction_id: auctionId,
      buyer_username: winnerUsername,
      buyer_user_id: String(winner.id),
      item_title: auction.title,
      item_description: auction.description || '',
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
    console.log('ÃÂ°ÃÂÃÂÃÂ¦ Order created for ' + winnerUsername + ' ÃÂ¢ÃÂÃÂ auction ' + auctionId);
  } catch (e) {
    console.error('Order creation error:', e.message);
  }
}

// ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ Admin: orders ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ
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
        console.log('ÃÂ°ÃÂÃÂÃÂ¬ Tracking update: ' + tracking_number + ' -> ' + status);
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
      const { data, error } = await supabase.from('auction_items').insert({ auction_id: req.params.id, title, description, image_url, starting_bid: starting_bid || 1, position, status: isStandard ? 'open' : 'pending', current_bid: isStandard ? (starting_bid || 1) : null, ends_at: isStandard ? (ends_at || null) : null }).select().single();
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
  app.post('/auction/:id/items/:itemId/bid', requireAuth, async (req, res) => {
        const { max_amount } = req.body;
        if (!max_amount || max_amount < 1) return res.status(400).json({ error: 'max_amount required' });
        const { data, error } = await supabase.rpc('place_standard_bid', {
                p_item_id: req.params.itemId,
                p_user_id: String(req.user.id),
                p_username: req.user.username,
                p_max_amount: max_amount
        });
        if (error) return res.status(400).json({ error: error.message || 'Bid failed' });
        res.json(data);
  });

  app.get('/auction/:id/items/standard-status', async (req, res) => {
        const { data, error } = await supabase.from('auction_items').select('*').eq('auction_id', req.params.id).order('position', { ascending: true });
        if (error) return res.status(500).json({ error: 'Failed to load items' });
        res.json(data);
  });

const PORT = process.env.PORT || 3001;

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
    const { error } = await supabase.from('item_images').delete().eq('id', req.params.imageId);
    if (error) return res.status(500).json({ error: 'Failed to delete image' });
    res.status(204).send();
});

// ── Image upload ──
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

server.keepAliveTimeout = 61000; // keep connections alive longer than proxy timeout
server.headersTimeout = 65000;

server.listen(PORT, async () => {
  console.log(`ÃÂÃÂ°ÃÂÃÂÃÂÃÂÃÂÃÂ WhatTheFind Live server running on port ${PORT}`);
  await resumeLiveAuctions();
      sweepExpiredStandardItems();
      setInterval(sweepExpiredStandardItems, 15000);
  initStorage();
});
