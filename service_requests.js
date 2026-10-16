// Service requests (F5, wtf-handoff SERVICES_BRIEF.md, migration zc): the one form behind the Services pages
// (Sell to us, Consign, Estate buyouts, Collection auctions) and the Contact page. Contracts in API.md.
//
// Private by design: contact details and photos are never public. The table is service_role only (RLS on); the
// photos go to the PRIVATE bucket 'service-request-photos', re-encoded first (no EXIF/GPS, like lot photos), and the
// admin sees them through signed links that last 10 minutes. Deleting a request removes its photos.
// Spam: a honeypot field (a bot that fills it gets the normal answer and nothing is stored), 5 requests an hour per
// IP, at most 10 photos of 8 MB each (JPEG, PNG or WebP only, read from the bytes).
const multer = require('multer');

const SERVICES = {
  sell: 'Sell to us',
  consign: 'Consign',
  estates: 'Estate buyouts',
  collection_auction: 'Collection auctions',
  general: 'General question',
};
const ITEM_COUNTS = { '1': '1', '2-10': '2 to 10', '11-25': '11 to 25', '26-100': '26 to 100', '100+': 'More than 100' };
const STATUSES = ['new', 'contacted', 'offer_made', 'closed'];
const BUCKET = 'service-request-photos';
const MAX_PHOTOS = 10;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;   // as sent; stored re-encoded (the bucket allows 5 MB)
const STORED_MAX_BYTES = 5 * 1024 * 1024;
const SIGNED_URL_SECONDS = 600;
const LIST_MAX = 200;
const THANKS = { ok: true, message: "Thanks, we'll be in touch within 72 hours." };
const NOT_AVAILABLE = { error: "The request form isn't open yet. Please email us instead.", code: 'not_available' };

// Before migration zc the table (and the bucket) don't exist.
const missing = e => !!e && ['42P01', 'PGRST205'].includes(e.code);

// A real US number, stored as its 10 digits: an optional leading 1, then NANP rules (area code and exchange don't
// start with 0 or 1; no N11 area code like 911; not the fictional 555-01xx range).
function cleanUsPhone(v) {
  if (typeof v !== 'string' || v.length > 30) return null;
  let d = v.replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(d)) return null;
  if (d.slice(1, 3) === '11') return null;
  if (d.slice(3, 6) === '555' && d.slice(6, 8) === '01') return null;
  return d;
}
const formatPhone = d => (d && d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d || '');

// A trimmed string of at most max characters, '' if absent; null if it is too long (or not a string).
function text(v, max) {
  if (v == null) return '';
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > max ? null : t;
}

