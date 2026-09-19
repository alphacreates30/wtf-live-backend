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
// Short timeouts: nodemailer's defaults (connectionTimeout alone is 2
// minutes) mean a wrong host/port/credential silently blocks every caller
// of sendAdminEmail for that long - including chargeOrder on its way to
// resolving, and the sequential auto-close loop's processing of every
// other lot in that same tick. sendAdminEmail already never throws past
// this file; this makes sure it also never hangs.
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  connectionTimeout: 8000,
  greetingTimeout: 8000,
  socketTimeout: 8000,
});

// whatthefind.live is Resend-verified for sending; it has no MX on the apex,
// so mail sent TO @whatthefind.live bounces. Reply-To always points at a real
// inbox so a buyer replying to a "you won" email actually reaches someone.
const ADMIN_FROM = 'WhatTheFind Live <alerts@whatthefind.live>';
const BUYER_FROM = 'WhatTheFind Live <auctions@whatthefind.live>';
const REPLY_TO = 'whatthefind.co@gmail.com';

// Resend's free tier is 3,000/month but capped at 100/day, and a day that
// hits the cap gets EVERYTHING rejected - including won/charged, which must
// never be dropped. email_send_log has one row per email actually accepted
// by Resend today (any kind); once that count is near the cap, only the
// lowest-value kind (outbid) gets suppressed - won/failed/shipped/admin
// always go through regardless of volume.
const DAILY_EMAIL_CAP = 100;
const OUTBID_SUPPRESS_AT = 90;

function startOfTodayUTC() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

// Fails CLOSED: if the count itself can't be read, we can't prove we're
// clear of the cap, so treat outbid as suppressed rather than risk being the
// send that trips Resend into rejecting a won/failed/shipped email today.
async function shouldSuppressOutbid() {
  const { count, error } = await supabase
    .from('email_send_log')
    .select('id', { count: 'exact', head: true })
    .gte('sent_at', startOfTodayUTC());
  if (error) {
    console.error('shouldSuppressOutbid: count query failed, suppressing outbid to be safe:', error.message);
    return true;
  }
  return (count || 0) >= OUTBID_SUPPRESS_AT;
}

// Shared send path for every outgoing email (admin alerts and buyer-facing
// mail alike) - never throws and never hangs past the 8s timeout, so a
// Resend outage can't block a charge, an auto-close tick, or a bid response.
// kind categorizes the send for the daily volume count and the outbid
// suppression check above; pass 'outbid' only for the outbid email itself.
async function sendEmail({ from, to, subject, html, text, kind = 'other' }) {
  if (!process.env.RESEND_API_KEY) return; // skip if not configured
  if (!to) return;

  if (kind === 'outbid' && await shouldSuppressOutbid()) {
    console.error(`OUTBID EMAIL SUPPRESSED (near ${DAILY_EMAIL_CAP}/day Resend cap): to=${to} subject="${subject}"`);
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, reply_to: REPLY_TO, subject, html, text }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error('Email send error:', res.status, await res.text());
      return;
    }
    try {
      await supabase.from('email_send_log').insert({ kind });
    } catch (logErr) {
      console.error('email_send_log insert failed:', logErr.message);
    }
  } catch (e) {
    console.error('Email send error:', e.message);
  }
}

async function sendAdminEmail(subject, text) {
  await sendEmail({ from: ADMIN_FROM, to: process.env.ADMIN_EMAIL, subject, text, kind: 'admin' });
}

// ------------------------------------------------------------
// BUYER EMAIL NOTIFICATIONS (won/charged, payment failed, outbid, shipped)
// ------------------------------------------------------------
// Plain transactional HTML - no images, no tracking pixels. Every email that
// mentions a charge shows the hammer price and buyer's premium as separate
// line items, never a bare total.

const OUTBID_THROTTLE_MS = 10 * 60 * 1000;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// order.hammer_cents/premium_cents/total_cents are integer cents; formatMoney
// is for those. auction_items.current_bid is a plain dollar figure - use
// formatDollars for that instead.
function formatMoney(cents) { return '$' + (Number(cents || 0) / 100).toFixed(2); }
function formatDollars(n) { return '$' + Number(n || 0).toFixed(2); }

function emailHtml(heading, bodyHtml) {
  return `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#222;">
    <div style="max-width:520px;margin:0 auto;padding:24px 20px;">
      <h2 style="margin:0 0 16px;font-size:18px;">${heading}</h2>
      ${bodyHtml}
      <p style="margin-top:32px;font-size:12px;color:#777;">WhatTheFind Live &middot; reply to this email if you have questions.</p>
    </div>
  </body>
</html>`;
}

function wonChargedEmailHtml(order, last4) {
  const premiumPct = order.hammer_cents > 0 ? Math.round((order.premium_cents / order.hammer_cents) * 100) : 0;
  const cardLine = last4 ? `<p style="margin:16px 0 0;color:#555;">Card ending in ${escapeHtml(last4)} was charged.</p>` : '';
  return emailHtml('You won it - and your card has been charged', `
    <p>Congratulations! You won <strong>${escapeHtml(order.item_title)}</strong>.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <tr><td style="padding:4px 0;color:#555;">Hammer price</td><td style="padding:4px 0;text-align:right;">${formatMoney(order.hammer_cents)}</td></tr>
      <tr><td style="padding:4px 0;color:#555;">Buyer's premium (${premiumPct}%)</td><td style="padding:4px 0;text-align:right;">${formatMoney(order.premium_cents)}</td></tr>
      <tr><td style="padding:8px 0 0;font-weight:bold;border-top:1px solid #ddd;">Total charged</td><td style="padding:8px 0 0;text-align:right;font-weight:bold;border-top:1px solid #ddd;">${formatMoney(order.total_cents)}</td></tr>
    </table>
    ${cardLine}
    <p style="margin:16px 0 0;">What happens next: the host will pack and ship your item, and you'll get another email with tracking once it's on its way.</p>
  `);
}

function paymentFailedEmailHtml(order, reason) {
  const premiumPct = order.hammer_cents > 0 ? Math.round((order.premium_cents / order.hammer_cents) * 100) : 0;
  return emailHtml('You won - but your card did not go through', `
    <p>You won <strong>${escapeHtml(order.item_title)}</strong>, but we were unable to charge the card on file.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <tr><td style="padding:4px 0;color:#555;">Hammer price</td><td style="padding:4px 0;text-align:right;">${formatMoney(order.hammer_cents)}</td></tr>
      <tr><td style="padding:4px 0;color:#555;">Buyer's premium (${premiumPct}%)</td><td style="padding:4px 0;text-align:right;">${formatMoney(order.premium_cents)}</td></tr>
      <tr><td style="padding:8px 0 0;font-weight:bold;border-top:1px solid #ddd;">Total due</td><td style="padding:8px 0 0;text-align:right;font-weight:bold;border-top:1px solid #ddd;">${formatMoney(order.total_cents)}</td></tr>
    </table>
    <p style="margin:16px 0 0;color:#555;">Reason: ${escapeHtml(reason)}</p>
    <p style="margin:16px 0 0;">Your win is still reserved for you. To fix this, log in to WhatTheFind Live and update your payment method on your profile, then reply to this email so the charge can be retried.</p>
  `);
}

// Invoice versions list every lot (hammer + premium each) before the total -
// same "never a bare total" rule as the per-order emails, just one email
// covering every lot the buyer won in the auction instead of one per lot.
function invoiceLotRows(orders) {
  return orders.map(o => {
    const premiumPct = o.hammer_cents > 0 ? Math.round((o.premium_cents / o.hammer_cents) * 100) : 0;
    return `<tr>
      <td style="padding:4px 0;color:#555;">${escapeHtml(o.item_title)}</td>
      <td style="padding:4px 0;text-align:right;">${formatMoney(o.hammer_cents)} + ${formatMoney(o.premium_cents)} premium (${premiumPct}%)</td>
    </tr>`;
  }).join('');
}

function invoiceWonChargedEmailHtml(invoice, orders, last4) {
  const cardLine = last4 ? `<p style="margin:16px 0 0;color:#555;">Card ending in ${escapeHtml(last4)} was charged.</p>` : '';
  return emailHtml('You won it - and your card has been charged', `
    <p>Congratulations! You won <strong>${orders.length}</strong> lot${orders.length === 1 ? '' : 's'}:</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      ${invoiceLotRows(orders)}
      <tr><td style="padding:8px 0 0;font-weight:bold;border-top:1px solid #ddd;">Total charged</td><td style="padding:8px 0 0;text-align:right;font-weight:bold;border-top:1px solid #ddd;">${formatMoney(invoice.total_cents)}</td></tr>
    </table>
    ${cardLine}
    <p style="margin:16px 0 0;">What happens next: the host will pack and ship your items, and you'll get another email with tracking once each is on its way.</p>
  `);
}

function invoicePaymentFailedEmailHtml(invoice, orders, reason) {
  return emailHtml('You won - but your card did not go through', `
    <p>You won <strong>${orders.length}</strong> lot${orders.length === 1 ? '' : 's'}, but we were unable to charge the card on file.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      ${invoiceLotRows(orders)}
      <tr><td style="padding:8px 0 0;font-weight:bold;border-top:1px solid #ddd;">Total due</td><td style="padding:8px 0 0;text-align:right;font-weight:bold;border-top:1px solid #ddd;">${formatMoney(invoice.total_cents)}</td></tr>
    </table>
    <p style="margin:16px 0 0;color:#555;">Reason: ${escapeHtml(reason)}</p>
    <p style="margin:16px 0 0;">Your wins are still reserved for you. To fix this, log in to WhatTheFind Live and update your payment method on your profile, then reply to this email so the charge can be retried.</p>
  `);
}

