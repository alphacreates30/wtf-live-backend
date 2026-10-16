// Buyer points and promotions (G2, wtf-handoff POINTS_BRIEF.md). Migration 2026-10-15z.
//
// One function decides the discounts for a charge: discountsForCharge(). The timed-auction invoice uses it
// (buildAndChargeInvoicesForAuction -> applyInvoiceDiscount) and so does the live-show hammer charge (G1:
// closeLiveLot -> chargeLiveOrder -> applyOrderDiscount, scope 'lot', premiumCents 0). It never changes a bid: it
// returns what comes off the winning bids AFTER the win.
//
// Rules (Albert, Oct 15):
//   earn     points_per_dollar per whole $1 of winning bid, per lot, rounded down; credited when the payment succeeds
//   reward   every points_per_reward points = one reward_cents reward; at most ONE per invoice (per lot, live);
//            never more than the winning bids it comes off; applied only if the buyer's auto-apply is on
//   code     a % code entered before the event closes, off the winning bids; does not stack with a reward: the
//            bigger saving wins (a tie uses the code, so the buyer keeps their points)
//   premium  worked out on the lower amount: the premium saved is the discount's share of the premium charged
//   shipping free_shipping promo, or bundle_free_shipping when the buyer won 3+ lots in that event
//
// Points are on only when POINTS_ENABLED=true (Railway) AND points_settings.enabled (admin). Promotions follow the
// same POINTS_ENABLED switch (the whole rewards feature ships off).

const DEFAULTS = { enabled: false, points_per_dollar: 1, points_per_reward: 250, reward_cents: 2500, expiry_months: 12 };
const BUNDLE_MIN_LOTS = 3;
const SETTINGS_TTL_MS = 10 * 1000;

const envOn = () => process.env.POINTS_ENABLED === 'true';
// Postgres "relation/function/column does not exist" and PostgREST's schema-cache equivalents: migration z missing.
const notMigrated = e => ['PGRST202', 'PGRST204', 'PGRST205', '42883', '42703', '42P01'].includes(e?.code);

// ---- pure maths (no database, no clock): the suites check these directly ----

function pointsForHammer(hammerCents, settings) {
  return Math.max(0, Math.floor((Number(hammerCents) || 0) / 100)) * (settings.points_per_dollar ?? 1);
}

// The premium saved when `offCents` comes off `hammerCents` that carried `premiumCents`: the discount's share of the
// premium actually charged (equals offCents x rate for one rate, and can never exceed the premium charged).
function premiumSaved(offCents, hammerCents, premiumCents) {
  if (!(hammerCents > 0) || !(premiumCents > 0) || !(offCents > 0)) return 0;
  return Math.min(premiumCents, Math.round(offCents * premiumCents / hammerCents));
}

// The one discount for a charge. Inputs:
//   hammerCents, premiumCents  what the charge covers before any discount (live: premiumCents 0)
//   balance, autoApply         the buyer's points
//   code                       { promotion_id, percent } the buyer entered for this event, or null
//   settings                   points settings (effective enabled flag included)
// Returns { kind: 'points_reward'|'promo_code'|null, points, off_cents, premium_off_cents, promotion_id,
//           options: { reward_cents, code_cents } }   (options = both savings, so the buyer can be shown which won)
function decideDiscount({ hammerCents, premiumCents = 0, balance = 0, autoApply = true, code = null, settings }) {
  const none = { kind: null, points: 0, off_cents: 0, premium_off_cents: 0, promotion_id: null, options: { reward_cents: 0, code_cents: 0 } };
  if (!settings || !(hammerCents > 0)) return none;
  const rewardCents = settings.enabled && autoApply && balance >= settings.points_per_reward
    ? Math.min(settings.reward_cents, hammerCents) : 0;
  const codeCents = code && code.percent > 0 ? Math.min(hammerCents, Math.floor(hammerCents * code.percent / 100)) : 0;
  const options = { reward_cents: rewardCents, code_cents: codeCents };
  if (!rewardCents && !codeCents) return { ...none, options };
  if (codeCents >= rewardCents) {
    return { kind: 'promo_code', points: 0, off_cents: codeCents, premium_off_cents: premiumSaved(codeCents, hammerCents, premiumCents),
      promotion_id: code.promotion_id, options };
  }
  return { kind: 'points_reward', points: settings.points_per_reward, off_cents: rewardCents,
    premium_off_cents: premiumSaved(rewardCents, hammerCents, premiumCents), promotion_id: null, options };
}

