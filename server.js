require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { AccessToken } = require('livekit-server-sdk');
const Stripe = require('stripe');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const helmet = require('helmet');
const sharp = require('sharp');
const aiLots = require('./ai_lots');
const { makeThumb, thumbPathFor } = require('./thumbs');
const lotRules = require('./lot_rules');
const { publicAuction, publicLot, auctionFor } = require('./public_view');
const rewardsLib = require('./rewards');

const app = express();
const server = http.createServer(app);

// -- Allowed browser origins (security review #11) --
// Was '*' on both Express and Socket.io. Only the site itself (and the local
// Vite dev server, when not running on Railway) may call the API from a
// browser. CORS_EXTRA_ORIGINS (comma-separated) adds more, e.g. a preview URL.
// Requests with no Origin (servers, webhooks, curl) are unaffected. Auth is a
// bearer token, not a cookie, so this is defence in depth rather than CSRF.
const ON_RAILWAY = !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const ALLOWED_ORIGINS = new Set([
  'https://whatthefind.live', 'https://www.whatthefind.live',
  ...(ON_RAILWAY ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173']),
  ...String(process.env.CORS_EXTRA_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean),
]);
const originAllowed = origin => !origin || ALLOWED_ORIGINS.has(origin);
const corsOrigin = (origin, cb) => cb(null, originAllowed(origin));

const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'] },
  // Browsers don't apply CORS to a WebSocket upgrade, so check the origin here too.
  allowRequest: (req, cb) => cb(null, originAllowed(req.headers.origin)),
});

// Security headers on every API response (security review #10): nosniff,
// no framing, a locked-down CSP (the API only ever returns JSON), HSTS, and no
// x-powered-by. The site's own headers (CSP etc.) are set in the frontend's
// vercel.json.
app.use(helmet());

// -- Stripe webhook needs raw body --
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(cors({ origin: corsOrigin }));
// JSON bodies: 100kb (security review #12). This used to be 60mb for every
// route, anonymous ones included, so repeated 60mb POSTs to /auth/login could
// exhaust the instance's memory. Express applies only the first JSON parser a
// request hits, so the three routes that take big bodies (base64 photo batches,
// 200-lot bulk create) are skipped here and parse their own - after
// requireAdmin, so a big body is only ever read for the admin.
const BIG_JSON_ROUTES = [/^\/ai\/(group-photos|analyze-lot)\/?$/, /^\/auction\/[^/]+\/items\/bulk\/?$/];
const smallJson = express.json({ limit: '100kb' });
app.use((req, res, next) => BIG_JSON_ROUTES.some(re => re.test(req.path)) ? next() : smallJson(req, res, next));

// -- Rate limits (security review #5) --
// There were none: 30 wrong passwords in under 5s, no lockout, and nothing
// slowing registration, reset emails, bids or chat. In-memory per instance.
// Railway puts exactly one proxy in front: trust that hop, so req.ip is the
// client (and a client can't pick its own IP by sending X-Forwarded-For).
app.set('trust proxy', 1);
// The verification suites fire many requests from localhost; guard.js sets
// this for the local servers they start. Loopback only - Railway traffic never
// arrives from loopback, and production never sets it.
const RATE_LIMIT_EXEMPT_LOOPBACK = process.env.RATE_LIMIT_EXEMPT_LOOPBACK === '1';
const isLoopback = ip => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
function limiter({ windowMs, limit, key, skipSuccessfulRequests = false, message = 'Too many requests. Please wait a few minutes and try again.' }) {
  return rateLimit({
    windowMs, limit, skipSuccessfulRequests,
    standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: key || (req => ipKeyGenerator(req.ip)),
    skip: req => RATE_LIMIT_EXEMPT_LOOPBACK && isLoopback(req.ip),
    handler: (req, res) => res.status(429).json({ error: message, code: 'rate_limited' }),
  });
}
const perUser = req => 'u:' + String(req.user?.id);
const LIMITS = {
  // Failed logins only: per IP, and per username across IPs (slows a spread-out
  // guess at one account - the admin's - without an easy lockout of it).
  loginIp: limiter({ windowMs: 15 * 60e3, limit: 10, skipSuccessfulRequests: true, message: 'Too many failed logins. Try again in 15 minutes.' }),
  loginUser: limiter({ windowMs: 60 * 60e3, limit: 30, skipSuccessfulRequests: true, key: req => 'login:' + String(req.body?.username ?? '').trim().toLowerCase(), message: 'Too many failed logins for this account. Try again later, or reset your password.' }),
  register: limiter({ windowMs: 60 * 60e3, limit: 5, message: 'Too many new accounts from here. Try again later.' }),
  forgot: limiter({ windowMs: 15 * 60e3, limit: 5 }),
  reset: limiter({ windowMs: 15 * 60e3, limit: 10 }),
  // Routes that check the current password: no guessing it through them.
  passwordCheck: limiter({ windowMs: 15 * 60e3, limit: 10, key: perUser }),
  bidding: limiter({ windowMs: 60e3, limit: 30, key: perUser, message: 'Too many bids too quickly. Wait a moment and try again.' }),
  ai: limiter({ windowMs: 60e3, limit: 30, key: perUser }),
  // Backstop for everything else, per IP.
  api: limiter({ windowMs: 60e3, limit: 1200 }),
};
app.use(LIMITS.api);

// -- Clients --
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
// Buyer points + promotions (G2). Off unless POINTS_ENABLED=true and the admin switch is on; see rewards.js.
const rewards = rewardsLib.makeRewards(supabase);

// No fallback: a known default secret would let anyone forge any login,
// including the admin account. Refuse to start instead.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET is unset or shorter than 32 characters. Set a strong JWT_SECRET (32+ chars) in the environment. Refusing to start.');
  process.exit(1);
}
const ADMIN_USERNAME = 'whatthefind';
// Live shows (G1, wtf-handoff LIVE_SHOWS_BRIEF.md). OFF unless LIVE_ENABLED=true: creating a live show, the live
// socket events, live pre-bids and the video token all refuse. Albert switches it on after the rehearsal (§9).
const LIVE_ENABLED = process.env.LIVE_ENABLED === 'true';
const LIVE_OFF = 'Live shows are not available yet.';

// -- Email: every message goes through Resend's HTTP API (sendEmail below). The
// old Nodemailer SMTP transport was created here but never used, and pulled in
// a dependency with open advisories; removed (security review #23).

// whatthefind.live is Resend-verified for sending; it has no MX on the apex,
// so mail sent TO @whatthefind.live bounces. Reply-To always points at a real
// inbox so a buyer replying to a "you won" email actually reaches someone.
const ADMIN_FROM = 'WhatTheFind Live <alerts@whatthefind.live>';
const BUYER_FROM = 'WhatTheFind Live <auctions@whatthefind.live>';
// Where links in emails point (password reset). Override for a staging frontend.
const SITE_URL = (process.env.SITE_URL || 'https://whatthefind.live').replace(/\/+$/, '');
const REPLY_TO = 'whatthefind.co@gmail.com';

// Resend Pro: 50,000 emails per billing period, no daily cap. The limit that can
// now bite is that quota, and a quota that runs out rejects EVERYTHING until it
// resets - including won/charged, which must never be dropped - so running out
// is worse than it ever was mid-day, not better. email_send_log has one row per
// email actually accepted by Resend (any kind); once the recent count is near
// the quota, only the lowest-value kind (outbid) gets suppressed -
// won/failed/shipped/admin always go through regardless of volume. The 5,000 of
// headroom is what those kinds run on.
//
// The window is a ROLLING 30 days, and it is deliberately APPROXIMATE and
// deliberately CONSERVATIVE. Resend's period is the billing cycle, which renews
// on the day the plan started (the 20th, at the time of writing), not the 1st -
// so a calendar month is wrong in both directions. Anchoring on today's billing
// day would be exact until the plan changes or is resubscribed, and then
// silently wrong with nobody to notice. A rolling window needs no such constant
// and errs in the SAFE direction: just after a real reset it still counts the
// pre-reset sends, so it reaches 45,000 sooner than Resend's own meter and
// suppresses outbid EARLY - a few dropped outbid emails, harmless. It can only
// err LATE on the last day of a 31-day cycle, when it misses about one day of
// sends - far inside the 5,000 headroom. Erring late is how won emails get
// rejected; erring early costs nothing that matters. Do not "fix" it to be exact.
const MONTHLY_EMAIL_CAP = 50000;
const OUTBID_SUPPRESS_AT = 45000;
const EMAIL_WINDOW_DAYS = 30;

function emailWindowStart() {
  return new Date(Date.now() - EMAIL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

// Fails CLOSED: if the count itself can't be read, we can't prove we're
// clear of the quota, so treat outbid as suppressed rather than risk being the
// send that trips Resend into rejecting a won/failed/shipped email this period.
async function shouldSuppressOutbid() {
  const { count, error } = await supabase
    .from('email_send_log')
    .select('id', { count: 'exact', head: true })
    .gte('sent_at', emailWindowStart());
  if (error) {
    console.error('shouldSuppressOutbid: count query failed, suppressing outbid to be safe:', error.message);
    return true;
  }
  return (count || 0) >= OUTBID_SUPPRESS_AT;
}

// Shared send path for every outgoing email (admin alerts and buyer-facing
// mail alike) - never throws and never hangs past the 8s timeout, so a
// Resend outage can't block a charge, an auto-close tick, or a bid response.
// kind categorizes the send for the rolling-window volume count and the outbid
// suppression check above; pass 'outbid' only for the outbid email itself.
// 'reminder' (watch-list reminders, F3) is held back the same way: like outbid
// it is the kind to drop when the quota is nearly gone. Returns true when Resend
// accepted the email, false otherwise (the reminder outbox retries on false).
// Logs never carry a buyer's email address (security review #21): the outbid
// suppression line used to print the recipient, and Resend's error body can
// echo it back. Railway keeps logs; addresses stay in the database.
const redactEmails = t => String(t ?? '').replace(/[^\s@"'<>,;:()]+@[^\s@"'<>,;:()]+\.[^\s@"'<>,;:()]+/g, '[email]');

// replyTo: where a reply goes (default the business address); a service request's email to Albert replies to its sender.
async function sendEmail({ from, to, subject, html, text, kind = 'other', headers, replyTo }) {
  if (!process.env.RESEND_API_KEY) return false; // skip if not configured
  if (!to) return false;

  if ((kind === 'outbid' || kind === 'reminder') && await shouldSuppressOutbid()) {
    console.error(`${kind.toUpperCase()} EMAIL SUPPRESSED (at ${OUTBID_SUPPRESS_AT} of the ${MONTHLY_EMAIL_CAP} Resend quota, rolling ${EMAIL_WINDOW_DAYS} days): subject="${redactEmails(subject)}"`);
    return false;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, reply_to: replyTo || REPLY_TO, subject, html, text, ...(headers ? { headers } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error('Email send error:', res.status, redactEmails(await res.text()).slice(0, 300));
      return false;
    }
    try {
      await supabase.from('email_send_log').insert({ kind });
    } catch (logErr) {
      console.error('email_send_log insert failed:', logErr.message);
    }
    return true;
  } catch (e) {
    console.error('Email send error:', e.message);
    return false;
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

// The pickup address (B6): only ever in a WINNER's email, and only when they chose pickup. Everyone else sees
// the town on the site. null -> nothing added (a shipping winner keeps the shipping wording).
async function pickupFor(auctionId) {
  const { data } = await supabase.from('auctions').select('*').eq('id', auctionId).maybeSingle();
  if (!data || !data.pickup_address) return null;
  return { address: data.pickup_address, starts_at: data.pickup_starts_at, ends_at: data.pickup_ends_at };
}
function fmtPickupTime(iso) {
  return iso ? new Date(iso).toLocaleString('en-US', { timeZone: SITE_TIMEZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }) : null;
}
function pickupBlockHtml(pickup, plural) {
  const window = pickup.starts_at && pickup.ends_at ? `${escapeHtml(fmtPickupTime(pickup.starts_at))} to ${escapeHtml(fmtPickupTime(pickup.ends_at))}` : null;
  return `<p style="margin:16px 0 0;"><strong>Pickup:</strong> collect your ${plural ? 'lots' : 'lot'} at <strong>${escapeHtml(pickup.address)}</strong>${window ? `, ${window}` : ''}. Lots not collected within the pickup window are forfeited.</p>`;
}
const nextStepHtml = (pickup, plural) => (pickup
  ? pickupBlockHtml(pickup, plural)
  : `<p style="margin:16px 0 0;">What happens next: the host will pack and ship your ${plural ? 'items' : 'item'}, and you'll get another email with tracking once ${plural ? 'each is' : "it's"} on its way.</p>`);

// No premium (live shows, brief §1.4): no premium row at all, rather than "Buyer's premium (0%) $0.00".
function orderPremiumRow(order) {
  if (!(order.premium_cents > 0)) return '';
  const premiumPct = order.hammer_cents > 0 ? Math.round((order.premium_cents / order.hammer_cents) * 100) : 0;
  return `<tr><td style="padding:4px 0;color:#555;">Buyer's premium (${premiumPct}%)</td><td style="padding:4px 0;text-align:right;">${formatMoney(order.premium_cents)}</td></tr>`;
}
// G2 on a live lot: the reward or code that came off this lot's winning bid.
function orderDiscountRow(order) {
  if (!order.discount_kind || !(order.discount_cents > 0)) return '';
  return `<tr><td style="padding:4px 0;color:#555;">${DISCOUNT_LABEL[order.discount_kind] || 'Discount'}</td><td style="padding:4px 0;text-align:right;color:#2e6b34;">&minus;${formatMoney(order.discount_cents)}</td></tr>`;
}

function wonChargedEmailHtml(order, last4, pickup = null) {
  const cardLine = last4 ? `<p style="margin:16px 0 0;color:#555;">Card ending in ${escapeHtml(last4)} was charged.</p>` : '';
  return emailHtml('You won it - and your card has been charged', `
    <p>Congratulations! You won <strong>${escapeHtml(order.item_title)}</strong>.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <tr><td style="padding:4px 0;color:#555;">Hammer price</td><td style="padding:4px 0;text-align:right;">${formatMoney(order.hammer_cents)}</td></tr>
      ${orderPremiumRow(order)}${orderDiscountRow(order)}
      <tr><td style="padding:8px 0 0;font-weight:bold;border-top:1px solid #ddd;">Total charged</td><td style="padding:8px 0 0;text-align:right;font-weight:bold;border-top:1px solid #ddd;">${formatMoney(order.total_cents)}</td></tr>
    </table>
    ${cardLine}
    ${nextStepHtml(pickup, false)}
  `);
}

function paymentFailedEmailHtml(order, reason, live = false) {
  return emailHtml('You won - but your card did not go through', `
    <p>You won <strong>${escapeHtml(order.item_title)}</strong>, but we were unable to charge the card on file.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      <tr><td style="padding:4px 0;color:#555;">Hammer price</td><td style="padding:4px 0;text-align:right;">${formatMoney(order.hammer_cents)}</td></tr>
      ${orderPremiumRow(order)}${orderDiscountRow(order)}
      <tr><td style="padding:8px 0 0;font-weight:bold;border-top:1px solid #ddd;">Total due</td><td style="padding:8px 0 0;text-align:right;font-weight:bold;border-top:1px solid #ddd;">${formatMoney(order.total_cents)}</td></tr>
    </table>
    <p style="margin:16px 0 0;color:#555;">Reason: ${escapeHtml(reason)}</p>
    ${live
      ? '<p style="margin:16px 0 0;">Update your card on your profile page and we will charge it straight away. Until then you can\'t bid in this show. If it isn\'t fixed by the end of the show, the lot may be offered again.</p>'
      : '<p style="margin:16px 0 0;">Your win is still reserved for you. To fix this, log in to WhatTheFind Live and update your payment method on your profile, then reply to this email so the charge can be retried.</p>'}
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
      <td style="padding:4px 0;text-align:right;">${formatMoney(o.hammer_cents)}${o.premium_cents > 0 ? ` + ${formatMoney(o.premium_cents)} premium (${premiumPct}%)` : ''}</td>
    </tr>`;
  }).join('');
}

// G2: the invoice's one discount, as its own line(s) above the total. Bids are never changed.
const DISCOUNT_LABEL = { points_reward: 'Points reward', promo_code: 'Promo code' };
function invoiceDiscountRows(invoice) {
  if (!invoice.discount_kind || !(invoice.discount_cents > 0)) return '';
  const row = (label, cents) => `<tr><td style="padding:4px 0;color:#555;">${label}</td><td style="padding:4px 0;text-align:right;color:#2e6b34;">&minus;${formatMoney(cents)}</td></tr>`;
  return row(DISCOUNT_LABEL[invoice.discount_kind] || 'Discount', invoice.discount_cents)
    + (invoice.discount_premium_cents > 0 ? row('Premium on that amount', invoice.discount_premium_cents) : '');
}
// "You earned 52 points: 198 / 250", plus a ready reward when there is one.
function pointsLineHtml(points) {
  if (!points || !(points.earned > 0)) return '';
  const ready = points.rewards_ready > 0
    ? ` You have a ${formatMoney(points.reward_cents)} reward ready${points.rewards_ready > 1 ? ` (${points.rewards_ready} in all)` : ''}.` : '';
  return `<p style="margin:16px 0 0;color:#555;">You earned <strong>${points.earned} points</strong>: ${points.toward_next} / ${points.per_reward}.${ready}</p>`;
}

function invoiceWonChargedEmailHtml(invoice, orders, last4, pickup = null, points = null) {
  const cardLine = last4 ? `<p style="margin:16px 0 0;color:#555;">Card ending in ${escapeHtml(last4)} was charged.</p>`
    : invoice.total_cents === 0 ? '<p style="margin:16px 0 0;color:#555;">Nothing to pay: your discount covered it.</p>' : '';
  return emailHtml('You won it - and your card has been charged', `
    <p>Congratulations! You won <strong>${orders.length}</strong> lot${orders.length === 1 ? '' : 's'}:</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      ${invoiceLotRows(orders)}
      ${invoiceDiscountRows(invoice)}
      <tr><td style="padding:8px 0 0;font-weight:bold;border-top:1px solid #ddd;">Total charged</td><td style="padding:8px 0 0;text-align:right;font-weight:bold;border-top:1px solid #ddd;">${formatMoney(invoice.total_cents)}</td></tr>
    </table>
    ${cardLine}
    ${pointsLineHtml(points)}
    ${nextStepHtml(pickup, true)}
  `);
}

function invoicePaymentFailedEmailHtml(invoice, orders, reason) {
  return emailHtml('You won - but your card did not go through', `
    <p>You won <strong>${orders.length}</strong> lot${orders.length === 1 ? '' : 's'}, but we were unable to charge the card on file.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">
      ${invoiceLotRows(orders)}
      ${invoiceDiscountRows(invoice)}
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
      html: wonChargedEmailHtml(order, last4, order.fulfillment_choice === 'pickup' ? await pickupFor(order.auction_id) : null),
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
      html: paymentFailedEmailHtml(order, reason, await isLiveModeAuction(order.auction_id)),
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
      .select('id, item_title, hammer_cents, premium_cents, fulfillment_choice')
      .eq('invoice_id', invoiceId);
    if (!orders?.length) return;

    const email = await getBuyerEmail(invoice.buyer_user_id);
    // G2: what this win earned and the balance now (null with points off).
    let points = null;
    try { points = await rewards.summaryFor(invoice.buyer_user_id, orders.map(o => o.id)); } catch { /* never block the email */ }
    if (!email) return;
    // One choice per buyer per auction (made before their first bid), so any order says it.
    const pickup = orders.some(o => o.fulfillment_choice === 'pickup') ? await pickupFor(invoice.auction_id) : null;

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
      html: invoiceWonChargedEmailHtml(invoice, orders, last4, pickup, points),
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
// ---- Sessions ----
// Changing a password (reset link, host temporary password, admin change) signs
// out every existing session. Each token carries the account's
// password_changed_at from when it was issued (claim `pca`, epoch ms); a token
// older than the account's current value is refused. Tokens with no claim were
// issued before this existed and stay valid until the account's password next
// changes; an account with no recorded change (or no row) has nothing to
// compare against, which is how things behaved before.
//
// Looked up through a 60s per-user cache so it isn't a DB hit per request. The
// instance that made the change updates its cache at once; any other instance
// (Railway briefly runs two during a deploy) can accept a revoked token for up
// to 60s.
const MIN_PASSWORD = 8;   // for newly set passwords; existing shorter ones still log in
const PCA_TTL_MS = 60 * 1000;
const pcaCache = new Map();   // userId -> { pca: ms | null, at: ms }

async function currentPca(userId) {
  const id = canonicalUuid(userId);
  if (!id) return { pca: null };
  const hit = pcaCache.get(id);
  if (hit && Date.now() - hit.at < PCA_TTL_MS) return hit;
  const { data, error } = await supabase.from('users').select('password_changed_at').eq('id', id).maybeSingle();
  if (error) {
    if (hit) return hit;   // serve stale rather than fail every request on a blip
    throw error;
  }
  const entry = { pca: data?.password_changed_at ? Date.parse(data.password_changed_at) : null, at: Date.now() };
  if (pcaCache.size > 50000) pcaCache.clear();
  pcaCache.set(id, entry);
  return entry;
}

function notePasswordChanged(userId, iso) {
  const id = canonicalUuid(userId);
  if (id) pcaCache.set(id, { pca: Date.parse(iso), at: Date.now() });
}

async function sessionValid(claims) {
  const { pca } = await currentPca(claims.id);
  if (pca == null) return true;
  return typeof claims.pca === 'number' && claims.pca >= pca;
}

const SESSION_TTL = '7d';
function signSession(user) {
  const pca = user.password_changed_at ? Date.parse(user.password_changed_at) : undefined;
  // 7 days (security review #10; was 30): the token lives in localStorage, so a
  // stolen one should stop working sooner. Existing 30-day tokens run out as issued.
  return jwt.sign({ id: user.id, username: user.username, ...(pca ? { pca } : {}) }, JWT_SECRET, { expiresIn: SESSION_TTL });
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing token' });
  let claims;
  try {
    claims = jwt.verify(auth.slice(7), JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
  sessionValid(claims).then(valid => {
    if (!valid) return res.status(401).json({ error: 'Your password was changed, so you were signed out. Please log in again.', code: 'session_revoked' });
    req.user = claims;
    next();
  }, e => {
    console.error('session check failed:', e.message);
    res.status(503).json({ error: 'Could not check your session. Try again in a moment.' });
  });
}

// ---- Id normalisation at the edge ----
// Every auction/lot id column is uuid now (orders.auction_id: migration c;
// auction_items/pre_bids.auction_id: migration 2026-09-24i). They used to be
// TEXT, where a wrong-case id matched case-sensitively and passed one check
// while missing another. On a uuid column a malformed id is an error (22P02)
// rather than a silent non-match, so validation here still matters.
// Every id that comes in from a URL, body, query or socket event is validated
// as a well-formed uuid and lowercased here, once, before any handler uses it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function canonicalUuid(v) {
  if (typeof v !== 'string') return null;
  const c = v.trim().toLowerCase();
  return UUID_RE.test(c) ? c : null;
}

// URL params. Every :id / :auctionId / :itemId / :imageId / :userId in this
// file is a uuid, so one param hook covers every route that takes one.
for (const name of ['id', 'auctionId', 'itemId', 'imageId', 'userId']) {
  app.param(name, (req, res, next, value) => {
    const c = canonicalUuid(value);
    if (!c) return res.status(400).json({ error: `Invalid ${name}` });
    req.params[name] = c;
    next();
  });
}

// Body ids: { single: ['order_id', ...], list: ['order_ids', ...] }. A field
// that is absent (or null/'') is left alone - each route already decides
// whether it is required.
function normalizeBodyIds({ single = [], list = [] }) {
  return (req, res, next) => {
    const body = req.body || {};
    for (const k of single) {
      if (body[k] == null || body[k] === '') continue;
      const c = canonicalUuid(body[k]);
      if (!c) return res.status(400).json({ error: `Invalid ${k}` });
      body[k] = c;
    }
    for (const k of list) {
      if (body[k] == null) continue;
      if (!Array.isArray(body[k])) return res.status(400).json({ error: `Invalid ${k}` });
      const out = body[k].map(canonicalUuid);
      if (out.some(x => !x)) return res.status(400).json({ error: `Invalid ${k}` });
      body[k] = out;
    }
    next();
  };
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
// A revoked session, or one that can't be checked, is treated as anonymous -
// the lower-privilege answer.
async function optionalAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    try {
      const claims = jwt.verify(auth.slice(7), JWT_SECRET);
      if (await sessionValid(claims)) req.user = claims;
    } catch { /* not logged in - proceed anonymously */ }
  }
  next();
}

// Sockets get the same session check as REST: a signed-out session must not
// keep bidding or chatting over a socket it opened earlier.
async function verifySocketToken(token) {
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    return (await sessionValid(claims)) ? claims : null;
  } catch {
    return null;
  }
}

// A database error is logged with the route, and the client gets a short
// generic message - never the error object itself, which carries table and
// column names, constraint names and Postgres detail (security review #16).
function dbFailure(req, res, err) {
  console.error(`${req.method} ${req.path} failed:`, err?.code || '', err?.message || err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

// ------------------------------------------------------------
// REST ENDPOINTS
// ------------------------------------------------------------

app.get('/', (req, res) => res.json({ status: 'WhatTheFind Live is running' }));

// Deploy fingerprint (#49): after a push, /version.commit must equal
// `git rev-parse HEAD`. Railway sets RAILWAY_GIT_COMMIT_SHA; locally it's null,
// which is correct - never derive it from git at runtime. Returns ONLY these two
// fields: this route must never become a place where config leaks.
const STARTED_AT = new Date().toISOString();
app.get('/version', (req, res) => res.json({ commit: process.env.RAILWAY_GIT_COMMIT_SHA || null, started_at: STARTED_AT }));

// -- Auth --
// Every account has an email (migration 2026-09-26m): it's how a forgotten
// password gets reset. Stored trimmed + lowercased. Not unique - two accounts
// may share one; a reset by email then sends a link for each.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function cleanEmail(v) {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

// Usernames (security review #14): admin is decided by the username, and names
// had no rules - 'WhatTheFind', 'WHATTHEFIND', 'whatthefind ' (trailing space),
// a Cyrillic-a lookalike and markup all registered, and could impersonate the
// host in chat and bids. New names are stored lowercase, only a-z 0-9 _, 3-30
// long, unique regardless of case (checked here and by the lower(username)
// index, migration q), and can't contain 'whatthefind' or be a staff-sounding
// name. Existing accounts keep their names; login accepts any casing.
const USERNAME_RE = /^[a-z0-9_]{3,30}$/;
const RESERVED_USERNAMES = new Set(['admin', 'administrator', 'host', 'support', 'staff', 'moderator', 'mod', 'system', 'root', 'official', 'help', 'owner']);
function usernameProblem(name) {
  if (!USERNAME_RE.test(name)) return 'Usernames are 3-30 characters: lowercase letters, numbers and _ only';
  if (name.replace(/_/g, '').includes('whatthefind') || RESERVED_USERNAMES.has(name.replace(/_/g, ''))) return "That username isn't available";
  if (name.startsWith('deleted_')) return "That username isn't available";   // the placeholder for deleted accounts (A5)
  return null;
}
const likeExact = v => v.replace(/[\\%_]/g, c => '\\' + c);   // ilike with no wildcards = case-insensitive equality

app.post('/auth/register', LIMITS.register, async (req, res) => {
  const { password } = req.body || {};
  if (typeof req.body?.username !== 'string' || typeof password !== 'string' || !password) return res.status(400).json({ error: 'username and password required' });
  const username = req.body.username.trim().toLowerCase();
  const problem = usernameProblem(username);
  if (problem) return res.status(400).json({ error: problem });
  const { data: taken, error: takenErr } = await supabase.from('users').select('id').ilike('username', likeExact(username)).limit(1);
  if (takenErr) return res.status(500).json({ error: 'Registration failed' });
  if (taken.length) return res.status(409).json({ error: 'Username already taken' });
  // A deleted account's old username is held for 30 days (A5), stored only as a hash. Before migration t exists the
  // table doesn't, and registration carries on as before.
  const { data: held, error: heldErr } = await supabase.from('reserved_usernames').select('reserved_until')
    .eq('username_hash', sha256(username)).gt('reserved_until', new Date().toISOString()).limit(1);
  if (heldErr && !['42P01', 'PGRST205'].includes(heldErr.code)) return dbFailure(req, res, heldErr);
  if (held?.length) return res.status(409).json({ error: "That username isn't available" });
  if (password.length < MIN_PASSWORD) return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
  const email = cleanEmail(req.body.email);
  if (!email) return res.status(400).json({ error: 'A valid email is required', detail: "It's how you reset your password if you forget it." });

  const password_hash = await bcrypt.hash(password, 10);
  const { data, error } = await supabase.from('users')
    .insert({ username, password_hash, email, password_changed_at: new Date().toISOString() })
    .select('id, username, email, password_changed_at, created_at').single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Username already taken' });
    return res.status(500).json({ error: 'Registration failed' });
  }
  const token = signSession(data);
  const { password_changed_at, ...user } = data;
  res.json({ token, user });
});

const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);   // same cost as real hashes
app.post('/auth/login', LIMITS.loginIp, LIMITS.loginUser, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) return res.status(400).json({ error: 'username and password required' });
  // Exact name first (older accounts may have capitals), then the lowercase form new names are stored in.
  let { data: user } = await supabase.from('users').select('*').eq('username', username).maybeSingle();
  if (!user && username.trim().toLowerCase() !== username) {
    ({ data: user } = await supabase.from('users').select('*').eq('username', username.trim().toLowerCase()).maybeSingle());
  }
  if (!user) {
    // Same bcrypt work as a real account, so the response time doesn't say
    // whether the username exists (security review #15: ~150ms vs ~80ms).
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  const token = signSession(user);
  res.json({ token, user: { id: user.id, username: user.username, email: user.email || null, created_at: user.created_at } });
});

// The signed-in account, including whether it still needs an email (accounts
// made before emails were required are asked for one at their next visit).
app.get('/auth/me', requireAuth, async (req, res) => {
  const { data: user, error } = await supabase.from('users').select('id, username, email, created_at').eq('id', req.user.id).single();
  if (error || !user) return res.status(401).json({ error: 'Account not found' });
  res.json(user);
});

// Add an email to an account that has none, or change it. Changing an existing
// email needs the current password: otherwise anyone holding a stolen session
// could point the account's resets at their own inbox and take it over.
app.post('/auth/email', requireAuth, LIMITS.passwordCheck, async (req, res) => {
  const email = cleanEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Enter a valid email address' });
  const { data: user } = await supabase.from('users').select('id, email, password_hash').eq('id', req.user.id).single();
  if (!user) return res.status(401).json({ error: 'Account not found' });
  if (user.email && user.email !== email) {
    const pw = req.body?.current_password;
    if (!pw || !(await bcrypt.compare(pw, user.password_hash))) {
      return res.status(401).json({ error: 'Enter your current password to change your email' });
    }
  }
  const { error } = await supabase.from('users').update({ email }).eq('id', user.id);
  if (error) return res.status(500).json({ error: 'Could not save your email' });
  res.json({ email });
});

// ---- Delete my account (A5, DELETE_ACCOUNT_BRIEF.md) ----
// Anonymise, don't erase: personal details go, sale records stay. The database
// work is one transaction in delete_account() (migration t); Stripe is done
// first, and if it fails nothing changes. Refused while the buyer still has
// something in progress, with what to do instead.
const DELETION_BLOCKERS = {
  leading_open_lot: "You're the highest bidder on a lot that's still open. Bids are binding, so wait until it closes.",
  max_bid_open_lot: "You have a max bid on a lot that's still open. Wait until it closes.",
  unpaid_invoice: "You have a payment that hasn't gone through. Update your card on your profile, or reply to the payment email, so it can be settled first.",
  order_not_shipped: "An item you won hasn't shipped or been collected yet, and we still need your address for it. Try again once it's on its way or collected.",
};
const blockersToMessages = codes => codes.map(c => DELETION_BLOCKERS[c] || c);
// Before migration t exists, the functions/column don't: the route says so instead of failing.
const notMigrated = e => ['PGRST202', '42883', '42703', 'PGRST204'].includes(e?.code);

app.post('/account/delete', requireAuth, LIMITS.loginIp, LIMITS.passwordCheck, async (req, res) => {
  if (req.user.username === ADMIN_USERNAME) return res.status(403).json({ error: "The host account can't be deleted" });
  const { password, confirm } = req.body || {};
  if (confirm !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm' });
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Enter your password' });

  const { data: user, error: uErr } = await supabase.from('users').select('id, username, email, password_hash').eq('id', req.user.id).maybeSingle();
  if (uErr) return dbFailure(req, res, uErr);
  if (!user) return res.status(401).json({ error: 'Account not found' });
  if (!(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'That password is not right' });

  const { data: blockers, error: bErr } = await supabase.rpc('account_deletion_blockers', { p_user_id: user.id });
  if (bErr) {
    if (notMigrated(bErr)) return res.status(503).json({ error: 'Account deletion is not available yet. Please contact us.' });
    return dbFailure(req, res, bErr);
  }
  if (blockers?.length) return res.status(409).json({ error: "Your account can't be deleted yet", reasons: blockersToMessages(blockers), codes: blockers });

  const { data: profile, error: pErr } = await supabase.from('profiles').select('email, stripe_customer_id').eq('user_id', String(user.id)).maybeSingle();
  if (pErr) return dbFailure(req, res, pErr);
  const emailOnFile = user.email || profile?.email || null;

  // Stripe first: saved cards detached, the customer deleted. If this fails, stop - nothing has changed.
  const customerId = profile?.stripe_customer_id;
  if (customerId) {
    if (!stripe) return res.status(503).json({ error: "We couldn't remove your saved card right now, so nothing was deleted. Please try again later." });
    try {
      const methods = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 100 });
      for (const m of methods.data || []) await stripe.paymentMethods.detach(m.id);
      await stripe.customers.del(customerId);
    } catch (e) {
      if (e?.code !== 'resource_missing') {   // already gone at Stripe: nothing left to remove
        console.error('account delete: Stripe cleanup failed for user', user.id, e?.code || '', e?.message);
        return res.status(502).json({ error: "We couldn't remove your saved card right now, so nothing was deleted. Please try again later." });
      }
    }
  }

  const { data: newName, error: dErr } = await supabase.rpc('delete_account', { p_user_id: user.id });
  if (dErr) {
    const m = /account_not_deletable:(\S+)/.exec(dErr.message || '');
    if (m) { const codes = m[1].split(','); return res.status(409).json({ error: "Your account can't be deleted yet", reasons: blockersToMessages(codes), codes }); }
    if (notMigrated(dErr)) return res.status(503).json({ error: 'Account deletion is not available yet. Please contact us.' });
    return dbFailure(req, res, dErr);
  }
  notePasswordChanged(user.id, new Date().toISOString());   // this instance drops every session at once
  console.log(`Account deleted: ${user.id} -> ${newName}`);

  // Confirmation to the address that was on file (read before the wipe; sent once the deletion has committed, so it
  // never announces a deletion that didn't happen). A failed send doesn't undo anything.
  if (emailOnFile) {
    await sendEmail({
      from: BUYER_FROM, to: emailOnFile, subject: 'Your WhatTheFind account has been deleted', kind: 'account_deleted',
      text: 'Your WhatTheFind account has been deleted, as you asked.\n\nYour name, contact details, address and saved card have been removed, and your username no longer appears on any bid or message. Records of past purchases (items, amounts, dates and the shipping address used) are kept for accounting and tax, as the privacy policy explains.\n\nIf you didn\'t ask for this, reply to this email.',
      html: emailHtml('Your account has been deleted', '<p>Your WhatTheFind account has been deleted, as you asked.</p><p>Your name, contact details, address and saved card have been removed, and your username no longer appears on any bid or message. Records of past purchases (items, amounts, dates and the shipping address used) are kept for accounting and tax, as the privacy policy explains.</p><p>If you didn\'t ask for this, reply to this email.</p>'),
    });
  }
  res.json({ deleted: true });
});

// ---- Forgotten password ----
// POST /auth/forgot-password { identifier } - a username or an email. Always
// answers the same thing, immediately, whether or not anything matched, so it
// can't be used to find out which usernames or emails have accounts; the
// lookup and email happen after the response is sent.
// POST /auth/reset-password { token, new_password } - single use, 1 hour.
const RESET_TTL_MS = 60 * 60 * 1000;
const RESET_MAX_PER_HOUR = 3;   // per account: stops the form being used to flood someone's inbox
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');

// The limit is enforced insert-first: count-then-insert let parallel requests
// all count before any of them inserted (4 of 4 sent, measured). Each request
// inserts its link, then keeps it only if it is among the first
// RESET_MAX_PER_HOUR in the window by id (identity order is fixed, so every
// racer agrees which ones those are); otherwise it deletes its own row and
// sends nothing. Fails closed: if the check errors, nothing is sent.
async function sendPasswordReset(user) {
  const since = new Date(Date.now() - RESET_TTL_MS).toISOString();
  const token = crypto.randomBytes(32).toString('base64url');
  const { data: row, error } = await supabase.from('password_resets').insert({
    user_id: user.id, token_hash: sha256(token), expires_at: new Date(Date.now() + RESET_TTL_MS).toISOString(),
  }).select('id').single();
  if (error) { console.error('password reset: insert failed:', error.message); return; }

  const { data: first, error: limErr } = await supabase.from('password_resets')
    .select('id').eq('user_id', user.id).gte('created_at', since)
    .order('id', { ascending: true }).limit(RESET_MAX_PER_HOUR);
  if (limErr || !first.some(r => r.id === row.id)) {
    await supabase.from('password_resets').delete().eq('id', row.id);
    console.error(limErr ? `password reset: limit check failed: ${limErr.message}` : `password reset: rate limited for ${user.username}`);
    return;
  }

  const link = `${SITE_URL}/reset-password?token=${token}`;
  await sendEmail({
    from: BUYER_FROM,
    to: user.email,
    subject: 'Reset your WhatTheFind password',
    kind: 'password_reset',
    text: `Someone asked to reset the password for the WhatTheFind account "${user.username}".\n\n`
      + `Set a new password here (the link works once, for 1 hour):\n${link}\n\n`
      + `If this wasn't you, ignore this email - your password hasn't changed.`,
    html: `<p>Someone asked to reset the password for the WhatTheFind account <strong>${escapeHtml(user.username)}</strong>.</p>`
      + `<p><a href="${link}">Set a new password</a> (the link works once, for 1 hour).</p>`
      + `<p>If this wasn't you, ignore this email - your password hasn't changed.</p>`,
  });
}

app.post('/auth/forgot-password', LIMITS.forgot, async (req, res) => {
  const identifier = typeof req.body?.identifier === 'string' ? req.body.identifier.trim() : '';
  if (!identifier) return res.status(400).json({ error: 'Enter your username or email' });
  res.json({ ok: true });

  try {
    const email = cleanEmail(identifier);
    const { data: users, error } = email
      ? await supabase.from('users').select('id, username, email').eq('email', email)
      : await supabase.from('users').select('id, username, email').eq('username', identifier);
    if (error) { console.error('password reset: lookup failed:', error.message); return; }
    for (const u of users || []) {
      if (u.email) await sendPasswordReset(u);
    }
  } catch (e) {
    console.error('password reset failed:', e.message);
  }
});

app.post('/auth/reset-password', LIMITS.reset, async (req, res) => {
  const { token, new_password } = req.body || {};
  if (typeof token !== 'string' || !token) return res.status(400).json({ error: 'This reset link is incomplete' });
  if (typeof new_password !== 'string' || new_password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
  }
  const now = new Date().toISOString();
  // Claim the link atomically: only one request can flip used_at from null,
  // so the same link can't be used twice even if submitted twice at once.
  const { data: claimed, error } = await supabase.from('password_resets')
    .update({ used_at: now })
    .eq('token_hash', sha256(token)).is('used_at', null).gt('expires_at', now)
    .select('user_id').maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not reset your password. Try again.' });
  if (!claimed) return res.status(400).json({ error: 'This reset link has expired or was already used', detail: 'Request a new one from the login page.' });

  const password_hash = await bcrypt.hash(new_password, 10);
  const { data: user, error: upErr } = await supabase.from('users')
    .update({ password_hash, password_changed_at: now }).eq('id', claimed.user_id).select('username').single();
  if (upErr || !user) return res.status(500).json({ error: 'Could not reset your password. Try again.' });
  notePasswordChanged(claimed.user_id, now);   // signs out every existing session
  // Any other outstanding links for this account are now pointless - retire them.
  await supabase.from('password_resets').update({ used_at: now }).eq('user_id', claimed.user_id).is('used_at', null);
  res.json({ success: true, username: user.username });
});

// Host fallback: a buyer who can't reach their email asks the host, who sets a
// temporary password here and tells them. The buyer can keep it or reset it
// by email later.
app.post('/admin/users/:userId/password', requireAdmin, async (req, res) => {
  const { new_password } = req.body || {};
  if (typeof new_password !== 'string' || new_password.length < MIN_PASSWORD) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD} characters` });
  }
  // A deleted account (A5) must stay unusable: no temporary password brings it back.
  const { data: target, error: tErr } = await supabase.from('users').select('deleted_at').eq('id', req.params.userId).maybeSingle();
  if (tErr && !notMigrated(tErr)) return dbFailure(req, res, tErr);
  if (target?.deleted_at) return res.status(409).json({ error: 'This account was deleted and cannot be changed' });
  const password_hash = await bcrypt.hash(new_password, 10);
  const password_changed_at = new Date().toISOString();
  const { data, error } = await supabase.from('users')
    .update({ password_hash, password_changed_at }).eq('id', req.params.userId).select('username').maybeSingle();
  if (error) return res.status(500).json({ error: 'Could not set the password' });
  if (!data) return res.status(404).json({ error: 'Account not found' });
  notePasswordChanged(req.params.userId, password_changed_at);   // signs out the buyer's existing sessions
  console.log(`Admin ${req.user.username} set a temporary password for ${data.username}`);
  res.json({ success: true, username: data.username });
});