function outbidEmailHtml(item) {
  return emailHtml('You have been outbid', `
    <p>Someone placed a higher bid on <strong>${escapeHtml(item.title)}</strong>.</p>
    <p style="margin:16px 0;">Current bid: <strong>${formatDollars(item.current_bid)}</strong></p>
    <p>Log in to WhatTheFind Live if you'd like to bid again before the lot closes.</p>
  `);
}

function shippedEmailHtml(order) {
  const trackingCell = order.tracking_url
    ? `<a href="${escapeHtml(order.tracking_url)}" style="color:#0645ad;">${escapeHtml(order.tracking_number || 'Track shipment')}</a>`
    : escapeHtml(order.tracking_number || 'N/A');
  const postageRow = order.shipping_cost_cents != null
    ? `<tr><td style="padding:4px 0;color:#555;">Postage charged</td><td style="padding:4px 0;text-align:right;">${formatMoney(order.shipping_cost_cents)}</td></tr>`
    : '';
  return emailHtml('Your item has shipped', `
    <p><strong>${escapeHtml(order.item_title)}</strong> is on its way.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <tr><td style="padding:4px 0;color:#555;">Carrier</td><td style="padding:4px 0;text-align:right;">${escapeHtml(order.tracking_carrier || 'N/A')}</td></tr>
      <tr><td style="padding:4px 0;color:#555;">Tracking number</td><td style="padding:4px 0;text-align:right;">${trackingCell}</td></tr>
      ${postageRow}
    </table>
  `);
}

async function getBuyerEmail(userId) {
  const { data: profile } = await supabase.from('profiles').select('email').eq('user_id', String(userId)).single();
  return profile?.email || null;
}

async function getEmailForUsername(username) {
  const { data: user } = await supabase.from('users').select('id').eq('username', username).single();
  if (!user) return null;
  return getBuyerEmail(user.id);
}

// Called on every chargeOrder resolution that means "the buyer won and was
// successfully charged" - including the already-charged replay path, so a
// process crash between a first successful charge and its email still gets
// healed by the next call. Idempotent via the won_email_sent_at claim: only
// the caller that flips it from null actually sends.
async function notifyWonAndCharged(orderId, paymentIntentId) {
  try {
    const { data: order, error } = await supabase
      .from('orders')
      .update({ won_email_sent_at: new Date().toISOString() })
      .eq('id', orderId)
      .is('won_email_sent_at', null)
      .select('*')
      .single();
    if (error || !order) return; // already sent, or order missing

    const email = await getBuyerEmail(order.buyer_user_id);
    if (!email) return;

    let last4 = null;
    try {
      if (stripe && paymentIntentId) {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['payment_method'] });
        last4 = pi.payment_method?.card?.last4 || null;
      }
    } catch { /* best-effort only - last4 is a nice-to-have, never worth failing the email over */ }

    await sendEmail({
      from: BUYER_FROM,
      to: email,
      subject: `You won "${order.item_title}" - payment charged`,
      html: wonChargedEmailHtml(order, last4),
      kind: 'won',
    });
  } catch (e) {
    console.error('notifyWonAndCharged error:', orderId, e.message);
  }
}

// Called on every chargeOrder resolution that means "the buyer won but the
// charge failed" - never on the concurrency-skip path (order.skipped), since
// that isn't an actual failure. Idempotent via payment_failed_email_sent_at.
async function notifyPaymentFailed(orderId, reason) {
  try {
    const { data: order, error } = await supabase
      .from('orders')
      .update({ payment_failed_email_sent_at: new Date().toISOString() })
      .eq('id', orderId)
      .is('payment_failed_email_sent_at', null)
      .select('*')
      .single();
    if (error || !order) return; // already sent, or order missing

    const email = await getBuyerEmail(order.buyer_user_id);
    if (!email) return;

    await sendEmail({
      from: BUYER_FROM,
      to: email,
      subject: `Payment issue - you won "${order.item_title}"`,
      html: paymentFailedEmailHtml(order, reason),
      kind: 'failed',
    });
  } catch (e) {
    console.error('notifyPaymentFailed error:', orderId, e.message);
  }
}

// Invoice equivalents of notifyWonAndCharged/notifyPaymentFailed above -
// same idempotency-via-sent-marker pattern, just reading/writing invoices
// and pulling every child order (via orders.invoice_id) to list each lot.
async function notifyInvoiceWonAndCharged(invoiceId, paymentIntentId) {
  try {
    const { data: invoice, error } = await supabase
      .from('invoices')
      .update({ won_email_sent_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .is('won_email_sent_at', null)
      .select('*')
      .single();
    if (error || !invoice) return; // already sent, or invoice missing

    const { data: orders } = await supabase
      .from('orders')
      .select('item_title, hammer_cents, premium_cents')
      .eq('invoice_id', invoiceId);
    if (!orders?.length) return;

    const email = await getBuyerEmail(invoice.buyer_user_id);
    if (!email) return;

    let last4 = null;
    try {
      if (stripe && paymentIntentId) {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['payment_method'] });
        last4 = pi.payment_method?.card?.last4 || null;
      }
    } catch { /* best-effort only - last4 is a nice-to-have, never worth failing the email over */ }

    await sendEmail({
      from: BUYER_FROM,
      to: email,
      subject: `You won ${orders.length} lot${orders.length === 1 ? '' : 's'} - payment charged`,
      html: invoiceWonChargedEmailHtml(invoice, orders, last4),
      kind: 'won',
    });
  } catch (e) {
    console.error('notifyInvoiceWonAndCharged error:', invoiceId, e.message);
  }
}

async function notifyInvoicePaymentFailed(invoiceId, reason) {
  try {
    const { data: invoice, error } = await supabase
      .from('invoices')
      .update({ payment_failed_email_sent_at: new Date().toISOString() })
      .eq('id', invoiceId)
      .is('payment_failed_email_sent_at', null)
      .select('*')
      .single();
    if (error || !invoice) return; // already sent, or invoice missing

    const { data: orders } = await supabase
      .from('orders')
      .select('item_title, hammer_cents, premium_cents')
      .eq('invoice_id', invoiceId);
    if (!orders?.length) return;

    const email = await getBuyerEmail(invoice.buyer_user_id);
    if (!email) return;

    await sendEmail({
      from: BUYER_FROM,
      to: email,
      subject: `Payment issue - you won ${orders.length} lot${orders.length === 1 ? '' : 's'}`,
      html: invoicePaymentFailedEmailHtml(invoice, orders, reason),
      kind: 'failed',
    });
  } catch (e) {
    console.error('notifyInvoicePaymentFailed error:', invoiceId, e.message);
  }
}

// Throttle for outbid mail: at most one per (item, outbid user) per
// OUTBID_THROTTLE_MS. Two-step and race-safe without a raw SQL function:
// step 1 reclaims a STALE row (last_sent_at past the window) atomically via
// a conditional UPDATE; step 2, only reached when no stale row was reclaimed,
// tries to INSERT a fresh row and relies on the (item_id, username) primary
// key to turn a concurrent duplicate insert into a no-op. Either way, at
// most one caller ever sees its write "win".
async function claimOutbidEmailSlot(itemId, username) {
  const cutoff = new Date(Date.now() - OUTBID_THROTTLE_MS).toISOString();
  const nowIso = new Date().toISOString();

  const { data: reclaimed } = await supabase
    .from('outbid_email_log')
    .update({ last_sent_at: nowIso })
    .eq('item_id', itemId)
    .eq('username', username)
    .lt('last_sent_at', cutoff)
    .select()
    .single();
  if (reclaimed) return true;

  const { data: inserted } = await supabase
    .from('outbid_email_log')
    .upsert({ item_id: itemId, username, last_sent_at: nowIso }, { onConflict: 'item_id,username', ignoreDuplicates: true })
    .select()
    .single();
  return !!inserted;
}

// outbid_email_log otherwise grows forever - one row per (lot, bidder) ever
// throttled, never removed on its own. The 10-minute window makes anything
// past a day pointless to keep, so sweep it out periodically rather than
// on every claim (which would turn every bid into a delete query too).
const OUTBID_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;

async function cleanupOutbidEmailLog() {
  try {
    const cutoff = new Date(Date.now() - OUTBID_LOG_RETENTION_MS).toISOString();
    const { error, count } = await supabase
      .from('outbid_email_log')
      .delete({ count: 'exact' })
      .lt('last_sent_at', cutoff);
    if (error) console.error('cleanupOutbidEmailLog error:', error.message);
    else if (count) console.log(`cleanupOutbidEmailLog: removed ${count} stale row(s)`);
  } catch (e) {
    console.error('cleanupOutbidEmailLog error:', e.message);
  }
}
setInterval(cleanupOutbidEmailLog, 60 * 60 * 1000); // hourly
cleanupOutbidEmailLog();

// previousLeader is the lot's leading_bidder BEFORE the bid that triggered
// this call. Re-reads the item fresh rather than trusting the RPC response
// shape, so this stays correct regardless of exactly what place_standard_bid
// returns. No-ops on the very first bid on a lot (no one to outbid yet) and
// whenever the lead didn't actually change hands (e.g. the leader's own
// proxy absorbed a lower bid and stayed on top).
async function notifyOutbidIfNeeded(itemId, previousLeader) {
  if (!previousLeader) return;
  try {
    const { data: item } = await supabase
      .from('auction_items').select('title, current_bid, leading_bidder').eq('id', itemId).single();
    if (!item || !item.leading_bidder || item.leading_bidder === previousLeader) return;

    const canSend = await claimOutbidEmailSlot(itemId, previousLeader);
    if (!canSend) return;

    const email = await getEmailForUsername(previousLeader);
    if (!email) return;

    await sendEmail({
      from: BUYER_FROM,
      to: email,
      subject: `You've been outbid on "${item.title}"`,
      html: outbidEmailHtml(item),
      kind: 'outbid',
    });
  } catch (e) {
    console.error('notifyOutbidIfNeeded error:', itemId, e.message);
  }
}