// Is a promotion running for an event at a moment? (auction_id null = site-wide)
function promoApplies(p, auctionId, atMs) {
  if (!p || !p.active) return false;
  if (p.auction_id && p.auction_id !== auctionId) return false;
  const at = Number(atMs);
  return Date.parse(p.starts_at) <= at && at < Date.parse(p.ends_at);
}

// Free postage for a shipment? orders: [{ auction_id, created_at }] (created_at = when the lot was won);
// lotsWonBy: { [auction_id]: number of lots this buyer won in that event }. Every order in the box must qualify.
function shippingPromoFor(orders, promos, lotsWonBy) {
  if (!orders?.length || !promos?.length) return null;
  const reasonFor = o => {
    const at = Date.parse(o.created_at);
    const live = promos.filter(p => promoApplies(p, o.auction_id, at));
    if (live.some(p => p.kind === 'free_shipping')) return 'free_shipping';
    if (live.some(p => p.kind === 'bundle_free_shipping') && (lotsWonBy[o.auction_id] || 0) >= BUNDLE_MIN_LOTS) return 'bundle_free_shipping';
    return null;
  };
  const reasons = orders.map(reasonFor);
  if (reasons.some(r => !r)) return null;
  return reasons.includes('free_shipping') ? 'free_shipping' : 'bundle_free_shipping';
}

// Stripe can't charge between 1c and 49c. If a discount would leave such a total, those few cents come off too
// (returned as extra premium saved), so the invoice is $0 and nothing is charged.
const STRIPE_MIN_CENTS = 50;
function belowStripeMinimum(totalCents, d) {
  if (!d?.kind) return 0;
  const left = totalCents - d.off_cents - d.premium_off_cents;
  return left > 0 && left < STRIPE_MIN_CENTS ? left : 0;
}

function progress(balance, settings) {
  const per = settings.points_per_reward;
  const b = Math.max(0, balance);
  return { toward_next: b % per, per_reward: per, rewards_ready: Math.floor(b / per) };
}

function normaliseCode(v) {
  const c = String(v ?? '').trim().toUpperCase();
  return /^[A-Z0-9_-]{3,30}$/.test(c) ? c : null;
}

// ---- database helpers (supabase = the service-role client) ----