module.exports = function registerServiceRequests(app, d) {
  const { supabase, requireAdmin, dbFailure, limiter, canonicalUuid, cleanEmail, reencodeUpload, sendEmail, emailHtml,
    escapeHtml, BUYER_FROM, ADMIN_FROM, SITE_URL, INBOX } = d;

  const sendLimit = limiter({ windowMs: 60 * 60e3, limit: 10, message: "Too many requests from here. Try again later, or email us." });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { files: MAX_PHOTOS, fileSize: MAX_PHOTO_BYTES, fields: 20, fieldSize: 8000, parts: MAX_PHOTOS + 20 },
  }).array('photos', MAX_PHOTOS);
  function parseForm(req, res, next) {
    upload(req, res, err => {
      if (!err) return next();
      const tooMany = err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE';
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each photo must be under 8 MB.' : tooMany ? 'You can send up to 10 photos.' : 'That form could not be read. Please try again.';
      res.status(400).json({ error: msg, code: 'bad_upload' });
    });
  }

  // What the form sent, checked. Returns { row } or { error, field }.
  function validate(b) {
    const service = typeof b.service === 'string' && SERVICES[b.service] ? b.service : null;
    if (!service) return { error: 'Choose what you need help with.', field: 'service' };
    const name = text(b.name, 120);
    if (!name) return { error: 'Enter your name.', field: 'name' };
    const email = cleanEmail(b.email);
    if (!email) return { error: 'Enter a valid email address.', field: 'email' };
    const phone = cleanUsPhone(b.phone);
    if (!phone) return { error: 'Enter a valid US phone number, with the area code.', field: 'phone' };
    const location = text(b.location, 120);
    if (location === null) return { error: 'City or ZIP is too long.', field: 'location' };
    const details = text(b.details, 4000);
    if (!details) return { error: details === null ? 'Please keep this under 4,000 characters.' : 'Tell us a little about what you have.', field: 'details' };
    const itemCount = b.item_count ? (ITEM_COUNTS[b.item_count] ? b.item_count : undefined) : null;
    if (itemCount === undefined) return { error: 'Choose roughly how many items.', field: 'item_count' };
    const heard = text(b.heard_from, 200);
    if (heard === null) return { error: 'Please keep this under 200 characters.', field: 'heard_from' };
    return { row: { service, name, email, phone, location: location || null, details, item_count: itemCount, heard_from: heard || null } };
  }

  app.post('/service-requests', sendLimit, parseForm, async (req, res) => {
    const b = req.body || {};
    // Honeypot: a field people never see. A bot that fills it gets the normal answer; nothing is stored or sent.
    if (b.website) return res.json(THANKS);
    const v = validate(b);
    if (v.error) return res.status(400).json({ error: v.error, field: v.field, code: 'invalid' });

    const { error: probe } = await supabase.from('service_requests').select('id').limit(1);
    if (missing(probe)) return res.status(503).json(NOT_AVAILABLE);
    if (probe) return dbFailure(req, res, probe);

    // Every photo is read from its bytes and re-encoded (no metadata) before anything is stored.
    const files = req.files || [];
    const photos = [];
    for (let i = 0; i < files.length; i++) {
      const img = await reencodeUpload(files[i].buffer);
      if (img.error) return res.status(400).json({ error: `Photo ${i + 1}: ${img.error}.`, field: 'photos', code: 'invalid' });
      if (img.buffer.length > STORED_MAX_BYTES) return res.status(400).json({ error: `Photo ${i + 1} is too large. Try a smaller photo.`, field: 'photos', code: 'invalid' });
      photos.push(img);
    }

    const id = require('crypto').randomUUID();
    const paths = [];
    const removeStored = () => (paths.length ? supabase.storage.from(BUCKET).remove(paths) : null);
    for (let i = 0; i < photos.length; i++) {
      const path = `${id}/${i + 1}-${require('crypto').randomBytes(6).toString('hex')}.${photos[i].ext}`;
      const { error } = await supabase.storage.from(BUCKET).upload(path, photos[i].buffer, { contentType: photos[i].contentType, upsert: false });
      if (error) {
        console.error('service request photo upload failed:', error.message);
        await removeStored();
        return res.status(500).json({ error: "Your photos couldn't be uploaded. Please try again." });
      }
      paths.push(path);
    }

    const { error } = await supabase.from('service_requests').insert({ id, ...v.row, photo_paths: paths });
    if (error) {
      await removeStored();
      if (missing(error)) return res.status(503).json(NOT_AVAILABLE);
      return dbFailure(req, res, error);
    }
    console.log(`Service request ${id}: ${v.row.service}, ${paths.length} photo(s)`);
    res.json(THANKS);
    notify(id, v.row, paths.length);   // never throws; the request is stored whatever happens to the emails
  });

  // Albert gets the details (reply goes straight to the sender) and a link to Admin -> Requests, where the photos
  // are (signed links expire, so none in the email). The sender gets a short confirmation that repeats none of what
  // they typed, so the form can't be used to send someone else our email with words of the sender's choosing.
  async function notify(id, r, photoCount) {
    try {
      const rows = [
        ['Service', SERVICES[r.service]], ['Name', r.name], ['Email', r.email], ['Phone', formatPhone(r.phone)],
        ['City / ZIP', r.location], ['How many items', r.item_count ? ITEM_COUNTS[r.item_count] : ''], ['Heard about us', r.heard_from],
        ['Photos', photoCount ? `${photoCount} (in Admin, Requests)` : 'None'],
      ].filter(([, val]) => val).map(([k, val]) => `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top;">${k}</td><td style="padding:4px 0;">${escapeHtml(val)}</td></tr>`).join('');
      await sendEmail({ from: ADMIN_FROM, to: INBOX, replyTo: r.email, subject: `New request: ${SERVICES[r.service]} from ${r.name}`.slice(0, 200), kind: 'service_request',
        html: emailHtml(`New request: ${escapeHtml(SERVICES[r.service])}`, `
          <table style="border-collapse:collapse;margin:0 0 16px;">${rows}</table>
          <p style="margin:0 0 4px;color:#555;">What they have:</p>
          <p style="margin:0 0 16px;white-space:pre-wrap;">${escapeHtml(r.details)}</p>
          <p><a href="${SITE_URL}/host/requests?id=${id}" style="background:#1a1a1a;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;">Open in Requests</a></p>
          <p style="margin:16px 0 0;color:#555;">Reply to this email to answer them directly.</p>`) });
      await sendEmail({ from: BUYER_FROM, to: r.email, subject: 'We got your request', kind: 'service_request',
        html: emailHtml('We got your request', `
          <p>Thanks for getting in touch about <strong>${escapeHtml(SERVICES[r.service])}</strong>. We'll be in touch within 72 hours.</p>
          <p style="margin:16px 0 0;">If you didn't send this, you can ignore this email.</p>`) });
    } catch (e) {
      console.error('service request emails failed:', id, e.message);
    }
  }

  // ---- Admin -> Requests ----
  async function withPhotos(rows) {
    const paths = rows.flatMap(r => r.photo_paths || []);
    const urls = new Map();
    for (let i = 0; i < paths.length; i += 100) {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(paths.slice(i, i + 100), SIGNED_URL_SECONDS);
      if (error) { console.error('service request signed urls failed:', error.message); break; }
      for (const s of data || []) if (s.signedUrl) urls.set(s.path, s.signedUrl);
    }
    return rows.map(({ photo_paths, ...r }) => ({ ...r, phone_display: formatPhone(r.phone), service_label: SERVICES[r.service] || r.service,
      photos: (photo_paths || []).map(p => ({ path: p, url: urls.get(p) || null })) }));
  }

  // ?service=sell|consign|estates|collection_auction|general  ?status=new|contacted|offer_made|closed  ?id=<one>
  app.get('/admin/service-requests', requireAdmin, async (req, res) => {
    let q = supabase.from('service_requests').select('*').order('created_at', { ascending: false }).limit(LIST_MAX);
    if (req.query.service) {
      if (!SERVICES[req.query.service]) return res.status(400).json({ error: 'Unknown service' });
      q = q.eq('service', req.query.service);
    }
    if (req.query.status) {
      if (!STATUSES.includes(req.query.status)) return res.status(400).json({ error: 'Unknown status' });
      q = q.eq('status', req.query.status);
    }
    if (req.query.id) {
      const id = canonicalUuid(req.query.id);
      if (!id) return res.status(400).json({ error: 'Bad id' });
      q = q.eq('id', id);
    }
    const { data, error } = await q;
    if (missing(error)) return res.json({ available: false, requests: [], new_count: 0 });
    if (error) return dbFailure(req, res, error);
    const { count } = await supabase.from('service_requests').select('id', { count: 'exact', head: true }).eq('status', 'new');
    res.json({ available: true, requests: await withPhotos(data || []), new_count: count || 0, services: SERVICES, statuses: STATUSES, item_counts: ITEM_COUNTS });
  });

  // The count of New, for the admin home and the nav.
  app.get('/admin/service-requests/summary', requireAdmin, async (req, res) => {
    const { count, error } = await supabase.from('service_requests').select('id', { count: 'exact', head: true }).eq('status', 'new');
    if (missing(error)) return res.json({ available: false, new_count: 0 });
    if (error) return dbFailure(req, res, error);
    res.json({ available: true, new_count: count || 0 });
  });

  // { status?, notes? }
  app.patch('/admin/service-requests/:id', requireAdmin, async (req, res) => {
    const id = canonicalUuid(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad id' });
    const patch = {};
    if (req.body?.status !== undefined) {
      if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Status must be new, contacted, offer_made or closed' });
      patch.status = req.body.status;
    }
    if (req.body?.notes !== undefined) {
      const notes = req.body.notes === null ? '' : text(req.body.notes, 4000);
      if (notes === null) return res.status(400).json({ error: 'Notes must be under 4,000 characters' });
      patch.notes = notes || null;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change' });
    const { data, error } = await supabase.from('service_requests').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select('*');
    if (error) return dbFailure(req, res, error);
    if (!data?.length) return res.status(404).json({ error: 'Request not found' });
    res.json((await withPhotos(data))[0]);
  });

  // Deleting a request removes its photos first; if they can't be removed, the request stays (no orphan photos).
  app.delete('/admin/service-requests/:id', requireAdmin, async (req, res) => {
    const id = canonicalUuid(req.params.id);
    if (!id) return res.status(400).json({ error: 'Bad id' });
    const { data: row, error } = await supabase.from('service_requests').select('id, photo_paths').eq('id', id).maybeSingle();
    if (error) return dbFailure(req, res, error);
    if (!row) return res.status(404).json({ error: 'Request not found' });
    if (row.photo_paths?.length) {
      const { error: rmErr } = await supabase.storage.from(BUCKET).remove(row.photo_paths);
      if (rmErr) { console.error('service request photos not removed:', id, rmErr.message); return res.status(500).json({ error: "The photos couldn't be removed, so the request was kept. Try again." }); }
    }
    const { error: delErr } = await supabase.from('service_requests').delete().eq('id', id);
    if (delErr) return dbFailure(req, res, delErr);
    res.status(204).send();
  });
};
module.exports.cleanUsPhone = cleanUsPhone;
module.exports.SERVICES = SERVICES;