// Idempotent via shipped_email_sent_at - safe to call once per order row
// matched by the Shippo webhook even if Shippo redelivers the same event.
async function notifyShipped(orderId) {
  try {
    const { data: order, error } = await supabase
      .from('orders')
      .update({ shipped_email_sent_at: new Date().toISOString() })
      .eq('id', orderId)
      .is('shipped_email_sent_at', null)
      .select('*')
      .single();
    if (error || !order) return;

    const email = await getBuyerEmail(order.buyer_user_id);
    if (!email) return;

    await sendEmail({
      from: BUYER_FROM,
      to: email,
      subject: `Your item has shipped: "${order.item_title}"`,
      html: shippedEmailHtml(order),
      kind: 'shipped',
    });
  } catch (e) {
    console.error('notifyShipped error:', orderId, e.message);
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

// Decodes a bearer token if present but never rejects the request - lets a
// route serve different data to a logged-in admin vs. everyone else (e.g.
// draft auctions) while staying public for anonymous callers.
function optionalAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try { req.user = jwt.verify(auth.slice(7), JWT_SECRET); } catch { /* not logged in - proceed anonymously */ }
  }
  next();
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
      await supabase.from('profiles').update({ stripe_customer_id: customerId }).eq('user_id', String(req.user.id));
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
  const { payment_method_id } = req.body;
  if (!payment_method_id) return res.status(400).json({ error: 'payment_method_id required' });

  // The Stripe customer to attach to comes from the caller's own profile,
  // never from the request body - a client-supplied customer_id would let
  // any logged-in user attach a card to (or change the default payment
  // method on) an arbitrary Stripe customer.
  const { data: profile } = await supabase.from('profiles').select('stripe_customer_id').eq('user_id', String(req.user.id)).single();
  const customerId = profile?.stripe_customer_id;
  if (!customerId) return res.status(400).json({ error: 'No Stripe customer on file - create a setup intent first' });

  try {
    // Attach to customer if needed
    await stripe.paymentMethods.attach(payment_method_id, { customer: customerId });
    await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: payment_method_id } });

    await supabase.from('profiles').update({ stripe_payment_method_id: payment_method_id, payment_status: 'ok' })
      .eq('user_id', String(req.user.id));

    // $1 authorization, released immediately - proves the card can actually
    // be charged, without moving any money. The card is already saved above,
    // so a failure here shouldn't fail this request; just record the result.
    try {
      const pi = await stripe.paymentIntents.create({
        amount: 100,
        currency: 'usd',
        customer: customerId,
        payment_method: payment_method_id,
        confirm: true,
        off_session: true,
        capture_method: 'manual',
      });
      await stripe.paymentIntents.cancel(pi.id);
      await supabase.from('profiles')
        .update({ card_verified_at: new Date().toISOString(), card_verify_error: null })
        .eq('user_id', String(req.user.id));
    } catch (verifyErr) {
      await supabase.from('profiles')
        .update({ card_verified_at: null, card_verify_error: verifyErr.message })
        .eq('user_id', String(req.user.id));
    }

    res.json({ success: true });
  } catch (e) {
    console.error('Save payment method error:', e.message);
    res.status(500).json({ error: 'Failed to save payment method' });
  }
});