// -- Profile --
app.post('/auth/change-password', requireAdmin, LIMITS.passwordCheck, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ error: 'current_password and new_password required' });
  if (new_password.length < MIN_PASSWORD)
    return res.status(400).json({ error: `New password must be at least ${MIN_PASSWORD} characters` });
  const { data: user } = await supabase.from('users').select('*').eq('username', ADMIN_USERNAME).single();
  if (!user) return res.status(404).json({ error: 'Admin user not found' });
  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
  const password_hash = await bcrypt.hash(new_password, 10);
  const password_changed_at = new Date().toISOString();
  const { error: updateErr } = await supabase.from('users').update({ password_hash, password_changed_at }).eq('username', ADMIN_USERNAME);
  if (updateErr) return res.status(500).json({ error: 'Failed to update password' });
  notePasswordChanged(user.id, password_changed_at);
  // This signs out every session, including the one making the change - hand it a fresh token.
  res.json({ success: true, token: signSession({ ...user, password_changed_at }) });
});

app.post('/profile', requireAuth, async (req, res) => {
  const { full_name, phone, address_line1, address_line2, city, state, zip, country } = req.body;
  if (!full_name || !phone || !address_line1 || !city || !state || !zip) {
    return res.status(400).json({ error: 'full_name, phone, address_line1, city, state, zip are required' });
  }
  const email = cleanEmail(req.body.email);
  if (!email) return res.status(400).json({ error: 'A valid email is required' });

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
  // An account with no email yet takes the profile's, so it can reset its password.
  await supabase.from('users').update({ email }).eq('id', req.user.id).is('email', null);
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
    // so a failure here shouldn't fail this request; just record the result. Bidding needs it to have passed
    // (biddingRefusal), so the answer says which it was.
    let cardVerified = false;
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
      cardVerified = true;
    } catch (verifyErr) {
      await supabase.from('profiles')
        .update({ card_verified_at: null, card_verify_error: verifyErr.message })
        .eq('user_id', String(req.user.id));
    }

    if (cardVerified) retryLiveOrdersFor(req.user.id);   // declined live lots: charged now (never throws)
    res.json({ success: true, card_verified: cardVerified });
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
app.post('/charge-winner', requireAuth, normalizeBodyIds({ single: ['auction_id', 'order_id', 'invoice_id'] }), async (req, res) => {
  const { auction_id, winner_username, order_id, invoice_id } = req.body;
  if (!invoice_id && !order_id && (!auction_id || !winner_username)) {
    return res.status(400).json({ error: 'invoice_id, order_id, or auction_id and winner_username, required' });
  }

  // Must be admin or host - of the auction the TARGET belongs to. What gets
  // charged is decided by invoice_id, else order_id, else auction_id +
  // winner_username, so authorise against that same thing. A caller-supplied
  // auction_id is only ever a cross-check: trusting it alone let the host of
  // auction A charge an invoice or order that lives in auction B.
  let auctionIdForAuth;
  if (invoice_id) {
    const { data: invoiceForAuth } = await supabase.from('invoices').select('auction_id').eq('id', invoice_id).maybeSingle();
    auctionIdForAuth = invoiceForAuth?.auction_id;
  } else if (order_id) {
    const { data: orderForAuth } = await supabase.from('orders').select('auction_id').eq('id', order_id).maybeSingle();
    auctionIdForAuth = orderForAuth?.auction_id;
  } else {
    auctionIdForAuth = auction_id;
  }
  if (!auctionIdForAuth) return res.status(404).json({ error: 'Auction not found' });
  // Body auction_id disagreeing with the target's own auction: refuse, and say
  // nothing about the other auction.
  if (auction_id && (invoice_id || order_id) && auction_id !== auctionIdForAuth) {
    return res.status(404).json({ error: 'Auction not found' });
  }
  const { data: auction } = await supabase.from('auctions').select('host_username').eq('id', auctionIdForAuth).maybeSingle();
  if (!auction) return res.status(404).json({ error: 'Auction not found' });
  if (req.user.username !== ADMIN_USERNAME && req.user.username !== auction.host_username) {
    return res.status(403).json({ error: 'Not authorized to charge' });
  }
  // invoice_id wins below, so an order_id sent alongside it must be on that
  // invoice - otherwise it would be ignored after being authorised as if used.
  if (invoice_id && order_id) {
    const { data: o } = await supabase.from('orders').select('invoice_id').eq('id', order_id).maybeSingle();
    if (!o || o.invoice_id !== invoice_id) return res.status(404).json({ error: 'Order not found on this invoice' });
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
      // Never over a charge that went through (security review #19): a late
      // failure event for an EARLIER attempt must not relabel an invoice that a
      // later attempt paid - the PaymentIntent id is set only on success.
      await supabase.from('invoices').update({ payment_status: 'failed', payment_error: reason }).eq('id', invoice_id).is('payment_intent_id', null);
      await supabase.from('orders').update({ payment_status: 'failed', payment_error: reason }).eq('invoice_id', invoice_id).is('payment_intent_id', null);
    } else if (order_id) {
      // Source of truth for whether an order is paid - not profiles, which
      // Phase D's UI doesn't read for this.
      await supabase.from('orders').update({ payment_status: 'failed', payment_error: reason }).eq('id', order_id).is('payment_intent_id', null);
    }
    if (winner_username) {
      await sendAdminEmail(
        `Stripe payment failed - ${winner_username}`,
        `Stripe payment_intent.payment_failed\n${invoice_id ? `Invoice: ${invoice_id}` : `Order: ${order_id || 'unknown'}`}\nWinner: ${winner_username}\nAuction: ${auction_id}\nError: ${reason}`
      );
    }
  }

  // G2: a refund takes back the points those lots earned (never below 0; points already spent are not clawed back,
  // the admin is told). Refunds are made in the Stripe dashboard; the webhook endpoint must include charge.refunded.
  // A partial refund can't say which lots it covers, so it changes no points and asks the admin to adjust by hand.
  if (event.type === 'charge.refunded') {
    try {
      const ch = event.data.object;
      const piId = typeof ch.payment_intent === 'string' ? ch.payment_intent : ch.payment_intent?.id;
      if (piId) {
        const { data: orders } = await supabase.from('orders').select('id, buyer_username').eq('payment_intent_id', piId);
        if (orders?.length) {
          if (ch.refunded || ch.amount_refunded >= ch.amount) {
            const reversed = await rewards.reverseForOrders(orders.map(o => o.id), 'Refunded');
            const short = reversed.filter(r => r.shortfall > 0);
            if (short.length) {
              await sendAdminEmail(`Points: refund after the reward was used - ${orders[0].buyer_username}`,
                `A refunded payment (${piId}) had earned points that were already spent.\n` +
                short.map(r => `Order ${r.order_id}: ${r.shortfall} points not taken back`).join('\n') +
                `\nNothing more happens automatically. Adjust in Admin > Points if needed.`);
            }
          } else {
            await sendAdminEmail(`Points: partial refund - ${orders[0].buyer_username}`,
              `Payment ${piId} was partly refunded (${formatMoney(ch.amount_refunded)} of ${formatMoney(ch.amount)}).\n` +
              `Points were not changed. If the refund covers whole lots, adjust the buyer's points in Admin > Points.`);
          }
        }
      }
    } catch (e) {
      console.error('charge.refunded points handling failed:', e.message);
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
  if (error) return dbFailure(req, res, error);
  // Deleted accounts (A5) show as "Deleted account": their profile fields are already empty; this adds the flag.
  const ids = (data || []).map(p => p.user_id).filter(id => canonicalUuid(id));
  let deleted = new Set();
  if (ids.length) {
    const { data: gone, error: gErr } = await supabase.from('users').select('id').in('id', ids).not('deleted_at', 'is', null);
    if (gErr && !notMigrated(gErr)) return dbFailure(req, res, gErr);
    deleted = new Set((gone || []).map(u => String(u.id)));
  }
  res.json((data || []).map(p => deleted.has(String(p.user_id)) ? { ...p, deleted: true } : p));
});

app.patch('/admin/buyers/:userId', requireAdmin, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ['pending', 'approved', 'rejected', 'blocked'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  // A deleted account can't be brought back (A5).
  const { data: target, error: tErr } = await supabase.from('users').select('deleted_at').eq('id', req.params.userId).maybeSingle();
  if (tErr && !notMigrated(tErr)) return dbFailure(req, res, tErr);
  if (target?.deleted_at) return res.status(409).json({ error: 'This account was deleted and cannot be changed' });

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
    // Never another bidder's name (B7): only whether it is the caller.
    const { leading_bidder, ...lot } = item;
    return {
      ...lot,
      leading: leading_bidder === username,
      lot_number: item.position != null ? item.position + 1 : null,
      max_bid: myMax || null,
      won: leading_bidder === username,
      closed: item.status === 'sold' || item.status === 'unsold',
      auction: auctionMap[item.auction_id] || null,
    }
  }).sort((a, b) => new Date(b.ends_at) - new Date(a.ends_at))

  res.json(result)
})