function makeRewards(supabase) {
  let cache = null; let cachedAt = 0;

  async function settings({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cachedAt < SETTINGS_TTL_MS) return cache;
    const { data, error } = await supabase.from('points_settings').select('*').eq('id', 1).maybeSingle();
    const s = { ...DEFAULTS, ...(data || {}) };
    s.migrated = !error || !notMigrated(error);
    if (error && !notMigrated(error)) console.error('points settings read failed:', error.message);
    s.enabled = envOn() && s.migrated && !error && !!data?.enabled;
    s.rewards_on = envOn() && s.migrated && !error;      // promotions: env switch + migration only
    cache = s; cachedAt = Date.now();
    return s;
  }
  function forget() { cache = null; }

  async function balanceOf(userId) {
    const { data, error } = await supabase.rpc('points_balance', { p_user_id: userId });
    if (error) throw error;
    return Number(data) || 0;
  }

  async function account(userId) {
    const { data, error } = await supabase.from('points_accounts').select('*').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data || { user_id: userId, auto_apply: true, last_win_at: null, created_at: null };
  }

  async function promosFor(auctionIds) {
    const ids = [...new Set(auctionIds)].filter(Boolean);
    let q = supabase.from('promotions').select('*').eq('active', true);
    q = ids.length ? q.or(`auction_id.is.null,auction_id.in.(${ids.join(',')})`) : q.is('auction_id', null);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  // The buyer's entered code for this event, if its promotion is still valid at `atMs`. On a timed auction the code
  // is used once, by the invoice. In a live show (reuse) it covers every lot the buyer wins in that show.
  async function enteredCode(userId, auctionId, atMs, { reuse = false } = {}) {
    const { data, error } = await supabase.from('promotion_uses').select('promotion_id, applied_at, invoice_id, promotions(*)')
      .eq('user_id', userId).eq('auction_id', auctionId).maybeSingle();
    if (error) throw error;
    if (!data || !data.promotions || (data.applied_at && !(reuse && !data.invoice_id))) return null;
    const p = data.promotions;
    if (p.kind !== 'percent_code' || !promoApplies(p, auctionId, atMs)) return null;
    return { promotion_id: p.id, percent: p.percent, code: p.code };
  }

  // THE shared decision for one charge (timed invoice now; live hammer charge in G1).
  //   scope 'invoice' | 'lot'; hammerCents/premiumCents = the charge before discounts; atMs = when the event closed
  //   (the code must have been valid then). Returns decideDiscount()'s result plus the settings used.
  async function discountsForCharge({ scope = 'invoice', userId, auctionId, hammerCents, premiumCents = 0, atMs = Date.now() }) {
    const s = await settings();
    if (!s.rewards_on) return { ...decideDiscount({ hammerCents: 0, settings: s }), settings: s };
    const [balance, acct, code] = await Promise.all([
      s.enabled ? balanceOf(userId) : 0,
      s.enabled ? account(userId) : { auto_apply: false },
      enteredCode(userId, auctionId, atMs, { reuse: scope === 'lot' }),
    ]);
    return { ...decideDiscount({ hammerCents, premiumCents, balance, autoApply: acct.auto_apply, code, settings: s }), settings: s };
  }

  // Decide and record an unpaid invoice's discount, once. Never throws; returns the kind applied (or null).
  async function applyInvoiceDiscount(invoiceId) {
    try {
      const s = await settings();
      if (!s.rewards_on) return null;
      const { data: inv, error } = await supabase.from('invoices').select('*').eq('id', invoiceId).maybeSingle();
      if (error || !inv || inv.discount_decided_at || inv.payment_status !== 'unpaid' || inv.payment_intent_id) return inv?.discount_kind || null;
      const { data: orders } = await supabase.from('orders').select('hammer_cents, premium_cents, created_at').eq('invoice_id', invoiceId);
      const hammer = (orders || []).reduce((t, o) => t + (o.hammer_cents || 0), 0);
      const premium = (orders || []).reduce((t, o) => t + (o.premium_cents || 0), 0);
      const closedAt = Math.max(...(orders || []).map(o => Date.parse(o.created_at) || 0), 0) || Date.now();
      await supabase.from('invoices').update({ hammer_cents: hammer }).eq('id', invoiceId).is('discount_decided_at', null);
      let d = await discountsForCharge({ userId: inv.buyer_user_id, auctionId: inv.auction_id, hammerCents: hammer, premiumCents: premium, atMs: closedAt });
      for (let attempt = 0; attempt < 3; attempt++) {
        d = { ...d, premium_off_cents: d.premium_off_cents + belowStripeMinimum(inv.total_cents, d) };
        const { data: result, error: rpcErr } = await supabase.rpc('apply_invoice_discount', {
          p_invoice_id: invoiceId, p_kind: d.kind || 'none', p_points: d.points, p_discount_cents: d.off_cents,
          p_premium_cents: d.premium_off_cents, p_promotion_id: d.promotion_id,
        });
        if (rpcErr) { console.error('apply_invoice_discount failed:', invoiceId, rpcErr.message); return null; }
        if (result !== 'insufficient') return String(result).replace(/^already:/, '') === 'none' ? null : String(result).replace(/^already:/, '');
        // The balance (or the code) changed under us - another invoice spent it. Decide again without that option.
        d = d.kind === 'points_reward'
          ? decideDiscount({ hammerCents: hammer, premiumCents: premium, balance: 0, code: await enteredCode(inv.buyer_user_id, inv.auction_id, closedAt), settings: s })
          : decideDiscount({ hammerCents: 0, settings: s });
      }
      return null;
    } catch (e) {
      console.error('applyInvoiceDiscount error:', invoiceId, e.message);
      return null;
    }
  }

  // A live lot's discount, decided once before its charge (G1 hammer). Same rules as an invoice, per lot: at most one
  // reward per lot, or the show's % code (the bigger saving), never below $0, never 1-49c left. Never throws; returns
  // the kind applied (or null).
  async function applyOrderDiscount(orderId) {
    try {
      const s = await settings();
      if (!s.rewards_on) return null;
      const { data: o, error } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
      if (error) { if (!notMigrated(error)) console.error('applyOrderDiscount read failed:', orderId, error.message); return null; }
      if (!o || o.discount_decided_at || o.invoice_id || o.payment_intent_id || (o.payment_status || 'unpaid') !== 'unpaid') return o?.discount_kind || null;
      const atMs = Date.parse(o.created_at) || Date.now();
      const premium = o.premium_cents || 0;
      let d = await discountsForCharge({ scope: 'lot', userId: o.buyer_user_id, auctionId: o.auction_id, hammerCents: o.hammer_cents, premiumCents: premium, atMs });
      for (let attempt = 0; attempt < 3; attempt++) {
        const off = d.kind ? d.off_cents + d.premium_off_cents + belowStripeMinimum(o.total_cents, d) : 0;
        const { data: result, error: rpcErr } = await supabase.rpc('apply_order_discount', {
          p_order_id: orderId, p_kind: d.kind || 'none', p_points: d.points, p_discount_cents: off, p_promotion_id: d.promotion_id,
        });
        if (rpcErr) { if (!notMigrated(rpcErr)) console.error('apply_order_discount failed:', orderId, rpcErr.message); return null; }
        if (result !== 'insufficient') { const k = String(result).replace(/^already:/, ''); return k === 'none' || k === 'not_unpaid' ? null : k; }
        d = d.kind === 'points_reward'
          ? decideDiscount({ hammerCents: o.hammer_cents, premiumCents: premium, balance: 0, code: await enteredCode(o.buyer_user_id, o.auction_id, atMs, { reuse: true }), settings: s })
          : decideDiscount({ hammerCents: 0, settings: s });
      }
      return null;
    } catch (e) {
      console.error('applyOrderDiscount error:', orderId, e.message);
      return null;
    }
  }

  // Credit each paid order's points. Never throws. Returns the total credited now.
  async function earnForOrders(orders) {
    try {
      const s = await settings();
      if (!s.enabled) return 0;
      let total = 0;
      for (const o of orders || []) {
        if (!o.buyer_user_id) continue;
        const pts = pointsForHammer(o.hammer_cents, s);
        const { data, error } = await supabase.rpc('points_earn', { p_user_id: o.buyer_user_id, p_order_id: o.id, p_points: pts });
        if (error) { console.error('points_earn failed:', o.id, error.message); continue; }
        total += Number(data) || 0;
      }
      return total;
    } catch (e) {
      console.error('earnForOrders error:', e.message);
      return 0;
    }
  }

  // Refund/cancellation: take back the points of these orders. Returns [{ order_id, shortfall }] for the admin.
  async function reverseForOrders(orderIds, note) {
    const out = [];
    for (const id of orderIds || []) {
      const { data, error } = await supabase.rpc('points_reverse', { p_order_id: id, p_note: note || null });
      if (error) { if (!notMigrated(error)) console.error('points_reverse failed:', id, error.message); continue; }
      if (Number(data) >= 0) out.push({ order_id: id, shortfall: Number(data) });
    }
    return out;
  }

  // For emails and screens: what these orders earned, and the balance now.
  async function summaryFor(userId, orderIds) {
    const s = await settings();
    if (!s.enabled) return null;
    const { data: rows } = await supabase.from('points_ledger').select('points').eq('kind', 'earn').in('order_id', orderIds || []);
    const earned = (rows || []).reduce((t, r) => t + r.points, 0);
    const balance = await balanceOf(userId);
    return { earned, balance, ...progress(balance, s), reward_cents: s.reward_cents };
  }

  return { settings, forget, balanceOf, account, promosFor, enteredCode, discountsForCharge, applyInvoiceDiscount,
    applyOrderDiscount, earnForOrders, reverseForOrders, summaryFor };
}

module.exports = {
  DEFAULTS, BUNDLE_MIN_LOTS, notMigrated, envOn,
  pointsForHammer, premiumSaved, decideDiscount, promoApplies, shippingPromoFor, progress, normaliseCode, belowStripeMinimum,
  makeRewards,
};