// -- Stripe: charge winner --
// Phase D's manual Charge/Retry. Standard-auction orders are billed on a
// batched invoice, so this routes to chargeInvoice for them (by explicit
// invoice_id, or by following order_id -> orders.invoice_id when set) and
// falls through to chargeOrder, untouched, only for orders with no invoice -
// i.e. live auctions, which never batch.
app.post('/charge-winner', requireAuth, async (req, res) => {
  const { auction_id, winner_username, order_id, invoice_id } = req.body;
  if (!invoice_id && !order_id && (!auction_id || !winner_username)) {
    return res.status(400).json({ error: 'invoice_id, order_id, or auction_id and winner_username, required' });
  }

  // Must be admin or host
  let auctionIdForAuth = auction_id;
  if (!auctionIdForAuth) {
    if (invoice_id) {
      const { data: invoiceForAuth } = await supabase.from('invoices').select('auction_id').eq('id', invoice_id).single();
      auctionIdForAuth = invoiceForAuth?.auction_id;
    } else {
      const { data: orderForAuth } = await supabase.from('orders').select('auction_id').eq('id', order_id).single();
      auctionIdForAuth = orderForAuth?.auction_id;
    }
  }
  const { data: auction } = await supabase.from('auctions').select('host_username').eq('id', auctionIdForAuth).single();
  if (!auction) return res.status(404).json({ error: 'Auction not found' });
  if (req.user.username !== ADMIN_USERNAME && req.user.username !== auction.host_username) {
    return res.status(403).json({ error: 'Not authorized to charge' });
  }

  if (invoice_id) {
    const result = await chargeInvoice(invoice_id);
    if (result.success) return res.json({ success: true, payment_intent_id: result.payment_intent_id });
    return res.status(402).json({ error: 'Payment failed', detail: result.error });
  }

  let targetOrderId = order_id;
  if (!targetOrderId) {
    // Legacy lookup by auction + winner. A standard auction where the same
    // buyer won multiple lots has multiple unpaid orders here - refuse to
    // guess which one; the caller must pass order_id.
    const { data: orders } = await supabase
      .from('orders')
      .select('id')
      .eq('auction_id', auction_id)
      .eq('buyer_username', winner_username)
      .eq('payment_status', 'unpaid');
    if (!orders?.length) return res.status(404).json({ error: 'No unpaid order found for this winner on this auction' });
    if (orders.length > 1) {
      return res.status(400).json({ error: 'Multiple unpaid orders match this winner on this auction - pass order_id' });
    }
    targetOrderId = orders[0].id;
  }

  // A standard-auction order carries the invoice it was billed on - charge
  // that instead of the order alone, same as the invoice_id branch above.
  const { data: targetOrder } = await supabase.from('orders').select('invoice_id').eq('id', targetOrderId).single();
  const result = targetOrder?.invoice_id
    ? await chargeInvoice(targetOrder.invoice_id)
    : await chargeOrder(targetOrderId);
  if (result.success) {
    res.json({ success: true, payment_intent_id: result.payment_intent_id });
  } else {
    res.status(402).json({ error: 'Payment failed', detail: result.error });
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
    const { order_id, invoice_id, winner_username, auction_id } = pi.metadata || {};
    const reason = pi.last_payment_error?.message || 'unknown';
    if (invoice_id) {
      // Source of truth for whether an invoice is paid - not profiles, which
      // Phase D's UI doesn't read for this. Mirror onto every child order so
      // orders.payment_status stays in sync with its invoice.
      await supabase.from('invoices').update({ payment_status: 'failed', payment_error: reason }).eq('id', invoice_id);
      await supabase.from('orders').update({ payment_status: 'failed', payment_error: reason }).eq('invoice_id', invoice_id);
    } else if (order_id) {
      // Source of truth for whether an order is paid - not profiles, which
      // Phase D's UI doesn't read for this.
      await supabase.from('orders').update({ payment_status: 'failed', payment_error: reason }).eq('id', order_id);
    }
    if (winner_username) {
      await sendAdminEmail(
        `Stripe payment failed - ${winner_username}`,
        `Stripe payment_intent.payment_failed\n${invoice_id ? `Invoice: ${invoice_id}` : `Order: ${order_id || 'unknown'}`}\nWinner: ${winner_username}\nAuction: ${auction_id}\nError: ${reason}`
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
    .from('auctions').select('id, title, status, mode, buyers_premium_pct').in('id', auctionIds)
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

// -- My Orders (what I won and was billed for) --
// Scoped to the caller's own JWT-derived id - never accepts a user id from
// the client, so there's no way to request someone else's orders.
app.get('/my-orders', requireAuth, async (req, res) => {
  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, auction_id, invoice_id, item_title, hammer_cents, premium_cents, total_cents, payment_status, status, tracking_number, tracking_carrier, tracking_url, fulfillment_choice, shipping_cost_cents, shipping_payment_status, shipping_payment_error, created_at')
    .eq('buyer_user_id', String(req.user.id))
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'Failed to load orders' });
  if (!orders?.length) return res.json([]);

  const auctionIds = [...new Set(orders.map(o => o.auction_id))];
  const { data: auctions } = await supabase.from('auctions').select('id, title, status, fulfillment_mode').in('id', auctionIds);
  const auctionMap = Object.fromEntries((auctions || []).map(a => [a.id, a]));

  res.json(orders.map(o => {
    const auction = auctionMap[o.auction_id];
    return {
      id: o.id,
      auction_id: o.auction_id,
      invoice_id: o.invoice_id || null,
      item_title: o.item_title,
      auction_title: auction?.title || null,
      hammer_cents: o.hammer_cents,
      premium_cents: o.premium_cents,
      total_cents: o.total_cents,
      payment_status: o.payment_status,
      status: o.status,
      tracking_number: o.tracking_number || null,
      tracking_carrier: o.tracking_carrier || null,
      tracking_url: o.tracking_url || null,
      fulfillment_choice: o.fulfillment_choice || null,
      // Only a 'both' auction that hasn't closed yet has a choice worth
      // changing - matches PATCH /auction/:id/fulfillment-choice's own
      // gate exactly, so this button never appears somewhere that call
      // would 400.
      can_change_fulfillment: !!auction && auction.fulfillment_mode === 'both' && auction.status !== 'ended',
      shipping_cost_cents: o.shipping_cost_cents ?? null,
      shipping_payment_status: o.shipping_payment_status || null,
      shipping_payment_error: o.shipping_payment_error || null,
      created_at: o.created_at,
    };
  }));
});

app.get('/auctions', optionalAuth, async (req, res) => {
  const { status } = req.query;
  const isAdmin = req.user?.username === ADMIN_USERNAME;
  let query = supabase.from('auctions')
        .select('id,title,description,image_url,category,starting_bid,current_bid,leading_bidder,status,starts_at,ends_at,mode,host_username,created_at')
    .order('created_at', { ascending: false });
  if (status) {
    // Drafts are private - only the admin can list them, even explicitly.
    if (status === 'draft' && !isAdmin) return res.json([]);
    query = query.eq('status', status);
  } else if (!isAdmin) {
    query = query.neq('status', 'draft');
  }
  const { data, error } = await query;
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.get('/auction/:id', optionalAuth, async (req, res) => {
  const { data, error } = await supabase.from('auctions').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Auction not found' });
  // A draft is a part-built auction that must stay invisible until published -
  // 404 instead of 403 so its existence isn't confirmed to a non-admin.
  if (data.status === 'draft' && req.user?.username !== ADMIN_USERNAME) {
    return res.status(404).json({ error: 'Auction not found' });
  }
  res.json(data);
});

const FULFILLMENT_MODES = ['shipping', 'pickup', 'both'];
// Bump when TERMS_OF_SALE.md changes materially - existing acceptance rows
// keep the version they actually agreed to, so this never rewrites history.
const TERMS_VERSION = '1';

app.patch('/auction/:id', requireAdmin, async (req, res) => {
  const { title, description, category, buyers_premium_pct, fulfillment_mode, pickup_address, pickup_starts_at, pickup_ends_at } = req.body;
  const u = {};
  if (title !== undefined) {
    if (!title) return res.status(400).json({ error: 'title cannot be empty' });
    u.title = title;
  }
  if (description !== undefined) u.description = description;
  if (category !== undefined) u.category = category;
  if (buyers_premium_pct !== undefined) {
    const pct = Number(buyers_premium_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 50) {
      return res.status(400).json({ error: 'buyers_premium_pct must be between 0 and 50' });
    }
    u.buyers_premium_pct = pct;
  }
  if (fulfillment_mode !== undefined) {
    if (!FULFILLMENT_MODES.includes(fulfillment_mode)) {
      return res.status(400).json({ error: `fulfillment_mode must be one of: ${FULFILLMENT_MODES.join(', ')}` });
    }
    u.fulfillment_mode = fulfillment_mode;
  }
  if (pickup_address !== undefined) u.pickup_address = pickup_address;
  if (pickup_starts_at !== undefined) {
    if (pickup_starts_at && isNaN(new Date(pickup_starts_at).getTime())) {
      return res.status(400).json({ error: 'pickup_starts_at is not a valid date' });
    }
    u.pickup_starts_at = pickup_starts_at || null;
  }
  if (pickup_ends_at !== undefined) {
    if (pickup_ends_at && isNaN(new Date(pickup_ends_at).getTime())) {
      return res.status(400).json({ error: 'pickup_ends_at is not a valid date' });
    }
    u.pickup_ends_at = pickup_ends_at || null;
  }
  const { data, error } = await supabase.from('auctions').update(u).eq('id', req.params.id).select().single();
  if (error || !data) return res.status(404).json({ error: 'Auction not found' });
  res.json(data);
});

app.post('/auction', requireAdmin, async (req, res) => {
  const { title, description, image_url, category, starting_bid, starts_at, ends_at, mode, fulfillment_mode } = req.body;
    // Live auctions are gated off (v2): createOrderOnWin is called from the
    // live socket path (start_auction timer / end_auction) with no charging
    // ever wired in, and live bidding still runs through the old place_bid
    // RPC (no proxy bidding, tiered increments, or atomic row lock that
    // place_standard_bid has). Reject explicitly instead of silently
    // coercing to standard so a live request surfaces, not disappears.
    if (mode === 'live') return res.status(400).json({ error: 'Live auctions are not available yet' });
    const auctionMode = 'standard';
    if (!title) return res.status(400).json({ error: 'title is required' });
    // Standard auction lots start at $0.00 by design - only reject missing/negative.
    if (starting_bid == null || Number(starting_bid) < 0) return res.status(400).json({ error: 'starting_bid must be 0 or more' });
      if (ends_at && new Date(ends_at) <= new Date()) return res.status(400).json({ error: 'ends_at must be in the future' });
    // No default - fulfillment_mode decides whether forfeiture applies to a
    // buyer's money, so it must be a deliberate choice, not something that
    // silently defaults on a missing field.
    if (!FULFILLMENT_MODES.includes(fulfillment_mode)) {
      return res.status(400).json({ error: `fulfillment_mode is required and must be one of: ${FULFILLMENT_MODES.join(', ')}` });
    }
  // Always created as a draft - never publicly visible until the host
  // explicitly publishes via POST /auction/:id/publish. starts_at is
  // resolved now (not at publish time) so a scheduled start set while
  // drafting is preserved.
  const { data, error } = await supabase.from('auctions').insert({
    title, description, image_url, category, starting_bid, current_bid: starting_bid,
        status: 'draft',
        starts_at: starts_at || new Date().toISOString(), ends_at: ends_at || null,
        mode: auctionMode,
        fulfillment_mode,
        host_username: req.user.username
  }).select().single();

  if (error) return res.status(500).json({ error: 'Failed to create auction' });
  res.status(201).json(data);
});

// Moves a draft auction live (or upcoming, for a scheduled starts_at) once
// the host is ready. Requires at least one lot - publishing an empty
// auction is almost certainly a mistake, not an intentional "coming soon".
app.post('/auction/:id/publish', requireAdmin, async (req, res) => {
  const { data: auction, error } = await supabase.from('auctions').select('status, starts_at, ends_at, fulfillment_mode, pickup_address, pickup_starts_at, pickup_ends_at').eq('id', req.params.id).single();
  if (error || !auction) return res.status(404).json({ error: 'Auction not found' });
  if (auction.status !== 'draft') return res.status(400).json({ error: 'Auction is not a draft' });

  const { count, error: countErr } = await supabase
    .from('auction_items')
    .select('id', { count: 'exact', head: true })
    .eq('auction_id', req.params.id);
  if (countErr) return res.status(500).json({ error: 'Failed to check lots' });
  if (!count) return res.status(400).json({ error: 'Add at least one lot before publishing' });

  if (auction.fulfillment_mode === 'pickup' || auction.fulfillment_mode === 'both') {
    if (!auction.pickup_address || !auction.pickup_starts_at || !auction.pickup_ends_at) {
      return res.status(400).json({ error: 'Add a pickup address and pickup window before publishing' });
    }
    if (auction.ends_at && new Date(auction.pickup_ends_at) <= new Date(auction.ends_at)) {
      return res.status(400).json({ error: 'Pickup window must end after the auction closes' });
    }
  }

  const newStatus = auction.starts_at && new Date(auction.starts_at) > new Date() ? 'upcoming' : 'live';
  // Guard the transition on status still being 'draft' so a concurrent
  // double-click can't publish twice.
  const { data: updated, error: updateErr } = await supabase
    .from('auctions')
    .update({ status: newStatus })
    .eq('id', req.params.id)
    .eq('status', 'draft')
    .select()
    .single();
  if (updateErr || !updated) return res.status(409).json({ error: 'Auction is no longer a draft' });

  res.json(updated);
});

// Self-scoped: the caller's own id comes from the JWT, never from a param -
// no route lets you ask about anyone else's acceptance.
app.get('/auction/:id/terms-acceptance', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('auction_terms_acceptances')
    .select('accepted_at, buyers_premium_pct, pickup_ends_at, fulfillment_mode, fulfillment_choice, terms_version')
    .eq('auction_id', req.params.id)
    .eq('user_id', String(req.user.id))
    .maybeSingle();
  if (error) return res.status(500).json({ error: 'Failed to check terms acceptance' });
  res.json({ accepted: !!data, ...(data || {}) });
});

app.post('/auction/:id/terms-acceptance', requireAuth, async (req, res) => {
  const { fulfillment_choice } = req.body;
  const { data: auction, error: auctionErr } = await supabase
    .from('auctions')
    .select('status, fulfillment_mode, buyers_premium_pct, pickup_ends_at')
    .eq('id', req.params.id)
    .single();
  if (auctionErr || !auction) return res.status(404).json({ error: 'Auction not found' });
  if (auction.status === 'draft' && req.user.username !== ADMIN_USERNAME) {
    return res.status(404).json({ error: 'Auction not found' });
  }

  // The buyer only picks between pickup and shipping when the auction
  // genuinely offers both - otherwise the choice is implied by the auction
  // and resolved server-side, so a client can never submit 'pickup' on a
  // shipping-only auction (or vice versa) no matter what it sends.
  let resolvedChoice;
  if (auction.fulfillment_mode === 'both') {
    if (fulfillment_choice !== 'shipping' && fulfillment_choice !== 'pickup') {
      return res.status(400).json({ error: "fulfillment_choice is required and must be 'shipping' or 'pickup'" });
    }
    resolvedChoice = fulfillment_choice;
  } else {
    resolvedChoice = auction.fulfillment_mode;
  }

  // Snapshotted server-side from the auction row right now - the client
  // never gets to supply these values. ignoreDuplicates makes a re-accept a
  // silent no-op: accepted_at and this snapshot (fulfillment_choice
  // included) must never be overwritten by a later call here - changing the
  // choice after the fact goes through PATCH /auction/:id/fulfillment-choice
  // instead, which updates nothing else.
  const { error: upsertErr } = await supabase.from('auction_terms_acceptances').upsert({
    auction_id: req.params.id,
    user_id: String(req.user.id),
    buyers_premium_pct: auction.buyers_premium_pct,
    pickup_ends_at: auction.pickup_ends_at,
    fulfillment_mode: auction.fulfillment_mode,
    fulfillment_choice: resolvedChoice,
    terms_version: TERMS_VERSION,
  }, { onConflict: 'auction_id,user_id', ignoreDuplicates: true });
  if (upsertErr) return res.status(500).json({ error: 'Failed to record acceptance' });

  const { data, error } = await supabase
    .from('auction_terms_acceptances')
    .select('accepted_at, buyers_premium_pct, pickup_ends_at, fulfillment_mode, fulfillment_choice, terms_version')
    .eq('auction_id', req.params.id)
    .eq('user_id', String(req.user.id))
    .single();
  if (error || !data) return res.status(500).json({ error: 'Failed to load acceptance' });
  res.json({ accepted: true, ...data });
});

// Lets a buyer change pickup vs shipping any time before the auction closes
// - only on a 'both' auction, since a shipping-only or pickup-only auction
// has no choice to change. Updates only fulfillment_choice: accepted_at and
// the buyers_premium_pct/pickup_ends_at/fulfillment_mode/terms_version
// snapshot stay exactly as they were at acceptance time.
app.patch('/auction/:id/fulfillment-choice', requireAuth, async (req, res) => {
  const { fulfillment_choice } = req.body;
  if (fulfillment_choice !== 'shipping' && fulfillment_choice !== 'pickup') {
    return res.status(400).json({ error: "fulfillment_choice must be 'shipping' or 'pickup'" });
  }

  const { data: auction, error: auctionErr } = await supabase
    .from('auctions').select('status, fulfillment_mode').eq('id', req.params.id).single();
  if (auctionErr || !auction) return res.status(404).json({ error: 'Auction not found' });
  if (auction.fulfillment_mode !== 'both') {
    return res.status(400).json({ error: 'This auction does not offer a choice of fulfilment' });
  }
  if (auction.status === 'ended') {
    return res.status(400).json({ error: 'Auction has closed - fulfilment choice can no longer be changed' });
  }

  const { data, error } = await supabase
    .from('auction_terms_acceptances')
    .update({ fulfillment_choice })
    .eq('auction_id', req.params.id)
    .eq('user_id', String(req.user.id))
    .select('accepted_at, buyers_premium_pct, pickup_ends_at, fulfillment_mode, fulfillment_choice, terms_version')
    .single();
  if (error || !data) return res.status(404).json({ error: 'Accept the auction terms before changing your fulfilment choice' });

  // Mirror onto this buyer's orders from this auction that haven't entered
  // the shipping-charge flow yet (still pending, never even claimed for a
  // charge) - an order already charged for postage or further along keeps
  // whatever choice it was charged under; this never touches that flow.
  await supabase.from('orders')
    .update({ fulfillment_choice })
    .eq('auction_id', req.params.id)
    .eq('buyer_user_id', String(req.user.id))
    .eq('status', 'pending')
    .is('shipping_payment_status', null);

  res.json({ accepted: true, ...data });
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

    // Drafts are private - resolve this BEFORE joining the room or emitting
    // any state (auction_state/bid_history/chat_history). Checking after
    // would already have leaked the auction to anyone who has its id.
    const { data: auction } = await supabase.from('auctions').select('*').eq('id', auctionId).single();
    if (auction && auction.status === 'draft' && (!user || user.username !== ADMIN_USERNAME)) {
      socket.emit('auction_error', { code: 'not_found', message: 'Auction not found.' });
      return;
    }

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

  // Live-auction bidding is gated off (v2), same as POST /auction rejecting
  // mode 'live': this path still calls the old place_bid RPC, not
  // place_standard_bid, so it has no proxy bidding, no tiered increments,
  // and no atomic row lock; and live auctions never charge (createOrderOnWin
  // is only wired into autoCloseStandardItems, not the live socket path).
  // Don't re-enable without fixing both.
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
  if (!winnerUsername) return null;
  try {
    // Idempotency: never create a second order for the same lot
    if (itemId) {
      const { data: existing, error: existingErr } = await supabase
        .from('orders').select('id').eq('item_id', itemId).limit(1);
      if (existingErr) {
        console.error('Order idempotency check failed:', existingErr.message);
        return null;
      }
      if (existing && existing.length) return existing[0].id;
    }

    const { data: winner, error: winnerErr } = await supabase.from('users').select('id').eq('username', winnerUsername).single();
    if (winnerErr || !winner) return null;
    const { data: profile } = await supabase.from('profiles').select('*').eq('user_id', String(winner.id)).single();
    const { data: auction, error: auctionErr } = await supabase.from('auctions').select('title, description, buyers_premium_pct').eq('id', auctionId).single();
    if (auctionErr || !auction) return null;

    // The buyer's own choice, made before their first bid at the terms
    // acknowledgement gate - never re-derived from the auction's current
    // fulfillment_mode, which could have been edited since. Every standard
    // bid/pre-bid path requires an acceptance row to exist before it lets a
    // bid through, so this should always find one; null only for a legacy
    // win with no acceptance row at all (a live auction from before this
    // gate existed).
    const { data: acceptance } = await supabase
      .from('auction_terms_acceptances')
      .select('fulfillment_choice')
      .eq('auction_id', auctionId)
      .eq('user_id', String(winner.id))
      .maybeSingle();
    const fulfillmentChoice = acceptance?.fulfillment_choice || null;

    // Money math in integer cents only - store the computed amounts, not the
    // rate, so a later premium-rate change can't rewrite past orders.
    const hammerCents = Math.round((finalBid || 0) * 100);
    const premiumPct = auction.buyers_premium_pct ?? 15;
    const premiumCents = Math.round(hammerCents * premiumPct / 100);
    const totalCents = hammerCents + premiumCents;

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

    const { data: inserted, error: insertErr } = await supabase.from('orders').insert({
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
      fulfillment_choice: fulfillmentChoice,
      hammer_cents: hammerCents,
      premium_cents: premiumCents,
      total_cents: totalCents,
    }).select('id').single();

    if (insertErr) {
      console.error('Order creation error:', insertErr.message);
      return null;
    }
    console.log('Order created for ' + winnerUsername + ' - auction ' + auctionId + (itemId ? ' item ' + itemId : ''));
    return inserted.id;
  } catch (e) {
    console.error('Order creation error:', e.message);
    return null;
  }
}

// Charges an order's buyer off-session for total_cents. Idempotent - a no-op
// if payment_intent_id is already set, and any other in-flight or already-
// resolved order is skipped by an atomic claim before the charge, so two
// callers (the auto-close job, a manual Charge/Retry click) can never both
// charge the same order. Never throws: every path resolves with {success,
// ...}, so a Stripe outage can't take down a caller like the auto-close job.
async function chargeOrder(orderId) {
  try {
    const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();
    if (!order) return { success: false, error: 'Order not found' };
    if (order.payment_intent_id) {
      await notifyWonAndCharged(orderId, order.payment_intent_id);
      return { success: true, payment_intent_id: order.payment_intent_id, alreadyCharged: true };
    }

    // Atomically claim this order before charging - the real defense against
    // two callers (the auto-close job, a manual Charge/Retry click, a
    // double-click) both proceeding at once. A conditional UPDATE is
    // serialized by Postgres row locking, so at most one caller's UPDATE
    // matches and gets a row back; the other sees payment_status already
    // moved off unpaid/failed and backs off. This is what lets each
    // genuinely new attempt (e.g. a Phase D retry after a real decline) use
    // a fresh idempotency key below instead of a stable per-order one,
    // without reopening the double-charge race a stable key was closing.
    //
    // Also reclaimable: a row stuck in 'charging' for over 5 minutes. Every
    // Railway deploy restarts the container, so a push landing between the
    // claim and the Stripe result stranded the order there permanently -
    // reclaim only matched unpaid/failed, and the UI disables its button on
    // 'charging' with no way to unstick it. charging_since is what lets a
    // later caller tell "actively being charged right now" apart from
    // "was claimed once and the process died before it could resolve".
    const staleCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .from('orders')
      .update({ payment_status: 'charging', charging_since: new Date().toISOString() })
      .eq('id', orderId)
      .is('payment_intent_id', null)
      .or(`payment_status.in.(unpaid,failed),and(payment_status.eq.charging,charging_since.lt.${staleCutoff})`)
      .select()
      .single();
    if (claimErr || !claimed) {
      return { success: false, error: 'Already being charged or already resolved', skipped: true };
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, stripe_payment_method_id')
      .eq('user_id', order.buyer_user_id)
      .single();

    if (!profile?.stripe_customer_id || !profile?.stripe_payment_method_id) {
      const reason = 'No payment method on file';
      await supabase.from('orders').update({ payment_status: 'failed', payment_error: reason }).eq('id', orderId);
      await sendAdminEmail(
        `Payment failed - ${order.buyer_username}`,
        `Order: ${orderId}\nAuction: ${order.auction_id}\nBuyer: ${order.buyer_username}\nAmount: $${((order.total_cents || 0) / 100).toFixed(2)}\nReason: ${reason}`
      );
      await notifyPaymentFailed(orderId, reason);
      return { success: false, error: reason };
    }

    if (!stripe) {
      const reason = 'Stripe not configured';
      await supabase.from('orders').update({ payment_status: 'failed', payment_error: reason }).eq('id', orderId);
      await sendAdminEmail(`Payment failed - ${order.buyer_username}`, `Order: ${orderId}\nReason: ${reason}`);
      await notifyPaymentFailed(orderId, reason);
      return { success: false, error: reason };
    }

    // Idempotency key is fresh per claimed attempt (not stable per order):
    // the claim above is what makes concurrent duplicate calls safe now, so
    // this only has to guard against our own network-level retry of this
    // one Stripe request - it no longer needs to survive across a later,
    // genuinely separate retry. A stable per-order key would have made a
    // Phase D "Retry" replay the first attempt's cached failure instead of
    // actually trying again.
    const paymentIntent = await stripe.paymentIntents.create({
      amount: order.total_cents || 0,
      currency: 'usd',
      customer: profile.stripe_customer_id,
      payment_method: profile.stripe_payment_method_id,
      confirm: true,
      off_session: true,
      metadata: { order_id: orderId, auction_id: order.auction_id, winner_username: order.buyer_username },
    }, { idempotencyKey: `order-${orderId}-${require('crypto').randomUUID()}` });

    await supabase.from('orders')
      .update({ payment_intent_id: paymentIntent.id, payment_status: 'paid', payment_error: null })
      .eq('id', orderId);
    await notifyWonAndCharged(orderId, paymentIntent.id);
    return { success: true, payment_intent_id: paymentIntent.id };
  } catch (e) {
    console.error('chargeOrder error:', orderId, e.message);
    try {
      await supabase.from('orders').update({ payment_status: 'failed', payment_error: e.message }).eq('id', orderId);
    } catch (updateErr) {
      console.error('chargeOrder: failed to record failure on order', orderId, updateErr.message);
    }
    await sendAdminEmail(
      `Payment failed - order ${orderId}`,
      `chargeOrder failed.\nOrder: ${orderId}\nError: ${e.message}`
    );
    await notifyPaymentFailed(orderId, e.message);
    return { success: false, error: e.message };
  }
}

// Charges an invoice's buyer off-session for total_cents - the standard-
// auction equivalent of chargeOrder above, one charge per buyer per auction
// instead of one per lot. Copies chargeOrder's proven pattern (atomic
// conditional claim including stale-charging reclaim, per-attempt
// idempotency key, mirrors the result onto every child order via
// orders.invoice_id, never throws) rather than modifying chargeOrder itself,
// which stays exactly as-is for live auctions.
async function chargeInvoice(invoiceId) {
  try {
    const { data: invoice } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
    if (!invoice) return { success: false, error: 'Invoice not found' };
    if (invoice.payment_intent_id) {
      await notifyInvoiceWonAndCharged(invoiceId, invoice.payment_intent_id);
      return { success: true, payment_intent_id: invoice.payment_intent_id, alreadyCharged: true };
    }

    const staleCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .from('invoices')
      .update({ payment_status: 'charging', charging_since: new Date().toISOString() })
      .eq('id', invoiceId)
      .is('payment_intent_id', null)
      .or(`payment_status.in.(unpaid,failed),and(payment_status.eq.charging,charging_since.lt.${staleCutoff})`)
      .select()
      .single();
    if (claimErr || !claimed) {
      return { success: false, error: 'Already being charged or already resolved', skipped: true };
    }
    // Mirror the claim onto every child order so orders.payment_status keeps
    // reflecting the invoice's state for UI that reads it directly.
    await supabase.from('orders').update({ payment_status: 'charging' }).eq('invoice_id', invoiceId);

    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, stripe_payment_method_id')
      .eq('user_id', invoice.buyer_user_id)
      .single();

    if (!profile?.stripe_customer_id || !profile?.stripe_payment_method_id) {
      const reason = 'No payment method on file';
      await supabase.from('invoices').update({ payment_status: 'failed', payment_error: reason }).eq('id', invoiceId);
      await supabase.from('orders').update({ payment_status: 'failed', payment_error: reason }).eq('invoice_id', invoiceId);
      await sendAdminEmail(
        `Payment failed - ${invoice.buyer_username}`,
        `Invoice: ${invoiceId}\nAuction: ${invoice.auction_id}\nBuyer: ${invoice.buyer_username}\nAmount: $${((invoice.total_cents || 0) / 100).toFixed(2)}\nReason: ${reason}`
      );
      await notifyInvoicePaymentFailed(invoiceId, reason);
      return { success: false, error: reason };
    }

    if (!stripe) {
      const reason = 'Stripe not configured';
      await supabase.from('invoices').update({ payment_status: 'failed', payment_error: reason }).eq('id', invoiceId);
      await supabase.from('orders').update({ payment_status: 'failed', payment_error: reason }).eq('invoice_id', invoiceId);
      await sendAdminEmail(`Payment failed - ${invoice.buyer_username}`, `Invoice: ${invoiceId}\nReason: ${reason}`);
      await notifyInvoicePaymentFailed(invoiceId, reason);
      return { success: false, error: reason };
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: invoice.total_cents || 0,
      currency: 'usd',
      customer: profile.stripe_customer_id,
      payment_method: profile.stripe_payment_method_id,
      confirm: true,
      off_session: true,
      metadata: { invoice_id: invoiceId, auction_id: invoice.auction_id, winner_username: invoice.buyer_username },
    }, { idempotencyKey: `invoice-${invoiceId}-${require('crypto').randomUUID()}` });

    await supabase.from('invoices')
      .update({ payment_intent_id: paymentIntent.id, payment_status: 'paid', payment_error: null })
      .eq('id', invoiceId);
    await supabase.from('orders')
      .update({ payment_intent_id: paymentIntent.id, payment_status: 'paid', payment_error: null })
      .eq('invoice_id', invoiceId);
    await notifyInvoiceWonAndCharged(invoiceId, paymentIntent.id);
    return { success: true, payment_intent_id: paymentIntent.id };
  } catch (e) {
    console.error('chargeInvoice error:', invoiceId, e.message);
    try {
      await supabase.from('invoices').update({ payment_status: 'failed', payment_error: e.message }).eq('id', invoiceId);
      await supabase.from('orders').update({ payment_status: 'failed', payment_error: e.message }).eq('invoice_id', invoiceId);
    } catch (updateErr) {
      console.error('chargeInvoice: failed to record failure on invoice', invoiceId, updateErr.message);
    }
    await sendAdminEmail(
      `Payment failed - invoice ${invoiceId}`,
      `chargeInvoice failed.\nInvoice: ${invoiceId}\nError: ${e.message}`
    );
    await notifyInvoicePaymentFailed(invoiceId, e.message);
    return { success: false, error: e.message };
  }
}

// Builds one invoice per distinct buyer for a just-closed standard auction
// and charges each. Called once, from autoCloseStandardItems, when the
// auction has no lots left open (all sold/unsold) - see the trigger there
// for why that check is safe without an artificial delay. Sums each order's
// already-captured total_cents rather than recomputing from the auction's
// current premium rate, same reasoning as createOrderOnWin.
//
// Idempotent: the (auction_id, buyer_user_id) unique constraint means a
// re-run (the close job retrying a not-yet-fully-processed auction) either
// finds the existing invoice row or loses a race to insert one and then
// fetches the winner - either way it converges on the same invoice id, links
// any not-yet-linked orders to it, and chargeInvoice's own claim makes a
// repeat charge attempt a no-op once paid (or safely retryable if failed).
async function buildAndChargeInvoicesForAuction(auctionId) {
  try {
    const { data: orders, error: ordersErr } = await supabase
      .from('orders')
      .select('id, buyer_user_id, buyer_username, total_cents, invoice_id')
      .eq('auction_id', auctionId);
    if (ordersErr) {
      console.error('buildAndChargeInvoicesForAuction: failed to load orders:', auctionId, ordersErr.message);
      return;
    }
    if (!orders?.length) return;

    const byBuyer = new Map();
    for (const o of orders) {
      if (!o.buyer_user_id) continue;
      if (!byBuyer.has(o.buyer_user_id)) byBuyer.set(o.buyer_user_id, { buyer_username: o.buyer_username, orders: [] });
      byBuyer.get(o.buyer_user_id).orders.push(o);
    }

    for (const [buyerUserId, group] of byBuyer) {
      const totalCents = group.orders.reduce((sum, o) => sum + (o.total_cents || 0), 0);

      let invoiceId = null;
      const { data: existingInvoice } = await supabase
        .from('invoices').select('id').eq('auction_id', auctionId).eq('buyer_user_id', buyerUserId).maybeSingle();
      if (existingInvoice) {
        invoiceId = existingInvoice.id;
      } else {
        const { data: inserted, error: insertErr } = await supabase
          .from('invoices')
          .insert({ auction_id: auctionId, buyer_user_id: buyerUserId, buyer_username: group.buyer_username, total_cents: totalCents })
          .select('id')
          .single();
        if (insertErr) {
          // Unique-constraint hit means a concurrent tick already created
          // it - fetch rather than treat this as a real failure.
          const { data: raceInvoice } = await supabase
            .from('invoices').select('id').eq('auction_id', auctionId).eq('buyer_user_id', buyerUserId).maybeSingle();
          if (!raceInvoice) {
            console.error('buildAndChargeInvoicesForAuction: invoice creation failed:', auctionId, buyerUserId, insertErr.message);
            continue;
          }
          invoiceId = raceInvoice.id;
        } else {
          invoiceId = inserted.id;
        }
      }

      const unlinkedIds = group.orders.filter(o => o.invoice_id !== invoiceId).map(o => o.id);
      if (unlinkedIds.length) {
        await supabase.from('orders').update({ invoice_id: invoiceId }).in('id', unlinkedIds);
      }

      try {
        await chargeInvoice(invoiceId);
      } catch (chargeErr) {
        console.error('buildAndChargeInvoicesForAuction: chargeInvoice failed:', invoiceId, chargeErr.message);
      }
    }
  } catch (e) {
    console.error('buildAndChargeInvoicesForAuction error:', auctionId, e.message);
  }
}

// Charges one shipment's postage, off-session, for amountCents. orderIds is
// every order in the shipment (a single order, or a bundle grouped for one
// parcel) - there's no separate shipments table, so the charge result is
// mirrored onto every order row in the group, the same way a future invoice
// would mirror onto its child orders. Copies chargeOrder's proven pattern
// (atomic conditional claim, per-attempt idempotency key, never throws)
// rather than reusing chargeOrder itself, since that claims exactly one row
// and chargeOrder must stay untouched. The claim locks on orderIds[0] only:
// callers always pass the same fixed order_ids array for a given shipment
// (driven from one admin action), so a double-click re-sends that exact set
// and the second call's claim matches zero rows once the first has already
// flipped the primary order off 'unpaid'/'failed' - no separate locking
// table needed for that to be race-safe.
async function chargeShipping(orderIds, amountCents) {
  const primaryId = orderIds[0];
  const restIds = orderIds.slice(1);
  try {
    const { data: orders, error: loadErr } = await supabase.from('orders').select('*').in('id', orderIds);
    if (loadErr || !orders || orders.length !== orderIds.length) {
      return { success: false, error: 'Order(s) not found' };
    }
    if (orders.some(o => o.shipping_payment_status === 'paid')) {
      return { success: false, error: 'Shipping already paid for one or more orders in this group' };
    }
    const buyerUserId = orders[0].buyer_user_id;
    if (orders.some(o => o.buyer_user_id !== buyerUserId)) {
      return { success: false, error: 'Orders in this group belong to different buyers' };
    }

    const staleCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .from('orders')
      .update({ shipping_payment_status: 'charging', shipping_charging_since: new Date().toISOString() })
      .eq('id', primaryId)
      .is('shipping_payment_intent_id', null)
      .or(`shipping_payment_status.in.(unpaid,failed),shipping_payment_status.is.null,and(shipping_payment_status.eq.charging,shipping_charging_since.lt.${staleCutoff})`)
      .select()
      .single();
    if (claimErr || !claimed) {
      return { success: false, error: 'Already being charged or already resolved', skipped: true };
    }
    // Best-effort mirror of the claim onto the rest of the group. The claim
    // above is what makes this shipment safe against a concurrent duplicate
    // call; if this mirror update fails partway, the primary order's claim
    // still prevents a second chargeShipping call on the same orderIds from
    // proceeding, and the final success/failure update below re-writes every
    // orderIds row anyway.
    if (restIds.length) {
      await supabase.from('orders')
        .update({ shipping_payment_status: 'charging', shipping_charging_since: new Date().toISOString() })
        .in('id', restIds);
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, stripe_payment_method_id')
      .eq('user_id', buyerUserId)
      .single();

    if (!profile?.stripe_customer_id || !profile?.stripe_payment_method_id) {
      const reason = 'No payment method on file';
      await supabase.from('orders').update({ shipping_payment_status: 'failed', shipping_payment_error: reason }).in('id', orderIds);
      await sendAdminEmail(
        `Shipping charge failed - ${orders[0].buyer_username}`,
        `Order(s): ${orderIds.join(', ')}\nAmount: ${formatMoney(amountCents)}\nReason: ${reason}`
      );
      return { success: false, error: reason };
    }

    if (!stripe) {
      const reason = 'Stripe not configured';
      await supabase.from('orders').update({ shipping_payment_status: 'failed', shipping_payment_error: reason }).in('id', orderIds);
      await sendAdminEmail(`Shipping charge failed - ${orders[0].buyer_username}`, `Order(s): ${orderIds.join(', ')}\nReason: ${reason}`);
      return { success: false, error: reason };
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: profile.stripe_customer_id,
      payment_method: profile.stripe_payment_method_id,
      confirm: true,
      off_session: true,
      metadata: { order_ids: orderIds.join(','), kind: 'shipping', buyer_username: orders[0].buyer_username },
    }, { idempotencyKey: `shipping-${primaryId}-${require('crypto').randomUUID()}` });

    await supabase.from('orders')
      .update({
        shipping_payment_intent_id: paymentIntent.id,
        shipping_payment_status: 'paid',
        shipping_payment_error: null,
        shipping_cost_cents: amountCents,
      })
      .in('id', orderIds);
    return { success: true, payment_intent_id: paymentIntent.id };
  } catch (e) {
    console.error('chargeShipping error:', orderIds.join(','), e.message);
    try {
      await supabase.from('orders').update({ shipping_payment_status: 'failed', shipping_payment_error: e.message }).in('id', orderIds);
    } catch (updateErr) {
      console.error('chargeShipping: failed to record failure on orders', orderIds.join(','), updateErr.message);
    }
    await sendAdminEmail(
      `Shipping charge failed - order(s) ${orderIds.join(', ')}`,
      `chargeShipping failed.\nOrder(s): ${orderIds.join(', ')}\nAmount: ${formatMoney(amountCents)}\nError: ${e.message}`
    );
    return { success: false, error: e.message };
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

// Loads order_ids and rejects the request if any is missing, not found, or
// set to local pickup - shared by the quote and charge+buy steps so neither
// can silently drift from the other's notion of "valid orders for this
// shipment".
async function loadShippableOrders(order_ids) {
  if (!order_ids?.length) return { error: 'order_ids required', status: 400 };
  const { data: orders } = await supabase.from('orders').select('*').in('id', order_ids);
  if (!orders?.length || orders.length !== order_ids.length) return { error: 'Orders not found', status: 404 };

  // null (not-yet-chosen, for 'both' auctions) is a legitimate state and
  // must not be treated as pickup - only block orders explicitly chosen as
  // pickup, since there's no sense buying a shipping label for a lot the
  // buyer is collecting in person.
  const pickupOrders = orders.filter(x => x.fulfillment_choice === 'pickup');
  if (pickupOrders.length) {
    return { error: `Cannot ship - order(s) ${pickupOrders.map(x => x.id).join(', ')} are set to local pickup`, status: 400 };
  }
  return { orders };
}

// Step 1 of the shipping flow: quote the real parcel with Shippo and return
// the cheapest rate WITHOUT buying anything. Weight and dimensions come from
// the host, entered at packing time - there is no hardcoded parcel and no
// fallback if any is missing, because a silent fallback here (a fixed 2lb
// box, regardless of the real contents) is the exact bug this replaces.
app.post('/admin/orders/shipping-quote', requireAdmin, async (req, res) => {
  const { order_ids, weight_oz, length_in, width_in, height_in } = req.body;
  if (weight_oz == null || length_in == null || width_in == null || height_in == null) {
    return res.status(400).json({ error: 'weight_oz, length_in, width_in and height_in are all required' });
  }
  if (!(weight_oz > 0) || !(length_in > 0) || !(width_in > 0) || !(height_in > 0)) {
    return res.status(400).json({ error: 'weight_oz, length_in, width_in and height_in must all be greater than 0' });
  }

  const { orders, error, status } = await loadShippableOrders(order_ids);
  if (error) return res.status(status).json({ error });

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
        // USPS rejects the shipment ("address_from.email must not be empty")
        // without this - found 2026-09-14 exercising the path for the first
        // time. No SHIP_FROM_EMAIL is configured, so fall back to the admin
        // inbox that's already set up.
        email: process.env.SHIP_FROM_EMAIL || process.env.ADMIN_EMAIL || '',
        // USPS also requires this - found immediately after fixing the email
        // one above, same exercise. No existing value to fall back to (unlike
        // email/ADMIN_EMAIL), so this is blank until SHIP_FROM_PHONE is set.
        phone: process.env.SHIP_FROM_PHONE || '',
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
        length: String(length_in), width: String(width_in), height: String(height_in),
        distance_unit: 'in',
        weight: String(weight_oz),
        mass_unit: 'oz',
      }],
      async: false,
      metadata: itemsSummary,
    });

    if (!shipment.rates?.length) {
      return res.status(400).json({ error: 'No shipping rates available', detail: shipment.messages });
    }

    const rate = shipment.rates.sort((a, b) => parseFloat(a.amount) - parseFloat(b.amount))[0];
    res.json({
      rate_id: rate.object_id,
      amount_cents: Math.round(parseFloat(rate.amount) * 100),
      provider: rate.provider,
      servicelevel: rate.servicelevel?.name || rate.servicelevel?.token || null,
      estimated_days: rate.estimated_days ?? null,
    });
  } catch (e) {
    console.error('Shippo quote error:', e.message);
    res.status(500).json({ error: 'Shippo request failed', detail: e.message });
  }
});

// Step 2: charge the buyer exactly the quoted rate, and only on a successful
// charge, buy that label. rate_id/amount_cents must be the quote from
// /admin/orders/shipping-quote above - charging happens before buying so we
// never ship goods we haven't been paid postage for, and never buy a label
// we can't recover the cost of.
app.post('/admin/orders/label', requireAdmin, async (req, res) => {
  const { order_ids, rate_id, amount_cents } = req.body;
  if (!rate_id || !(amount_cents > 0)) {
    return res.status(400).json({ error: 'rate_id and amount_cents (from a shipping quote) are required' });
  }

  const { orders, error, status } = await loadShippableOrders(order_ids);
  if (error) return res.status(status).json({ error });

  if (!SHIPPO_API_KEY) return res.status(500).json({ error: 'SHIPPO_API_KEY not configured' });

  const chargeResult = await chargeShipping(order_ids, amount_cents);
  if (!chargeResult.success) {
    return res.status(402).json({ error: `Shipping charge failed: ${chargeResult.error}`, detail: chargeResult.error });
  }

  try {
    // Fetched independently rather than trusting a client-supplied provider
    // name or a field on the Transaction response - a Transaction has no
    // reliable carrier-name field of its own (that's exactly the bug fixed
    // 2026-09-14, see the tracking_carrier note below), so the rate itself
    // is re-read from Shippo the same way the original single-request flow
    // read it off the /shipments/ response.
    const rateDetails = await shippoFetch('GET', `/rates/${rate_id}/`);
    const transaction = await shippoFetch('POST', '/transactions/', {
      rate: rate_id,
      label_file_type: 'PDF',
      async: false,
    });

    if (transaction.status !== 'SUCCESS') {
      // The buyer has already been charged at this point (chargeResult
      // succeeded above) - this is money collected with no label bought, so
      // it needs a human, not a silent retry with a possibly-stale rate.
      await sendAdminEmail(
        `Shipping charged but label purchase FAILED - order(s) ${order_ids.join(', ')}`,
        `Charged ${formatMoney(amount_cents)} (payment_intent ${chargeResult.payment_intent_id}) but Shippo label purchase failed.\nOrder(s): ${order_ids.join(', ')}\nDetail: ${JSON.stringify(transaction.messages)}`
      );
      return res.status(500).json({
        error: `Buyer was charged but label purchase failed - needs manual follow-up: ${JSON.stringify(transaction.messages)}`,
        detail: transaction.messages,
      });
    }

    // rate.provider (e.g. "USPS") is the carrier name - a Transaction has no
    // such field itself. tracking_url_provider is Shippo's own hosted
    // tracking page for this shipment, and is what buyers should be linked
    // to directly rather than a carrier slug we guess a URL from.
    const trackingCarrier = rateDetails?.provider || null;
    const trackingUrl = transaction.tracking_url_provider;
    if (!trackingCarrier || !trackingUrl) {
      console.error(
        `Shippo label for order(s) ${order_ids.join(',')}: missing ${!trackingCarrier ? 'rate.provider' : ''}${!trackingCarrier && !trackingUrl ? ' and ' : ''}${!trackingUrl ? 'transaction.tracking_url_provider' : ''} after a successful label purchase - Shippo's response shape may have changed.`
      );
    }

    const groupId = orders[0].group_id || orders[0].id;
    await supabase.from('orders').update({
      status: 'label_created',
      group_id: groupId,
      shippo_transaction_id: transaction.object_id,
      label_url: transaction.label_url,
      tracking_number: transaction.tracking_number,
      tracking_carrier: trackingCarrier,
      tracking_url: trackingUrl,
    }).in('id', order_ids);

    res.json({
      label_url: transaction.label_url,
      tracking_number: transaction.tracking_number,
      shipping_cost_cents: amount_cents,
    });
  } catch (e) {
    console.error('Shippo error:', e.message);
    await sendAdminEmail(
      `Shipping charged but label purchase FAILED - order(s) ${order_ids.join(', ')}`,
      `Charged ${formatMoney(amount_cents)} (payment_intent ${chargeResult.payment_intent_id}) but Shippo label purchase threw.\nOrder(s): ${order_ids.join(', ')}\nError: ${e.message}`
    );
    res.status(500).json({ error: `Buyer was charged but label purchase failed - needs manual follow-up: ${e.message}`, detail: e.message });
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
        const { data: updatedOrders } = await supabase
          .from('orders').update({ status }).eq('tracking_number', tracking_number)
          .select('id');
        console.log('- Tracking update: ' + tracking_number + ' -> ' + status);
        if (status === 'shipped' && updatedOrders?.length) {
          for (const o of updatedOrders) {
            notifyShipped(o.id).catch(e => console.error('notifyShipped error:', e.message));
          }
        }
      }
    }
  } catch (e) {
    console.error('Shippo webhook error:', e.message);
  }
  res.json({ received: true });
});