// -- My Orders (what I won and was billed for) --
// Scoped to the caller's own JWT-derived id - never accepts a user id from
// the client, so there's no way to request someone else's orders.
//
// Pages through ALL of the buyer's orders rather than taking one select: a
// single select is silently cut at PostgREST's max-rows cap, and this is the
// screen that shows what a buyer owes. Unlike the admin list this is not
// truncated-with-a-count, because the page groups lots into invoices and must
// see every lot of an invoice to show the right total.
//
// count and rows are separate queries, so they can disagree while an auction
// is closing and writing orders. The loop therefore never trusts the count
// alone: it stops on an empty page, on a short page once it has the count,
// and at a hard page cap (returning what it has, loudly logged, rather than
// erroring or spinning). Rows are keyed by id because an insert between pages
// shifts the offset and can repeat a row - a repeated lot would inflate an
// invoice total.
const MY_ORDERS_PAGE = 500;
const MY_ORDERS_MAX_PAGES = 20;
let myOrdersHasDiscount = null;
app.get('/my-orders', requireAuth, async (req, res) => {
  const byId = new Map();
  let total = null;
  let fetched = 0;
  let pages = 0;
  while (total === null || fetched < total) {
    if (pages >= MY_ORDERS_MAX_PAGES) {
      console.error(`[my-orders] PAGE CAP HIT for user ${req.user.id}: ${MY_ORDERS_MAX_PAGES} pages, ${byId.size} orders returned, count said ${total}. Returning a partial list.`);
      break;
    }
    pages++;
    // discount_kind/discount_cents (a live lot's G2 discount) exist only after migration za: asked for, and dropped
    // from the select if the database doesn't have them yet.
    const page = cols => supabase
      .from('orders')
      .select(cols, { count: 'exact' })
      .eq('buyer_user_id', String(req.user.id))
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(fetched, fetched + MY_ORDERS_PAGE - 1);
    const BASE = 'id, auction_id, invoice_id, item_title, hammer_cents, premium_cents, total_cents, payment_status, status, tracking_number, tracking_carrier, tracking_url, fulfillment_choice, shipping_cost_cents, shipping_payment_status, shipping_payment_error, created_at';
    let { data, error, count } = await page(myOrdersHasDiscount === false ? BASE : BASE + ', discount_kind, discount_cents');
    if (error && error.code === '42703' && myOrdersHasDiscount !== false) { myOrdersHasDiscount = false; ({ data, error, count } = await page(BASE)); }
    if (error) return res.status(500).json({ error: 'Failed to load orders' });
    total = count ?? 0;
    if (!data?.length) break;                 // count and rows disagree - never spin
    fetched += data.length;
    for (const o of data) byId.set(o.id, o);
    if (data.length < MY_ORDERS_PAGE && fetched >= total) break;
  }
  const orders = [...byId.values()];
  if (!orders.length) return res.json([]);

  const auctionIds = [...new Set(orders.map(o => o.auction_id))];
  // '*' because pickup_town only exists after migration y. These are the caller's own WON orders, so a pickup
  // order may carry the street address (B6).
  const { data: auctions } = await supabase.from('auctions').select('*').in('id', auctionIds);
  const auctionMap = Object.fromEntries((auctions || []).map(a => [a.id, a]));
  // G2: each invoice's discount line (points reward or promo code) and the points each lot earned. Both are the
  // caller's own rows; before migration z (or with nothing to show) the fields are null.
  const invoiceIds = [...new Set(orders.map(o => o.invoice_id).filter(Boolean))];
  const invoiceMap = {};
  if (invoiceIds.length) {
    const { data: invs, error: invErr } = await supabase.from('invoices')
      .select('id, total_cents, discount_kind, discount_cents, discount_premium_cents').in('id', invoiceIds).eq('buyer_user_id', String(req.user.id));
    if (!invErr) for (const v of invs || []) invoiceMap[v.id] = v;
  }
  const earnedMap = {};
  {
    const { data: earned, error: eErr } = await supabase.from('points_ledger').select('order_id, points')
      .eq('user_id', req.user.id).eq('kind', 'earn').in('order_id', orders.map(o => o.id));
    if (!eErr) for (const r of earned || []) earnedMap[r.order_id] = r.points;
  }
  const promoMap = {};
  if (orders.some(o => o.shipping_payment_status === 'paid' && o.shipping_cost_cents === 0)) {
    const { data: sp, error: spErr } = await supabase.from('orders').select('id, shipping_promo').in('id', orders.map(o => o.id)).not('shipping_promo', 'is', null);
    if (!spErr) for (const r of sp || []) promoMap[r.id] = r.shipping_promo;
  }

  res.json(orders.map(o => {
    const inv = o.invoice_id ? invoiceMap[o.invoice_id] : null;
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
      invoice: inv ? { total_cents: inv.total_cents, discount_kind: inv.discount_kind || null,
        discount_cents: inv.discount_cents || 0, discount_premium_cents: inv.discount_premium_cents || 0 } : null,
      // A live lot's own discount (G2, phase 1b): timed lots carry theirs on `invoice`.
      discount: o.discount_kind && o.discount_cents > 0 ? { kind: o.discount_kind, cents: o.discount_cents } : null,
      points_earned: earnedMap[o.id] ?? null,
      shipping_promo: promoMap[o.id] || null,
      pickup: o.fulfillment_choice === 'pickup' && auction ? {
        address: auction.pickup_address || null, town: auction.pickup_town || null,
        starts_at: auction.pickup_starts_at || null, ends_at: auction.pickup_ends_at || null,
      } : null,
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
  if (error) return dbFailure(req, res, error);
  const rows = await withThumbs(data);
  res.json(isAdmin ? rows : rows.map(publicAuction));   // B7: no leading_bidder for the public
});

app.get('/auction/:id', optionalAuth, async (req, res) => {
  const { data, error } = await supabase.from('auctions').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Auction not found' });
  // A draft is a part-built auction that must stay invisible until published -
  // 404 instead of 403 so its existence isn't confirmed to a non-admin.
  // (A live show's rehearsal: a logged-in account with the private link's key, ?rehearsal=<key>.)
  if (data.status === 'draft' && !canSeeAuction(data, req.user, req.query.rehearsal)) {
    return res.status(404).json({ error: 'Auction not found' });
  }
  // B6/B7: the public gets the pickup town, never the street address, and no bidder; the admin the full row.
  res.json(auctionFor(data, req.user?.username, ADMIN_USERNAME));   // the host/admin: the whole row (rehearsal_key too)
});

const FULFILLMENT_MODES = ['shipping', 'pickup', 'both'];
// Bump when TERMS_OF_SALE.md changes materially - existing acceptance rows
// keep the version they actually agreed to, so this never rewrites history.
const TERMS_VERSION = '1';

app.patch('/auction/:id', requireAdmin, async (req, res) => {
  const { title, description, category, buyers_premium_pct, fulfillment_mode, pickup_address, pickup_town, pickup_starts_at, pickup_ends_at, clock_seconds, auto_pace, starts_at } = req.body;
  const u = {};
  // Live shows (phase 2a): the default clock per lot, auto-pace, and the start time (before it goes on air).
  if (clock_seconds !== undefined || auto_pace !== undefined || starts_at !== undefined) {
    const { data: cur } = await supabase.from('auctions').select('mode, on_air_at').eq('id', req.params.id).maybeSingle();
    if (cur?.mode !== 'live') return res.status(400).json({ error: 'clock_seconds, auto_pace and starts_at can only be changed on a live show' });
    if (clock_seconds !== undefined) {
      if (!LIVE_CLOCK_PRESETS.includes(Number(clock_seconds))) return res.status(400).json({ error: 'Clock must be 60, 30, 15 or 5 seconds' });
      u.clock_seconds = Number(clock_seconds);
    }
    if (auto_pace !== undefined) u.auto_pace = auto_pace === true;
    if (starts_at !== undefined) {
      if (cur.on_air_at) return res.status(400).json({ error: 'The show has already been on air' });
      if (!starts_at || isNaN(new Date(starts_at).getTime())) return res.status(400).json({ error: 'starts_at is not a valid date' });
      u.starts_at = new Date(starts_at).toISOString();
    }
  }
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
    // Live shows have no buyer's premium (brief §1.4); the database also forces 0 (migration za).
    if (pct !== 0) {
      const { data: cur } = await supabase.from('auctions').select('mode').eq('id', req.params.id).maybeSingle();
      if (cur?.mode === 'live') return res.status(400).json({ error: 'Live shows have no buyer\'s premium' });
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
  // What the public sees instead of the street (B6). Needs migration y: before it the column doesn't exist.
  if (pickup_town !== undefined) {
    const town = typeof pickup_town === 'string' ? pickup_town.trim() : '';
    if (town.length > 80) return res.status(400).json({ error: 'pickup_town is at most 80 characters' });
    u.pickup_town = town || null;
  }
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
  let { data, error } = await supabase.from('auctions').update(u).eq('id', req.params.id).select().single();
  // Before migration y there is no pickup_town column: save everything else rather than block the settings,
  // and say the town wasn't kept.
  let townSaved = true;
  if (error && 'pickup_town' in u && /pickup_town/.test(error.message || '')) {
    delete u.pickup_town; townSaved = false;
    ({ data, error } = await supabase.from('auctions').update(u).eq('id', req.params.id).select().single());
  }
  if (error || !data) return res.status(404).json({ error: 'Auction not found' });
  res.json(townSaved ? data : { ...data, pickup_town_saved: false });
});

app.post('/auction', requireAdmin, async (req, res) => {
  const { title, description, image_url, category, starting_bid, starts_at, ends_at, mode, fulfillment_mode, clock_seconds, auto_pace } = req.body;
    // Live shows only while LIVE_ENABLED is on. Rejected explicitly (not coerced to standard) so a live request
    // surfaces instead of disappearing. A live show has no buyer's premium (brief §1.4).
    if (mode === 'live' && !LIVE_ENABLED) return res.status(400).json({ error: 'Live auctions are not available yet' });
    const auctionMode = mode === 'live' ? 'live' : 'standard';
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
    // A live show (phase 2a): a start time, the default clock per lot, and the auto-pace option. No end time.
    const live = {};
    if (auctionMode === 'live') {
      if (!starts_at || isNaN(new Date(starts_at).getTime())) return res.status(400).json({ error: 'A live show needs a start time' });
      if (clock_seconds !== undefined && !LIVE_CLOCK_PRESETS.includes(Number(clock_seconds))) return res.status(400).json({ error: 'Clock must be 60, 30, 15 or 5 seconds' });
      if (clock_seconds !== undefined) live.clock_seconds = Number(clock_seconds);
      if (auto_pace !== undefined) live.auto_pace = auto_pace === true;
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
        ...(auctionMode === 'live' ? { buyers_premium_pct: 0, ends_at: null, ...live } : {}),
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
  // '*': pickup_town only exists after migration y; required once it does.
  const { data: auction, error } = await supabase.from('auctions').select('*').eq('id', req.params.id).single();
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
    if ('pickup_town' in auction && !auction.pickup_town) {
      return res.status(400).json({ error: 'Add the pickup town (what bidders see before winning) before publishing' });
    }
    if (auction.ends_at && new Date(auction.pickup_ends_at) <= new Date(auction.ends_at)) {
      return res.status(400).json({ error: 'Pickup window must end after the auction closes' });
    }
  }

  // A live show stays SCHEDULED ('upcoming') until the host taps Go live (two-step start, review answer 9). A draft
  // that went on air was a rehearsal: it has sold lots and orders, so it is never published.
  if (auction.mode === 'live' && auction.on_air_at) return res.status(400).json({ error: 'This show was used for a rehearsal. Create a new show for the real one.', code: 'rehearsed' });
  const newStatus = auction.mode === 'live' ? 'upcoming' : auction.starts_at && new Date(auction.starts_at) > new Date() ? 'upcoming' : 'live';
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

app.post('/auction/:id/terms-acceptance', requireAuth, LIMITS.bidding, async (req, res) => {
  const refusal = await biddingRefusal(req.user);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
  const { fulfillment_choice } = req.body;
  const { data: auction, error: auctionErr } = await supabase
    .from('auctions')
    .select('*')   // '*': rehearsal_key exists only after migration zd
    .eq('id', req.params.id)
    .single();
  if (auctionErr || !auction) return res.status(404).json({ error: 'Auction not found' });
  if (auction.status === 'draft' && !canSeeAuction(auction, req.user, req.query.rehearsal ?? req.body?.rehearsal)) {
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

// LiveKit room token (security review #18; live phase 2c, audit §4). Who gets what:
//   the host (the show's host_username, or the admin): publish video, audio and data; identity "host".
//   the host's second device (?role=controller): subscribe only, hidden, its own identity (LiveKit allows one
//     connection per identity, so it would otherwise kick the phone off).
//   everyone else, logged in or not: subscribe only, hidden (not in the participant list), a random identity, never
//     the username. Usernames reach the room only through our own socket events.
// Only for a show that is scheduled or on air (an ended show is 404); a draft needs the admin or, for its rehearsal,
// a logged-in account with the key. A logged-in buyer needs an approved profile, like the room itself (which shows
// "Complete your profile" otherwise); blocked: 403. Anonymous tokens: a per-IP limit (20 per 10 minutes).
// The cap of LIVE_ANON_CAP guests is counted where guests are, in the room (join_auction): past it a guest gets
// login_to_watch and the page shows "Log in to watch" and never asks for a token. A token request isn't tied to a
// room connection, so it can't be counted here; the per-IP limit is what holds a direct caller.
const LIVE_ANON_CAP = 60;
const LIVE_TOKEN_TTL = '6h';
const anonTokenLimit = limiter({ windowMs: 10 * 60e3, limit: 20, message: 'Too many tries. Wait a few minutes, or log in to watch.' });
async function anonViewersIn(auctionId) {
  return (await io.in(auctionId).fetchSockets()).filter(x => !x.data?.username).length;
}
app.get('/auction/:id/token', optionalAuth, (req, res, next) => (req.user ? next() : anonTokenLimit(req, res, next)), async (req, res) => {
  if (!LIVE_ENABLED) return res.status(404).json({ error: 'Auction not found' });
  const { data: auction, error } = await supabase.from('auctions').select('host_username, status, mode, rehearsal_key, on_air_at, ended_at').eq('id', req.params.id).maybeSingle();
  if (error) return dbFailure(req, res, error);
  if (!auction || auction.mode !== 'live' || showEnded(auction) || !canSeeAuction(auction, req.user, req.query.rehearsal)
      || !['upcoming', 'live', 'draft'].includes(auction.status)) return res.status(404).json({ error: 'Auction not found' });
  const isHost = !!req.user && (auction.host_username === req.user.username || req.user.username === ADMIN_USERNAME);
  const controller = isHost && req.query.role === 'controller';
  if (req.user && !isHost) {
    const { data: profile, error: pErr } = await supabase.from('profiles').select('status').eq('user_id', String(req.user.id)).maybeSingle();
    if (pErr) return dbFailure(req, res, pErr);
    if (profile?.status === 'blocked') return res.status(403).json({ error: 'You have been removed from this auction.', code: 'blocked' });
    if (profile?.status !== 'approved') return res.status(403).json({ error: 'Your account must be approved to join the live stream', code: 'not_approved' });
  }
  if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) return res.status(503).json({ error: 'Live video is not configured' });
  const publisher = isHost && !controller;
  const identity = publisher ? 'host' : (controller ? 'ctl-' : 'v-') + require('crypto').randomBytes(9).toString('base64url');
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, { identity, ttl: LIVE_TOKEN_TTL });
  at.addGrant({ roomJoin: true, room: 'auction-' + req.params.id, canSubscribe: true, canPublish: publisher, canPublishData: publisher, hidden: !publisher });
  res.json({ token: await at.toJwt(), room: 'auction-' + req.params.id, url: process.env.LIVEKIT_URL, isHost: publisher, role: publisher ? 'host' : controller ? 'controller' : 'viewer' });
});


// An auction that has produced orders can't be deleted: orders (and invoices,
// which cascade off the auction) are the record of what a buyer owes and what
// was sold, and there is no FK from orders to auctions, so a delete here used
// to leave them behind pointing at nothing - unreachable from any per-auction
// view and easy to lose track of while still unpaid. Fails closed: if the
// check itself errors, nothing is deleted.
app.delete('/auction/:id', requireAdmin, async (req, res) => {
  // req.params.id is already a canonical lowercase uuid (app.param above).
  const auctionId = req.params.id;
  const { data: existing, error: ordersErr } = await supabase
    .from('orders')
    .select('id, payment_status, shipping_payment_status')
    .eq('auction_id', auctionId);
  if (ordersErr) return res.status(500).json({ error: 'Could not check this auction for orders, so it was not deleted' });
  if (existing.length) {
    const notSettled = existing.filter(o => o.payment_status !== 'paid' || (o.shipping_payment_status && o.shipping_payment_status !== 'paid')).length;
    return res.status(409).json({
      error: 'This auction has orders and cannot be deleted',
      detail: `${existing.length} order${existing.length === 1 ? '' : 's'} came from it` + (notSettled ? `, ${notSettled} not fully paid` : '') + '. Orders are the record of what buyers owe and were sold.',
    });
  }
  // The whole cascade is ONE function call = ONE transaction (migration
  // 2026-09-20e): lots, bids, chat, pre-bids, images, terms acceptances, then the
  // auction. If an order or invoice exists at that instant the final delete is
  // refused (RESTRICT) and everything before it rolls back - nothing is removed.
  // The order check above is only for a readable message; it is not what protects
  // the data. (This used to delete the children one statement at a time, then the
  // parent, ignoring the parent's error: an order created in the gap - an auction
  // closing creates them - refused the parent AFTER the lots, bids and chat were
  // gone, and the route still answered 200.)
  const { error: delErr } = await supabase.rpc('delete_auction_cascade', { p_auction_id: auctionId });
  if (delErr) {
    if (delErr.code === '23503') {
      return res.status(409).json({
        error: 'This auction has orders and cannot be deleted',
        detail: 'An order or invoice was created for it while it was being deleted. Nothing was removed.',
      });
    }
    console.error('DELETE /auction/:id failed:', auctionId, delErr.code, delErr.message);
    return res.status(500).json({ error: 'Could not delete this auction. Nothing was removed.' });
  }
  res.json({ success: true });
});
// A draft's bids and chat stay as private as the draft itself (security review
// #17): anonymous reads by id used to return them. 404, as for /auction/:id.
async function hideDraftFromNonAdmin(req, res, next) {
  const { data: auction, error } = await supabase.from('auctions').select('*').eq('id', req.params.id).maybeSingle();   // '*': rehearsal_key (zd)
  if (error) return dbFailure(req, res, error);
  if (auction?.status === 'draft' && !canSeeAuction(auction, req.user, req.query.rehearsal)) return res.status(404).json({ error: 'Auction not found' });
  next();
}

// B7: nobody but the admin sees who bid. Everyone else gets the count.
app.get('/auction/:id/bids', optionalAuth, hideDraftFromNonAdmin, async (req, res) => {
  if (req.user?.username === ADMIN_USERNAME) {
    const { data, error } = await supabase.from('bids').select('*').eq('auction_id', req.params.id).order('created_at', { ascending: false }).limit(50);
    if (error) return dbFailure(req, res, error);
    return res.json(data);
  }
  const { count, error } = await supabase.from('bids').select('id', { count: 'exact', head: true }).eq('auction_id', req.params.id);
  if (error) return dbFailure(req, res, error);
  res.json({ bid_count: count || 0 });
});

app.get('/auction/:id/chat', optionalAuth, hideDraftFromNonAdmin, async (req, res) => {
  const { data, error } = await supabase.from('chat_messages').select('*').eq('auction_id', req.params.id).eq('flagged', false).order('created_at', { ascending: true }).limit(100);
  if (error) return dbFailure(req, res, error);
  res.json(data);
});

// ------------------------------------------------------------
// AUCTION LIFECYCLE
// ------------------------------------------------------------

const viewers = {};
const userSockets = {}; // userId (string) -> Set of socket IDs

// ---- Live lots (G1 phase 1, LIVE_SHOWS_BRIEF.md §1.1-1.4) ----
// The clock lives in the DATABASE: auction_items.ends_at, set by open_live_lot and extended by a late bid inside
// place_standard_bid's row lock (migration za). This process only watches it: one 1-second ticker per open live
// lot sends the time left to the room and, at 0, calls the hammer. Several processes may watch the same lot (a
// Railway deploy overlap): close_live_lot is the claim, so exactly one of them closes it. A restart loses nothing:
// recoverLiveLots() re-watches every open live lot at boot and every 30 s.
// The show itself has no clock: it ends when the host ends it. (The old auction-level timer ended a live show one
// second after it started, because live shows have no ends_at, and made an order with no lot: audit finding 3.)
const LIVE_CLOCK_PRESETS = [60, 30, 15, 5];  // seconds per lot, the host's choice (Albert, Oct 15); the database allows 5-600
const LIVE_DEFAULT_CLOCK = 30;
// The show is on air from the host's start (or the first lot offered): stops pre-bid expiry (migration zb).
async function markOnAir(auctionId) {
  await syncDbClock();
  const { error } = await supabase.from('auctions').update({ on_air_at: new Date(dbNow()).toISOString() }).eq('id', auctionId).is('on_air_at', null);
  if (error && !rewardsLib.notMigrated(error)) console.error('markOnAir failed:', auctionId, error.message);
}
const LIVE_EXTEND = { window: 5, by: 5 };    // "a bid in the last 5 s adds 5 s"; Sudden death = by 0
const liveLots = new Map();                  // itemId -> { auctionId, endsAt (ms), interval, closing }

// ends_at is set and checked by the DATABASE clock (now() inside the row lock). This server's clock can be seconds
// off (one test machine ran 6.5 s ahead), which would tick early and show viewers the wrong time left. So the
// server counts down by the database's time: dbNow() = its own clock + the measured offset (live_db_now(),
// migration za), re-measured at most once a minute.
let dbOffsetMs = 0, dbOffsetAt = 0;
const dbNow = () => Date.now() + dbOffsetMs;
async function syncDbClock({ force = false } = {}) {
  if (!force && Date.now() - dbOffsetAt < 60 * 1000) return;
  const t0 = Date.now();
  const { data, error } = await supabase.rpc('live_db_now');
  const t1 = Date.now();
  if (error || !data) return;
  dbOffsetMs = Date.parse(data) - Math.round((t0 + t1) / 2);
  dbOffsetAt = t1;
}

function watchLiveLot(lot) {
  const endsAt = Date.parse(lot.ends_at);
  const w = liveLots.get(lot.id);
  if (w) { w.endsAt = endsAt; return; }
  const entry = { auctionId: lot.auction_id, endsAt, closing: false };
  entry.interval = setInterval(() => liveTick(lot.id).catch(e => console.error('live tick failed:', lot.id, e.message)), 1000);
  liveLots.set(lot.id, entry);
}
function unwatchLiveLot(itemId) {
  const w = liveLots.get(itemId);
  if (w) { clearInterval(w.interval); liveLots.delete(itemId); }
}
// Every clock message carries ends_at and the server's time, so a client counts down on its own between ticks.
// server_now is the database's time, the one ends_at is measured against: time left = ends_at - server_now.
const liveClock = (auctionId, itemId, endsAt) => ({
  auctionId, item_id: itemId, seconds: Math.max(0, Math.ceil((endsAt - dbNow()) / 1000)),
  ends_at: new Date(endsAt).toISOString(), server_now: new Date(dbNow()).toISOString(),
});

async function liveTick(itemId) {
  const w = liveLots.get(itemId);
  if (!w || w.closing) return;
  io.to(w.auctionId).emit('item_timer_tick', liveClock(w.auctionId, itemId, w.endsAt));
  if (dbNow() < w.endsAt) return;
  w.closing = true;
  try {
    if (await closeLiveLot(itemId, false)) return;
    // Not closed by this call: a last-second bid moved the clock (watch the new time), or another process closed it.
    const { data: lot } = await supabase.from('auction_items').select('id, auction_id, status, ends_at').eq('id', itemId).maybeSingle();
    if (lot?.status === 'open' && lot.ends_at) watchLiveLot(lot); else unwatchLiveLot(itemId);
  } finally {
    const still = liveLots.get(itemId);
    if (still) still.closing = false;
  }
}

// The hammer (brief §1.4): the database closes the lot (open -> sold/unsold, the claim), then the order is created
// (idempotent per lot), then the room is told. The CHARGE runs off this path, so the host moves on at once and a
// slow or declined card never holds up the show. No reserve and no premium in live shows.
async function closeLiveLot(itemId, force) {
  const { data: lot, error } = await supabase.rpc('close_live_lot', { p_item_id: itemId, p_force: !!force });
  if (error) { console.error('close_live_lot failed:', itemId, error.code, error.message); return null; }
  if (!lot || !lot.id) return null;
  unwatchLiveLot(itemId);
  const sold = lot.status === 'sold';
  const orderId = sold ? await createOrderOnWin(lot.auction_id, lot.leading_bidder, lot.current_bid, lot.id) : null;
  if (orderId) await joinShowBox(orderId);
  // Live shows show the winner's username ("Sold to @name, $60"; phase 2), never a max; each viewer also hears
  // whether THEY won.
  await emitPerViewer(lot.auction_id, 'lot_closed', u => ({
    auctionId: lot.auction_id, item_id: lot.id, lot_number: lot.position + 1, status: lot.status, amount: sold ? Number(lot.current_bid) : null,
    username: sold ? lot.leading_bidder : null, you_won: sold && !!u && u === lot.leading_bidder,
  }));
  if (orderId) chargeLiveOrder(orderId);   // not awaited (never throws)
  else if (sold) console.error(`Live lot ${itemId} sold but its order was not created yet; recoverLiveLots retries it`);
  console.log(`Live lot ${itemId} closed: ${lot.status}${sold ? ` at $${lot.current_bid}` : ''}`);
  await emitShowState(lot.auction_id);
  autoPaceAfterClose(lot.auction_id);      // not awaited (never throws)
  return lot;
}

// A live lot's payment: its G2 discount (points reward or the show's % code, decided once; no premium in live),
// then the card on file. Never throws; the result is for the suites and the log.
function chargeLiveOrder(orderId, { retry = false } = {}) {
  return (async () => {
    await rewards.applyOrderDiscount(orderId);
    const r = await chargeOrder(orderId);
    if (!r.success && !r.skipped) console.log(`Live lot payment failed: order ${orderId}: ${r.error}`);
    if (!r.skipped && (!r.success || retry)) await tellRoomAboutPayment(orderId, r);
    return r;
  })().catch(e => { console.error('chargeLiveOrder error:', orderId, e.message); return { success: false, error: e.message }; });
}

// Declined card mid-show (brief §1.5): the buyer sees it in the room (and can't bid again in this show until it is
// fixed: liveUnpaid), and the host gets an alert on that lot. A retry that goes through clears both. The decline
// email (notifyPaymentFailed) and the admin email go out from chargeOrder as for any order.
async function tellRoomAboutPayment(orderId, r) {
  try {
    const { data: o } = await supabase.from('orders').select('id, auction_id, item_id, item_title, buyer_username, total_cents').eq('id', orderId).maybeSingle();
    if (!o) return;
    const { data: a } = await supabase.from('auctions').select('*').eq('id', o.auction_id).maybeSingle();
    const { data: lot } = await supabase.from('auction_items').select('position').eq('id', o.item_id).maybeSingle();
    const base = { auctionId: o.auction_id, item_id: o.item_id, order_id: o.id, amount_cents: o.total_cents, lot_number: lot ? lot.position + 1 : null };
    for (const s of await io.in(o.auction_id).fetchSockets()) {
      const u = s.data?.username;
      if (u && u === o.buyer_username) {
        s.emit(r.success ? 'payment_ok' : 'payment_failed', { ...base, message: r.success
          ? 'Your card went through. You can bid again.'
          : "Your card was declined for a lot you won. Update your card to keep bidding: we'll charge it as soon as you do." });
      } else if (u && (u === a?.host_username || u === ADMIN_USERNAME)) {
        // The host is the admin: they see who it is (their orders page already does).
        // can_rerun: the alert's "Re-run now" (rerun_lot), while the show is on air.
        s.emit(r.success ? 'lot_payment_fixed' : 'lot_payment_failed', { ...base, buyer: o.buyer_username, item_title: o.item_title,
          ...(r.success ? {} : { reason: r.error || null, can_rerun: showOnAir(a) }) });
      }
    }
  } catch (e) {
    console.error('tellRoomAboutPayment error:', orderId, e.message);
  }
}

// A buyer whose card was declined in this show can't bid until it is fixed, so their pre-bid on the lot being opened
// doesn't count: it is removed before the lot opens (it would otherwise make them the leader).
async function dropBlockedPrebids(auctionId, itemId) {
  try {
    const ids = await liveBlockedBuyers(auctionId);
    if (!ids.length) return;
    const { data: gone } = await supabase.from('pre_bids').delete().eq('item_id', itemId).in('buyer_user_id', ids).select('id');
    if (gone?.length) console.log(`Lot ${itemId}: ${gone.length} pre-bid(s) from buyers with a declined card in this show not counted`);
  } catch (e) {
    console.error('dropBlockedPrebids error:', itemId, e.message);
  }
}

// The buyers who can't bid in this show: a declined live lot not yet fixed, or a declined lot the host re-ran in the
// show ("Re-run now": that order is cancelled, but the card is the same one) with no new card saved since that win.
// userId narrows it to one buyer. Returns their ids.
async function liveBlockedBuyers(auctionId, userId = null) {
  let q = supabase.from('orders').select('buyer_user_id, payment_status, created_at').eq('auction_id', auctionId).is('invoice_id', null)
    .or('payment_status.eq.failed,and(payment_status.eq.cancelled,reoffered_item_id.not.is.null)');
  if (userId) q = q.eq('buyer_user_id', String(userId));
  const { data, error } = await q;
  if (error) { if (!rewardsLib.notMigrated(error)) console.error('liveBlockedBuyers:', error.message); return []; }
  const blocked = new Set((data || []).filter(o => o.payment_status === 'failed').map(o => o.buyer_user_id));
  const rerun = (data || []).filter(o => o.payment_status === 'cancelled' && !blocked.has(o.buyer_user_id));
  if (rerun.length) {
    const { data: profs } = await supabase.from('profiles').select('user_id, card_verified_at').in('user_id', [...new Set(rerun.map(o => o.buyer_user_id))]);
    const verifiedAt = new Map((profs || []).map(p => [String(p.user_id), p.card_verified_at ? Date.parse(p.card_verified_at) : 0]));
    for (const o of rerun) if (!(verifiedAt.get(String(o.buyer_user_id)) > Date.parse(o.created_at))) blocked.add(o.buyer_user_id);
  }
  return [...blocked].filter(Boolean);
}

// Can this buyer not bid in this show (liveBlockedBuyers)?
async function liveUnpaid(userId, auctionId) {
  return (await liveBlockedBuyers(auctionId, userId)).length > 0;
}
const LIVE_UNPAID = "Your card was declined for a lot you won in this show. Update your card on your profile page to keep bidding.";

// A buyer saved a card that passed the $1 check: their declined live lots are charged again at once (paid ones
// clear the room alerts). A lot the host already re-offered or re-ran is cancelled, so it is never charged; in a show
// still on air, a buyer whose declined lots were all re-run hears "you can bid again". Never throws.
async function retryLiveOrdersFor(userId) {
  try {
    const { data: failed } = await supabase.from('orders').select('id, auction_id').eq('buyer_user_id', String(userId))
      .eq('payment_status', 'failed').is('invoice_id', null).is('payment_intent_id', null);
    const { data: rerun } = await supabase.from('orders').select('auction_id, buyer_username').eq('buyer_user_id', String(userId))
      .eq('payment_status', 'cancelled').not('reoffered_item_id', 'is', null);
    if (!failed?.length && !rerun?.length) return;
    const { data: live } = await supabase.from('auctions').select('*').eq('mode', 'live')   // '*': ended_at (zd)
      .in('id', [...new Set([...(failed || []), ...(rerun || [])].map(o => o.auction_id))]);
    const liveIds = new Set((live || []).map(a => a.id));
    for (const o of failed || []) if (liveIds.has(o.auction_id)) await chargeLiveOrder(o.id, { retry: true });
    const onAir = new Set((live || []).filter(showOnAir).map(a => a.id));
    for (const auctionId of new Set((rerun || []).filter(o => onAir.has(o.auction_id)).map(o => o.auction_id))) {
      if ((failed || []).some(o => o.auction_id === auctionId) || await liveUnpaid(userId, auctionId)) continue;   // told by the charge
      const username = rerun.find(o => o.auction_id === auctionId).buyer_username;
      for (const s of await io.in(auctionId).fetchSockets()) {
        if (username && s.data?.username === username) s.emit('payment_ok', { auctionId, charged: false, message: 'Your card is updated. You can bid again.' });
      }
    }
  } catch (e) {
    console.error('retryLiveOrdersFor error:', userId, e.message);
  }
}

// Re-offer a declined live lot (reoffer_live_order, migration zb): into a later show or a timed auction once the
// show has ended, or back into the same show while it is on air ("Re-run now": next = offered next, else at the end
// of the lineup). On a re-run the room hears the lineup changed, the host's alert clears, and the buyer is told in
// the room and by email; the cancelled order is never charged, even if they fix their card later.
// Returns { item_id, lot_number } or { error, status } (status 400: refused; 500: the database).
async function reofferLiveOrder(orderId, targetId, next = false) {
  const { data: newId, error } = await supabase.rpc('reoffer_live_order', { p_order_id: orderId, p_target_auction_id: targetId, p_next: !!next });
  if (error) {
    if (error.code === 'P0001') return { error: error.message, status: 400 };
    console.error('reoffer_live_order failed:', orderId, error.code, error.message);
    return { error: 'Could not re-offer the lot', status: 500, dbError: error };
  }
  const { data: lots } = await supabase.from('auction_items').select('*').in('id', [newId]);
  const lot = lots?.[0];
  const out = { item_id: newId, lot_number: lot ? lot.position + 1 : null };
  try {
    const { data: o } = await supabase.from('orders').select('id, auction_id, item_id, item_title, buyer_user_id, buyer_username').eq('id', orderId).maybeSingle();
    if (!o || o.auction_id !== targetId || !lot) return out;
    // A re-run in the same show.
    const { data: show } = await supabase.from('auctions').select('id, title, host_username').eq('id', o.auction_id).maybeSingle();
    const { data: old } = await supabase.from('auction_items').select('position').eq('id', o.item_id).maybeSingle();
    const n = old ? old.position + 1 : null;
    const said = `Your card was declined, so lot ${n} was offered again.`;
    await emitPerViewer(o.auction_id, 'lot_rerun', u => ({
      auctionId: o.auction_id, item: publicLot(lot), lot_number: out.lot_number, next: !!lot.offer_next,
      rerun_of: { item_id: o.item_id, lot_number: n, status: 'unsold' },
      ...(u && u === o.buyer_username ? { you: true, message: said } : {}),
      ...(u && (u === show?.host_username || u === ADMIN_USERNAME) ? { order_id: o.id, buyer: o.buyer_username } : {}),
    }));
    const { data: back } = await supabase.from('points_ledger').select('points').eq('order_id', o.id).eq('kind', 'adjust').limit(1);
    const email = await getBuyerEmail(o.buyer_user_id);
    if (email) await sendEmail({ from: BUYER_FROM, to: email, subject: `Lot ${n} was offered again`, kind: 'failed',
      html: emailHtml(`Lot ${n} was offered again`, `
        <p>${escapeHtml(said)} The lot was <strong>${escapeHtml(o.item_title)}</strong> in <strong>${escapeHtml(show?.title || 'the show')}</strong>.</p>
        <p style="margin:16px 0 0;">You won't be charged for it, even if you update your card later.${back?.length ? ' The points reward on it is back in your balance.' : ''}</p>
        <p style="margin:16px 0 0;">To keep bidding in this show, update your card on your profile page.</p>`) });
  } catch (e) {
    console.error('reofferLiveOrder: telling the room/buyer failed:', orderId, e.message);
  }
  return out;
}

// One box per buyer per show (brief §1.6): every lot a buyer wins in a show joins one order group, so packing, the
// label and the postage charge happen once, through the existing group/label flow. Pickup wins aren't boxed.
async function joinShowBox(orderId) {
  try {
    const { data: o } = await supabase.from('orders').select('id, auction_id, buyer_user_id, fulfillment_choice, group_id').eq('id', orderId).maybeSingle();
    if (!o || o.group_id || o.fulfillment_choice === 'pickup') return;
    const { data: sib } = await supabase.from('orders').select('group_id').eq('auction_id', o.auction_id).eq('buyer_user_id', o.buyer_user_id)
      .not('group_id', 'is', null).neq('payment_status', 'cancelled').limit(1);
    const groupId = sib?.[0]?.group_id || require('crypto').randomUUID();
    await supabase.from('orders').update({ group_id: groupId }).eq('id', o.id).is('group_id', null);
  } catch (e) {
    console.error('joinShowBox error:', orderId, e.message);
  }
}

// "Your show wins": one email per buyer after the show (brief §1.6; no per-lot win emails, review answer 1). Sent
// once per show (auctions.live_summary_sent_at, migration zb), and only when every lot's charge has settled (paid or
// declined), so it says what actually happened; the 30-second job tries again until then. Returns true if sent.
async function sendLiveShowSummaries(auctionId) {
  try {
    const { data: a, error } = await supabase.from('auctions').select('*').eq('id', auctionId).maybeSingle();
    if (error || !a || a.mode !== 'live' || !showEnded(a) || !('live_summary_sent_at' in a) || a.live_summary_sent_at) return false;
    const { data: orders, error: oErr } = await supabase.from('orders').select('*').eq('auction_id', auctionId).order('created_at');
    if (oErr || (orders || []).some(o => ['unpaid', 'charging'].includes(o.payment_status || 'unpaid'))) return false;
    const { data: claimed } = await supabase.from('auctions').update({ live_summary_sent_at: new Date().toISOString() })
      .eq('id', auctionId).is('live_summary_sent_at', null).select('id');
    if (!claimed?.length) return false;
    const byBuyer = new Map();
    for (const o of orders || []) {
      if (o.payment_status === 'cancelled' || !o.buyer_user_id) continue;
      if (!byBuyer.has(o.buyer_user_id)) byBuyer.set(o.buyer_user_id, []);
      byBuyer.get(o.buyer_user_id).push(o);
    }
    const pickup = byBuyer.size ? await pickupFor(auctionId) : null;
    for (const [userId, list] of byBuyer) {
      const email = await getBuyerEmail(userId);
      if (!email) continue;
      await sendEmail({ from: BUYER_FROM, to: email, subject: `Your wins from "${a.title}"`,
        html: liveSummaryEmailHtml(a, list, list[0].fulfillment_choice === 'pickup' ? pickup : null), kind: 'won' });
    }
    console.log(`Live show ${auctionId}: summary emails to ${byBuyer.size} buyer(s)`);
    return true;
  } catch (e) {
    console.error('sendLiveShowSummaries error:', auctionId, e.message);
    return false;
  }
}
function liveSummaryEmailHtml(show, orders, pickup) {
  const td = 'padding:4px 0;';
  const rows = orders.map(o => `<tr>
      <td style="${td}color:#555;">${escapeHtml(o.item_title)}</td>
      <td style="${td}text-align:right;">${formatMoney(o.hammer_cents)}${o.discount_cents > 0 ? `<br><span style="color:#2e6b34;">&minus;${formatMoney(o.discount_cents)} ${DISCOUNT_LABEL[o.discount_kind] || 'discount'}</span>` : ''}</td>
      <td style="${td}text-align:right;">${o.payment_status === 'paid' ? 'Paid' : '<strong>Card declined</strong>'}</td>
    </tr>`).join('');
  const paid = orders.filter(o => o.payment_status === 'paid');
  const declined = orders.some(o => o.payment_status !== 'paid');
  const n = orders.length;
  return emailHtml(`Your wins from ${escapeHtml(show.title)}`, `
    <p>You won <strong>${n} lot${n === 1 ? '' : 's'}</strong> in the show. There is no buyer's premium in live shows: each lot is its winning bid.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;">${rows}
      <tr><td style="padding:8px 0 0;font-weight:bold;border-top:1px solid #ddd;">Charged to your card</td><td></td><td style="padding:8px 0 0;text-align:right;font-weight:bold;border-top:1px solid #ddd;">${formatMoney(paid.reduce((t, o) => t + (o.total_cents || 0), 0))}</td></tr>
    </table>
    ${declined ? '<p style="margin:16px 0 0;"><strong>Your card was declined for the lots marked above.</strong> Update your card on your profile page and we will charge it straight away. If it isn\'t fixed, those lots may be offered again.</p>' : ''}
    ${pickup ? pickupBlockHtml(pickup, n > 1) : `<p style="margin:16px 0 0;">Everything you won in this show ships together in one box. Postage is charged once, after it is packed, and you'll get tracking by email.</p>`}
  `);
}

// Pre-bid expiry (research additions; review answer 4): a live show that hasn't gone on air 24 hours after its
// scheduled start releases its pre-bids. They are deleted, and each bidder gets one email listing their lots; the
// outbox row (notifications, kind 'prebid_released') is the record. Once per show (auctions.prebids_released_at).
const PREBID_EXPIRY_MS = 24 * 60 * 60 * 1000;
async function releaseExpiredPrebids(now = new Date()) {
  const out = { shows: 0, released: 0, emails: 0 };
  try {
    const cutoff = new Date(now.getTime() - PREBID_EXPIRY_MS).toISOString();
    const { data: shows, error } = await supabase.from('auctions').select('id, title').eq('mode', 'live').in('status', ['upcoming', 'live'])
      .is('on_air_at', null).is('prebids_released_at', null).lt('starts_at', cutoff);
    if (error) { if (!rewardsLib.notMigrated(error)) console.error('releaseExpiredPrebids:', error.message); return out; }
    for (const show of shows || []) {
      const { data: claimed } = await supabase.from('auctions').update({ prebids_released_at: now.toISOString() })
        .eq('id', show.id).is('prebids_released_at', null).is('on_air_at', null).select('id');
      if (!claimed?.length) continue;
      out.shows++;
      const { data: pbs } = await supabase.from('pre_bids').select('id, item_id, buyer_user_id').eq('auction_id', show.id);
      if (!pbs?.length) continue;
      await supabase.from('pre_bids').delete().in('id', pbs.map(p => p.id));
      out.released += pbs.length;
      const lotIds = [...new Set(pbs.map(p => p.item_id))];
      await supabase.from('auction_items').update({ pre_bid_count: 0, top_pre_bid: null }).in('id', lotIds).eq('status', 'pending');
      const { data: lots } = await supabase.from('auction_items').select('id, title, position').in('id', lotIds);
      const lotById = Object.fromEntries((lots || []).map(l => [l.id, l]));
      const byBuyer = new Map();
      for (const p of pbs) { if (!byBuyer.has(p.buyer_user_id)) byBuyer.set(p.buyer_user_id, new Set()); byBuyer.get(p.buyer_user_id).add(p.item_id); }
      for (const [userId, items] of byBuyer) {
        const titles = [...items].map(id => lotById[id]).filter(Boolean).sort((x, y) => x.position - y.position)
          .map(l => `<li>Lot ${l.position + 1}: ${escapeHtml(l.title)}</li>`).join('');
        const email = await getBuyerEmail(userId);
        const sent = email ? await sendEmail({ from: BUYER_FROM, to: email, subject: `Your pre-bids on "${show.title}" were released`, kind: 'prebid_released',
          html: emailHtml('Your pre-bids were released', `<p>The live show <strong>${escapeHtml(show.title)}</strong> didn't start within 24 hours of its scheduled time, so your pre-bids on it no longer count:</p><ul>${titles}</ul><p style="margin:16px 0 0;">Nothing was charged. If the show is rescheduled, you can pre-bid again.</p>`) }) : false;
        if (sent) out.emails++;
        const stamp = new Date().toISOString();
        const { error: nErr } = await supabase.from('notifications').insert({ user_id: userId, kind: 'prebid_released', payload: { auction_id: show.id, item_ids: [...items] },
          claimed_at: stamp, attempts: 1, sent_at: stamp, error: sent ? null : (email ? 'email not sent' : 'no email on file') });
        if (nErr) console.error('prebid_released outbox row failed:', nErr.message);
      }
      console.log(`Live show ${show.id} not on air 24 h after its start: ${pbs.length} pre-bid(s) released`);
    }
  } catch (e) {
    console.error('releaseExpiredPrebids error:', e.message);
  }
  return out;
}

// The 30-second job's live step (after recoverLiveLots): pre-bid expiry, and summaries for ended shows still owed one.
async function runLiveHousekeeping() {
  await releaseExpiredPrebids();
  // Ended shows, then rehearsals that ended (still drafts, with ended_at: that query stays silent before migration zd).
  const { data: owed, error } = await supabase.from('auctions').select('id').eq('mode', 'live').eq('status', 'ended').is('live_summary_sent_at', null);
  if (error) { if (!rewardsLib.notMigrated(error)) console.error('runLiveHousekeeping:', error.message); return; }
  const { data: rehearsed, error: rErr } = await supabase.from('auctions').select('id').eq('mode', 'live').eq('status', 'draft').not('ended_at', 'is', null).is('live_summary_sent_at', null);
  if (rErr && !rewardsLib.notMigrated(rErr)) console.error('runLiveHousekeeping (rehearsals):', rErr.message);
  for (const a of [...(owed || []), ...(rehearsed || [])]) await sendLiveShowSummaries(a.id);
}

// Boot, and every 30 s (the auto-close job): watch every open live lot (a restart mid-lot resumes from ends_at), and
// finish any hammer a crash interrupted within the last 24 hours: a sold live lot with no order gets one, and a live
// order still 'unpaid' a minute after the sale is charged. A 'failed' charge is never retried here (that is the
// buyer's card to fix). Live lots are the ones open_live_lot gave a live clock (extend_by_seconds not null).
const LIVE_RECOVERY_MS = 24 * 60 * 60 * 1000;
async function recoverLiveLots() {
  try {
    const { data: open, error } = await supabase.from('auction_items').select('id, auction_id, status, ends_at')
      .eq('status', 'open').not('extend_by_seconds', 'is', null);
    if (error) { if (!rewardsLib.notMigrated(error)) console.error('recoverLiveLots: open lots:', error.message); return; }
    if (open?.length) await syncDbClock();
    for (const lot of open || []) if (!liveLots.has(lot.id) && lot.ends_at) watchLiveLot(lot);

    const since = new Date(Date.now() - LIVE_RECOVERY_MS).toISOString();
    const { data: sold } = await supabase.from('auction_items').select('id, auction_id, leading_bidder, current_bid')
      .eq('status', 'sold').not('extend_by_seconds', 'is', null).gt('ends_at', since);
    if (!sold?.length) return;
    const { data: orders } = await supabase.from('orders').select('id, item_id, payment_status, invoice_id, payment_intent_id, created_at')
      .in('item_id', sold.map(l => l.id));
    const byItem = new Map((orders || []).map(o => [o.item_id, o]));
    const settleBefore = Date.now() - 60 * 1000;
    for (const lot of sold) {
      const o = byItem.get(lot.id);
      if (!o) {
        const id = await createOrderOnWin(lot.auction_id, lot.leading_bidder, lot.current_bid, lot.id);
        if (id) { console.error(`Recovered live lot ${lot.id}: order ${id} created after a missed hammer`); await chargeLiveOrder(id); }
      } else if ((o.payment_status || 'unpaid') === 'unpaid' && !o.invoice_id && !o.payment_intent_id && Date.parse(o.created_at) < settleBefore) {
        console.error(`Recovered live lot ${lot.id}: order ${o.id} was never charged`);
        await chargeLiveOrder(o.id);
      }
    }
  } catch (e) {
    console.error('recoverLiveLots error:', e.message);
  }
}
// ---- The show (G1 phase 2a, LIVE_SHOWS_PHASE2_BRIEF.md; migration zd) ----
// A live show is SCHEDULED once published (status 'upcoming'), ON AIR from the host's Go live (status 'live',
// on_air_at), and ENDED by End show or by the auto-end below (status 'ended', ended_at). A DRAFT live show can also go
// on air as a REHEARSAL: it stays a draft (hidden from every list) and only invited test accounts get in, with the
// private link's key (?rehearsal=<key>). While on air the host steps through:
//   show_lot (lot N on screen) -> start_clock (open, preset + Sudden death) -> add_time / sold_now / pass, or the
//   clock runs out (the hammer) -> show_lot (the next one) ... -> end_show (refused while a lot is open).
// The database is the state: auctions.shown_item_id is the lot on screen, an 'open' lot is the one selling. Every
// change goes out to the room as one `show_state` (the same for everyone except `you_lead`; live shows show
// usernames on bids and wins, never anyone's max).
const LIVE_TALK_MS = 15 * 1000;              // auto-pace: talk time before the next lot's clock starts
const LIVE_IDLE_END_MS = 60 * 60 * 1000;     // a show on air with no host activity this long ends itself
const LIVE_ADD_SECONDS = 15;                 // the host's "+15 s"
const showOnAir = a => !!a && a.mode === 'live' && (a.status === 'live' || (a.status === 'draft' && !!a.on_air_at && !a.ended_at));
const showEnded = a => !!a && (a.status === 'ended' || !!a.ended_at);
// The private rehearsal link: a draft live show, its current key, compared in constant time.
function rehearsalOk(auction, key) {
  if (!auction || auction.mode !== 'live' || auction.status !== 'draft' || !auction.rehearsal_key || typeof key !== 'string' || !key) return false;
  const a = Buffer.from(key), b = Buffer.from(auction.rehearsal_key);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}
// Who may see an auction by its id: anyone unless it is a draft; a draft, the admin, or (a live show's rehearsal) a
// logged-in account with the current key. Lists never show drafts.
const canSeeAuction = (auction, user, key) => !!auction && (auction.status !== 'draft' || user?.username === ADMIN_USERNAME || (!!user && rehearsalOk(auction, key)));

// The lineup: the lots still waiting, in the order they'll be offered: a lot put "next" (a re-run or Run again)
// first, then the host's drag order (run_order), then lot number. Lot numbers (position + 1) never change.
const lineupSort = (a, b) => (Number(!!b.offer_next) - Number(!!a.offer_next)) || ((a.run_order ?? Infinity) - (b.run_order ?? Infinity)) || (a.position - b.position);
const LIVE_LOT_COLS = 'id, auction_id, position, title, description, condition, image_url, starting_bid, current_bid, bid_count, pre_bid_count, status, ends_at, created_at, leading_bidder, offer_next, run_order, clock_seconds, sudden_death, run_again_of, extend_by_seconds';
async function showLots(auctionId) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('auction_items').select(LIVE_LOT_COLS).eq('auction_id', auctionId).order('position').range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
// A lot as the room sees it: the public row, its number, and in a live show the leader's username (never a max).
const liveLotView = (l, { leader = false } = {}) => (l ? {
  ...publicLot(l), lot_number: l.position + 1,
  ...(leader ? { leader: l.bid_count > 0 ? l.leading_bidder || null : null, sudden_death: l.extend_by_seconds === 0 } : {}),
} : null);

// Everything a host or viewer screen needs about the show, in one object (also GET /auction/:id/show-state).
async function liveShowState(auctionId) {
  const { data: a, error } = await supabase.from('auctions').select('*').eq('id', auctionId).maybeSingle();
  if (error) throw error;
  if (!a || a.mode !== 'live') return null;
  const lots = await showLots(auctionId);
  await syncDbClock();
  const open = lots.find(l => l.status === 'open') || null;
  const shown = open || lots.find(l => l.id === a.shown_item_id && l.status === 'pending') || null;
  const lineup = lots.filter(l => l.status === 'pending').sort(lineupSort);
  const sold = lots.filter(l => l.status === 'sold');
  const closed = lots.filter(l => (l.status === 'sold' || l.status === 'unsold') && l.ends_at).sort((x, y) => Date.parse(y.ends_at) - Date.parse(x.ends_at));
  const last = closed[0] || null;
  return {
    auctionId, title: a.title, status: a.status, on_air: showOnAir(a), rehearsal: a.status === 'draft', ended: showEnded(a),
    on_air_at: a.on_air_at || null, ended_at: a.ended_at || null, starts_at: a.starts_at || null,
    clock_seconds: a.clock_seconds ?? LIVE_DEFAULT_CLOCK, auto_pace: !!a.auto_pace, on_hold: !!a.on_hold, autostart_at: a.autostart_at || null,
    // open.next_bid: the one-tap Bid amount for anyone not leading (lot_rules, the same rule the bid is checked by).
    shown: liveLotView(shown, { leader: !!open }), open: open ? { ...liveLotView(open, { leader: true }), ends_at: new Date(Date.parse(open.ends_at)).toISOString(), next_bid: lotRules.nextBidAmounts(open)[0] } : null,
    last: last ? { item_id: last.id, lot_number: last.position + 1, title: last.title, status: last.status,
      amount: last.status === 'sold' ? Number(last.current_bid) : null, winner: last.status === 'sold' ? last.leading_bidder : null,
      // passed: the host Passed it, or skipped it before its clock started (no bids, no live clock).
      passed: last.status === 'unsold' && (last.bid_count > 0 || last.extend_by_seconds == null),
      can_run_again: last.status === 'unsold' && !lots.some(c => c.run_again_of === last.id && c.status === 'pending') } : null,
    up_next: lineup.filter(l => l.id !== shown?.id).slice(0, 3).map(l => liveLotView(l)),
    stats: { sold_count: sold.length, sold_total: Math.round(sold.reduce((t, l) => t + Number(l.current_bid || 0) * 100, 0)) / 100,
      lots_left: lineup.length, lots_total: lots.length },
    server_now: new Date(dbNow()).toISOString(),
  };
}
const showStateFor = (st, username) => st && ({ ...st, you_lead: !!username && st.open?.leader === username });
async function emitShowState(auctionId) {
  try {
    const st = await liveShowState(auctionId);
    if (st) await emitPerViewer(auctionId, 'show_state', u => showStateFor(st, u));
  } catch (e) {
    console.error('emitShowState error:', auctionId, e.message);
  }
}

// Open a lot: blocked buyers' pre-bids dropped (phase 1b), then open_live_lot (pre-bids by the proxy rule, never at
// the top max; the clock starts), and the room is told. Returns the lot, or { error }.
async function openLiveLot(auctionId, itemId, secs, suddenDeath) {
  await dropBlockedPrebids(auctionId, itemId);
  await syncDbClock();
  const { data: lot, error } = await supabase.rpc('open_live_lot', {
    p_item_id: itemId, p_seconds: secs, p_extend_window_seconds: LIVE_EXTEND.window,
    p_extend_by_seconds: suddenDeath ? 0 : LIVE_EXTEND.by, p_opening_min: OPENING_BID_MIN,
  });
  if (error) {
    if (error.code === 'P0001') return { error: error.message };
    console.error('open_live_lot failed:', error.code, error.message);
    return { error: 'Could not open the lot' };
  }
  watchLiveLot(lot);
  await markOnAir(auctionId);
  await supabase.from('auctions').update({ shown_item_id: lot.id, autostart_at: null }).eq('id', auctionId);
  const clock = liveClock(auctionId, lot.id, Date.parse(lot.ends_at));
  await emitPerViewer(auctionId, 'item_activated', u => ({
    item: publicLot(lot), lot_number: lot.position + 1, you_lead: !!u && u === lot.leading_bidder, pre_bid_count: lot.pre_bid_count || 0,
    leader: lot.bid_count > 0 ? lot.leading_bidder : null, next_bid: lotRules.nextBidAmounts(lot)[0], timer_seconds: secs, sudden_death: !!suddenDeath, ends_at: clock.ends_at, server_now: clock.server_now,
  }));
  io.to(auctionId).emit('item_timer_tick', clock);
  await emitShowState(auctionId);
  return lot;
}

// Auto-pace (per show, off by default): after a lot closes on its clock or Sold now, the next lot in the lineup goes
// on screen and its clock starts after LIVE_TALK_MS, unless the host taps Hold. autostart_at in the database is the
// plan, so a second server or a restart can carry it out (the 30-second job); clearing it is the claim, so the clock
// starts once. A Pass doesn't advance (the host is in charge then).
const autostartTimers = new Map();
function armAutostart(auctionId, atIso) {
  clearTimeout(autostartTimers.get(auctionId));
  const ms = Math.max(0, Date.parse(atIso) - Date.now());
  autostartTimers.set(auctionId, setTimeout(() => { autostartTimers.delete(auctionId); liveAutostart(auctionId).catch(e => console.error('autostart failed:', auctionId, e.message)); }, ms + 50));
}
async function autoPaceAfterClose(auctionId) {
  try {
    const { data: a } = await supabase.from('auctions').select('*').eq('id', auctionId).maybeSingle();
    if (!showOnAir(a) || !a.auto_pace || a.on_hold) return;
    const { data: pending } = await supabase.from('auction_items').select('id, position, offer_next, run_order').eq('auction_id', auctionId).eq('status', 'pending');
    const next = (pending || []).sort(lineupSort)[0];
    if (!next) return;
    const at = new Date(Date.now() + LIVE_TALK_MS).toISOString();
    const { data: set } = await supabase.from('auctions').update({ shown_item_id: next.id, autostart_at: at })
      .eq('id', auctionId).eq('on_hold', false).eq('auto_pace', true).select('id');
    if (!set?.length) return;
    armAutostart(auctionId, at);
    await emitShowState(auctionId);
  } catch (e) {
    console.error('autoPaceAfterClose error:', auctionId, e.message);
  }
}
async function liveAutostart(auctionId) {
  const { data: a } = await supabase.from('auctions').select('*').eq('id', auctionId).maybeSingle();
  if (!a?.autostart_at || !showOnAir(a) || a.on_hold || !a.shown_item_id) return;
  if (Date.parse(a.autostart_at) > Date.now()) { armAutostart(auctionId, a.autostart_at); return; }
  const { data: claimed } = await supabase.from('auctions').update({ autostart_at: null })
    .eq('id', auctionId).eq('autostart_at', a.autostart_at).eq('on_hold', false).select('id');
  if (!claimed?.length) return;
  const { data: lot } = await supabase.from('auction_items').select('id, status, clock_seconds, sudden_death').eq('id', a.shown_item_id).maybeSingle();
  if (lot?.status !== 'pending') return;
  const r = await openLiveLot(auctionId, lot.id, lot.clock_seconds ?? a.clock_seconds ?? LIVE_DEFAULT_CLOCK, !!lot.sudden_death);
  if (r?.error) console.log(`Auto-pace: lot ${lot.id} not opened: ${r.error}`);
}

// End the show (the host's End show, or the auto-end): refused while a lot is open. A real show becomes 'ended'; a
// rehearsal stays a draft with ended_at. Then the "your show wins" emails (once every charge has settled).
// Returns { ok } or { error, code }.
async function endLiveShow(auctionId, { auto = false } = {}) {
  const { data: open } = await supabase.from('auction_items').select('id').eq('auction_id', auctionId).eq('status', 'open').limit(1);
  if (open?.length) return { error: 'A lot is still open. Let its clock finish, or Pass it, then end the show.', code: 'lot_open' };
  const { data: a } = await supabase.from('auctions').select('*').eq('id', auctionId).maybeSingle();
  if (!showOnAir(a)) return { error: 'This show is not on air', code: 'not_on_air' };
  const at = new Date().toISOString();
  const done = { ended_at: at, shown_item_id: null, autostart_at: null, on_hold: false };
  const q = a.status === 'draft'
    ? supabase.from('auctions').update(done).eq('id', auctionId).eq('status', 'draft').is('ended_at', null)
    : supabase.from('auctions').update({ ...done, status: 'ended' }).eq('id', auctionId).eq('status', 'live');
  const { data: ended } = await q.select('id');
  if (!ended?.length) return { error: 'This show is not on air', code: 'not_on_air' };
  clearTimeout(autostartTimers.get(auctionId));
  io.to(auctionId).emit('auction_ended', { auctionId, ...(auto ? { auto: true } : {}), ...(a.status === 'draft' ? { rehearsal: true } : {}) });
  await emitShowState(auctionId);
  console.log(`- Show ${auctionId} ended${auto ? ' (no host activity for 60 min)' : ''}`);
  sendLiveShowSummaries(auctionId);   // never throws; the 30-second job retries until every charge has settled
  return { ok: true };
}

// The 30-second job's show step: an auto-pace start that is due (its timer was on another server, or lost in a
// restart), and the auto-end: on air, no host activity for 60 min (counted from Go live if the host never tapped
// anything since), no lot open, nothing about to start.
async function runLiveShowHousekeeping(now = Date.now()) {
  if (!LIVE_ENABLED) return;
  try {
    const { data: due, error } = await supabase.from('auctions').select('id').eq('mode', 'live').not('autostart_at', 'is', null)
      .lte('autostart_at', new Date(now).toISOString());
    if (error) { if (!rewardsLib.notMigrated(error)) console.error('runLiveShowHousekeeping:', error.message); return; }
    for (const a of due || []) await liveAutostart(a.id);
    const cutoff = new Date(now - LIVE_IDLE_END_MS).toISOString();
    const { data: idle } = await supabase.from('auctions').select('id, status, on_air_at, ended_at, last_host_activity_at, autostart_at')
      .eq('mode', 'live').in('status', ['live', 'draft']).not('on_air_at', 'is', null).is('ended_at', null).is('autostart_at', null)
      .or(`last_host_activity_at.lt.${cutoff},and(last_host_activity_at.is.null,on_air_at.lt.${cutoff})`);
    for (const a of idle || []) {
      const r = await endLiveShow(a.id, { auto: true });
      if (r.error && r.code !== 'lot_open') console.log(`Auto-end of show ${a.id} skipped: ${r.error}`);
    }
  } catch (e) {
    console.error('runLiveShowHousekeeping error:', e.message);
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

// The live-mode events below act on the auction row itself (auction-level
// current_bid/leading_bidder, status, ends_at). None of that applies to a
// standard auction, which runs lot by lot: a socket place_bid used to set a
// standard auction's leading_bidder, and end_auction ended it without invoices
// (security review #6). They refuse anything that isn't live mode.
const LIVE_ONLY = 'This is not a live auction.';
async function isLiveModeAuction(auctionId) {
  const { data } = await supabase.from('auctions').select('mode').eq('id', auctionId).maybeSingle();
  return data?.mode === 'live';
}

// B7: room-wide events carry no bidder identity. Where a viewer needs to know about THEMSELVES (leading, won),
// each socket in the room gets its own copy with `you_*` set from its own login.
async function emitPerViewer(room, event, payloadFor) {
  for (const s of await io.in(room).fetchSockets()) s.emit(event, payloadFor(s.data?.username || null));
}

io.on('connection', (socket) => {
  // Every socket event that carries an auctionId gets it validated and
  // lowercased before its handler runs (room names are case-sensitive too: an
  // uppercase id would join a room nothing is ever broadcast to).
  const SOCKET_ID_ERRORS = {
    join_auction: ['auction_error', { code: 'not_found', message: 'Auction not found.' }],
    place_bid: ['bid_error', { message: 'Invalid auction id' }],
    send_chat: ['chat_error', { message: 'Invalid auction id' }],
  };
  socket.use(([event, payload], next) => {
    if (payload && typeof payload === 'object' && 'auctionId' in payload) {
      const c = canonicalUuid(payload.auctionId);
      if (!c) {
        const [evt, body] = SOCKET_ID_ERRORS[event] || ['host_error', { message: 'Invalid auction id' }];
        socket.emit(evt, body);
        return;   // drop the event: the handler never sees a malformed id
      }
      payload.auctionId = c;
    }
    next();
  });

  // Every event handler goes through this (security review #4). A client can
  // send any event with any payload - or none: the handlers destructure their
  // payload, so an event with no payload threw inside an async handler, and an
  // unhandled rejection exits Node. One anonymous socket.emit('place_bid') took
  // the whole server down. The payload is always an object here, and a handler
  // that throws is logged, never fatal.
  // Per-connection rate limits too (review #5): [events, per ms, error event, message].
  const SOCKET_LIMITS = {
    send_chat: [5, 10e3, 'chat_error', 'You are sending messages too quickly.'],
    place_bid: [10, 10e3, 'bid_error', 'Too many bids too quickly.'],
    default: [30, 60e3],
  };
  const socketHits = {};
  const socketExempt = RATE_LIMIT_EXEMPT_LOOPBACK && isLoopback(socket.handshake.address);
  const on = (event, handler) => socket.on(event, async (payload, ...rest) => {
    if (!socketExempt) {
      const [limit, windowMs, errEvent, message] = SOCKET_LIMITS[event] || SOCKET_LIMITS.default;
      const now = Date.now();
      const hits = (socketHits[event] || []).filter(t => now - t < windowMs);
      if (hits.length >= limit) {
        if (errEvent) socket.emit(errEvent, { message, code: 'rate_limited' });
        socketHits[event] = hits;
        return;
      }
      hits.push(now);
      socketHits[event] = hits;
    }
    try {
      await handler(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}, ...rest);
    } catch (e) {
      console.error(`socket ${event} failed:`, e.message);
    }
  });

  console.log(`- User connected: ${socket.id}`);

  on('join_auction', async ({ auctionId, token, rehearsal } = {}) => {
    // Support legacy string-only calls
    if (typeof auctionId === 'string' && !token) { /* auctionId already set */ }

    const user = token ? await verifySocketToken(token) : null;

    // Drafts are private - resolve this BEFORE joining the room or emitting
    // any state (auction_state/bid_history/chat_history). Checking after
    // would already have leaked the auction to anyone who has its id.
    // A live show's rehearsal: a logged-in account with the private link's key gets into the draft (phase 2a).
    const { data: auction } = await supabase.from('auctions').select('*').eq('id', auctionId).single();
    if (auction && auction.status === 'draft' && !canSeeAuction(auction, user, rehearsal)) {
      socket.emit('auction_error', { code: 'not_found', message: 'Auction not found.' });
      return;
    }
    if (auction?.status === 'draft' && user && user.username !== ADMIN_USERNAME) socket.data.rehearsal = auctionId;
    // Logged-out viewers of a live show: at most LIVE_ANON_CAP at a time, so logged-in buyers always get in.
    if (!user && auction?.mode === 'live' && LIVE_ENABLED && !(await io.in(auctionId).fetchSockets()).some(x => x.id === socket.id)
        && await anonViewersIn(auctionId) >= LIVE_ANON_CAP) {
      socket.emit('auction_error', { code: 'login_to_watch', message: 'This show is full for guests. Log in to watch: buyers with an account always get in.' });
      return;
    }

    // Check approval status for authenticated users
    if (user) {
      socket.userId = String(user.id);
      socket.username = user.username;
      socket.data.username = user.username;   // read by emitPerViewer (fetchSockets returns data, not props)

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

    const isAdmin = user?.username === ADMIN_USERNAME;
    if (auction) {
      socket.emit('auction_state', isAdmin ? auctionFor(auction, user.username, ADMIN_USERNAME) : { ...publicAuction(auction), you_lead: !!user && auction.leading_bidder === user.username,
        ...(auction.mode === 'live' ? { on_air: showOnAir(auction), rehearsal: auction.status === 'draft' } : {}) });
    }

    // Who bid what: the admin only (B7).
    if (isAdmin) {
      const { data: bids } = await supabase.from('bids').select('*').eq('auction_id', auctionId).order('created_at', { ascending: false }).limit(20);
      if (bids) socket.emit('bid_history', bids);
    }

    // A live show with a lot open: the joining viewer gets that lot, whether THEY lead, and its clock.
    if (auction?.mode === 'live' && showOnAir(auction)) {
      const { data: openLot } = await supabase.from('auction_items').select('*').eq('auction_id', auctionId).eq('status', 'open').maybeSingle();
      if (openLot?.ends_at) {
        const clock = liveClock(auctionId, openLot.id, Date.parse(openLot.ends_at));
        socket.emit('item_activated', { item: isAdmin ? openLot : publicLot(openLot), lot_number: openLot.position + 1, you_lead: !!user && openLot.leading_bidder === user.username,
          leader: openLot.bid_count > 0 ? openLot.leading_bidder : null,
          pre_bid_count: openLot.pre_bid_count || 0, ends_at: clock.ends_at, server_now: clock.server_now });
        socket.emit('item_timer_tick', clock);
      }
    }

    const { data: chatHistory } = await supabase.from('chat_messages').select('*').eq('auction_id', auctionId).eq('flagged', false).order('created_at', { ascending: true }).limit(50);
    if (chatHistory) socket.emit('chat_history', chatHistory);
    // A live show: everything its screens need, in one object (the same as GET /auction/:id/show-state).
    if (auction?.mode === 'live' && LIVE_ENABLED) {
      try { const st = await liveShowState(auctionId); if (st) socket.emit('show_state', showStateFor(st, user?.username || null)); }
      catch (e) { console.error('show_state on join failed:', auctionId, e.message); }
    }

    console.log(`- ${socket.id} joined auction ${auctionId} - ${viewers[auctionId].size} watching`);
  });

  // Live bidding (brief §1.1, §1.3). The SAME engine as timed lots: place_standard_bid (row lock, proxy/max bids,
  // tiered increments, one pre_bids table), with the live lot's own clock rule inside it. The SAME gates as the
  // REST bid: login, approved, not blocked, a VERIFIED card, not the host, the show's terms accepted. Errors come
  // back as bid_error { message, code } with the REST codes, so the room can open the right fix.
  // Payload: { auctionId, itemId?, max_amount, token } (`amount` is accepted for max_amount; no itemId = the lot
  // that is open now).
  on('place_bid', async ({ auctionId, itemId, max_amount, amount, token }) => {
    const fail = (message, code) => socket.emit('bid_error', code ? { message, code } : { message });
    if (!LIVE_ENABLED) return fail(LIVE_OFF, 'live_off');
    const user = await verifySocketToken(token);
    if (!user) return fail('You must be logged in to bid', 'login_required');
    const { data: auction } = await supabase.from('auctions').select('id, mode, status, host_username, on_air_at, ended_at').eq('id', auctionId).maybeSingle();
    if (!auction || auction.mode !== 'live') return fail('Bidding on this auction happens lot by lot.');
    // A rehearsal (a draft on air) only for the accounts that came in through its private link.
    if (auction.status === 'draft' && socket.data.rehearsal !== auctionId) return fail('Item not found', 'not_found');
    const refusal = await biddingRefusal(user, auction);
    if (refusal) return fail(refusal.error, refusal.code);
    if (!showOnAir(auction)) return fail('This show is not on air', 'not_on_air');
    if (!(await hasAcceptedTerms(user.id, auctionId))) return fail('You must accept the auction terms before bidding', 'terms_required');
    if (await liveUnpaid(user.id, auctionId)) return fail(LIVE_UNPAID, 'payment_failed');
    const max = parseMaxBid(max_amount ?? amount);
    if (max == null) return fail(`Max bid must be between $1 and $${MAX_BID_DOLLARS.toLocaleString('en-US')}`, 'bad_amount');

    let q = supabase.from('auction_items').select('id, auction_id, status, current_bid, starting_bid, bid_count, leading_bidder, ends_at');
    q = itemId ? q.eq('id', canonicalUuid(itemId) || '00000000-0000-0000-0000-000000000000') : q.eq('auction_id', auctionId).eq('status', 'open');
    const { data: lots } = await q.limit(1);
    const lot = lots?.[0];
    if (!lot || !lotBelongsToAuction(lot, auctionId)) return fail('Item not found', 'not_found');
    if (lot.status !== 'open') return fail('No lot is open for bidding right now', 'lot_not_open');

    const isLeader = lot.leading_bidder === user.username;
    const minBid = lotRules.minimumBid(lot, isLeader);
    if (max < minBid) return fail(`Min bid: $${minBid.toFixed(2)}`, 'below_minimum');

    // The leader raising their own max changes only the max (migration n), never the price or the room.
    if (isLeader) {
      const { data: rows, error: maxErr } = await supabase.rpc('update_standard_leader_max', { p_item_id: lot.id, p_username: user.username, p_max_amount: max });
      if (maxErr) console.error('update_standard_leader_max failed:', maxErr.code, maxErr.message);
      if (rows && rows.length) return socket.emit('bid_ok', { ...bidResult(rows[0], user.username), max_only: true });
    }
    const { data, error } = await supabase.rpc('place_standard_bid', {
      p_item_id: lot.id, p_user_id: String(user.id), p_username: user.username, p_max_amount: max,
      p_opening_min: OPENING_BID_MIN, p_soft_close_minutes: SOFT_CLOSE_MINUTES,
    });
    if (error) {
      if (error.code === 'P0001') return fail(error.message, 'refused');
      console.error('live place_standard_bid failed:', error.code, error.message);
      return fail('Bid failed');
    }
    if (data.ends_at) watchLiveLot(data);   // a late bid may have added time
    socket.emit('bid_ok', bidResult(data, user.username));
    // Live shows show usernames on bids (phase 2): the leader after this bid ("@name $45"), never anyone's max. Each
    // viewer also learns whether THEY lead. Outbid = the in-room alert (no outbid email per bid during a show).
    await emitPerViewer(auctionId, 'new_bid', u => ({
      auction_id: auctionId, item_id: data.id, amount: Number(data.current_bid), bid_count: data.bid_count, username: data.leading_bidder || null,
      next_bid: lotRules.nextBidAmounts(data)[0],
      ends_at: data.ends_at, server_now: new Date(dbNow()).toISOString(), you_lead: !!u && u === data.leading_bidder,
    }));
  });

  on('send_chat', async ({ auctionId, text, token }) => {
    const user = await verifySocketToken(token);
    if (!user) { socket.emit('chat_error', { message: 'You must be logged in to chat' }); return; }
    if (typeof text !== 'string' || !text.trim()) return;
    const clean = text.trim().slice(0, 200);

    // Same standing as joining the room (security review #7): this used to check
    // the token only, so a blocked user kept posting - into any auction, drafts
    // included - just by emitting the event.
    const { data: auction } = await supabase.from('auctions').select('host_username, leading_bidder, status').eq('id', auctionId).maybeSingle();
    if (!auction || (auction.status === 'draft' && user.username !== ADMIN_USERNAME && socket.data.rehearsal !== auctionId)) {
      socket.emit('chat_error', { message: 'Auction not found' }); return;
    }
    if (user.username !== ADMIN_USERNAME) {
      const { data: profile, error: pErr } = await supabase.from('profiles').select('status').eq('user_id', String(user.id)).maybeSingle();
      if (pErr) { socket.emit('chat_error', { message: 'Could not check your account. Try again in a moment.' }); return; }
      if (!profile || profile.status !== 'approved') {
        socket.emit('chat_error', { message: profile?.status === 'blocked' ? 'You have been removed from this auction.' : 'Your account must be approved before you can chat.' }); return;
      }
    }

    let role = 'viewer';
    if (auction.host_username === user.username) role = 'host';
    else if (auction.leading_bidder === user.username) role = 'bidder';

    const { data: msg, error } = await supabase.from('chat_messages').insert({ auction_id: auctionId, username: user.username, text: clean, role }).select().single();
    if (error) { console.error('Chat save error:', error); return; }

    io.to(auctionId).emit('new_chat', { id: msg.id, type: 'msg', auction_id: auctionId, username: user.username, text: clean, role, created_at: msg.created_at });
  });

  // -- Admin: block user mid-auction --
    on('block_user', async ({ targetUserId, targetUsername, auctionId, token }) => {
    const admin = await verifySocketToken(token);
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

  // Host events (phase 2a, LIVE_SHOWS_PHASE2_BRIEF.md; audit §2). Each one: live shows switched on, a live-mode
  // auction, and only its host (or the admin). Every accepted event records host activity (the 60-minute auto-end)
  // and answers the sender with host_ok { action }; a refused one with host_error { message, code }. The state
  // machine refuses steps out of order (start_clock with no lot on screen, show_lot while a lot sells, and so on).
  async function liveHost(auctionId, token) {
    if (!LIVE_ENABLED) { socket.emit('host_error', { message: LIVE_OFF, code: 'live_off' }); return null; }
    const user = await verifySocketToken(token);
    if (!user) { socket.emit('host_error', { message: 'Unauthorized' }); return null; }
    const { data: auction } = await supabase.from('auctions').select('*').eq('id', auctionId).maybeSingle();
    if (!auction || (auction.host_username !== user.username && user.username !== ADMIN_USERNAME)) {
      socket.emit('host_error', { message: 'Only the host can run this show' }); return null;
    }
    if (auction.mode !== 'live') { socket.emit('host_error', { message: LIVE_ONLY }); return null; }
    return { user, auction };
  }
  const hostErr = (message, code, extra = {}) => { socket.emit('host_error', { message, ...(code ? { code } : {}), ...extra }); return null; };
  const hostOk = (action, extra = {}) => socket.emit('host_ok', { action, ...extra });
  const touchHost = (auctionId, extra = {}) => supabase.from('auctions').update({ last_host_activity_at: new Date().toISOString(), ...extra }).eq('id', auctionId);
  const openLotOf = async auctionId => (await supabase.from('auction_items').select(LIVE_LOT_COLS).eq('auction_id', auctionId).eq('status', 'open').limit(1)).data?.[0] || null;
  // Only on air; a host who isn't gets told why.
  function needOnAir(a) {
    if (showOnAir(a)) return true;
    hostErr(showEnded(a) ? 'This show has ended' : 'Go live first', showEnded(a) ? 'ended' : 'not_on_air');
    return false;
  }

  // Go live: a scheduled show goes on air (status 'live', on_air_at). A draft goes on air as a REHEARSAL (it stays a
  // draft: hidden, only for the private link's invited accounts).
  async function goLive(auctionId, token, { legacy = false } = {}) {
    const h = await liveHost(auctionId, token);
    if (!h) return;
    const a = h.auction;
    if (showEnded(a)) return hostErr('This show has ended', 'ended');
    if (showOnAir(a) && a.on_air_at && !legacy) return hostErr('The show is already on air', 'already_on_air');
    await syncDbClock();
    const at = new Date(dbNow()).toISOString();   // the database's clock, like the lots'
    let ok = true;
    if (a.status === 'draft') {
      const { data } = await supabase.from('auctions').update({ on_air_at: at, last_host_activity_at: at }).eq('id', auctionId).eq('status', 'draft').is('on_air_at', null).select('id');
      ok = !!data?.length || (legacy && showOnAir(a));
    } else if (a.status === 'upcoming' || a.status === 'live') {
      const { data } = await supabase.from('auctions').update({ status: 'live', last_host_activity_at: at }).eq('id', auctionId).in('status', ['upcoming', 'live']).select('id');
      ok = !!data?.length;
      if (ok) await markOnAir(auctionId);
    } else ok = false;
    if (!ok) return hostErr('This show has ended or is not published', 'not_scheduled');
    io.to(auctionId).emit('auction_started', { auctionId, ...(a.status === 'draft' ? { rehearsal: true } : {}) });
    hostOk('go_live');
    await emitShowState(auctionId);
    console.log(`- Host ${h.user.username} put show ${auctionId} on air${a.status === 'draft' ? ' (rehearsal)' : ''}`);
  }
  on('go_live', ({ auctionId, token }) => goLive(auctionId, token));
  on('start_auction', ({ auctionId, token }) => goLive(auctionId, token, { legacy: true }));   // phase 1 name

  // Show lot N: puts a waiting lot on screen (no clock yet). { itemId } or the next in the lineup. Refused while a lot
  // is selling. Showing another lot instead is fine (the host changed their mind).
  async function showLot(h, auctionId, itemId) {
    const lots = await showLots(auctionId);
    if (lots.some(l => l.status === 'open')) { hostErr('A lot is still selling', 'lot_open'); return null; }
    const lineup = lots.filter(l => l.status === 'pending').sort(lineupSort);
    const id = itemId ? canonicalUuid(itemId) : null;
    const lot = id ? lineup.find(l => l.id === id) : lineup[0];
    if (!lot) {
      if (id) { hostErr('That lot is not waiting to be offered', 'not_pending'); return null; }
      io.to(auctionId).emit('items_finished', { auctionId });
      hostErr('Every lot has been offered', 'no_lots');
      return null;
    }
    await touchHost(auctionId, { shown_item_id: lot.id, autostart_at: null });
    clearTimeout(autostartTimers.get(auctionId));
    return lot;
  }
  on('show_lot', async ({ auctionId, itemId, token }) => {
    const h = await liveHost(auctionId, token);
    if (!h || !needOnAir(h.auction)) return;
    const lot = await showLot(h, auctionId, itemId);
    if (!lot) return;
    hostOk('show_lot', { item_id: lot.id, lot_number: lot.position + 1 });
    await emitShowState(auctionId);
  });

  // Start the clock on the lot on screen: { seconds: 60 | 30 | 15 | 5, suddenDeath } (default: the lot card's
  // choice, else the show's default). Its pre-bids apply by the proxy rule, never at the top max (brief §1.2).
  async function startClock(h, auctionId, seconds, suddenDeath, lot) {
    const secs = Number(seconds ?? lot.clock_seconds ?? h.auction.clock_seconds ?? LIVE_DEFAULT_CLOCK);
    if (!LIVE_CLOCK_PRESETS.includes(secs)) return hostErr('Clock must be 60, 30, 15 or 5 seconds', 'bad_clock');
    await touchHost(auctionId);
    const r = await openLiveLot(auctionId, lot.id, secs, suddenDeath === undefined ? !!lot.sudden_death : suddenDeath === true);
    if (r.error) return hostErr(r.error, 'refused');
    return r;
  }
  on('start_clock', async ({ auctionId, seconds, suddenDeath, token }) => {
    const h = await liveHost(auctionId, token);
    if (!h || !needOnAir(h.auction)) return;
    if (await openLotOf(auctionId)) return hostErr('A lot is already selling', 'lot_open');
    const { data: lot } = h.auction.shown_item_id
      ? await supabase.from('auction_items').select(LIVE_LOT_COLS).eq('id', h.auction.shown_item_id).maybeSingle() : { data: null };
    if (!lot || lot.status !== 'pending') return hostErr('Show a lot first', 'no_lot_shown');
    const r = await startClock(h, auctionId, seconds, suddenDeath, lot);
    if (r?.id) hostOk('start_clock', { item_id: r.id, ends_at: r.ends_at });
  });
  // Phase 1's one step: the lot on screen (or the next in the lineup) is shown and its clock started at once.
  on('next_item', async ({ auctionId, token, timerSeconds, suddenDeath = false }) => {
    const h = await liveHost(auctionId, token);
    if (!h) return;
    if (!showOnAir(h.auction)) return hostErr('Start the show first', 'not_on_air');
    const secs = timerSeconds === undefined ? LIVE_DEFAULT_CLOCK : (Number(timerSeconds) || LIVE_DEFAULT_CLOCK);
    if (!LIVE_CLOCK_PRESETS.includes(secs)) return hostErr('Clock must be 60, 30, 15 or 5 seconds', 'bad_clock');
    if (await openLotOf(auctionId)) return hostErr('Another lot is still open', 'lot_open');
    const { data: shown } = h.auction.shown_item_id
      ? await supabase.from('auction_items').select(LIVE_LOT_COLS).eq('id', h.auction.shown_item_id).maybeSingle() : { data: null };
    const lot = shown?.status === 'pending' ? shown : await showLot(h, auctionId, null);
    if (!lot) return;
    const r = await startClock(h, auctionId, secs, suddenDeath === true, lot);
    if (r?.id) hostOk('next_item', { item_id: r.id });
  });

  // +15 s on the open lot's clock (any 1-120 s with `seconds`; phase 1's extend_auction sends extraSeconds).
  async function addTime(auctionId, token, seconds) {
    const h = await liveHost(auctionId, token);
    if (!h) return;
    const secs = Number(seconds ?? LIVE_ADD_SECONDS);
    if (!Number.isInteger(secs) || secs < 1 || secs > 120) return hostErr('Add 1 to 120 seconds', 'bad_seconds');
    const lot = await openLotOf(auctionId);
    if (!lot?.ends_at) return hostErr('No lot is open', 'no_lot_open');
    const newEndsAt = new Date(Date.parse(lot.ends_at) + secs * 1000).toISOString();
    // Only if nothing moved it since the read (a bid's extension, the hammer): then the host just taps again.
    const { data: moved } = await supabase.from('auction_items').update({ ends_at: newEndsAt })
      .eq('id', lot.id).eq('status', 'open').eq('ends_at', lot.ends_at).select('id, auction_id, ends_at');
    if (!moved?.length) return hostErr('The lot just changed. Try again.', 'changed');
    await touchHost(auctionId);
    watchLiveLot(moved[0]);
    io.to(auctionId).emit('item_extended', { auctionId, item_id: lot.id, ends_at: moved[0].ends_at, server_now: new Date(dbNow()).toISOString() });
    hostOk('add_time', { item_id: lot.id, ends_at: moved[0].ends_at });
    console.log(`- Host ${h.user.username} added ${secs}s to lot ${lot.id}`);
  }
  on('add_time', ({ auctionId, seconds, token }) => addTime(auctionId, token, seconds));
  on('extend_auction', ({ auctionId, extraSeconds, token }) => addTime(auctionId, token, extraSeconds ?? NaN));   // phase 1 name

  // Sold now: the open lot sells to its leader at the current bid, before its clock runs out. Needs a bid.
  on('sold_now', async ({ auctionId, token }) => {
    const h = await liveHost(auctionId, token);
    if (!h || !needOnAir(h.auction)) return;
    const lot = await openLotOf(auctionId);
    if (!lot) return hostErr('No lot is open', 'no_lot_open');
    if (!(lot.bid_count > 0) || !lot.leading_bidder) return hostErr('No bids yet. Pass it instead, or wait.', 'no_bids');
    await touchHost(auctionId);
    const closed = await closeLiveLot(lot.id, true);
    if (!closed) return hostErr('The lot just closed', 'changed');
    hostOk('sold_now', { item_id: lot.id, status: closed.status, amount: Number(closed.current_bid), username: closed.leading_bidder });
  });

  // Pass: the open lot closes with no sale, whatever its bids ('unsold', no order); a lot on screen whose clock
  // hasn't started is skipped ('unsold' too). Either can Run again later.
  async function passLot(auctionId, token) {
    const h = await liveHost(auctionId, token);
    if (!h || !needOnAir(h.auction)) return;
    const open = await openLotOf(auctionId);
    if (open) {
      const { data: lot, error } = await supabase.rpc('pass_live_lot', { p_item_id: open.id });
      if (error) { console.error('pass_live_lot failed:', error.code, error.message); return hostErr('Could not pass the lot'); }
      if (!lot?.id) return hostErr('The lot just closed', 'changed');
      unwatchLiveLot(lot.id);
      await touchHost(auctionId);
      await emitPerViewer(auctionId, 'lot_closed', () => ({ auctionId, item_id: lot.id, lot_number: lot.position + 1, status: 'unsold', passed: true, amount: null, username: null, you_won: false }));
      hostOk('pass', { item_id: lot.id });
      console.log(`- Host ${h.user.username} passed lot ${lot.id}`);
    } else {
      const id = h.auction.shown_item_id;
      // ends_at = when it was skipped (the "last lot" in show_state, which can then Run again).
      const { data: skipped } = id ? await supabase.from('auction_items').update({ status: 'unsold', ends_at: new Date(dbNow()).toISOString() }).eq('id', id).eq('status', 'pending').select('id, position') : { data: null };
      if (!skipped?.length) return hostErr('No lot is open', 'no_lot_open');
      await touchHost(auctionId, { shown_item_id: null, autostart_at: null });
      clearTimeout(autostartTimers.get(auctionId));
      await emitPerViewer(auctionId, 'lot_closed', () => ({ auctionId, item_id: id, lot_number: skipped[0].position + 1, status: 'unsold', passed: true, amount: null, username: null, you_won: false }));
      hostOk('pass', { item_id: id });
    }
    await emitShowState(auctionId);
  }
  on('pass', ({ auctionId, token }) => passLot(auctionId, token));
  on('pass_lot', ({ auctionId, token }) => passLot(auctionId, token));   // phase 1b name

  // Run again (a Passed or no-bid lot): a copy with the next free lot number, { itemId, next: true (offered next) |
  // false (at the end) }. Lot numbers never change.
  on('run_again', async ({ auctionId, itemId, next = false, token }) => {
    const h = await liveHost(auctionId, token);
    if (!h || !needOnAir(h.auction)) return;
    const id = canonicalUuid(itemId);
    const { data: lot } = id ? await supabase.from('auction_items').select('id, auction_id, position').eq('id', id).maybeSingle() : { data: null };
    if (!lot || lot.auction_id !== auctionId) return hostErr('That lot is not in this show', 'not_found');
    const { data: newId, error } = await supabase.rpc('run_again_live_lot', { p_item_id: lot.id, p_next: next === true });
    if (error) {
      if (error.code === 'P0001') return hostErr(error.message, 'refused');
      console.error('run_again_live_lot failed:', error.code, error.message);
      return hostErr('Could not run the lot again');
    }
    await touchHost(auctionId);
    const { data: copy } = await supabase.from('auction_items').select('*').eq('id', newId).maybeSingle();
    await emitPerViewer(auctionId, 'lineup_changed', () => ({ auctionId, item: copy ? publicLot(copy) : null, lot_number: copy ? copy.position + 1 : null,
      next: next === true, run_again_of: { item_id: lot.id, lot_number: lot.position + 1 } }));
    hostOk('run_again', { item_id: newId, lot_number: copy ? copy.position + 1 : null, next: next === true });
    await emitShowState(auctionId);
    console.log(`- Host ${h.user.username} runs lot ${lot.id} again as ${newId}`);
  });

  // "Re-run now" on the host's declined-card alert (Albert, Oct 16): { orderId, next: true (offered next) | false (at
  // the end of the lineup) }. Only while the show is on air; the order is cancelled and never charged (reofferLiveOrder).
  on('rerun_lot', async ({ auctionId, orderId, next = true, token }) => {
    const h = await liveHost(auctionId, token);
    if (!h) return;
    const id = canonicalUuid(orderId);
    const { data: o } = id ? await supabase.from('orders').select('id, auction_id').eq('id', id).maybeSingle() : { data: null };
    if (!o || o.auction_id !== auctionId) return socket.emit('host_error', { message: 'That lot is not in this show' });
    const r = await reofferLiveOrder(o.id, auctionId, next !== false);
    if (r.error) return socket.emit('host_error', { message: r.error, code: 'rerun_refused' });
    await touchHost(auctionId);
    socket.emit('rerun_ok', { auctionId, order_id: o.id, item_id: r.item_id, lot_number: r.lot_number, next: next !== false });
    await emitShowState(auctionId);
    console.log(`- Host ${h.user.username} re-ran order ${o.id} as lot ${r.item_id}`);
  });

  // Hold: auto-pace waits (the planned clock start is cancelled) until the host taps it again. { on } or a toggle.
  // Released with a lot on screen and auto-pace on, that lot's clock starts after the talk time.
  on('hold', async ({ auctionId, on: wanted, token }) => {
    const h = await liveHost(auctionId, token);
    if (!h || !needOnAir(h.auction)) return;
    const hold = typeof wanted === 'boolean' ? wanted : !h.auction.on_hold;
    let autostart = null;
    if (!hold && h.auction.auto_pace && h.auction.shown_item_id && !(await openLotOf(auctionId))) {
      const { data: shown } = await supabase.from('auction_items').select('status').eq('id', h.auction.shown_item_id).maybeSingle();
      if (shown?.status === 'pending') autostart = new Date(Date.now() + LIVE_TALK_MS).toISOString();
    }
    await touchHost(auctionId, { on_hold: hold, autostart_at: autostart });
    if (autostart) armAutostart(auctionId, autostart); else clearTimeout(autostartTimers.get(auctionId));
    hostOk('hold', { on: hold });
    await emitShowState(auctionId);
  });

  // The show's options from the host screen: { auto_pace, clock_seconds } (either).
  on('set_show_options', async ({ auctionId, auto_pace, clock_seconds, token }) => {
    const h = await liveHost(auctionId, token);
    if (!h) return;
    const u = {};
    if (typeof auto_pace === 'boolean') u.auto_pace = auto_pace;
    if (clock_seconds !== undefined) {
      if (!LIVE_CLOCK_PRESETS.includes(Number(clock_seconds))) return hostErr('Clock must be 60, 30, 15 or 5 seconds', 'bad_clock');
      u.clock_seconds = Number(clock_seconds);
    }
    if (!Object.keys(u).length) return hostErr('Nothing to change', 'bad_request');
    if (u.auto_pace === false) { u.autostart_at = null; clearTimeout(autostartTimers.get(auctionId)); }
    await touchHost(auctionId, u);
    hostOk('set_show_options', u);
    await emitShowState(auctionId);
  });

  // A lot card's clock: { itemId, seconds: 60 | 30 | 15 | 5 | null (the show's default), suddenDeath }. Waiting lots only.
  on('set_lot_clock', async ({ auctionId, itemId, seconds, suddenDeath, token }) => {
    const h = await liveHost(auctionId, token);
    if (!h) return;
    const u = {};
    if (seconds !== undefined) {
      if (seconds !== null && !LIVE_CLOCK_PRESETS.includes(Number(seconds))) return hostErr('Clock must be 60, 30, 15 or 5 seconds', 'bad_clock');
      u.clock_seconds = seconds === null ? null : Number(seconds);
    }
    if (typeof suddenDeath === 'boolean') u.sudden_death = suddenDeath;
    if (!Object.keys(u).length) return hostErr('Nothing to change', 'bad_request');
    const id = canonicalUuid(itemId);
    const { data: set } = id ? await supabase.from('auction_items').update(u).eq('id', id).eq('auction_id', auctionId).eq('status', 'pending').select('id') : { data: null };
    if (!set?.length) return hostErr('That lot is not waiting to be offered', 'not_pending');
    await touchHost(auctionId);
    hostOk('set_lot_clock', { item_id: id, ...u });
    await emitShowState(auctionId);
  });

  // Drag to reorder: { itemIds } = every waiting lot, in the new order. Lot numbers don't change (run_order does).
  on('reorder_lineup', async ({ auctionId, itemIds, token }) => {
    const h = await liveHost(auctionId, token);
    if (!h) return;
    const ids = Array.isArray(itemIds) ? itemIds.map(canonicalUuid) : [];
    const { data: pending } = await supabase.from('auction_items').select('id').eq('auction_id', auctionId).eq('status', 'pending');
    const want = new Set((pending || []).map(l => l.id));
    if (!ids.length || ids.some(x => !x) || new Set(ids).size !== ids.length || ids.length !== want.size || ids.some(x => !want.has(x))) {
      return hostErr('The lineup changed. Here it is again.', 'lineup_changed');
    }
    for (let i = 0; i < ids.length; i++) {
      await supabase.from('auction_items').update({ run_order: i, offer_next: false }).eq('id', ids[i]).eq('status', 'pending');
    }
    await touchHost(auctionId);
    io.to(auctionId).emit('lineup_changed', { auctionId });
    hostOk('reorder_lineup');
    await emitShowState(auctionId);
  });

  // End show: refused while a lot is open (Albert, Oct 15). No show-level order: every sale is a lot.
  async function endShow(auctionId, token) {
    const h = await liveHost(auctionId, token);
    if (!h) return;
    const r = await endLiveShow(auctionId);
    if (r.error) return hostErr(r.error, r.code);
    hostOk('end_show');
    console.log(`- Host ${h.user.username} ended show ${auctionId}`);
  }
  on('end_show', ({ auctionId, token }) => endShow(auctionId, token));
  on('end_auction', ({ auctionId, token }) => endShow(auctionId, token));   // phase 1 name

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
    // lotRules.premiumCents is also what the lot page's "with premium" line uses.
    const hammerCents = Math.round((finalBid || 0) * 100);
    const premiumCents = lotRules.premiumCents(hammerCents, auction.buyers_premium_pct);
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
      // 23505 = orders_item_id_key (migration 2026-09-21g): another caller - an
      // overlapping tick, a second instance during a deploy - created this lot's
      // order between our existence check above and this insert. That is the
      // idempotent outcome, not a failure: return the order that won the race.
      if (itemId && insertErr.code === '23505') {
        const { data: raced } = await supabase.from('orders').select('id').eq('item_id', itemId).limit(1);
        if (raced && raced.length) return raced[0].id;
      }
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
    // Live shows send no per-lot win email: the buyer sees "You won" in the room and gets one summary after the
    // show (Albert, Oct 15, review question 1). The decline email stays immediate.
    const winEmail = !(await isLiveModeAuction(order.auction_id));
    if (order.payment_intent_id) {
      if (winEmail) await notifyWonAndCharged(orderId, order.payment_intent_id);
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

    // G2 on a live lot: a reward or code can bring the lot to $0 (apply_order_discount never leaves 1-49c). Paid,
    // with a marker instead of a Stripe PaymentIntent, and it still earns its points.
    if ((claimed.total_cents || 0) === 0 && claimed.discount_kind) {
      const marker = 'no_charge_discount';
      await supabase.from('orders').update({ payment_intent_id: marker, payment_status: 'paid', payment_error: null }).eq('id', orderId);
      await rewards.earnForOrders([order]);
      if (winEmail) await notifyWonAndCharged(orderId, null);
      return { success: true, payment_intent_id: marker };
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
      amount: claimed.total_cents || 0,   // after any discount (read under the claim)
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
    await rewards.earnForOrders([order]);   // G2 (live shows): points for the paid lot; never throws
    if (winEmail) await notifyWonAndCharged(orderId, paymentIntent.id);
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

// The won-and-charged email runs AFTER the money has moved and the invoice is
// marked paid. Nothing it does may be able to reach chargeInvoice's catch, which
// would record a charged invoice as failed and email the buyer "payment failed".
// notifyInvoiceWonAndCharged already swallows its own errors; this makes the
// guarantee structural rather than a property of that function's body.
async function notifyWonAfterCharge(invoiceId, paymentIntentId) {
  try {
    await notifyInvoiceWonAndCharged(invoiceId, paymentIntentId);
  } catch (e) {
    console.error('won email failed after a successful charge (invoice stays paid):', invoiceId, e.message);
  }
}

// Charges an invoice's buyer off-session for total_cents - the standard-
// auction equivalent of chargeOrder above, one charge per buyer per auction
// instead of one per lot. Copies chargeOrder's proven pattern (atomic
// conditional claim including stale-charging reclaim, per-attempt
// idempotency key, mirrors the result onto every child order via
// orders.invoice_id, never throws) rather than modifying chargeOrder itself,
// which stays exactly as-is for live auctions.
async function chargeInvoice(invoiceId, { auto = false } = {}) {
  try {
    const { data: invoice } = await supabase.from('invoices').select('*').eq('id', invoiceId).single();
    if (!invoice) return { success: false, error: 'Invoice not found' };
    if (invoice.payment_intent_id) {
      await notifyWonAfterCharge(invoiceId, invoice.payment_intent_id);
      return { success: true, payment_intent_id: invoice.payment_intent_id, alreadyCharged: true };
    }

    const staleCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    // A FAILED invoice is claimable only by a human (manual Charge/Retry via
    // /charge-winner). The auto-close job passes { auto: true }, which narrows the
    // claim to 'unpaid' (plus the stale-'charging' crash recovery): a tick that
    // re-enters an auction it has already charged - an overlapping tick, a second
    // instance - must never re-attempt a declined card on its own.
    const claimable = auto ? 'payment_status.eq.unpaid' : 'payment_status.in.(unpaid,failed)';
    const { data: claimed, error: claimErr } = await supabase
      .from('invoices')
      .update({ payment_status: 'charging', charging_since: new Date().toISOString() })
      .eq('id', invoiceId)
      .is('payment_intent_id', null)
      .or(`${claimable},and(payment_status.eq.charging,charging_since.lt.${staleCutoff})`)
      .select()
      .single();
    if (claimErr || !claimed) {
      if (auto && invoice.payment_status === 'failed') {
        return { success: false, error: 'Failed earlier - left for manual retry', skipped: true };
      }
      return { success: false, error: 'Already being charged or already resolved', skipped: true };
    }
    // Mirror the claim onto every child order so orders.payment_status keeps
    // reflecting the invoice's state for UI that reads it directly.
    await supabase.from('orders').update({ payment_status: 'charging' }).eq('invoice_id', invoiceId);

    // G2: a discount (points reward or % code) can bring an invoice to $0. Nothing to charge: it is paid, with a
    // marker instead of a Stripe PaymentIntent (applyInvoiceDiscount never leaves a total between 1c and Stripe's 50c).
    if ((claimed.total_cents || 0) === 0 && claimed.discount_kind) {
      const marker = 'no_charge_discount';
      await supabase.from('invoices').update({ payment_intent_id: marker, payment_status: 'paid', payment_error: null }).eq('id', invoiceId);
      await supabase.from('orders').update({ payment_intent_id: marker, payment_status: 'paid', payment_error: null }).eq('invoice_id', invoiceId);
      const { data: paidOrders } = await supabase.from('orders').select('id, buyer_user_id, hammer_cents').eq('invoice_id', invoiceId);
      await rewards.earnForOrders(paidOrders);
      await notifyWonAfterCharge(invoiceId, null);
      return { success: true, payment_intent_id: marker };
    }

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
    // G2: points for each paid lot, before the won email (which shows them). earnForOrders never throws.
    const { data: paidOrders } = await supabase.from('orders').select('id, buyer_user_id, hammer_cents').eq('invoice_id', invoiceId);
    await rewards.earnForOrders(paidOrders);
    await notifyWonAfterCharge(invoiceId, paymentIntent.id);
    return { success: true, payment_intent_id: paymentIntent.id };
  } catch (e) {
    console.error('chargeInvoice error:', invoiceId, e.message);
    try {
      // Never overwrite an invoice that already carries a PaymentIntent: money
      // has moved, so whatever threw, it is not "payment failed". (Retry and
      // the UI both treat a PaymentIntent id as "already charged".)
      await supabase.from('invoices').update({ payment_status: 'failed', payment_error: e.message }).eq('id', invoiceId).is('payment_intent_id', null);
      await supabase.from('orders').update({ payment_status: 'failed', payment_error: e.message }).eq('invoice_id', invoiceId).is('payment_intent_id', null);
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

      // G2: the invoice's one discount (points reward or % code), decided once, before the charge. Never throws;
      // with points off (or before migration z) it does nothing.
      await rewards.applyInvoiceDiscount(invoiceId);

      try {
        await chargeInvoice(invoiceId, { auto: true });
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

// Orders id/invoice_id are uuids, and Postgres has no ILIKE for uuid, so a
// typed prefix ("2ef6", "2ef6560d-a1") becomes an inclusive range instead:
// the prefix padded with 0s up to the prefix padded with fs. Returns null if
// the text can't be the start of a uuid.
function uuidPrefixRange(text) {
  const hex = text.replace(/-/g, '');
  if (!hex || hex.length > 32 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const fmt = h => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return [fmt(hex.toLowerCase().padEnd(32, '0')), fmt(hex.toLowerCase().padEnd(32, 'f'))];
}

const ADMIN_ORDERS_DEFAULT_LIMIT = 200;
const ADMIN_ORDERS_MAX_LIMIT = 200;

// Filtered, bounded, and counted. Returns { orders, total }: total is the
// exact number of orders matching the filter/search, so the UI can say
// "showing 200 of 847" instead of a silently truncated list. PostgREST caps a
// response at the project's max-rows setting with no error, so an unbounded
// select('*') here would eventually just stop showing orders.
//
// limit/offset page over the MATCHED orders. Each page is then widened to
// every sibling of its orders - the rest of the same invoice and the rest of
// the same bundle - so a page boundary or a search hit on one lot never
// leaves an invoice or bundle showing only some of its lots (the invoice
// card lists its lots and the amount it charges). `orders` can therefore
// hold more rows than `limit`; `total` still counts matches only.
app.get('/admin/orders', requireAdmin, async (req, res) => {
  const rawAuctionId = typeof req.query.auction_id === 'string' ? req.query.auction_id.trim() : '';
  const auctionId = rawAuctionId ? canonicalUuid(rawAuctionId) : '';
  if (rawAuctionId && !auctionId) return res.status(400).json({ error: 'Invalid auction_id' });
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const limitN = parseInt(req.query.limit, 10);
  const offsetN = parseInt(req.query.offset, 10);
  const limit = Math.min(Number.isFinite(limitN) && limitN > 0 ? limitN : ADMIN_ORDERS_DEFAULT_LIMIT, ADMIN_ORDERS_MAX_LIMIT);
  const offset = Number.isFinite(offsetN) && offsetN > 0 ? offsetN : 0;

  let query = supabase
    .from('orders')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .range(offset, offset + limit - 1);

  if (auctionId) query = query.eq('auction_id', auctionId);

  if (q) {
    // Values go inside double quotes in PostgREST's or() syntax, so escape
    // backslash and " there, and escape LIKE's own wildcards so a typed % or _
    // is literal. LIKE escaping goes first; the quote-escaping then doubles
    // the backslashes it added.
    const BS = '\\';
    const like = q.replace(/[\\%_]/g, c => BS + c);
    const quoted = `"%${like.replace(/[\\"]/g, c => BS + c)}%"`;
    const clauses = [`buyer_username.ilike.${quoted}`, `item_title.ilike.${quoted}`];
    const range = uuidPrefixRange(q);
    if (range) {
      clauses.push(`and(id.gte.${range[0]},id.lte.${range[1]})`);
      clauses.push(`and(invoice_id.gte.${range[0]},invoice_id.lte.${range[1]})`);
    }
    query = query.or(clauses.join(','));
  }

  const { data: page, error, count } = await query;
  if (error) return dbFailure(req, res, error);

  const have = new Set(page.map(o => o.id));
  const invoiceIds = [...new Set(page.map(o => o.invoice_id).filter(Boolean))];
  const groupIds = [...new Set(page.map(o => o.group_id).filter(Boolean))];
  let orders = page;
  if (invoiceIds.length || groupIds.length) {
    const sibClauses = [];
    if (invoiceIds.length) sibClauses.push(`invoice_id.in.(${invoiceIds.join(',')})`);
    if (groupIds.length) sibClauses.push(`group_id.in.(${groupIds.join(',')})`);
    const { data: sibs, error: sibErr } = await supabase
      .from('orders')
      .select('*')
      .or(sibClauses.join(','))
      .order('created_at', { ascending: false })
      .order('id', { ascending: true });
    if (sibErr) return dbFailure(req, res, sibErr);
    orders = [...page, ...sibs.filter(o => !have.has(o.id))]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? -1 : 1));
  }

  // matched = how many of the total this page covers (orders may exceed it -
  // see the sibling widening above); the UI compares it to total to say
  // "showing 200 of 847".
  res.json({ orders, total: count ?? page.length, matched: page.length });
});

// Populates the orders screen's auction selector. Counts come from one exact
// count query per auction, NOT from grouping a select of orders - that select
// would hit the same silent row cap this whole endpoint exists to get around.
app.get('/admin/auctions/summary', requireAdmin, async (req, res) => {
  const { data: auctions, error } = await supabase
    .from('auctions')
    .select('id, title, status, starts_at, ends_at, created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return dbFailure(req, res, error);
  const counts = await Promise.all((auctions || []).map(a =>
    supabase.from('orders').select('id', { count: 'exact', head: true }).eq('auction_id', a.id)
  ));
  const failed = counts.find(c => c.error);
  if (failed) return dbFailure(req, res, failed.error);
  res.json((auctions || []).map((a, i) => ({ ...a, order_count: counts[i].count ?? 0 })));
});

// AI spend for the Host Dashboard, from the ai_usage log. Totals are summed
// here rather than shipping every row: all time, per day (in the caller's time
// zone, so "today" and "this month" match the host's calendar), per auction.
app.get('/admin/ai-usage', requireAdmin, async (req, res) => {
  let tz = 'UTC';
  try { if (req.query.tz) { new Intl.DateTimeFormat('en-CA', { timeZone: String(req.query.tz) }); tz = String(req.query.tz); } } catch {}
  const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });

  // PostgREST caps a response at 1000 rows, so page through.
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('ai_usage')
      .select('id, created_at, kind, auction_id, cost_usd')
      .order('id', { ascending: true })
      .range(from, from + 999);
    if (error) {
      if (error.code === '42P01' || error.code === 'PGRST205') {
        return res.status(503).json({ error: 'AI spend tracking is not set up yet', detail: 'Run migration 2026-09-26l-ai-usage.sql in the Supabase SQL editor.' });
      }
      return res.status(500).json({ error: 'Could not load AI spend' });
    }
    rows.push(...data);
    if (data.length < 1000) break;
  }

  const byDay = {}, byAuction = {}, byKind = {};
  let total = 0, unpriced = 0;
  for (const r of rows) {
    const cost = r.cost_usd == null ? 0 : Number(r.cost_usd);
    if (r.cost_usd == null) unpriced++;
    total += cost;
    const day = dayOf.format(new Date(r.created_at));
    (byDay[day] ||= { cost: 0, calls: 0 }); byDay[day].cost += cost; byDay[day].calls++;
    const k = r.auction_id || 'none';
    (byAuction[k] ||= { cost: 0, calls: 0 }); byAuction[k].cost += cost; byAuction[k].calls++;
    (byKind[r.kind] ||= { cost: 0, calls: 0 }); byKind[r.kind].cost += cost; byKind[r.kind].calls++;
  }

  const ids = Object.keys(byAuction).filter(k => k !== 'none');
  const titles = {};
  if (ids.length) {
    const { data } = await supabase.from('auctions').select('id, title').in('id', ids);
    for (const a of data || []) titles[a.id] = a.title;
  }
  res.json({
    tz,
    total: { cost: total, calls: rows.length, unpriced_calls: unpriced },
    by_day: byDay,
    by_kind: byKind,
    by_auction: Object.entries(byAuction)
      .map(([id, v]) => ({
        auction_id: id === 'none' ? null : id,
        title: id === 'none' ? null : (titles[id] ?? null),
        deleted: id !== 'none' && !(id in titles),
        ...v,
      }))
      .sort((a, b) => b.cost - a.cost),
  });
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

// G2: is this box's postage free for the buyer? A free-shipping promo for the event(s), or the bundle bonus (3+ lots
// won by this buyer in that event). Every order in the box must qualify. null = the buyer pays, as before. The label
// is still bought; only the buyer's charge is skipped. Never throws (a failed check = the buyer pays, as before).
async function shippingPromoForOrders(orders) {
  try {
    const s = await rewards.settings();
    if (!s.rewards_on || !orders?.length) return null;
    const auctionIds = [...new Set(orders.map(o => o.auction_id))];
    const promos = await rewards.promosFor(auctionIds);
    if (!promos.length) return null;
    const { data: won } = await supabase.from('orders').select('auction_id')
      .eq('buyer_user_id', orders[0].buyer_user_id).in('auction_id', auctionIds);
    const lotsWonBy = {};
    for (const o of won || []) lotsWonBy[o.auction_id] = (lotsWonBy[o.auction_id] || 0) + 1;
    return rewardsLib.shippingPromoFor(orders, promos, lotsWonBy);
  } catch (e) {
    console.error('shipping promo check failed (buyer pays):', e.message);
    return null;
  }
}

// Step 1 of the shipping flow: quote the real parcel with Shippo and return
// the cheapest rate WITHOUT buying anything. Weight and dimensions come from
// the host, entered at packing time - there is no hardcoded parcel and no
// fallback if any is missing, because a silent fallback here (a fixed 2lb
// box, regardless of the real contents) is the exact bug this replaces.
app.post('/admin/orders/shipping-quote', requireAdmin, normalizeBodyIds({ list: ['order_ids'] }), async (req, res) => {
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
    const shippingPromo = await shippingPromoForOrders(orders);
    res.json({
      rate_id: rate.object_id,
      amount_cents: Math.round(parseFloat(rate.amount) * 100),
      // G2: what the buyer is charged for this label (0 when a promo makes it free) and why
      buyer_pays_cents: shippingPromo ? 0 : Math.round(parseFloat(rate.amount) * 100),
      shipping_promo: shippingPromo,
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
app.post('/admin/orders/label', requireAdmin, normalizeBodyIds({ list: ['order_ids'] }), async (req, res) => {
  const { order_ids, rate_id, amount_cents } = req.body;
  if (!rate_id || !(amount_cents > 0)) {
    return res.status(400).json({ error: 'rate_id and amount_cents (from a shipping quote) are required' });
  }

  const { orders, error, status } = await loadShippableOrders(order_ids);
  if (error) return res.status(status).json({ error });

  if (!SHIPPO_API_KEY) return res.status(500).json({ error: 'SHIPPO_API_KEY not configured' });

  // Charge what Shippo says the rate costs, re-read now - never an amount the
  // browser sent (security review #20). The client's amount_cents is only a
  // cross-check: if it no longer matches (a stale or mistyped quote), nothing
  // is charged and the host gets a fresh quote.
  if (typeof rate_id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(rate_id)) return res.status(400).json({ error: 'Invalid rate_id' });
  let rateDetails;
  try { rateDetails = await shippoFetch('GET', `/rates/${rate_id}/`); } catch (e) {
    console.error('Shippo rate lookup failed:', e.message);
    return res.status(502).json({ error: 'Could not confirm the shipping rate with Shippo. Try again.' });
  }
  const rateCents = Math.round(parseFloat(rateDetails?.amount) * 100);
  if (rateDetails?.object_id !== rate_id || String(rateDetails?.currency || '').toUpperCase() !== 'USD' || !(rateCents > 0)) {
    return res.status(400).json({ error: 'That shipping rate is not valid any more. Get a new quote.' });
  }
  if (rateCents !== amount_cents) {
    return res.status(409).json({ error: `The rate is now ${formatMoney(rateCents)}, not ${formatMoney(amount_cents)}. Get a new quote.` });
  }

  // G2: free postage for the buyer (promo) - the label is bought, the buyer is not charged.
  const shippingPromo = await shippingPromoForOrders(orders);
  let chargeResult;
  if (shippingPromo && orders.some(o => ['paid', 'charging'].includes(o.shipping_payment_status))) {
    chargeResult = { success: false, error: 'Shipping already paid or being charged for one or more orders in this group' };
  } else if (shippingPromo) {
    const { data: claimed } = await supabase.from('orders')
      .update({ shipping_payment_status: 'paid', shipping_payment_error: null, shipping_cost_cents: 0, shipping_promo: shippingPromo })
      .in('id', order_ids).or('shipping_payment_status.is.null,shipping_payment_status.in.(unpaid,failed)').select('id');
    chargeResult = claimed?.length === order_ids.length
      ? { success: true, payment_intent_id: null }
      : { success: false, error: 'Shipping already paid or being charged for one or more orders in this group' };
  } else {
    chargeResult = await chargeShipping(order_ids, rateCents);
  }
  if (!chargeResult.success) {
    return res.status(402).json({ error: 'Shipping charge failed', detail: chargeResult.error });
  }

  try {
    // Fetched independently rather than trusting a client-supplied provider
    // name or a field on the Transaction response - a Transaction has no
    // reliable carrier-name field of its own (that's exactly the bug fixed
    // 2026-09-14, see the tracking_carrier note below), so the rate itself
    // is re-read from Shippo the same way the original single-request flow
    // read it off the /shipments/ response.
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
        `Charged ${formatMoney(rateCents)} (payment_intent ${chargeResult.payment_intent_id}) but Shippo label purchase failed.\nOrder(s): ${order_ids.join(', ')}\nDetail: ${JSON.stringify(transaction.messages)}`
      );
      return res.status(500).json({
        error: 'Buyer was charged but label purchase failed - needs manual follow-up',
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
      shipping_cost_cents: rateCents,
      buyer_paid_cents: shippingPromo ? 0 : rateCents,
      shipping_promo: shippingPromo,
    });
  } catch (e) {
    console.error('Shippo error:', e.message);
    await sendAdminEmail(
      `Shipping charged but label purchase FAILED - order(s) ${order_ids.join(', ')}`,
      `Charged ${formatMoney(rateCents)} (payment_intent ${chargeResult.payment_intent_id}) but Shippo label purchase threw.\nOrder(s): ${order_ids.join(', ')}\nError: ${e.message}`
    );
    res.status(500).json({ error: 'Buyer was charged but label purchase failed - needs manual follow-up', detail: e.message });
  }
});

app.post('/admin/orders/group', requireAdmin, normalizeBodyIds({ list: ['order_ids'] }), async (req, res) => {
  const { order_ids } = req.body;
  if (!order_ids?.length) return res.status(400).json({ error: 'order_ids required' });
  const groupId = require('crypto').randomUUID();
  await supabase.from('orders').update({ group_id: groupId }).in('id', order_ids);
  res.json({ group_id: groupId });
});

// ---- Live shows after the show (brief §1.5, review answer 5) ----
// A show's lots whose buyer's card was declined and never fixed: what the host may re-offer once the show has ended.
app.get('/admin/live/:id/unpaid', requireAdmin, async (req, res) => {
  const { data: show, error } = await supabase.from('auctions').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return dbFailure(req, res, error);
  if (!show || show.mode !== 'live') return res.status(404).json({ error: 'Live show not found' });
  const { data: orders, error: oErr } = await supabase.from('orders').select('id, item_id, item_title, buyer_username, buyer_user_id, total_cents, payment_error, created_at')
    .eq('auction_id', show.id).eq('payment_status', 'failed').is('invoice_id', null).order('created_at');
  if (oErr) return dbFailure(req, res, oErr);
  // can_rerun: back into this show now (on air); can_reoffer: to a later show or a timed auction (after the show).
  res.json({ show: { id: show.id, title: show.title, status: show.status }, can_rerun: showOnAir(show), can_reoffer: show.status === 'ended', lots: orders || [] });
});

// Failed live payments per buyer (answer 5: no automatic strike; the admin sees the count and can block a repeat
// non-payer the usual way). failed = still unpaid, reoffered = lots that went back on sale.
app.get('/admin/live/failed-payments', requireAdmin, async (req, res) => {
  const { data: shows, error } = await supabase.from('auctions').select('id').eq('mode', 'live');
  if (error) return dbFailure(req, res, error);
  if (!shows?.length) return res.json([]);
  const { data: orders, error: oErr } = await supabase.from('orders').select('buyer_user_id, buyer_username, payment_status, created_at')
    .in('auction_id', shows.map(s => s.id)).in('payment_status', ['failed', 'cancelled']).is('invoice_id', null);
  if (oErr) return dbFailure(req, res, oErr);
  const by = new Map();
  for (const o of orders || []) {
    const b = by.get(o.buyer_user_id) || { buyer_user_id: o.buyer_user_id, username: o.buyer_username, failed: 0, reoffered: 0, last_at: null };
    if (o.payment_status === 'failed') b.failed++; else b.reoffered++;
    if (!b.last_at || o.created_at > b.last_at) b.last_at = o.created_at;
    by.set(o.buyer_user_id, b);
  }
  res.json([...by.values()].sort((x, y) => (y.failed + y.reoffered) - (x.failed + x.reoffered)));
});

// Re-offer an unpaid live lot: the host chooses each time where it goes: { auction_id } of a later live show (it
// waits there to be offered) or a timed auction that hasn't ended (open until that auction's end), after the show;
// or the show itself while it is on air ("Re-run now", { next: true (default) | false = at the end }; the host's
// rerun_lot socket event does the same). The order is cancelled and kept as the record; a points reward spent on it
// is given back (reoffer_live_order).
app.post('/admin/live/orders/:orderId/reoffer', requireAdmin, async (req, res) => {
  const orderId = canonicalUuid(req.params.orderId), target = canonicalUuid(req.body?.auction_id);
  if (!orderId || !target) return res.status(400).json({ error: 'auction_id (the show or timed auction to re-offer it in) is required' });
  const r = await reofferLiveOrder(orderId, target, req.body?.next !== false);
  if (r.dbError) return dbFailure(req, res, r.dbError);
  if (r.error) return res.status(r.status).json({ error: r.error });
  console.log(`Live order ${orderId} re-offered in auction ${target} as lot ${r.item_id}`);
  res.json({ item_id: r.item_id, auction_id: target, lot_number: r.lot_number });
});


// ---- Live show screens (phase 2a). Contracts in API.md. ----
// The show's state, as the room gets it in `show_state` (for a first load, a reconnect, or the app). Public for a
// published show; a draft needs the admin or the rehearsal key. you_lead is the caller's own.
async function liveShowFor(req, res) {
  if (!LIVE_ENABLED) { res.status(404).json({ error: 'Auction not found' }); return null; }
  const { data: a, error } = await supabase.from('auctions').select('*').eq('id', req.params.id).maybeSingle();
  if (error) { dbFailure(req, res, error); return null; }
  if (!a || a.mode !== 'live' || !canSeeAuction(a, req.user, req.query.rehearsal)) { res.status(404).json({ error: 'Live show not found' }); return null; }
  return a;
}
app.get('/auction/:id/show-state', optionalAuth, async (req, res) => {
  const a = await liveShowFor(req, res);
  if (!a) return;
  try { res.json(showStateFor(await liveShowState(a.id), req.user?.username || null)); } catch (e) { dbFailure(req, res, e); }
});

// The lineup: the lots still to be offered in order (`waiting`), then the rest (`done`: open, sold, unsold), each
// with its lot number. The host's lineup sheet; the room's "Up next" is the first three (show_state.up_next).
app.get('/auction/:id/lineup', optionalAuth, async (req, res) => {
  const a = await liveShowFor(req, res);
  if (!a) return;
  try {
    const lots = await showLots(a.id);
    const thumbs = await thumbsFor(lots.map(l => l.image_url));
    const view = l => ({ ...liveLotView(l, { leader: l.status !== 'pending' }), thumb_url: thumbs(l.image_url),
      ...(l.status === 'sold' ? { winner: l.leading_bidder, amount: Number(l.current_bid) } : {}),
      ...(l.status === 'unsold' ? { can_run_again: !lots.some(c => c.run_again_of === l.id && c.status === 'pending') } : {}) });
    const order = { open: 0, sold: 1, unsold: 1 };
    res.json({
      auction_id: a.id, shown_item_id: showOnAir(a) ? a.shown_item_id || null : null,
      waiting: lots.filter(l => l.status === 'pending').sort(lineupSort).map(view),
      done: lots.filter(l => l.status !== 'pending').sort((x, y) => (order[x.status] ?? 2) - (order[y.status] ?? 2) || y.position - x.position).map(view),
    });
  } catch (e) {
    dbFailure(req, res, e);
  }
});

// The private rehearsal link (draft live shows): a new random key each call, so rotating it shuts the old link.
// Accounts already in on the old key are sent out of the room.
app.post('/admin/live/:id/rehearsal-key', requireAdmin, async (req, res) => {
  const { data: a, error } = await supabase.from('auctions').select('id, mode, status').eq('id', req.params.id).maybeSingle();
  if (error) return dbFailure(req, res, error);
  if (!a || a.mode !== 'live') return res.status(404).json({ error: 'Live show not found' });
  if (a.status !== 'draft') return res.status(400).json({ error: 'Only a draft show has a rehearsal link (publish makes it public)' });
  const key = require('crypto').randomBytes(18).toString('base64url');
  const { error: uErr } = await supabase.from('auctions').update({ rehearsal_key: key }).eq('id', a.id).eq('status', 'draft');
  if (uErr) return dbFailure(req, res, uErr);
  for (const s of await io.in(a.id).fetchSockets()) {
    if (s.data?.rehearsal === a.id) { s.emit('auction_error', { code: 'rehearsal_closed', message: 'This rehearsal link was changed. Ask the host for the new one.' }); s.leave(a.id); s.data.rehearsal = null; }
  }
  res.json({ rehearsal_key: key, path: `/auction/${a.id}?rehearsal=${key}` });
});

// The pre-show checklist (host): the lineup and opening bids, lots without a photo, and the accounts in the room right
// now with whether each can bid (approved, verified card, terms accepted). Camera, light and sound are checked on the
// host's device.
app.get('/admin/live/:id/checklist', requireAdmin, async (req, res) => {
  const { data: a, error } = await supabase.from('auctions').select('*').eq('id', req.params.id).maybeSingle();
  if (error) return dbFailure(req, res, error);
  if (!a || a.mode !== 'live') return res.status(404).json({ error: 'Live show not found' });
  try {
    const lots = await showLots(a.id);
    const waiting = lots.filter(l => l.status === 'pending').sort(lineupSort);
    const names = [...new Set((await io.in(a.id).fetchSockets()).map(s => s.data?.username).filter(u => u && u !== ADMIN_USERNAME && u !== a.host_username))];
    let buyers = [];
    if (names.length) {
      const { data: users } = await supabase.from('users').select('id, username').in('username', names);
      const ids = (users || []).map(u => String(u.id));
      const { data: profs } = ids.length ? await supabase.from('profiles').select('user_id, status, stripe_payment_method_id, card_verified_at').in('user_id', ids) : { data: [] };
      const { data: terms } = ids.length ? await supabase.from('auction_terms_acceptances').select('user_id').eq('auction_id', a.id).in('user_id', ids) : { data: [] };
      const prof = new Map((profs || []).map(p => [String(p.user_id), p])), took = new Set((terms || []).map(t => String(t.user_id)));
      buyers = (users || []).map(u => {
        const p = prof.get(String(u.id));
        return { username: u.username, approved: p?.status === 'approved', card: !!p?.stripe_payment_method_id, card_verified: !!p?.card_verified_at, terms: took.has(String(u.id)) };
      }).sort((x, y) => x.username.localeCompare(y.username));
    }
    res.json({
      show: { id: a.id, title: a.title, status: a.status, starts_at: a.starts_at, clock_seconds: a.clock_seconds ?? LIVE_DEFAULT_CLOCK, auto_pace: !!a.auto_pace, rehearsal: a.status === 'draft', has_rehearsal_link: !!a.rehearsal_key },
      lots: { waiting: waiting.length, total: lots.length, without_photo: waiting.filter(l => !l.image_url).length },
      lineup: waiting.map(l => ({ id: l.id, lot_number: l.position + 1, title: l.title, starting_bid: Number(l.starting_bid || 0), image_url: l.image_url || null,
        clock_seconds: l.clock_seconds ?? null, sudden_death: !!l.sudden_death, pre_bid_count: l.pre_bid_count || 0 })),
      buyers_in_room: buyers,
    });
  } catch (e) {
    dbFailure(req, res, e);
  }
});

// After the show (host): the winner list (every sold lot) and the packing list, one box per buyer (the phase 1b
// order groups; pickup buyers get one entry each, not boxed). Lot numbers, titles, usernames, ship or pickup.
app.get('/admin/live/:id/packing', requireAdmin, async (req, res) => {
  const { data: a, error } = await supabase.from('auctions').select('*').eq('id', req.params.id).maybeSingle();   // '*': ended_at (zd)
  if (error) return dbFailure(req, res, error);
  if (!a || a.mode !== 'live') return res.status(404).json({ error: 'Live show not found' });
  const { data: orders, error: oErr } = await supabase.from('orders').select('id, item_id, item_title, buyer_username, buyer_user_id, hammer_cents, total_cents, payment_status, fulfillment_choice, group_id, status, created_at')
    .eq('auction_id', a.id).neq('payment_status', 'cancelled').order('created_at');
  if (oErr) return dbFailure(req, res, oErr);
  const { data: lots } = (orders || []).length ? await supabase.from('auction_items').select('id, position, title').in('id', orders.map(o => o.item_id)) : { data: [] };
  const num = new Map((lots || []).map(l => [l.id, l.position + 1])), title = new Map((lots || []).map(l => [l.id, l.title]));
  const row = o => ({ order_id: o.id, lot_number: num.get(o.item_id) ?? null, title: title.get(o.item_id) ?? o.item_title, amount_cents: o.hammer_cents ?? o.total_cents ?? 0, payment_status: o.payment_status || 'unpaid' });
  const boxes = new Map();
  for (const o of orders || []) {
    const pickup = o.fulfillment_choice === 'pickup';
    const key = pickup ? `pickup:${o.buyer_user_id}` : (o.group_id ? `box:${o.group_id}` : `buyer:${o.buyer_user_id}`);
    if (!boxes.has(key)) boxes.set(key, { buyer: o.buyer_username, fulfillment: pickup ? 'pickup' : 'shipping', group_id: pickup ? null : o.group_id || null, lots: [] });
    boxes.get(key).lots.push(row(o));
  }
  const list = [...boxes.values()].map(b => ({ ...b, lots: b.lots.sort((x, y) => (x.lot_number ?? 0) - (y.lot_number ?? 0)) }))
    .sort((x, y) => x.buyer.localeCompare(y.buyer) || x.fulfillment.localeCompare(y.fulfillment));
  res.json({
    show: { id: a.id, title: a.title, status: a.status, on_air_at: a.on_air_at || null, ended_at: a.ended_at || null },
    winners: (orders || []).map(o => ({ ...row(o), buyer: o.buyer_username, fulfillment: o.fulfillment_choice || 'shipping' })).sort((x, y) => (x.lot_number ?? 0) - (y.lot_number ?? 0)),
    boxes: list,
  });
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
  if (error) return dbFailure(req, res, error);
  res.json(data);
});

// Shippo webhooks carry no signature we verify, and this route used to accept
// anyone's POST: knowing a tracking number (every buyer knows their own) was
// enough to mark an order delivered, or shipped with a "your item has shipped"
// email (security review #9). The webhook URL registered in Shippo must now
// carry ?key=<SHIPPO_WEBHOOK_SECRET>, compared in constant time. Fails closed:
// with no secret configured, every call is refused.
function shippoWebhookAuthorised(req) {
  const secret = process.env.SHIPPO_WEBHOOK_SECRET;
  const given = typeof req.query.key === 'string' ? req.query.key : '';
  if (!secret || secret.length < 32 || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

app.post('/webhook/shippo', async (req, res) => {
  if (!shippoWebhookAuthorised(req)) {
    if (!process.env.SHIPPO_WEBHOOK_SECRET) console.error('Shippo webhook refused: SHIPPO_WEBHOOK_SECRET is not set');
    return res.status(401).json({ error: 'Unauthorized' });
  }
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

// Lot rows for anyone but the admin/host go through publicLot (public_view.js), an ALLOW-list: no max
// (top_pre_bid: a rival could bid exactly to it), no reserve (security review #8), and since B7 no bidder
// identity at all (leading_bidder). A buyer's own standing and max come from their own authenticated calls
// (/auction/:id/my-standing, /lots/:id/me, /my-bids), never from the public row.
function canSeeLotMaxes(user, auction) {
  return !!user && (user.username === ADMIN_USERNAME || (!!auction && user.username === auction.host_username));
}
// The bidder's own answer after a bid: the public lot plus where THEY stand (never who else leads).
const bidResult = (row, username) => ({ ...publicLot(row), your_status: row && row.leading_bidder === username ? 'winning' : 'outbid' });

app.get('/auction/:id/items', optionalAuth, async (req, res) => {
  const { data: auction } = await supabase.from('auctions').select('*').eq('id', req.params.id).single();   // '*': rehearsal_key (zd)
  if (auction?.status === 'draft' && !canSeeAuction(auction, req.user, req.query.rehearsal)) {
    return res.status(404).json({ error: 'Auction not found' });
  }
  const { data, error } = await supabase
    .from('auction_items').select('*').eq('auction_id', req.params.id).order('position', { ascending: true });
  if (error) return dbFailure(req, res, error);
  res.json(await withThumbs(canSeeLotMaxes(req.user, auction) ? data : data.map(publicLot)));
});

app.post('/auction/:id/items', requireAdmin, async (req, res) => {
  const { title, description, image_url, starting_bid, ends_at } = req.body;
      if (!title) return res.status(400).json({ error: 'title is required' });
      const { data: ex } = await supabase.from('auction_items').select('position').eq('auction_id', req.params.id).order('position', { ascending: false }).limit(1);
      const position = ex && ex.length ? ex[0].position + 1 : 0;
      const { data: auctionRow } = await supabase.from('auctions').select('mode').eq('id', req.params.id).single();
      const isStandard = auctionRow && auctionRow.mode === 'standard';
      const { data, error } = await supabase.from('auction_items').insert({ auction_id: req.params.id, title, description, image_url, starting_bid: starting_bid ?? 0, position, status: isStandard ? 'open' : 'pending', current_bid: isStandard ? (starting_bid ?? 0) : null, ends_at: isStandard ? (ends_at || null) : null }).select().single();
      if (error) return dbFailure(req, res, error);
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
  // A lot that has an order cannot be deleted: orders.item_id references it
  // (NO ACTION), so Postgres refuses with 23503. Report that - this used to
  // ignore the error and answer { success: true } for a lot still sitting there
  // (the same lie #45 fixed for DELETE /auction/:id). Its pre-bids, images,
  // outbid-log rows and bids cascade with it when the delete does go through.
  const { error } = await supabase.from('auction_items').delete().eq('id', req.params.itemId).eq('auction_id', req.params.id);
  if (error) {
    if (error.code === '23503') {
      return res.status(409).json({
        error: 'This lot has an order and cannot be deleted',
        detail: 'Orders are the record of what buyers owe and were sold. Nothing was removed.',
      });
    }
    console.error('DELETE /auction/:id/items/:itemId failed:', req.params.itemId, error.code, error.message);
    return res.status(500).json({ error: 'Could not delete this lot. Nothing was removed.' });
  }
  res.json({ success: true });
});

// A bid or pre-bid is a promise to pay, and a winner who can't be charged loses
// the lot for everyone. So only an approved, unblocked buyer with a saved card
// may accept terms, pre-bid or bid (security review #3: accounts with no
// profile, pending, rejected and even blocked could all take the lead). Fails
// closed on a lookup error. The same check for timed lots, live pre-bids and
// live socket bids (Albert, Oct 15, LIVE_SHOWS_PHASE0_REVIEW.md question 2):
//   - the card must be VERIFIED (the $1 check at /save-payment-method), not just saved;
//   - the host/admin account can never bid, on any auction (no shill bids). `auction` (optional) also refuses
//     that auction's own host_username.
const HOST_CANNOT_BID = { status: 403, code: 'host_cannot_bid', error: 'The host account can\'t bid' };
const hostCannotBid = (user, auction) => user.username === ADMIN_USERNAME || (!!auction?.host_username && auction.host_username === user.username);
async function biddingRefusal(user, auction = null) {
  if (hostCannotBid(user, auction)) return HOST_CANNOT_BID;
  const { data: p, error } = await supabase.from('profiles')
    .select('status, stripe_payment_method_id, card_verified_at').eq('user_id', String(user.id)).maybeSingle();
  if (error) return { status: 503, error: 'Could not check your account. Try again in a moment.' };
  if (!p) return { status: 403, code: 'no_profile', error: 'Complete your buyer profile before bidding' };
  if (p.status === 'blocked') return { status: 403, code: 'blocked', error: 'This account cannot bid' };
  if (p.status !== 'approved') return { status: 403, code: 'not_approved', error: 'Your account must be approved before you can bid' };
  if (!p.stripe_payment_method_id) return { status: 403, code: 'no_card', error: 'Add a payment card before bidding' };
  if (!p.card_verified_at) return { status: 403, code: 'card_not_verified', error: 'Your card couldn\'t be verified. Replace it on your profile page before bidding' };
  return null;
}

// Has this buyer accepted this auction's terms? (The guarantee behind every bid and pre-bid; the modal is the UX.)
async function hasAcceptedTerms(userId, auctionId) {
  const { data } = await supabase.from('auction_terms_acceptances').select('auction_id')
    .eq('auction_id', auctionId).eq('user_id', String(userId)).maybeSingle();
  return !!data;
}

// A max bid is a real number of dollars, at most MAX_BID_DOLLARS, whole cents.
// Stops a troll parking an unbeatable $99,999,999 max on every lot (#3).
const MAX_BID_DOLLARS = 100000;
function parseMaxBid(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n) || n < 1 || n > MAX_BID_DOLLARS) return null;
  return Math.round(n * 100) / 100;
}

// auction_items.auction_id is uuid (migration 2026-09-24i) and req params are
// canonical lowercase (app.param), so a plain === would do; the lowercasing is
// kept as a harmless belt-and-braces from when the column was text.
function lotBelongsToAuction(item, auctionId) {
  return String(item.auction_id || '').toLowerCase() === String(auctionId).toLowerCase();
}

app.post('/auction/:id/items/:itemId/prebid', requireAuth, LIMITS.bidding, async (req, res) => {
  const max_amount = parseMaxBid(req.body?.max_amount);
  if (max_amount == null) return res.status(400).json({ error: `Max bid must be between $1 and $${MAX_BID_DOLLARS.toLocaleString('en-US')}` });
  const refusal = await biddingRefusal(req.user);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
  // '*': prebids_released_at only exists after migration zb.
  const { data: auctionRow } = await supabase.from('auctions').select('*').eq('id', req.params.id).single();
  if (!auctionRow) return res.status(404).json({ error: 'Auction not found' });
  if (auctionRow.status === 'draft') return res.status(400).json({ error: 'Auction is not published yet' });
  if (auctionRow.mode === 'live' && !LIVE_ENABLED) return res.status(400).json({ error: LIVE_OFF, code: 'live_off' });
  if (auctionRow.mode === 'live' && auctionRow.prebids_released_at) return res.status(400).json({ error: "This show didn't start on time, so its pre-bids were released. Pre-bidding is closed.", code: 'prebids_released' });
  if (auctionRow.mode === 'live' && await liveUnpaid(req.user.id, req.params.id)) return res.status(403).json({ error: LIVE_UNPAID, code: 'payment_failed' });
  if (hostCannotBid(req.user, auctionRow)) return res.status(403).json({ error: HOST_CANNOT_BID.error, code: HOST_CANNOT_BID.code });

  // A pre-bid is equally binding as a live bid - it commits the buyer to
  // purchase at that price - so it gets the same terms-acceptance guarantee.
  const { data: acceptance } = await supabase
    .from('auction_terms_acceptances')
    .select('auction_id')
    .eq('auction_id', req.params.id)
    .eq('user_id', String(req.user.id))
    .maybeSingle();
  if (!acceptance) return res.status(403).json({ error: 'You must accept the auction terms before bidding' });

  const { data: item } = await supabase.from('auction_items').select('status, auction_id').eq('id', req.params.itemId).single();
  if (!item) return res.status(404).json({ error: 'Item not found' });
  // The terms check above is for the auction in the URL. The lot must belong
  // to that same auction, or terms accepted on auction A would cover a pre-bid
  // on a lot in auction B (no terms, no fulfilment choice, wrong premium).
  if (!lotBelongsToAuction(item, req.params.id)) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'pending') return res.status(400).json({ error: 'Pre-bidding closed' });
  const { data, error } = await supabase.from('pre_bids').upsert({ item_id: req.params.itemId, auction_id: req.params.id, buyer_username: req.user.username, buyer_user_id: String(req.user.id), max_amount }, { onConflict: 'item_id,buyer_username' }).select().single();
  if (error) return dbFailure(req, res, error);
  const { data: all } = await supabase.from('pre_bids').select('max_amount').eq('item_id', req.params.itemId);
  const top = all ? Math.max(...all.map(b => parseFloat(b.max_amount))) : max_amount;
  await supabase.from('auction_items').update({ pre_bid_count: all ? all.length : 1, top_pre_bid: top }).eq('id', req.params.itemId);
  res.json({ success: true, pre_bid: data });
});

app.get('/auction/:id/items/:itemId/prebid', requireAuth, async (req, res) => {
  const { data } = await supabase.from('pre_bids').select('max_amount').eq('item_id', req.params.itemId).eq('buyer_username', req.user.username).single();
  res.json(data || null);
});

app.delete('/auction/:id/items/:itemId/prebid', requireAuth, LIMITS.bidding, async (req, res) => {
  // pre_bids is also where an OPEN lot keeps every bidder's max (place_standard_bid), so a max can only be
  // withdrawn before the lot opens. Deleting it from an open lot let a bid be taken back mid-auction.
  const { data: item } = await supabase.from('auction_items').select('status, auction_id').eq('id', req.params.itemId).maybeSingle();
  if (!item || !lotBelongsToAuction(item, req.params.id)) return res.status(404).json({ error: 'Item not found' });
  if (item.status !== 'pending') return res.status(400).json({ error: "Bids on an open lot can't be withdrawn" });
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

// The auction rules a page may state in words (e.g. "a late bid resets that lot's clock to 2 minutes"), so no
// page hard-codes them. Public, same for everyone, nothing secret. Contract in API.md.
app.get('/config', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  // G2: whether points are on and the one-sentence numbers ("a point for every $1 you win; every 250 is $25 off"),
  // so public pages can show the points line. Nothing per buyer.
  const p = await rewards.settings();
  res.json({ soft_close_minutes: SOFT_CLOSE_MINUTES, live_enabled: LIVE_ENABLED,
    points: p.enabled ? { enabled: true, points_per_dollar: p.points_per_dollar, points_per_reward: p.points_per_reward, reward_cents: p.reward_cents } : { enabled: false } });
});

// Lots open at $0.00, so "current bid + increment" would allow a $0 opening
// bid. This is the floor for the first bid on a lot; every bid after it
// follows the normal increment tiers (lot_rules.js, shared with the lot page).
const { OPENING_BID_MIN } = lotRules;

app.post('/auction/:id/items/:itemId/bid', requireAuth, LIMITS.bidding, async (req, res) => {
  const max_amount = parseMaxBid(req.body?.max_amount);
  if (max_amount == null) return res.status(400).json({ error: `Max bid must be between $1 and $${MAX_BID_DOLLARS.toLocaleString('en-US')}` });
  const refusal = await biddingRefusal(req.user);
  if (refusal) return res.status(refusal.status).json({ error: refusal.error, code: refusal.code });

  const { data: auctionRow } = await supabase.from('auctions').select('status, mode, host_username').eq('id', req.params.id).single();
  if (!auctionRow) return res.status(404).json({ error: 'Auction not found' });
  if (auctionRow.status === 'draft') return res.status(400).json({ error: 'Auction is not published yet' });
  // A live show's lots are bid on in the show (socket place_bid: its clock, its gates, its room). This route is
  // for timed lots only, so it can't be a side door around the live clock (audit finding 10). Pre-bids before
  // the show still go through POST .../prebid.
  if (auctionRow.mode === 'live') return res.status(400).json({ error: 'Bid on this lot in the live show', code: 'live_lot' });
  if (hostCannotBid(req.user, auctionRow)) return res.status(403).json({ error: HOST_CANNOT_BID.error, code: HOST_CANNOT_BID.code });

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
    .select('current_bid,starting_bid,bid_count,leading_bidder,status,ends_at,auction_id')
    .eq('id', req.params.itemId).single();
  if (!bidItem) return res.status(404).json({ error: 'Item not found' });
  // Same as pre-bid: the terms check above covers the URL's auction, so the
  // lot has to be in it. Without this a bid lands on any auction's lot as
  // long as the bidder accepted terms on ANY auction.
  if (!lotBelongsToAuction(bidItem, req.params.id)) return res.status(404).json({ error: 'Item not found' });
  if (bidItem.status === 'sold' || bidItem.status === 'unsold') return res.status(400).json({ error: 'Lot is closed' });
  if (bidItem.ends_at && new Date(bidItem.ends_at) <= new Date()) return res.status(400).json({ error: 'Lot has closed' });

  const isLeader = bidItem.leading_bidder === req.user.username;
  // Lots start at $0.00, so the opening bid can't just be the floor - it would
  // be $0. OPENING_BID_MIN is the smallest first bid on a lot with no bids yet.
  // The lot page's one-tap amounts come from the same function (nextBidAmounts).
  const minBid = lotRules.minimumBid(bidItem, isLeader);
  if (max_amount < minBid) return res.status(400).json({ error: `Min bid: $${minBid.toFixed(2)}` });

  // The leader resubmitting their max is not a new bid: place_standard_bid
  // would insert a bids row at the unchanged price and bump bid_count. This
  // RPC (migration 2026-09-27n) re-checks the lead under the lot's row lock
  // and only records the max. No row back means the lead changed since the
  // read above (or the function isn't installed yet): place it as a real bid.
  if (isLeader) {
    const { data: rows, error: maxErr } = await supabase.rpc('update_standard_leader_max', {
      p_item_id: req.params.itemId,
      p_username: req.user.username,
      p_max_amount: max_amount
    });
    if (maxErr) console.error('update_standard_leader_max failed:', maxErr.code, maxErr.message);
    if (rows && rows.length) return res.json({ ...bidResult(rows[0], req.user.username), extended: false, max_only: true });
  }

  const { data, error } = await supabase.rpc('place_standard_bid', {
    p_item_id: req.params.itemId,
    p_user_id: String(req.user.id),
    p_username: req.user.username,
    p_max_amount: max_amount,
    p_opening_min: OPENING_BID_MIN,
    p_soft_close_minutes: SOFT_CLOSE_MINUTES
  });
  if (error) {
    // The bid function's own checks raise readable messages (P0001, e.g. "Item is not open for bidding");
    // anything else is a database error, which is logged, not sent (security review #16).
    if (error.code === 'P0001') return res.status(400).json({ error: error.message });
    console.error('place_standard_bid failed:', error.code, error.message);
    return res.status(400).json({ error: 'Bid failed' });
  }

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
  // data is the lot row after the proxy battle: the leader's max and name, which a losing challenger must not
  // get back. They get the public lot and whether THEY lead.
  res.json({ ...bidResult(data, req.user.username), extended });

  // Fire-and-forget: this notifies whoever *lost* the lead, a different user
  // than the one who just bid, so it must never delay this response.
  notifyOutbidIfNeeded(req.params.itemId, bidItem.leading_bidder)
    .catch(e => console.error('notifyOutbidIfNeeded error:', e.message));
});

// The caller's own standing per lot (B7): the public lot rows name nobody, so the room asks this instead of
// comparing leading_bidder with its own name. Never anyone else's.
app.get('/auction/:id/my-standing', requireAuth, async (req, res) => {
  const { data: auction } = await supabase.from('auctions').select('status').eq('id', req.params.id).maybeSingle();
  if (!auction || (auction.status === 'draft' && req.user.username !== ADMIN_USERNAME)) return res.status(404).json({ error: 'Auction not found' });
  try {
    const lots = await lotsOf([req.params.id], 'id, status, ends_at, bid_count, leading_bidder');
    res.set('Cache-Control', 'no-store');
    res.json({ lots: lots.length ? await standingFor(req.user, lots) : {} });
  } catch (e) {
    dbFailure(req, res, e);
  }
});

app.get('/auction/:id/items/standard-status', optionalAuth, async (req, res) => {
  const { data: auction } = await supabase.from('auctions').select('status, host_username').eq('id', req.params.id).single();
  if (auction?.status === 'draft' && req.user?.username !== ADMIN_USERNAME) {
    return res.status(404).json({ error: 'Auction not found' });
  }
  const { data, error } = await supabase.from('auction_items').select('*').eq('auction_id', req.params.id).order('position', { ascending: true });
  if (error) return res.status(500).json({ error: 'Failed to load items' });
  res.json(await withThumbs(canSeeLotMaxes(req.user, auction) ? data : data.map(publicLot)));
});

// ---------------------------------------------------------------------------
// Homepage (wtf-handoff HOMEPAGE_REFRESH_BRIEF.md). Public, no login, and the
// same answer for everyone - which is what makes the short cache below safe.
// The web page and a future app both render from these; contracts in API.md.
//
// Public rules as everywhere else: drafts never appear, and a lot is sent as
// HOME_LOT_FIELDS only - an allow-list, so top_pre_bid, reserve_price and the
// leading bidder can't slip out when a column is added to auction_items.
// ---------------------------------------------------------------------------
const HOME_LOT_FIELDS = 'id, auction_id, position, title, image_url, current_bid, bid_count, ends_at, status';
const HOME_RAIL_MAX = 12;
const HOME_UPCOMING_MAX = 6;
const OPEN_AUCTION_IMAGES = 3;          // the card collage: 1 large + 2 small
const BLURB_MAX = 90;
const CLOSING_SCHEDULE_DAYS = 7;
// The site's own time zone, for grouping "Closing this week" by day. Times are
// sent as ISO (UTC); only the day grouping needs a zone.
const SITE_TIMEZONE = process.env.SITE_TIMEZONE || 'America/New_York';
// "Most wanted" is only worth showing once bidding is actually happening: a
// rail of lots with one bid each reads as an empty room. Below this many lots
// with bids the rail is sent empty, and an empty rail is hidden.
const MOST_WANTED_MIN_LOTS = 3;
const HOME_CACHE_MS = 10_000;

// Standard auctions have no job that flips 'upcoming' to 'live' at starts_at:
// bidding opens by the clock. So "live" here means status 'live', or
// 'upcoming' with starts_at passed; "upcoming" means not started yet.
function auctionPhase(a, nowMs) {
  if (a.status === 'live') return 'live';
  if (a.status === 'upcoming') return a.starts_at && new Date(a.starts_at).getTime() > nowMs ? 'upcoming' : 'live';
  return null;
}
const isoOrNull = v => (v ? new Date(v).toISOString() : null);
// Premium is always shown beside a bid (BRAND.md), so every lot list carries its
// auctions' own buyer's premium - keyed by auction id, the lot shape stays as it is.
const premiumMap = auctions => Object.fromEntries((auctions || []).map(a => [a.id, a.buyers_premium_pct == null ? null : Number(a.buyers_premium_pct)]));
// thumb: from thumbsFor(). thumb_url null = no thumbnail yet; show image_url.
// titles: auction id -> title, so a card can say which collection a lot is in.
const homeLot = (thumb, titles = {}) => l => ({
  id: l.id, auction_id: l.auction_id, auction_title: titles[l.auction_id] ?? null,
  position: l.position, title: l.title, image_url: l.image_url || null, thumb_url: thumb(l.image_url),
  current_bid: Number(l.current_bid ?? 0), bid_count: l.bid_count ?? 0, ends_at: isoOrNull(l.ends_at), status: l.status,
});

// One line for an auction card: the description's first sentence, plain text,
// at most BLURB_MAX characters (cut at a word, with an ellipsis). The full story
// lives on the auction's own page.
function blurbOf(description) {
  const text = String(description || '')
    .replace(/<[^>]*>/g, ' ')              // any HTML
    .replace(/[*_#>`[\]]+/g, '')            // markdown marks
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?])/g, '$1')          // a removed tag can leave "word :"
    .trim();
  if (!text) return '';
  const first = (text.match(/^.+?[.!?](?=\s|$)/) || [text])[0];
  if (first.length <= BLURB_MAX) return first;
  const cut = first.slice(0, BLURB_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return (space > 40 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, '') + '…';
}
const siteDate = (() => {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: SITE_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  return t => fmt.format(new Date(t));   // YYYY-MM-DD in the site's zone
})();

// Every lot row of the given auctions, few columns, paged past PostgREST's 1000.
async function lotsOf(auctionIds, columns) {
  const out = [];
  if (!auctionIds.length) return out;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('auction_items').select(columns)
      .in('auction_id', auctionIds).order('auction_id').order('position').range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

async function buildHome() {
  const nowMs = Date.now(), now = new Date(nowMs).toISOString();
  const { data: auctions, error } = await supabase.from('auctions')
    .select('id, title, description, status, starts_at, ends_at, image_url, buyers_premium_pct')
    .in('status', ['live', 'upcoming']);
  if (error) throw error;
  const live = [], upcoming = [];
  for (const a of auctions || []) (auctionPhase(a, nowMs) === 'live' ? live : upcoming).push(a);
  const liveIds = live.map(a => a.id);
  const titles = Object.fromEntries((auctions || []).map(a => [a.id, a.title]));

  // One query per rail. auction_items is indexed on ends_at and on (auction_id, status).
  const openLots = () => supabase.from('auction_items').select(HOME_LOT_FIELDS)
    .in('auction_id', liveIds).not('status', 'in', '("sold","unsold")').gt('ends_at', now);
  const [ending, wanted, first] = liveIds.length ? await Promise.all([
    openLots().order('ends_at', { ascending: true }).order('position', { ascending: true }).limit(HOME_RAIL_MAX),
    openLots().gt('bid_count', 0).order('bid_count', { ascending: false }).order('ends_at', { ascending: true }).limit(HOME_RAIL_MAX),
    openLots().eq('bid_count', 0).order('ends_at', { ascending: true }).order('position', { ascending: true }).limit(HOME_RAIL_MAX),
  ]) : [{ data: [] }, { data: [] }, { data: [] }];
  for (const r of [ending, wanted, first]) if (r.error) throw r.error;

  // Open auctions: lot counts, closing times and collage photos, from one pass
  // over their lots (a few columns each). An open lot: not sold/unsold, not past its end.
  const allLots = await lotsOf(liveIds, 'auction_id, position, image_url, ends_at, status');
  const per = Object.fromEntries(liveIds.map(id => [id, { count: 0, first: null, last: null, photos: [], closes: [] }]));
  for (const l of allLots) {
    const p = per[l.auction_id];
    p.count++;
    if (l.image_url && p.photos.length <= OPEN_AUCTION_IMAGES) p.photos.push(l.image_url);
    const t = l.ends_at ? Date.parse(l.ends_at) : NaN;
    if (['sold', 'unsold'].includes(l.status) || !(t > nowMs)) continue;
    if (p.first === null || t < p.first) p.first = t;
    if (p.last === null || t > p.last) p.last = t;
    p.closes.push(t);
  }
  // Soonest ending first: the auction's own end, else its last open lot's.
  const endOf = a => (a.ends_at ? Date.parse(a.ends_at) : per[a.id].last ?? Infinity);
  live.sort((a, b) => endOf(a) - endOf(b));
  upcoming.sort((a, b) => (a.starts_at ? Date.parse(a.starts_at) : Infinity) - (b.starts_at ? Date.parse(b.starts_at) : Infinity));

  const collage = Object.fromEntries(live.map(a => [a.id, [...new Set([a.image_url, ...per[a.id].photos].filter(Boolean))].slice(0, OPEN_AUCTION_IMAGES)]));
  const wantedLots = (wanted.data || []).length >= MOST_WANTED_MIN_LOTS ? wanted.data : [];
  const upcomingOut = upcoming.filter(a => a.starts_at).slice(0, HOME_UPCOMING_MAX);
  const thumb = await thumbsFor([...(ending.data || []), ...wantedLots, ...(first.data || []), ...upcomingOut]
    .map(x => x.image_url).concat(...Object.values(collage)));
  const lot = homeLot(thumb, titles);

  // "Closing this week": one entry per auction per day (in the site's zone) on
  // which some of its lots close, for the next CLOSING_SCHEDULE_DAYS days.
  const horizon = nowMs + CLOSING_SCHEDULE_DAYS * 86400e3;
  const closing_schedule = [];
  for (const a of live) {
    const byDay = new Map();
    for (const t of per[a.id].closes) {
      if (t > horizon) continue;
      const d = siteDate(t), e = byDay.get(d);
      if (!e) byDay.set(d, { first: t, last: t }); else { e.first = Math.min(e.first, t); e.last = Math.max(e.last, t); }
    }
    for (const [date, e] of byDay) closing_schedule.push({ date, auction_id: a.id, title: a.title, first_close: isoOrNull(e.first), last_close: isoOrNull(e.last) });
  }
  closing_schedule.sort((x, y) => Date.parse(x.first_close) - Date.parse(y.first_close));

  return {
    timezone: SITE_TIMEZONE,
    open_auctions: live.map(a => {
      const p = per[a.id];
      return {
        id: a.id, title: a.title, blurb: blurbOf(a.description), lot_count: p.count,
        starts_at: isoOrNull(a.starts_at), ends_at: isoOrNull(a.ends_at ?? p.last),
        first_lot_ends_at: isoOrNull(p.first), last_lot_ends_at: isoOrNull(p.last),
        buyers_premium_pct: a.buyers_premium_pct == null ? null : Number(a.buyers_premium_pct),
        images: collage[a.id].map(url => ({ url, thumb_url: thumb(url) })),
      };
    }),
    closing_schedule,
    premium_pct: premiumMap(auctions),
    rails: {
      ending_soon: (ending.data || []).map(lot),
      most_wanted: wantedLots.map(lot),
      first_bid: (first.data || []).map(lot),
    },
    upcoming: upcomingOut.map(a => ({
      id: a.id, title: a.title, blurb: blurbOf(a.description),
      starts_at: isoOrNull(a.starts_at), ends_at: isoOrNull(a.ends_at),
      image_url: a.image_url || null, thumb_url: thumb(a.image_url),
    })),
  };
}

// The busiest page: build it at most once per HOME_CACHE_MS per instance, and
// let concurrent callers share one build. server_now is stamped per response,
// so the countdowns (which tick client-side from it) never drift by the cache age.
let homeCache = { at: 0, body: null, pending: null };
app.get('/home', async (req, res) => {
  try {
    if (!homeCache.body || Date.now() - homeCache.at > HOME_CACHE_MS) {
      if (!homeCache.pending) {
        homeCache.pending = buildHome()
          .then(body => { homeCache = { at: Date.now(), body, pending: null }; return body; })
          .catch(e => { homeCache.pending = null; throw e; });
      }
      await homeCache.pending;
    }
    res.set('Cache-Control', 'no-store');
    res.json({ server_now: new Date().toISOString(), ...homeCache.body });
  } catch (e) {
    dbFailure(req, res, e);
  }
});

// Simple search over lot titles in live and upcoming auctions (the full
// filtered lots page comes later). Same lot fields as the homepage rails.
const SEARCH_MAX = 48;
app.get('/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().replace(/\s+/g, ' ') : '';
  if (q.length < 2) return res.json({ server_now: new Date().toISOString(), q, lots: [], premium_pct: {} });
  if (q.length > 100) return res.status(400).json({ error: 'Search is too long' });
  const nowMs = Date.now();
  const { data: auctions, error } = await supabase.from('auctions').select('id, title, status, starts_at, buyers_premium_pct').in('status', ['live', 'upcoming']);
  if (error) return dbFailure(req, res, error);
  const open = (auctions || []).filter(a => auctionPhase(a, nowMs)), ids = open.map(a => a.id);
  if (!ids.length) return res.json({ server_now: new Date().toISOString(), q, lots: [], premium_pct: {} });
  const { data: lots, error: lotsErr } = await supabase.from('auction_items').select(HOME_LOT_FIELDS)
    .in('auction_id', ids).ilike('title', `%${likeExact(q)}%`)
    .order('ends_at', { ascending: true, nullsFirst: false }).order('position', { ascending: true }).limit(SEARCH_MAX);
  if (lotsErr) return dbFailure(req, res, lotsErr);
  const titles = Object.fromEntries(open.map(a => [a.id, a.title]));
  const found = (lots || []).map(homeLot(await thumbsFor((lots || []).map(l => l.image_url)), titles)), inResults = new Set(found.map(l => l.auction_id));
  res.json({ server_now: new Date().toISOString(), q, lots: found, premium_pct: premiumMap(open.filter(a => inResults.has(a.id))) });
});

// "Wake me when it opens" (migration u). Stores the address only - nothing is
// sent yet. Always the same answer, whether the address is new, already on the
// list or caught by the honeypot, so the form can't be used to test who signed up.
const SIGNUP_OK = { ok: true, message: "Thanks. We'll email you when the next collection opens." };
const signupLimit = limiter({ windowMs: 60 * 60e3, limit: 5, message: 'Too many sign-ups from here. Try again later.' });
app.post('/signup', signupLimit, async (req, res) => {
  // Honeypot: a field people never see. A bot that fills it gets the normal answer.
  if (req.body?.website) return res.json(SIGNUP_OK);
  const email = cleanEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Enter a valid email address' });
  const { error } = await supabase.from('drop_signups').upsert({ email }, { onConflict: 'email', ignoreDuplicates: true });
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return res.status(503).json({ error: "Sign-up isn't open yet. Please try again soon." });
    return dbFailure(req, res, error);
  }
  res.json(SIGNUP_OK);
});

// ---------------------------------------------------------------------------
// Watch list, followed auctions and reminder emails (F3, wtf-handoff
// WATCH_LIST_BRIEF.md, migration w). Contracts in API.md.
//
// Private by design: only the buyer sees their own watches and follows. There
// are no public watch counts; the admin sees counts per lot and per auction.
// /home, /search and the auction pages stay the same for everyone (cacheable);
// the page asks GET /me/watching for the ids and marks its buttons itself.
//
// Reminders are emails now; the outbox (notifications) has a channel column so
// the phone app can add push later without changing any of this.
// ---------------------------------------------------------------------------
const WATCH_MAX = 500;
const REMINDER_KINDS = ['lot_closing', 'auction_open', 'auction_closing'];
const REMINDER_LABELS = {
  lot_closing: 'lots you watch closing within the hour',
  auction_open: 'auctions you follow opening',
  auction_closing: 'auctions you follow closing tomorrow',
};
// Before migration w these tables and functions don't exist.
const watchMissing = e => !!e && ['42P01', 'PGRST205', 'PGRST202', '42883'].includes(e.code);
const watchUnavailable = res => res.status(503).json({ error: 'Watching is not available yet. Please try again soon.', code: 'watch_unavailable' });
LIMITS.watch = limiter({ windowMs: 60e3, limit: 60, key: perUser, message: 'Too many changes too quickly. Wait a moment and try again.' });

// A lot or auction a buyer may watch/follow: published (never a draft).
async function watchableLot(itemId) {
  const { data: lot } = await supabase.from('auction_items').select('id, auction_id, status, ends_at').eq('id', itemId).maybeSingle();
  if (!lot) return null;
  const { data: auction } = await supabase.from('auctions').select('id, status, starts_at').eq('id', lot.auction_id).maybeSingle();
  if (!auction || auction.status === 'draft') return null;
  return { lot, auction };
}

app.post('/watch/:itemId', requireAuth, LIMITS.watch, async (req, res) => {
  const found = await watchableLot(req.params.itemId);
  if (!found) return res.status(404).json({ error: 'Lot not found' });
  const { lot } = found;
  if (['sold', 'unsold'].includes(lot.status) || (lot.ends_at && Date.parse(lot.ends_at) <= Date.now())) return res.status(400).json({ error: 'This lot has closed', code: 'lot_closed' });
  const { count, error: cErr } = await supabase.from('lot_watches').select('item_id', { count: 'exact', head: true }).eq('user_id', req.user.id);
  if (watchMissing(cErr)) return watchUnavailable(res);
  if (cErr) return dbFailure(req, res, cErr);
  if (count >= WATCH_MAX) {
    const { data: already } = await supabase.from('lot_watches').select('item_id').eq('user_id', req.user.id).eq('item_id', lot.id).maybeSingle();
    if (!already) return res.status(400).json({ error: `You can watch up to ${WATCH_MAX} lots. Remove some to add more.`, code: 'watch_limit' });
  }
  const { error } = await supabase.from('lot_watches').upsert({ user_id: req.user.id, item_id: lot.id }, { onConflict: 'user_id,item_id', ignoreDuplicates: true });
  if (watchMissing(error)) return watchUnavailable(res);
  if (error) return dbFailure(req, res, error);
  res.json({ watching: true });
});

app.delete('/watch/:itemId', requireAuth, LIMITS.watch, async (req, res) => {
  const { error } = await supabase.from('lot_watches').delete().eq('user_id', req.user.id).eq('item_id', req.params.itemId);
  if (watchMissing(error)) return watchUnavailable(res);
  if (error) return dbFailure(req, res, error);
  res.json({ watching: false });
});

app.post('/follow/:auctionId', requireAuth, LIMITS.watch, async (req, res) => {
  const { data: auction } = await supabase.from('auctions').select('id, status, starts_at').eq('id', req.params.auctionId).maybeSingle();
  if (!auction || auction.status === 'draft') return res.status(404).json({ error: 'Auction not found' });
  if (auction.status === 'ended') return res.status(400).json({ error: 'This auction has ended', code: 'auction_ended' });
  // Following an auction that is already open (or already inside its last 24
  // hours) marks that reminder as done: the buyer is looking at it right now.
  const nowMs = Date.now(), nowIso = new Date(nowMs).toISOString();
  const open = auctionPhase(auction, nowMs) === 'live';
  let closingSoon = false;
  if (open) {
    const { data: first } = await supabase.from('auction_items').select('ends_at').eq('auction_id', auction.id)
      .not('status', 'in', '("sold","unsold")').gt('ends_at', nowIso).order('ends_at', { ascending: true }).limit(1);
    closingSoon = !!(first && first[0] && Date.parse(first[0].ends_at) - nowMs <= 24 * 3600e3);
  }
  const { error } = await supabase.from('auction_follows').upsert({
    user_id: req.user.id, auction_id: auction.id,
    open_notified_at: open ? nowIso : null, closing_notified_at: closingSoon ? nowIso : null,
  }, { onConflict: 'user_id,auction_id', ignoreDuplicates: true });
  if (watchMissing(error)) return watchUnavailable(res);
  if (error) return dbFailure(req, res, error);
  res.json({ following: true });
});

app.delete('/follow/:auctionId', requireAuth, LIMITS.watch, async (req, res) => {
  const { error } = await supabase.from('auction_follows').delete().eq('user_id', req.user.id).eq('auction_id', req.params.auctionId);
  if (watchMissing(error)) return watchUnavailable(res);
  if (error) return dbFailure(req, res, error);
  res.json({ following: false });
});

// A buyer's standing on each lot: winning / outbid / no_bid while open;
// won / lost / closed after. From the leader's username and the buyer's own
// bids and max bids - nothing about anyone else leaves the server.
async function standingFor(user, lots) {
  const ids = lots.map(l => l.id);
  const mine = new Set();
  if (ids.length) {
    const [{ data: b }, { data: p }] = await Promise.all([
      supabase.from('bids').select('item_id').in('item_id', ids).eq('username', user.username),
      supabase.from('pre_bids').select('item_id').in('item_id', ids).eq('buyer_user_id', String(user.id)),
    ]);
    for (const r of [...(b || []), ...(p || [])]) mine.add(r.item_id);
  }
  const nowMs = Date.now();
  return Object.fromEntries(lots.map(l => {
    const leading = !!l.leading_bidder && l.leading_bidder === user.username && (l.bid_count || 0) > 0;
    const open = !['sold', 'unsold'].includes(l.status) && !(l.ends_at && Date.parse(l.ends_at) <= nowMs);
    const s = open ? (leading ? 'winning' : mine.has(l.id) ? 'outbid' : 'no_bid')
      : (l.status === 'sold' && leading ? 'won' : mine.has(l.id) ? 'lost' : 'closed');
    return [l.id, s];
  }));
}

app.get('/me/watching', requireAuth, async (req, res) => {
  const empty = { lots: [], auctions: [], ids: { lots: [], auctions: [] } };
  const [w, f] = await Promise.all([
    supabase.from('lot_watches').select('item_id, created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }),
    supabase.from('auction_follows').select('auction_id, created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }),
  ]);
  if (watchMissing(w.error) || watchMissing(f.error)) return res.json({ ...empty, available: false });
  if (w.error || f.error) return dbFailure(req, res, w.error || f.error);
  const itemIds = (w.data || []).map(r => r.item_id), followIds = (f.data || []).map(r => r.auction_id);
  const lotsRaw = [];
  for (let i = 0; i < itemIds.length; i += 200) {
    const { data, error } = await supabase.from('auction_items')
      .select('id, auction_id, position, title, image_url, current_bid, bid_count, ends_at, status, leading_bidder').in('id', itemIds.slice(i, i + 200));
    if (error) return dbFailure(req, res, error);
    lotsRaw.push(...data);
  }
  const auctionIds = [...new Set([...lotsRaw.map(l => l.auction_id), ...followIds])];
  const { data: auctions, error: aErr } = auctionIds.length
    ? await supabase.from('auctions').select('id, title, description, status, starts_at, ends_at, image_url, buyers_premium_pct').in('id', auctionIds)
    : { data: [] };
  if (aErr) return dbFailure(req, res, aErr);
  const byId = Object.fromEntries((auctions || []).filter(a => a.status !== 'draft').map(a => [a.id, a]));
  const lots = lotsRaw.filter(l => byId[l.auction_id]);
  const standing = await standingFor(req.user, lots);
  const nowMs = Date.now();
  const thumb = await thumbsFor([...lots.map(l => l.image_url), ...Object.values(byId).map(a => a.image_url)]);
  const order = Object.fromEntries(itemIds.map((id, i) => [id, i]));
  const followed = followIds.filter(id => byId[id]);
  const counts = {};
  if (followed.length) {
    for (const l of await lotsOf(followed, 'auction_id')) counts[l.auction_id] = (counts[l.auction_id] || 0) + 1;
  }
  res.json({
    lots: lots.sort((a, b) => order[a.id] - order[b.id]).map(l => ({
      ...homeLot(thumb, { [l.auction_id]: byId[l.auction_id].title })(l),
      auction_phase: auctionPhase(byId[l.auction_id], nowMs) || byId[l.auction_id].status,
      buyers_premium_pct: byId[l.auction_id].buyers_premium_pct == null ? null : Number(byId[l.auction_id].buyers_premium_pct),
      my_status: standing[l.id],
    })),
    auctions: followed.map(id => {
      const a = byId[id];
      return {
        id: a.id, title: a.title, blurb: blurbOf(a.description), phase: auctionPhase(a, nowMs) || a.status,
        starts_at: isoOrNull(a.starts_at), ends_at: isoOrNull(a.ends_at), lot_count: counts[a.id] || 0,
        image_url: a.image_url || null, thumb_url: thumb(a.image_url),
      };
    }),
    ids: { lots: lots.map(l => l.id), auctions: followed },
  });
});

// The lot page: GET /lots/:itemId (+ /me, /bids, /related, /by-number). lot_page.js; contracts in API.md.
require('./lot_page')(app, {
  supabase, requireAuth, dbFailure, ADMIN_USERNAME, thumbsFor, homeLot, premiumMap, blurbOf, auctionPhase, isoOrNull,
  standingFor, SOFT_CLOSE_MINUTES, CONTACT_EMAIL: REPLY_TO,
});

// Service requests (F5, migration zc): POST /service-requests (the Services/Contact form) and Admin -> Requests.
// service_requests.js; contracts in API.md. Requests go to SERVICES_EMAIL, else the business address in the terms.
require('./service_requests')(app, {
  supabase, requireAdmin, dbFailure, limiter, canonicalUuid, cleanEmail, reencodeUpload, sendEmail, emailHtml, escapeHtml,
  BUYER_FROM, ADMIN_FROM, SITE_URL, INBOX: process.env.SERVICES_EMAIL || REPLY_TO,
});

async function prefsFor(userId) {
  const { data, error } = await supabase.from('notification_prefs').select('lot_closing, auction_open, auction_closing').eq('user_id', userId).maybeSingle();
  if (error) return { error };
  return { prefs: { lot_closing: data?.lot_closing ?? true, auction_open: data?.auction_open ?? true, auction_closing: data?.auction_closing ?? true } };
}

app.get('/me/notification-prefs', requireAuth, async (req, res) => {
  const { prefs, error } = await prefsFor(req.user.id);
  if (watchMissing(error)) return watchUnavailable(res);
  if (error) return dbFailure(req, res, error);
  res.json(prefs);
});

app.put('/me/notification-prefs', requireAuth, LIMITS.watch, async (req, res) => {
  const body = req.body || {};
  const u = {};
  for (const k of REMINDER_KINDS) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'boolean') return res.status(400).json({ error: `${k} must be true or false` });
    u[k] = body[k];
  }
  const { error } = await supabase.from('notification_prefs').upsert({ user_id: req.user.id, ...u, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (watchMissing(error)) return watchUnavailable(res);
  if (error) return dbFailure(req, res, error);
  const { prefs } = await prefsFor(req.user.id);
  res.json(prefs);
});

// One-click unsubscribe. The token names the account and the kind ('all' or
// one reminder kind), signed with a key derived from JWT_SECRET; it never
// expires, so a link in an old email still works. GET only describes what the
// link will do (so a mail scanner that fetches links changes nothing); POST
// does it - the site's /unsubscribe page, and mail clients using the
// List-Unsubscribe-Post one-click header, both POST.
const UNSUB_KEY = crypto.createHmac('sha256', JWT_SECRET).update('wtf-unsubscribe-v1').digest();
const b64u = b => Buffer.from(b).toString('base64url');
function unsubscribeToken(userId, kind = 'all') {
  const body = b64u(JSON.stringify({ u: userId, k: kind }));
  return body + '.' + crypto.createHmac('sha256', UNSUB_KEY).update(body).digest('base64url');
}
function readUnsubscribeToken(token) {
  if (typeof token !== 'string' || token.length > 400) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = crypto.createHmac('sha256', UNSUB_KEY).update(body).digest();
  let got; try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  try {
    const { u, k } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!canonicalUuid(u) || !(k === 'all' || REMINDER_KINDS.includes(k))) return null;
    return { userId: canonicalUuid(u), kind: k };
  } catch { return null; }
}
const unsubscribeWhat = kind => (kind === 'all' ? 'reminder emails (watched lots and followed auctions)' : REMINDER_LABELS[kind]);

app.get('/unsubscribe', (req, res) => {
  const t = readUnsubscribeToken(req.query.token);
  if (!t) return res.status(400).json({ error: 'This unsubscribe link is not valid.' });
  res.json({ ok: true, kind: t.kind, what: unsubscribeWhat(t.kind) });
});

app.post('/unsubscribe', async (req, res) => {
  const t = readUnsubscribeToken(req.query.token || req.body?.token);
  if (!t) return res.status(400).json({ error: 'This unsubscribe link is not valid.' });
  const off = t.kind === 'all' ? Object.fromEntries(REMINDER_KINDS.map(k => [k, false])) : { [t.kind]: false };
  const { error } = await supabase.from('notification_prefs').upsert({ user_id: t.userId, ...off, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (watchMissing(error)) return watchUnavailable(res);
  if (error && error.code === '23503') return res.json({ ok: true, kind: t.kind, what: unsubscribeWhat(t.kind) });   // account gone
  if (error) return dbFailure(req, res, error);
  res.json({ ok: true, kind: t.kind, what: unsubscribeWhat(t.kind) });
});

// The admin's view of interest: watchers per lot and followers per auction.
// ---- Buyer points + promotions (G2, wtf-handoff POINTS_BRIEF.md; rules and the shared discount decision in
// rewards.js). Everything answers "enabled: false" (buyer) or 503 (admin writes) until migration z is applied and
// POINTS_ENABLED=true; with points off nothing here changes any money.
const POINTS_HISTORY_LIMIT = 100;
const pointsUnavailable = res => res.status(503).json({ error: 'Points are not available yet.' });
const pointsDbError = (req, res, err) => rewardsLib.notMigrated(err) ? pointsUnavailable(res) : dbFailure(req, res, err);
const expiresAt = (acct, months) => {
  const base = acct?.last_win_at || acct?.created_at;
  if (!base) return null;
  const d = new Date(base); d.setUTCMonth(d.getUTCMonth() + months); return d.toISOString();
};

// The caller's own points: balance, progress, $ saved, expiry, auto-apply, history. Only ever the caller's rows.
async function pointsFor(userId, s, { historyLimit = POINTS_HISTORY_LIMIT } = {}) {
  const [balance, acct, { data: ledger, error: lErr }, { data: invs, error: iErr }] = await Promise.all([
    rewards.balanceOf(userId),
    rewards.account(userId),
    supabase.from('points_ledger').select('kind, points, note, created_at, order_id, invoice_id')
      .eq('user_id', userId).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(historyLimit),
    supabase.from('invoices').select('discount_cents, discount_premium_cents')
      .eq('buyer_user_id', String(userId)).eq('discount_kind', 'points_reward').eq('payment_status', 'paid'),
  ]);
  if (lErr) throw lErr;
  if (iErr) throw iErr;
  const orderIds = [...new Set((ledger || []).map(r => r.order_id).filter(Boolean))];
  const titles = {};
  if (orderIds.length) {
    const { data } = await supabase.from('orders').select('id, item_title').in('id', orderIds).eq('buyer_user_id', String(userId));
    for (const o of data || []) titles[o.id] = o.item_title;
  }
  return {
    enabled: true,
    balance,
    ...rewardsLib.progress(balance, s),
    reward_cents: s.reward_cents,
    points_per_dollar: s.points_per_dollar,
    saved_cents: (invs || []).reduce((t, v) => t + (v.discount_cents || 0) + (v.discount_premium_cents || 0), 0),
    auto_apply: acct.auto_apply !== false,
    expires_at: balance > 0 ? expiresAt(acct, s.expiry_months) : null,
    expiry_months: s.expiry_months,
    history: (ledger || []).map(r => ({ kind: r.kind, points: r.points, note: r.note || null, created_at: r.created_at,
      item_title: r.order_id ? titles[r.order_id] || null : null })),
  };
}

app.get('/me/points', requireAuth, async (req, res) => {
  const s = await rewards.settings();
  if (!s.enabled) return res.json({ enabled: false });
  try { res.json(await pointsFor(req.user.id, s)); } catch (e) { pointsDbError(req, res, e); }
});

app.put('/me/points/settings', requireAuth, LIMITS.watch, async (req, res) => {
  const s = await rewards.settings();
  if (!s.enabled) return res.status(404).json({ error: 'Points are not switched on.' });
  const { auto_apply } = req.body || {};
  if (typeof auto_apply !== 'boolean') return res.status(400).json({ error: 'auto_apply must be true or false' });
  const { error } = await supabase.from('points_accounts')
    .upsert({ user_id: req.user.id, auto_apply, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) return pointsDbError(req, res, error);
  res.json({ auto_apply });
});

// Promotions a buyer can see on an event page: running or coming up, for this auction or site-wide. Never the
// code itself (the house shares it), only that a % code exists.
app.get('/auction/:id/promotions', async (req, res) => {
  const id = canonicalUuid(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid auction id' });
  const s = await rewards.settings();
  if (!s.rewards_on) return res.json([]);
  const { data: auction } = await supabase.from('auctions').select('id, status').eq('id', id).maybeSingle();
  if (!auction || auction.status === 'draft') return res.status(404).json({ error: 'Auction not found' });
  try {
    const now = Date.now();
    const promos = (await rewards.promosFor([id])).filter(p => Date.parse(p.ends_at) > now);
    res.json(promos.map(p => ({ kind: p.kind, percent: p.kind === 'percent_code' ? p.percent : null,
      starts_at: p.starts_at, ends_at: p.ends_at, bundle_min_lots: p.kind === 'bundle_free_shipping' ? rewardsLib.BUNDLE_MIN_LOTS : null })));
  } catch (e) { pointsDbError(req, res, e); }
});

// A % code for one event, entered before it closes. One per buyer per event (a new code replaces the old one until
// the invoice is decided). Applied off the winning bids at close; doesn't stack with a points reward: the bigger
// saving wins.
async function codeState(userId, auctionId) {
  const { data, error } = await supabase.from('promotion_uses').select('applied_at, promotions(code, percent)')
    .eq('user_id', userId).eq('auction_id', auctionId).maybeSingle();
  if (error) throw error;
  return data ? { code: data.promotions?.code || null, percent: data.promotions?.percent ?? null, applied: !!data.applied_at } : null;
}
async function codeAuction(req, res, auctionIdRaw) {
  const s = await rewards.settings();
  if (!s.rewards_on) { res.status(404).json({ error: 'Promo codes are not available.' }); return null; }
  const auctionId = canonicalUuid(auctionIdRaw);
  if (!auctionId) { res.status(400).json({ error: 'Invalid auction id' }); return null; }
  const { data: auction, error } = await supabase.from('auctions').select('id, status').eq('id', auctionId).maybeSingle();
  if (error) { dbFailure(req, res, error); return null; }
  if (!auction || auction.status === 'draft') { res.status(404).json({ error: 'Auction not found' }); return null; }
  return auction;
}
const CODE_NOTE = 'Comes off your winning bids in this auction when it closes. If you also have a points reward, the bigger saving is used.';

app.get('/checkout/code', requireAuth, async (req, res) => {
  const auction = await codeAuction(req, res, req.query.auction_id);
  if (!auction) return;
  try { res.json({ entered: await codeState(req.user.id, auction.id), note: CODE_NOTE }); } catch (e) { pointsDbError(req, res, e); }
});

app.post('/checkout/apply-code', requireAuth, LIMITS.bidding, async (req, res) => {
  const auction = await codeAuction(req, res, req.body?.auction_id);
  if (!auction) return;
  const code = rewardsLib.normaliseCode(req.body?.code);
  const bad = () => res.status(400).json({ error: "That code isn't valid for this auction." });
  if (!code) return bad();
  if (auction.status === 'ended') return res.status(409).json({ error: 'This auction has closed, so codes can no longer be added.' });
  const { data: inv } = await supabase.from('invoices').select('id').eq('auction_id', auction.id).eq('buyer_user_id', String(req.user.id)).maybeSingle();
  if (inv) return res.status(409).json({ error: 'Your invoice for this auction has already been made, so codes can no longer be added.' });
  try {
    const now = Date.now();
    const promo = (await rewards.promosFor([auction.id]))
      .find(p => p.kind === 'percent_code' && p.code === code && rewardsLib.promoApplies(p, auction.id, now));
    if (!promo) return bad();
    const prev = await codeState(req.user.id, auction.id);
    if (prev?.applied) return res.status(409).json({ error: 'A code has already been used on this auction.' });
    const { error } = await supabase.from('promotion_uses')
      .upsert({ promotion_id: promo.id, user_id: req.user.id, auction_id: auction.id, created_at: new Date().toISOString() }, { onConflict: 'user_id,auction_id' });
    if (error) return pointsDbError(req, res, error);
    res.json({ entered: { code: promo.code, percent: promo.percent, applied: false }, note: CODE_NOTE });
  } catch (e) { pointsDbError(req, res, e); }
});

app.delete('/checkout/apply-code', requireAuth, LIMITS.bidding, async (req, res) => {
  const auction = await codeAuction(req, res, req.query.auction_id);
  if (!auction) return;
  const { error } = await supabase.from('promotion_uses').delete()
    .eq('user_id', req.user.id).eq('auction_id', auction.id).is('applied_at', null);
  if (error) return pointsDbError(req, res, error);
  res.json({ entered: null });
});

// -- Admin: points settings, promotions, a buyer's points, total outstanding --
const POINTS_SETTING_RANGES = { points_per_dollar: [0, 100], points_per_reward: [1, 100000], reward_cents: [1, 100000], expiry_months: [1, 120] };
async function adminPointsSettings() {
  const s = await rewards.settings({ fresh: true });
  const { data } = await supabase.from('points_settings').select('*').eq('id', 1).maybeSingle();
  return {
    admin_enabled: !!data?.enabled, env_enabled: rewardsLib.envOn(), migrated: s.migrated, enabled: s.enabled,
    points_per_dollar: s.points_per_dollar, points_per_reward: s.points_per_reward, reward_cents: s.reward_cents, expiry_months: s.expiry_months,
  };
}
app.get('/admin/points-settings', requireAdmin, async (req, res) => res.json(await adminPointsSettings()));

app.put('/admin/points-settings', requireAdmin, async (req, res) => {
  const b = req.body || {};
  const u = {};
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    u.enabled = b.enabled;
  }
  for (const [k, [lo, hi]] of Object.entries(POINTS_SETTING_RANGES)) {
    if (b[k] === undefined) continue;
    if (!Number.isInteger(b[k]) || b[k] < lo || b[k] > hi) return res.status(400).json({ error: `${k} must be a whole number from ${lo} to ${hi}` });
    u[k] = b[k];
  }
  const { error } = await supabase.from('points_settings').update({ ...u, updated_at: new Date().toISOString() }).eq('id', 1);
  if (error) return pointsDbError(req, res, error);
  rewards.forget();
  res.json(await adminPointsSettings());
});

const PROMO_KINDS = ['percent_code', 'free_shipping', 'bundle_free_shipping'];
function promoFields(b, { partial = false } = {}) {
  const u = {};
  if (!partial || b.kind !== undefined) {
    if (!PROMO_KINDS.includes(b.kind)) return { error: `kind must be one of ${PROMO_KINDS.join(', ')}` };
    u.kind = b.kind;
  }
  if (!partial || b.auction_id !== undefined) {
    if (b.auction_id === null || b.auction_id === undefined || b.auction_id === '') u.auction_id = null;
    else { u.auction_id = canonicalUuid(b.auction_id); if (!u.auction_id) return { error: 'Invalid auction_id' }; }
  }
  for (const k of ['starts_at', 'ends_at']) {
    if (partial && b[k] === undefined) continue;
    const t = Date.parse(b[k]);
    if (!Number.isFinite(t)) return { error: `${k} must be a date and time` };
    u[k] = new Date(t).toISOString();
  }
  if (b.active !== undefined) {
    if (typeof b.active !== 'boolean') return { error: 'active must be true or false' };
    u.active = b.active;
  }
  if (u.kind === 'percent_code') {
    u.code = rewardsLib.normaliseCode(b.code);
    if (!u.code) return { error: 'code: 3 to 30 letters, numbers, - or _' };
    if (!Number.isInteger(b.percent) || b.percent < 1 || b.percent > 90) return { error: 'percent must be a whole number from 1 to 90' };
    u.percent = b.percent;
  } else if (u.kind) { u.code = null; u.percent = null; }
  return { u };
}
app.get('/admin/promotions', requireAdmin, async (req, res) => {
  let q = supabase.from('promotions').select('*').order('starts_at', { ascending: false });
  if (req.query.auction_id) {
    const id = canonicalUuid(req.query.auction_id);
    if (!id) return res.status(400).json({ error: 'Invalid auction_id' });
    q = q.or(`auction_id.eq.${id},auction_id.is.null`);
  }
  const { data, error } = await q;
  if (error) return pointsDbError(req, res, error);
  const ids = (data || []).map(p => p.id);
  const uses = {};
  if (ids.length) {
    const { data: u } = await supabase.from('promotion_uses').select('promotion_id, applied_at').in('promotion_id', ids);
    for (const r of u || []) { const x = uses[r.promotion_id] ||= { entered: 0, applied: 0 }; x.entered++; if (r.applied_at) x.applied++; }
  }
  res.json((data || []).map(p => ({ ...p, uses: uses[p.id] || { entered: 0, applied: 0 } })));
});
app.post('/admin/promotions', requireAdmin, async (req, res) => {
  const { u, error: e } = promoFields(req.body || {});
  if (e) return res.status(400).json({ error: e });
  if (Date.parse(u.ends_at) <= Date.parse(u.starts_at)) return res.status(400).json({ error: 'ends_at must be after starts_at' });
  const { data, error } = await supabase.from('promotions').insert({ ...u, active: u.active ?? true }).select('*').single();
  if (error) return pointsDbError(req, res, error);
  res.status(201).json(data);
});
app.patch('/admin/promotions/:id', requireAdmin, async (req, res) => {
  const id = canonicalUuid(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const b = req.body || {};
  if (b.kind !== undefined || b.code !== undefined || b.percent !== undefined) return res.status(400).json({ error: 'Kind, code and percent can not be changed; make a new promotion.' });
  const { u, error: e } = promoFields(b, { partial: true });
  if (e) return res.status(400).json({ error: e });
  const { data, error } = await supabase.from('promotions').update(u).eq('id', id).select('*').maybeSingle();
  if (error) return error.code === '23514' ? res.status(400).json({ error: 'ends_at must be after starts_at' }) : pointsDbError(req, res, error);
  if (!data) return res.status(404).json({ error: 'Promotion not found' });
  res.json(data);
});
app.delete('/admin/promotions/:id', requireAdmin, async (req, res) => {
  const id = canonicalUuid(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const { count } = await supabase.from('promotion_uses').select('id', { count: 'exact', head: true }).eq('promotion_id', id).not('applied_at', 'is', null);
  if (count > 0) return res.status(409).json({ error: 'This code has been used on invoices. Switch it off instead.' });
  const { error } = await supabase.from('promotions').delete().eq('id', id);
  if (error) return pointsDbError(req, res, error);
  res.json({ deleted: true });
});

async function adminPointsUser(req, res) {
  const id = canonicalUuid(req.params.userId);
  if (!id) { res.status(400).json({ error: 'Invalid user id' }); return null; }
  const { data: user } = await supabase.from('users').select('id, username').eq('id', id).maybeSingle();
  if (!user) { res.status(404).json({ error: 'Buyer not found' }); return null; }
  return user;
}
app.get('/admin/points/:userId', requireAdmin, async (req, res) => {
  const user = await adminPointsUser(req, res);
  if (!user) return;
  const s = await rewards.settings({ fresh: true });
  try { res.json({ username: user.username, ...(await pointsFor(user.id, s, { historyLimit: 1000 })), enabled: s.enabled }); }
  catch (e) { pointsDbError(req, res, e); }
});
app.post('/admin/points/:userId/adjust', requireAdmin, async (req, res) => {
  const user = await adminPointsUser(req, res);
  if (!user) return;
  const { points, note } = req.body || {};
  if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 100000) return res.status(400).json({ error: 'points must be a whole number, not 0' });
  if (typeof note !== 'string' || !note.trim() || note.length > 300) return res.status(400).json({ error: 'A note (up to 300 characters) is required' });
  const { data, error } = await supabase.rpc('points_adjust', { p_user_id: user.id, p_points: points, p_note: note.trim() });
  if (error) {
    if (/points_below_zero/.test(error.message || '')) return res.status(409).json({ error: 'That would take the balance below 0.' });
    return pointsDbError(req, res, error);
  }
  res.json({ balance: data });
});
app.get('/admin/points-summary', requireAdmin, async (req, res) => {
  const s = await rewards.settings({ fresh: true });
  const { data, error } = await supabase.rpc('points_outstanding', { p_points_per_reward: s.points_per_reward });
  if (error) return pointsDbError(req, res, error);
  const row = Array.isArray(data) ? data[0] : data;
  const points = Number(row?.points) || 0;
  res.json({
    points_outstanding: points, buyers: Number(row?.buyers) || 0, rewards_ready: Number(row?.rewards_ready) || 0,
    // What the outstanding points are worth at the current rate (the most they could cost), and what could be used now.
    value_cents: Math.floor(points * s.reward_cents / s.points_per_reward),
    ready_value_cents: (Number(row?.rewards_ready) || 0) * s.reward_cents,
    enabled: s.enabled,
  });
});

// Expiry: points expire after expiry_months with no paid win; a reminder email goes 30 days before. Run from the
// 30-second close job, at most once an hour per instance; the database functions are idempotent and lock per buyer,
// so two instances at once can't double-expire or double-remind. `now` is a parameter so the suite can fake the clock.
let pointsHousekeepingAt = 0;
async function runPointsHousekeeping(now = new Date(), { force = false } = {}) {
  if (!force && Date.now() - pointsHousekeepingAt < 60 * 60 * 1000) return null;
  pointsHousekeepingAt = Date.now();
  try {
    const s = await rewards.settings();
    if (!s.enabled) return null;
    const { data: due, error: rErr } = await supabase.rpc('points_reminders_due', { p_now: now.toISOString(), p_months: s.expiry_months });
    if (rErr) { if (!rewardsLib.notMigrated(rErr)) console.error('points reminders failed:', rErr.message); return null; }
    let reminded = 0;
    for (const r of due || []) {
      const email = await getBuyerEmail(r.user_id);
      if (!email) continue;
      const when = new Date(r.expires_at).toLocaleDateString('en-US', { timeZone: SITE_TIMEZONE, month: 'long', day: 'numeric', year: 'numeric' });
      const body = `<p>Your <strong>${r.balance} points</strong> expire on <strong>${escapeHtml(when)}</strong>.</p>
        <p>Win any lot before then and they stay, along with everything you earn next. Every ${s.points_per_reward} points is ${formatMoney(s.reward_cents)} off a future win.</p>
        <p><a href="${SITE_URL}/auctions" style="background:#1a1a1a;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;">See what's on</a></p>
        <p style="margin-top:24px;font-size:12px;color:#666;">${escapeHtml(BUSINESS_NAME)} &middot; ${escapeHtml(REPLY_TO)}${BUSINESS_POSTAL_ADDRESS ? ' &middot; ' + escapeHtml(BUSINESS_POSTAL_ADDRESS) : ''}</p>`;
      if (await sendEmail({ from: BUYER_FROM, to: email, subject: `Your ${r.balance} points expire on ${when}`, html: emailHtml('Your points expire soon', body), kind: 'points_expiry' })) reminded++;
    }
    const { data: expired, error: eErr } = await supabase.rpc('points_expire_due', { p_now: now.toISOString(), p_months: s.expiry_months });
    if (eErr) console.error('points expiry failed:', eErr.message);
    return { reminded, expired: Number(expired) || 0 };
  } catch (e) {
    console.error('runPointsHousekeeping error:', e.message);
    return null;
  }
}

app.get('/admin/watch-counts', requireAdmin, async (req, res) => {
  const auctionId = canonicalUuid(req.query.auction_id);
  if (!auctionId) return res.status(400).json({ error: 'Invalid auction_id' });
  const lots = await lotsOf([auctionId], 'id');
  const ids = lots.map(l => l.id);
  const counts = {};
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase.from('lot_watches').select('item_id').in('item_id', ids.slice(i, i + 200));
    if (watchMissing(error)) return res.json({ available: false, followers: 0, lots: {} });
    if (error) return dbFailure(req, res, error);
    for (const r of data) counts[r.item_id] = (counts[r.item_id] || 0) + 1;
  }
  const { count, error } = await supabase.from('auction_follows').select('user_id', { count: 'exact', head: true }).eq('auction_id', auctionId);
  if (error && !watchMissing(error)) return dbFailure(req, res, error);
  res.json({ followers: count || 0, lots: counts });
});

// ---- Reminder emails ----
// Runs in the auto-close loop. queue_reminders() claims what is due and writes
// outbox rows in one transaction (each reminder once, ever); this then sends
// ONE email per buyer per run covering all of their due reminders, and marks
// those rows sent. A lot that closed since it was queued is left out; a lot
// that is both in a "closing within the hour" reminder and in a followed
// auction's top lots is listed once.
// The business postal address for the email footer comes from config (A1 is
// not settled yet); until it is set the footer has name + contact only.
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'What The Find';
const BUSINESS_POSTAL_ADDRESS = process.env.BUSINESS_POSTAL_ADDRESS || '';
const API_PUBLIC_URL = (process.env.API_PUBLIC_URL || 'https://wtf-live-backend-production.up.railway.app').replace(/\/+$/, '');

function reminderFooterHtml(userId) {
  const unsub = `${SITE_URL}/unsubscribe?token=${encodeURIComponent(unsubscribeToken(userId, 'all'))}`;
  return `<p style="margin-top:28px;font-size:12px;color:#666;line-height:1.5;">
    You're getting this because you watch lots or follow auctions on What The Find.
    <a href="${SITE_URL}/notifications" style="color:#666;">Choose which reminders you get</a> or
    <a href="${unsub}" style="color:#666;">unsubscribe from all reminders</a>.<br>
    ${escapeHtml(BUSINESS_NAME)} &middot; ${escapeHtml(REPLY_TO)}${BUSINESS_POSTAL_ADDRESS ? ' &middot; ' + escapeHtml(BUSINESS_POSTAL_ADDRESS) : ''}
  </p>`;
}
const STANDING_TEXT = { winning: "You're winning", outbid: 'Outbid', no_bid: 'No bid yet' };
const lotLink = l => `${SITE_URL}/auction/${l.auction_id}?lot=${l.id}`;
function reminderLotRowHtml(l, standing, pct) {
  return `<tr>
    <td style="padding:8px 0;border-bottom:1px solid #eee;">
      <a href="${lotLink(l)}" style="color:#1a1a1a;font-weight:600;text-decoration:none;">Lot ${l.position + 1}: ${escapeHtml(l.title)}</a><br>
      <span style="font-size:13px;color:#555;">${l.bid_count > 0 ? `${formatDollars(l.current_bid)} + ${pct ?? 15}% premium &middot; ` : 'No bids yet &middot; '}closes ${escapeHtml(new Date(l.ends_at).toLocaleString('en-US', { timeZone: SITE_TIMEZONE, weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }))}${standing ? ' &middot; <strong>' + STANDING_TEXT[standing] + '</strong>' : ''}</span>
    </td>
    <td style="padding:8px 0 8px 12px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;"><a href="${lotLink(l)}" style="background:#9E2B20;color:#fff;padding:7px 14px;border-radius:6px;text-decoration:none;font-size:13px;">Bid</a></td>
  </tr>`;
}

async function sendReminderEmail(user, rows, nowMs) {
  const lotIds = [...new Set(rows.filter(r => r.kind === 'lot_closing').map(r => r.payload.item_id))];
  const openIds = [...new Set(rows.filter(r => r.kind === 'auction_open').map(r => r.payload.auction_id))];
  const closingIds = [...new Set(rows.filter(r => r.kind === 'auction_closing').map(r => r.payload.auction_id))];
  const auctionIds = [...new Set([...openIds, ...closingIds])];
  const [{ data: lotsRaw }, { data: auctions }] = await Promise.all([
    lotIds.length ? supabase.from('auction_items').select('id, auction_id, position, title, current_bid, bid_count, ends_at, status, leading_bidder').in('id', lotIds) : { data: [] },
    auctionIds.length ? supabase.from('auctions').select('id, title, description, status, starts_at, ends_at, image_url, buyers_premium_pct').in('id', auctionIds) : { data: [] },
  ]);
  const isOpenLot = l => !['sold', 'unsold'].includes(l.status) && l.ends_at && Date.parse(l.ends_at) > nowMs;
  const closingLots = (lotsRaw || []).filter(isOpenLot).sort((a, b) => Date.parse(a.ends_at) - Date.parse(b.ends_at));
  const aById = Object.fromEntries((auctions || []).filter(a => a.status !== 'draft' && a.status !== 'ended').map(a => [a.id, a]));
  // Top 5 lots by bids for each auction closing tomorrow, minus the lots already listed above.
  const listed = new Set(closingLots.map(l => l.id));
  const tops = {};
  for (const id of closingIds.filter(id => aById[id])) {
    const { data } = await supabase.from('auction_items').select('id, auction_id, position, title, current_bid, bid_count, ends_at, status, leading_bidder')
      .eq('auction_id', id).not('status', 'in', '("sold","unsold")').gt('ends_at', new Date(nowMs).toISOString())
      .order('bid_count', { ascending: false }).order('ends_at', { ascending: true }).limit(5 + listed.size);
    tops[id] = (data || []).filter(l => !listed.has(l.id)).slice(0, 5);
  }
  const standing = await standingFor(user, [...closingLots, ...Object.values(tops).flat()]);
  const pctOf = id => { const a = aById[id]; return a && a.buyers_premium_pct != null ? Number(a.buyers_premium_pct) : null; };
  const lotAuctionPct = {};
  if (closingLots.length) {
    const { data } = await supabase.from('auctions').select('id, buyers_premium_pct').in('id', [...new Set(closingLots.map(l => l.auction_id))]);
    for (const a of data || []) lotAuctionPct[a.id] = a.buyers_premium_pct == null ? null : Number(a.buyers_premium_pct);
  }

  const parts = [], subjects = [];
  if (closingLots.length) {
    subjects.push(closingLots.length === 1 ? `"${closingLots[0].title}" closes within the hour` : `${closingLots.length} lots you're watching close within the hour`);
    parts.push({ title: 'Closing within the hour', body: `
      <table role="presentation" style="width:100%;border-collapse:collapse;">${closingLots.map(l => reminderLotRowHtml(l, standing[l.id], lotAuctionPct[l.auction_id])).join('')}</table>` });
  }
  const photos = {};
  const openAuctions = openIds.map(id => aById[id]).filter(Boolean);
  for (const a of openAuctions) {
    const { data } = await supabase.from('auction_items').select('image_url, ends_at').eq('auction_id', a.id).order('position', { ascending: true });
    const imgs = [...new Set([a.image_url, ...(data || []).map(l => l.image_url)].filter(Boolean))].slice(0, 3);
    const thumb = await thumbsFor(imgs);
    const lastEnd = (data || []).map(l => l.ends_at).filter(Boolean).sort().pop();
    photos[a.id] = { imgs: imgs.map(u => thumb(u) || u), count: (data || []).length, end: a.ends_at || lastEnd };
    subjects.push(`${a.title} is open`);
    parts.push({ title: `${escapeHtml(a.title)} is open`, body: `
      <p style="margin:0 0 8px;">${photos[a.id].imgs.map(src => `<img src="${src}" width="160" alt="" style="width:160px;height:120px;object-fit:cover;border-radius:6px;margin:0 6px 6px 0;">`).join('')}</p>
      <p style="margin:0 0 6px;color:#444;">${escapeHtml(blurbOf(a.description))}</p>
      <p style="margin:0 0 12px;font-size:14px;">${photos[a.id].count} lots${photos[a.id].end ? ' &middot; ends ' + escapeHtml(new Date(photos[a.id].end).toLocaleString('en-US', { timeZone: SITE_TIMEZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })) : ''}</p>
      <p><a href="${SITE_URL}/auction/${a.id}" style="background:#1a1a1a;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;">Browse lots</a></p>` });
  }
  for (const id of closingIds) {
    const a = aById[id];
    if (!a) continue;
    subjects.push(`${a.title} closes tomorrow`);
    parts.push({ title: `${escapeHtml(a.title)}: closing tomorrow`, body: `
      ${tops[id].length ? `<p style="margin:0 0 4px;color:#444;">The most bid-on lots right now:</p>
      <table role="presentation" style="width:100%;border-collapse:collapse;">${tops[id].map(l => reminderLotRowHtml(l, standing[l.id], pctOf(id))).join('')}</table>` : ''}
      <p style="margin-top:10px;"><a href="${SITE_URL}/auction/${a.id}" style="color:#1a1a1a;">See every lot</a></p>` });
  }
  if (!parts.length) return { skipped: 'nothing still open to remind about' };

  const subject = subjects.length === 1 ? subjects[0] : `${subjects[0]} (and ${subjects.length - 1} more)`;
  const body = parts.length === 1 ? parts[0].body
    : parts.map(p => `<h3 style="margin:22px 0 6px;font-size:16px;">${p.title}</h3>${p.body}`).join('');
  const html = emailHtml(parts.length === 1 ? parts[0].title : 'Your reminders from What The Find', body + reminderFooterHtml(user.id));
  const oneClick = `${API_PUBLIC_URL}/unsubscribe?token=${encodeURIComponent(unsubscribeToken(user.id, 'all'))}`;
  const sent = await sendEmail({
    from: BUYER_FROM, to: user.email, subject, html, kind: 'reminder',
    headers: { 'List-Unsubscribe': `<${oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  });
  return sent ? { sent: true } : { failed: 'email not accepted' };
}

let remindersRunning = false;
async function runReminders(now = new Date()) {
  if (remindersRunning) return { skipped: 'already running' };
  remindersRunning = true;
  const out = { queued: 0, emails: 0, failed: 0, skipped: 0 };
  try {
    const { data: queued, error: qErr } = await supabase.rpc('queue_reminders', { p_now: now.toISOString() });
    if (watchMissing(qErr)) return { unavailable: true };
    if (qErr) { console.error('queue_reminders failed:', qErr.code, qErr.message); return out; }
    out.queued = queued || 0;
    const { data: rows, error: cErr } = await supabase.rpc('claim_notifications', { p_channel: 'email', p_limit: 500 });
    if (cErr) { console.error('claim_notifications failed:', cErr.code, cErr.message); return out; }
    const byUser = new Map();
    for (const r of rows || []) { if (!byUser.has(r.user_id)) byUser.set(r.user_id, []); byUser.get(r.user_id).push(r); }
    for (const [userId, list] of byUser) {
      const ids = list.map(r => r.id);
      const done = (patch) => supabase.from('notifications').update(patch).in('id', ids);
      try {
        const { data: user } = await supabase.from('users').select('id, username, email, deleted_at').eq('id', userId).maybeSingle();
        const { prefs } = await prefsFor(userId);
        const wanted = list.filter(r => !prefs || prefs[r.kind] !== false);
        if (!user || user.deleted_at || !user.email || !wanted.length) {
          await done({ sent_at: new Date().toISOString(), error: !user || user.deleted_at ? 'account deleted' : !user.email ? 'no email on file' : 'reminder switched off' });
          out.skipped++; continue;
        }
        const r = await sendReminderEmail(user, wanted, now.getTime());
        if (r.sent) { await done({ sent_at: new Date().toISOString(), error: null }); out.emails++; }
        else if (r.skipped) { await done({ sent_at: new Date().toISOString(), error: r.skipped }); out.skipped++; }
        else { await done({ claimed_at: null, error: r.failed }); out.failed++; }
      } catch (e) {
        console.error('reminder email failed:', e.message);
        await done({ claimed_at: null, error: String(e.message).slice(0, 200) });
        out.failed++;
      }
    }
    if (out.queued || out.emails || out.failed) console.log(`Reminders: ${out.queued} queued, ${out.emails} emails sent, ${out.failed} failed, ${out.skipped} skipped`);
    return out;
  } catch (e) {
    console.error('runReminders error:', e.message);
    return out;
  } finally {
    remindersRunning = false;
  }
}

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

// AI spend log: one ai_usage row per Claude response (migration 2026-09-26l).
// Fire-and-forget - the host is waiting on the AI result, so a failed insert
// (e.g. the migration not run yet) is logged and never fails the request.
// auction_id is optional in each AI route's body, for the per-auction breakdown.
function aiUsageTracker(req) {
    const auctionId = req.body?.auction_id || null;
    return (kind, response) => {
        const u = response?.usage || {};
        const model = response?.model || aiLots.MODEL;
        supabase.from('ai_usage').insert({
            kind,
            model,
            auction_id: auctionId,
            username: req.user?.username || null,
            input_tokens: u.input_tokens || 0,
            output_tokens: u.output_tokens || 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
            cache_read_input_tokens: u.cache_read_input_tokens || 0,
            cost_usd: aiLots.costUsd(model, u),
        }).then(({ error }) => {
            if (error) console.error('ai_usage insert failed:', error.code, error.message);
        }, e => console.error('ai_usage insert failed:', e.message));
    };
}
const aiIds = normalizeBodyIds({ single: ['auction_id'] });

// Step 1: which photos belong to the same lot. Thumbnails only - small and
// cheap, since this pass only needs to tell items apart, not read maker marks.
app.post('/ai/group-photos', requireAdmin, LIMITS.ai, aiJson, aiIds, async (req, res) => {
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
        const groups = await aiLots.groupPhotos(thumbnails, undefined, aiUsageTracker(req));
        res.json({ groups, photo_count: thumbnails.length, lot_count: groups.length });
    } catch (e) {
        console.error('AI grouping failed:', e.message);
        res.status(502).json({ error: `AI grouping failed: ${e.message}` });
    }
});

// Step 2: catalogue one confirmed group. Higher-resolution images than step 1,
// because this pass reads labels, signatures and damage.
app.post('/ai/analyze-lot', requireAdmin, LIMITS.ai, aiJson, aiIds, async (req, res) => {
    const { images, condition } = req.body || {};
    if (!Array.isArray(images) || !images.length) {
        return res.status(400).json({ error: 'images array is required' });
    }
    try {
        const analysis = await aiLots.analyzeLot(images, condition || '', aiUsageTracker(req));
        res.json(analysis);
    } catch (e) {
        console.error('AI analysis failed:', e.message);
        res.status(502).json({ error: `AI analysis failed: ${e.message}` });
    }
});

// Step 2b: host corrected a wrong title and wants the body rewritten to match.
// Text-only - no photos, so it is fast and cheap.
app.post('/ai/regenerate-description', requireAdmin, LIMITS.ai, aiIds, async (req, res) => {
    const { title, condition } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title is required' });
    try {
        const result = await aiLots.regenerateDescription(title, condition || '', aiUsageTracker(req));
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
        // Live shows: no reserve (the lot always sells to the highest bidder), and the lot waits ('pending', no
        // clock) until the host offers it in the show.
        const live = auction.mode === 'live';
        if (live && lot.reserve_price != null && lot.reserve_price !== '') { failed.push({ index: i, title: lot.title, error: 'Live shows have no reserve price' }); continue; }
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
                status: live ? 'pending' : 'open',
                ends_at: live ? null : (lot.ends_at || null),
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
    if (error) return dbFailure(req, res, error);
    res.json(data || []);
});

app.post('/auction/:auctionId/items/:itemId/images', requireAuth, async (req, res) => {
    const { url, position } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const { data: auction } = await supabase.from('auctions').select('host_username').eq('id', req.params.auctionId).single();
    if (!auction || auction.host_username !== req.user.username) return res.status(403).json({ error: 'Not authorized' });
    // Hosting :auctionId says nothing about :itemId - the lot must actually be
    // in that auction, or any host could attach images to another host's lot.
    const { data: lot } = await supabase.from('auction_items').select('auction_id').eq('id', req.params.itemId).single();
    if (!lot || !lotBelongsToAuction(lot, req.params.auctionId)) return res.status(404).json({ error: 'Item not found' });
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

// Every photo is decoded and re-encoded here before it is stored (security
// review #13). The file used to be stored byte-for-byte, so a phone photo's EXIF
// - GPS included, often the host's home - went into the PUBLIC bucket whenever
// the browser hadn't stripped it, and any image/* was accepted (SVG too). Now:
// the real format is read from the bytes (never the header), only JPEG, PNG
// and WebP are accepted, EXIF orientation is applied, size is capped, and the
// output carries no metadata at all (sharp drops it unless asked to keep it).
const UPLOAD_TYPES = { jpeg: ['image/jpeg', 'jpg'], png: ['image/png', 'png'], webp: ['image/webp', 'webp'] };
const UPLOAD_MAX_EDGE = 2400;
async function reencodeUpload(buffer) {
  let meta;
  try { meta = await sharp(buffer, { limitInputPixels: 60e6 }).metadata(); } catch { return { error: 'That file is not an image we can read' }; }
  const type = UPLOAD_TYPES[meta.format];
  if (!type) return { error: 'Only JPEG, PNG or WebP images can be uploaded' };
  const img = sharp(buffer, { limitInputPixels: 60e6 }).rotate()
    .resize({ width: UPLOAD_MAX_EDGE, height: UPLOAD_MAX_EDGE, fit: 'inside', withoutEnlargement: true });
  const out = meta.format === 'png' ? img.png() : meta.format === 'webp' ? img.webp({ quality: 85 }) : img.jpeg({ quality: 85, mozjpeg: true });
  return { buffer: await out.toBuffer(), contentType: type[0], ext: type[1] };
}

// Thumbnails (F1a, migration v). Cards, rails, search results and the homepage
// collage show a small WebP instead of the full photo; the lot page keeps the
// full one. The recipe is in thumbs.js, shared with scripts/backfill-thumbs.js.
// Stores the thumbnail and records full URL -> thumbnail URL. Never throws: a
// photo without a thumbnail still works everywhere (the site falls back to the
// full photo), so a failure here is logged, not passed on to the upload.
async function storeThumb(fullPath, fullUrl, buffer) {
  try {
    const thumbPath = thumbPathFor(fullPath);
    const { error: upErr } = await supabase.storage.from('item-images')
      .upload(thumbPath, await makeThumb(buffer), { contentType: 'image/webp', upsert: true });
    if (upErr) { console.error('thumbnail upload failed:', upErr.message); return null; }
    const thumbUrl = supabase.storage.from('item-images').getPublicUrl(thumbPath).data.publicUrl;
    const { error } = await supabase.from('image_thumbs').upsert({ url: fullUrl, thumb_url: thumbUrl }, { onConflict: 'url' });
    if (error) {
      // Before migration v there is nowhere to record it: remove the orphan file.
      console.error('image_thumbs insert failed:', error.code, error.message);
      await supabase.storage.from('item-images').remove([thumbPath]);
      return null;
    }
    thumbCache.set(fullUrl, thumbUrl);
    return thumbUrl;
  } catch (e) {
    console.error('thumbnail failed:', e.message);
    return null;
  }
}

// full URL -> thumbnail URL, for everything that shows photos as cards. A URL
// with a thumbnail never changes it, so hits are cached for the life of the
// process; misses are asked again (the backfill may have added one since).
const thumbCache = new Map();
const THUMB_CACHE_MAX = 20000;
async function thumbsFor(urls) {
  const want = [...new Set(urls.filter(u => typeof u === 'string' && u && !thumbCache.has(u)))];
  for (let i = 0; i < want.length; i += 200) {
    const { data, error } = await supabase.from('image_thumbs').select('url, thumb_url').in('url', want.slice(i, i + 200));
    if (error) { if (error.code !== '42P01' && error.code !== 'PGRST205') console.error('image_thumbs read failed:', error.code, error.message); break; }
    for (const r of data || []) { if (thumbCache.size >= THUMB_CACHE_MAX) thumbCache.clear(); thumbCache.set(r.url, r.thumb_url); }
  }
  return u => (u && thumbCache.get(u)) || null;
}
// Adds thumb_url beside image_url on each row (null = none yet: show image_url).
async function withThumbs(rows) {
  if (!Array.isArray(rows)) return rows;
  const thumb = await thumbsFor(rows.map(r => r && r.image_url));
  return rows.map(r => (r ? { ...r, thumb_url: thumb(r.image_url) } : r));
}

app.post('/upload-image', requireAdmin, express.raw({ type: 'image/*', limit: '5mb' }), async (req, res) => {
  try {
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer) || !buffer.length) return res.status(400).json({ error: 'No image data' });
    const img = await reencodeUpload(buffer);
    if (img.error) return res.status(400).json({ error: img.error });
    const filePath = `items/${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${img.ext}`;
    const { error: upErr } = await supabase.storage
      .from('item-images')
      .upload(filePath, img.buffer, { contentType: img.contentType, upsert: false });
    if (upErr) { console.error('upload-image: storage upload failed:', upErr.message); return res.status(500).json({ error: 'Upload failed' }); }
    const { data: { publicUrl } } = supabase.storage.from('item-images').getPublicUrl(filePath);
    const thumbUrl = await storeThumb(filePath, publicUrl, img.buffer);
    res.json({ url: publicUrl, thumb_url: thumbUrl });
  } catch (err) {
    console.error('upload-image failed:', err.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

server.keepAliveTimeout = 61000; // keep connections open longer than Railway's proxy timeout
server.headersTimeout = 65000;

// Auto-close standard auction items when their ends_at passes
// Overlap guard. The job runs on setInterval(30s) and a tick can outlast its
// interval (200 lots closing means ~150 order creations and, at the end, one
// sequential Stripe call per buyer), so without this a second tick starts on
// top of the first. In-process only: it does not stop a second INSTANCE (a
// deploy overlap) - orders(item_id) being unique does that, at the database.
// A tick that has held the flag for over 10 minutes is presumed hung and is
// stepped over rather than blocking the job forever (same idea as the 5-minute
// charging_since reclaim).
let autoCloseRunningSince = 0
const AUTO_CLOSE_STALE_MS = 10 * 60 * 1000
// Ends one standard auction once every one of its lots is closed (sold or
// unsold), building and charging that auction's invoices first. Split out
// of autoCloseStandardItems's sweep so one auction can be driven at a time
// (by a test, or in principle by a future retry path) without touching
// every live auction in the database.
//
// Every SOLD lot must have its order inserted before invoices are built - a
// lot can be flipped to 'sold' here (making "no open items" true for a
// concurrent tick or a second instance) a moment before createOrderOnWin
// for it actually finishes over there. Building now would sum only the
// orders that exist yet, permanently undercharging that buyer: once this
// auction is 'ended', this function never runs for it again, so a
// late-arriving order is left with no invoice at all. Deferring costs
// nothing - "no open items" stays true next tick, so this function is
// simply called again.
async function maybeEndStandardAuction(auctionId) {
  const { data: openItems } = await supabase
    .from('auction_items')
    .select('id')
    .eq('auction_id', auctionId)
    .not('status', 'in', '("sold","unsold")')
  if (openItems?.length) return { ended: false }

  const { data: allItems } = await supabase
    .from('auction_items').select('id').eq('auction_id', auctionId)
  if (!allItems?.length) return { ended: false }

  const { data: soldItems } = await supabase
    .from('auction_items').select('id').eq('auction_id', auctionId).eq('status', 'sold')
  if (soldItems?.length) {
    const { data: coveredOrders } = await supabase
      .from('orders').select('item_id').eq('auction_id', auctionId).in('item_id', soldItems.map(i => i.id))
    const covered = new Set((coveredOrders || []).map(o => o.item_id))
    if (soldItems.some(i => !covered.has(i.id))) {
      console.log('Auto-close: deferring invoice build for auction', auctionId, '- a sold lot has no order yet')
      return { ended: false, deferred: true }
    }
  }

  try {
    await buildAndChargeInvoicesForAuction(auctionId)
  } catch (invErr) {
    console.error('buildAndChargeInvoicesForAuction failed for auction', auctionId, invErr.message)
  }
  // Unconditional: reached regardless of whether any invoice above charged
  // successfully, declined, or errored.
  await supabase.from('auctions').update({ status: 'ended' }).eq('id', auctionId)
  console.log('Auto-ended standard auction:', auctionId)
  return { ended: true }
}

// Recovery for security review #2. Before the fix, the live-mode timer could
// end a standard auction while lots were still open; those lots then sold with
// an order but no invoice, and nothing revisits an ended auction. This finds
// standard-lot orders with no invoice on an ENDED standard auction and bills
// them: one new invoice per buyer, charged like any other (auto: an unpaid
// invoice only) - but only when the auction's last lot closed within the last
// 24 hours. Anything older is reported to the admin and never charged
// automatically: a buyer shouldn't find a surprise charge days after the sale.
// A buyer who already has an invoice on that auction is also only reported:
// linking a late order onto an invoice that may already be charged would hide
// it as paid. Each report goes out once per process, not every tick.
const STRANDED_AUTO_CHARGE_MS = 24 * 60 * 60 * 1000
const strandedReported = new Set()
async function reportStranded(key, subject, lines) {
  if (strandedReported.has(key)) return
  strandedReported.add(key)
  console.error('UNBILLED ORDERS: ' + lines.join(' | '))
  await sendAdminEmail(subject, lines.join('\n'))
}
async function invoiceStrandedOrders() {
  const { data: stranded, error } = await supabase.from('orders')
    .select('id, auction_id, buyer_user_id, buyer_username, total_cents')
    .is('invoice_id', null).not('item_id', 'is', null).not('buyer_user_id', 'is', null)
  if (error) { console.error('invoiceStrandedOrders: failed to load orders:', error.message); return }
  if (!stranded?.length) return
  const { data: ended, error: endedErr } = await supabase.from('auctions').select('id')
    .in('id', [...new Set(stranded.map(o => o.auction_id))]).eq('mode', 'standard').eq('status', 'ended')
  if (endedErr) { console.error('invoiceStrandedOrders: failed to load auctions:', endedErr.message); return }
  const endedIds = new Set((ended || []).map(a => a.id))
  if (!endedIds.size) return
  // When selling actually stopped: the auction's last lot close.
  const { data: lots, error: lotsErr } = await supabase.from('auction_items').select('auction_id, ends_at').in('auction_id', [...endedIds])
  if (lotsErr) { console.error('invoiceStrandedOrders: failed to load lots:', lotsErr.message); return }
  const lastClose = {}
  for (const l of lots || []) {
    const t = l.ends_at ? Date.parse(l.ends_at) : NaN
    if (Number.isFinite(t) && !(lastClose[l.auction_id] >= t)) lastClose[l.auction_id] = t
  }
  const groups = new Map()
  for (const o of stranded) {
    if (!endedIds.has(o.auction_id)) continue
    const k = o.auction_id + '|' + o.buyer_user_id
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(o)
  }
  for (const [k, orders] of groups) {
    const { auction_id: auctionId, buyer_user_id: buyerUserId, buyer_username: buyerUsername } = orders[0]
    const summary = [`Auction: ${auctionId}`, `Buyer: ${buyerUsername}`, `Orders with no invoice: ${orders.map(o => o.id).join(', ')}`, `Total not billed: ${formatMoney(orders.reduce((n, o) => n + (o.total_cents || 0), 0))}`]
    const closed = lastClose[auctionId]
    if (!(Date.now() - closed <= STRANDED_AUTO_CHARGE_MS)) {
      await reportStranded(k, `Unbilled order(s) - ${buyerUsername}`, [...summary, `Last lot closed: ${closed ? new Date(closed).toISOString() : 'unknown'}`, 'Older than 24 hours: not charged automatically.'])
      continue
    }
    const { data: existing, error: exErr } = await supabase.from('invoices').select('id')
      .eq('auction_id', auctionId).eq('buyer_user_id', buyerUserId).maybeSingle()
    if (exErr) { console.error('invoiceStrandedOrders: invoice lookup failed:', auctionId, exErr.message); continue }
    if (existing) {
      await reportStranded(k, `Unbilled order(s) - ${buyerUsername}`, [...summary, `Existing invoice: ${existing.id}`, 'Not linked automatically: the existing invoice may already be charged.'])
      continue
    }
    const { data: inv, error: insErr } = await supabase.from('invoices')
      .insert({ auction_id: auctionId, buyer_user_id: buyerUserId, buyer_username: buyerUsername, total_cents: orders.reduce((n, o) => n + (o.total_cents || 0), 0) })
      .select('id').single()
    if (insErr) { console.error('invoiceStrandedOrders: invoice insert failed (another instance?):', auctionId, insErr.message); continue }
    await supabase.from('orders').update({ invoice_id: inv.id }).in('id', orders.map(o => o.id)).is('invoice_id', null)
    console.error(`Recovered unbilled orders: auction ${auctionId} buyer ${buyerUsername}, ${orders.length} order(s) -> invoice ${inv.id}`)
    await chargeInvoice(inv.id, { auto: true })
  }
}

async function autoCloseStandardItems() {
  if (autoCloseRunningSince && Date.now() - autoCloseRunningSince < AUTO_CLOSE_STALE_MS) return
  autoCloseRunningSince = Date.now()
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
    // Live-show lots have an ends_at too (their clock), but only the live hammer closes them (closeLiveLot): this
    // job leaves every lot of a live-mode auction alone, or there would be two closers again (audit finding 9).
    const { data: liveModeAuctions, error: liveModeErr } = await supabase.from('auctions').select('id').eq('mode', 'live')
    if (liveModeErr) { console.error('autoCloseStandardItems: failed to load live-mode auctions:', liveModeErr.message); return }
    const liveModeIds = new Set((liveModeAuctions || []).map(a => a.id))

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
        if (draftAuctionIds.has(item.auction_id) || liveModeIds.has(item.auction_id)) continue
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
        // closes. Live-show lots are skipped above (closeLiveLot charges them
        // per lot, at the hammer).
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

    for (const auction of liveAuctions || []) {
      await maybeEndStandardAuction(auction.id)
    }

    // Step 3: bill any orders an earlier bug left without an invoice.
    await invoiceStrandedOrders()

    // Step 4: watch-list reminders (F3). Never throws; does nothing before migration w.
    await runReminders()

    // Step 5: points expiry + reminders (G2). Hourly; never throws; does nothing with points off.
    await runPointsHousekeeping()

    // Step 6: live lots (G1): re-watch open ones, finish a hammer a crash interrupted; pre-bid expiry and the
    // after-show summaries (phase 1b). Never throws.
    await recoverLiveLots()
    await runLiveHousekeeping()
    await runLiveShowHousekeeping()
  } catch (e) {
    console.error('autoCloseStandardItems error:', e)
  } finally {
    autoCloseRunningSince = 0
  }
}
setInterval(autoCloseStandardItems, 30000)
autoCloseStandardItems()


// Last error handler: errors thrown before or inside a route (a body over the
// limit, malformed JSON, an unexpected throw) answer with a short JSON error
// instead of Express's default HTML page, which includes a stack trace
// whenever NODE_ENV isn't 'production'.
app.use((err, req, res, next) => {
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error('Unhandled route error:', req.method, req.path, err.message);
  if (res.headersSent) return next(err);
  res.status(status).json({ error: status === 413 ? 'Request too large' : status < 500 ? 'Bad request' : 'Something went wrong' });
});

// Backstop for #4: a rejected promise nobody awaited is logged, not fatal.
// (Uncaught synchronous exceptions still exit - that state can't be trusted.)
process.on('unhandledRejection', e => console.error('Unhandled rejection:', e && e.stack || e));

server.listen(PORT, async () => {
  console.log(`WhatTheFind Live server running on port ${PORT}`);
  await recoverLiveLots();
  initStorage();
});