// AUCTION ITEMS AND PRE-BIDS

app.get('/auction/:id/items', optionalAuth, async (req, res) => {
  const { data: auction } = await supabase.from('auctions').select('status').eq('id', req.params.id).single();
  if (auction?.status === 'draft' && req.user?.username !== ADMIN_USERNAME) {
    return res.status(404).json({ error: 'Auction not found' });
  }
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
  const { data: auctionRow } = await supabase.from('auctions').select('status').eq('id', req.params.id).single();
  if (!auctionRow) return res.status(404).json({ error: 'Auction not found' });
  if (auctionRow.status === 'draft') return res.status(400).json({ error: 'Auction is not published yet' });

  // A pre-bid is equally binding as a live bid - it commits the buyer to
  // purchase at that price - so it gets the same terms-acceptance guarantee.
  const { data: acceptance } = await supabase
    .from('auction_terms_acceptances')
    .select('auction_id')
    .eq('auction_id', req.params.id)
    .eq('user_id', String(req.user.id))
    .maybeSingle();
  if (!acceptance) return res.status(403).json({ error: 'You must accept the auction terms before bidding' });

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

  const { data: auctionRow } = await supabase.from('auctions').select('status').eq('id', req.params.id).single();
  if (!auctionRow) return res.status(404).json({ error: 'Auction not found' });
  if (auctionRow.status === 'draft') return res.status(400).json({ error: 'Auction is not published yet' });

  // Belt and braces: the acknowledgement modal is the UX, this is the
  // guarantee. The forfeiture clause is only defensible if every bidder
  // demonstrably accepted terms before bidding, not just whoever hit the modal.
  const { data: acceptance } = await supabase
    .from('auction_terms_acceptances')
    .select('auction_id')
    .eq('auction_id', req.params.id)
    .eq('user_id', String(req.user.id))
    .maybeSingle();
  if (!acceptance) return res.status(403).json({ error: 'You must accept the auction terms before bidding' });

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

  // Fire-and-forget: this notifies whoever *lost* the lead, a different user
  // than the one who just bid, so it must never delay this response.
  notifyOutbidIfNeeded(req.params.itemId, bidItem.leading_bidder)
    .catch(e => console.error('notifyOutbidIfNeeded error:', e.message));
});

app.get('/auction/:id/items/standard-status', optionalAuth, async (req, res) => {
  const { data: auction } = await supabase.from('auctions').select('status').eq('id', req.params.id).single();
  if (auction?.status === 'draft' && req.user?.username !== ADMIN_USERNAME) {
    return res.status(404).json({ error: 'Auction not found' });
  }
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

app.post('/upload-image', requireAdmin, express.raw({ type: 'image/*', limit: '5mb' }), async (req, res) => {
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

    // A draft's lots must never close or create orders, even if their
    // ends_at (set while still drafting) has already passed by publish time.
    const { data: draftAuctions, error: draftErr } = await supabase
      .from('auctions').select('id').eq('status', 'draft')
    if (draftErr) console.error('autoCloseStandardItems: failed to load draft auctions:', draftErr.message)
    const draftAuctionIds = new Set((draftAuctions || []).map(a => a.id))

    // Step 1: Close any items whose ends_at has passed and aren't already closed.
    // This is the ONLY place standard lots get closed - see note on
    // sweepExpiredStandardItems above.
    const { data: expiredItems, error: expiredErr } = await supabase
      .from('auction_items')
      .select('id, auction_id, bid_count, leading_bidder, current_bid, reserve_price')
      .lt('ends_at', now)
      .not('status', 'in', '("sold","unsold")')

    if (expiredErr) {
      // Without this the whole sweep silently no-ops on a DB error - next
      // tick retries, but a persistent error would close nothing forever
      // with zero signal. Log it so that's visible instead.
      console.error('autoCloseStandardItems: failed to load expired items:', expiredErr.message)
    } else if (expiredItems?.length) {
      for (const item of expiredItems) {
        if (draftAuctionIds.has(item.auction_id)) continue
        const hasWinner = !!item.leading_bidder && item.bid_count > 0

        // Respect a reserve price if one is set
        const reserve = item.reserve_price != null ? parseFloat(item.reserve_price) : null
        const metReserve = reserve == null || parseFloat(item.current_bid || 0) >= reserve

        const sold = hasWinner && metReserve
        const newStatus = sold ? 'sold' : 'unsold'

        const { error: updErr } = await supabase
          .from('auction_items').update({ status: newStatus }).eq('id', item.id)
        if (updErr) { console.error('Close item failed:', item.id, updErr.message); continue }

        // Create the order for the winner. createOrderOnWin is idempotent
        // and returns the order id (existing or newly created) directly -
        // no follow-up lookup, so there's no query here whose error could
        // get silently dropped. No per-lot charge here anymore - standard
        // auctions batch every buyer's lots into one invoice and charge once
        // when the whole auction closes (Step 2 below), not as each lot
        // closes. Live auctions don't go through this sweep at all (their
        // items never get an ends_at - see the comment on Step 1 above), so
        // this doesn't touch per-lot live charging.
        if (sold) {
          await createOrderOnWin(item.auction_id, item.leading_bidder, item.current_bid, item.id)
        }
        console.log(`Standard item ${item.id} closed: ${newStatus}`)
      }
    }

    // Step 2: End any standard live auctions where ALL items are now closed.
    // This is also the batched-charging trigger: when the last open lot in
    // an auction closes, build one invoice per buyer (summing their orders'
    // already-captured total_cents) and attempt to charge each. No
    // artificial delay - soft close already extends individual lots, so "no
    // open items left" is genuinely the end.
    //
    // Ending the auction is NOT gated on charging succeeding. A decline is
    // an expected outcome, not a crash to retry - if it blocked 'ended',
    // one buyer's bad card would hold the whole auction open on every tick
    // forever, retrying a charge that will keep failing. That's the same
    // shape of bug as a stuck 'charging' order with no way out (the reason
    // chargeOrder's stale-claim reclaim exists at all). A failed invoice is
    // recorded via invoices.payment_status = 'failed' and left for Phase
    // D's manual Charge/Retry, exactly like a failed order always has been -
    // the auction still ends here regardless.
    //
    // buildAndChargeInvoicesForAuction never throws (see its own comment),
    // so the try/catch below is defensive only, not something the 'ended'
    // update depends on.
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
          try {
            await buildAndChargeInvoicesForAuction(auction.id)
          } catch (invErr) {
            console.error('buildAndChargeInvoicesForAuction failed for auction', auction.id, invErr.message)
          }
          // Unconditional: reached regardless of whether any invoice above
          // charged successfully, declined, or errored.
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
