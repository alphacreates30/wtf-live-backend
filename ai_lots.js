// ---------------------------------------------------------------------------
// AI lot creation for standard auctions.
//
// Two Claude vision steps, kept deliberately separate:
//   1. groupPhotos()  - cheap pass over small thumbnails, decides which photos
//                       belong to the same physical lot. Nothing is saved.
//   2. analyzeLot()   - one call per confirmed group, writes the title and
//                       description that buyers actually read.
//
// Plus regenerateDescription(), a text-only pass for when the host corrects a
// wrong title and wants the body to stop describing the wrong object.
//
// The host always reviews groupings before anything is created, so a wrong
// guess in step 1 costs a drag-and-drop, not a broken lot.
// ---------------------------------------------------------------------------

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-5';

let _client = null;
function client() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  }
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// Anthropic caps a single request at 100 images. Accuracy degrades well before
// that ceiling though - large batches start losing track of items that aren't
// anywhere near a chunk boundary. 50 keeps a safety margin and trades a few
// extra sequential calls on big batches for grouping we can trust.
const GROUPING_CHUNK_SIZE = 50;

// Soft cap per batch. Not an API limit (we chunk internally) - purely to keep
// the review grid usable and the bill predictable.
const PHOTO_SOFT_CAP = 800;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const GROUPING_SYSTEM_PROMPT = `You are helping an auction house sort a batch of
photos into distinct lots before the lots are created. The photos were taken in
upload order, and sellers usually photograph one lot in a short burst (the item
from a few angles, its box, a maker's mark or label, a close-up of damage)
before moving on to the next lot - so a change in the object shown, the
background/surface, or hand positioning often marks the start of a new lot.
Photos of the SAME lot can still look very different (different angles,
lighting, zoom, with vs. without packaging), so judge by whether the photos
belong to the same LOT, not by how similar the pixels look.

CRITICAL RULE ABOUT BOXES AND PACKAGING: a photo of an item's original box or
packaging (the box alone, the item beside or inside its box, a label on the
box, the foam insert) belongs to THAT SAME LOT, never its own separate lot,
even though a box and the object inside it look completely different. This is
the single most common mistake. Do not split an item's photos from its own
box's photos. A box photo almost always belongs with whichever item's photos
are immediately adjacent to it in upload order.

CRITICAL RULE ABOUT GROUPED LOTS: estate and collection auctions often sell
several objects together as one lot (a box of assorted tools, a shelf of
glassware, a stack of records). If a photo shows multiple objects arranged
together as a single offering, that is ONE lot, not one lot per object.

WATCH FOR SPLIT BURSTS: sometimes a packaging photo lands in the middle of a
burst rather than at its edge, making one lot look like two short bursts. It is
still ONE lot. Before finalizing, check every pair of consecutive groups: if
the group before and the group after show the same object, same surface, and
same lighting, merge them. When genuinely torn between merging two adjacent
groups or keeping them separate, MERGE - an unnecessary split creates a
duplicate, broken lot, which costs the auction more than one lot carrying a
couple of extra photos.

You will be shown each photo labeled with its index (Photo 0, Photo 1, ...).
Respond with ONLY a single JSON object, no markdown fences and no commentary:

{"groups": [[0, 1, 2], [3, 4]]}

Rules:
- Every photo index from 0 to N-1 must appear in exactly one group.
- A group may be a single photo if a lot only has one photo.
- Order groups in the sequence the lots first appear.
- If genuinely unsure whether two adjacent photos are the same lot, make your
  best guess. The host reviews and fixes groupings before anything is created,
  so a wrong guess is cheap - but leaving an index out of the JSON entirely
  is not.`;

const ANALYSIS_SYSTEM_PROMPT = `You are an experienced auction cataloguer writing
lot listings for an online estate and collectibles auction. You will be shown
photos of a single lot. Study them closely - maker's marks, signatures, labels,
stamps, materials, patterns, wear and damage - and respond with ONLY a single
JSON object, no markdown fences and no commentary, with exactly these fields:

{
  "title": "the lot title - see TITLE RULES below",
  "description": "2-4 sentences of plain text (no HTML, no bullet points) describing what the lot is, what stands out about it, and anything a bidder would want to know. Factual and specific. Do not invent provenance, do not estimate value, and do not restate the condition grade - condition is handled separately.",
  "category": "a short category, e.g. Furniture, Jewelry, Fine Art, Glassware, Tools, Toys, Books, Textiles, Electronics, Collectibles",
  "item_type": "short generic type, e.g. 'Cast Iron Skillet'",
  "brand": "maker, manufacturer, artist or marque if identifiable, else empty string",
  "model_or_style": "model, pattern, character, edition or style if identifiable, else empty string",
  "material": "primary material if identifiable, else empty string",
  "color": "primary colour(s)",
  "dimensions": "approximate size if it can be judged from the photos or a visible label, else empty string",
  "notable_features": ["short phrase", "short phrase"],
  "visible_flaws": ["short phrase describing each visible chip, crack, stain, repair, missing part or wear - empty list only if you genuinely see none"],
  "estimated_value_usd": "your rough retail/resale estimate for the whole lot as a plain number, or empty string if you have no basis for one. This guides the host's reserve - it is NOT the starting bid.",
  "confidence": "high | medium | low - your confidence in the identification"
}

Be honest. If you cannot identify a maker or pattern, leave the field empty
rather than guessing. Bidders rely on this being accurate, and an invented
attribution is far worse than an absent one.

FLAWS MATTER MORE HERE THAN ANYWHERE ELSE. These lots are usually collected in
person, and an undisclosed chip becomes an argument at pickup. Report every
flaw you can actually see. Do not soften them and do not speculate about
damage you cannot see.

TITLE RULES:
1. Front-load what a bidder searches for: Maker/Brand, then Item Type, then the
   single most identifying attribute (pattern, character, model, era), then
   secondary attributes (material, colour, size).
2. Keep it under 80 characters. Use the space for real, accurate attributes -
   do not pad.
3. If the lot contains multiple pieces, lead with the count, e.g.
   "Lot of 6 Cut Crystal Wine Glasses".
4. No filler or hype: no "L@@K", "WOW", "MUST SEE", "HTF", emoji, excessive
   punctuation or ALL-CAPS words. "Rare" only for a documented limited or
   numbered edition.
5. Do not repeat a keyword. Do not use quotation marks.
6. Title Case - capitalize each significant word.
7. Do not put the condition grade in the title. It is shown separately.`;

const CORRECTION_SYSTEM_PROMPT = `An auction lot was catalogued incorrectly - this
happens with obscure or unmarked pieces - and the host has corrected the title
to what the lot actually is. You do not have photos. Work only from the
corrected title and your own knowledge. Respond with ONLY a single JSON object,
no markdown fences and no commentary:

{
  "title": "the corrected title, lightly cleaned up if needed - never change what item it identifies",
  "description": "2-4 sentences of plain text describing what the lot actually is, based on the corrected identification. No HTML, no bullets, no condition grade, no value estimate.",
  "category": "short category",
  "item_type": "short generic type",
  "brand": "maker if known from the title or your knowledge, else empty string",
  "model_or_style": "model/pattern/character/edition if known, else empty string",
  "material": "if known, else empty string",
  "notable_features": ["short phrase"],
  "confidence": "high | medium | low"
}

Be honest: if you do not actually recognize this item from the title alone,
leave fields sparse rather than inventing plausible detail. Never contradict
the corrected title - it reflects what the host has confirmed the lot is.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Marks the system prompt as cacheable. These prompts are long and identical on
// every call in a batch, so caching cuts both latency and cost substantially.
function cacheableSystem(text) {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

// Accepts either a bare base64 string or a full data URL and returns the parts
// the Messages API wants.
function toImageBlock(raw) {
  let mediaType = 'image/jpeg';
  let data = raw;
  const m = /^data:([^;]+);base64,(.*)$/s.exec(raw || '');
  if (m) { mediaType = m[1]; data = m[2]; }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

function textOf(response) {
  return (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

// Models sometimes wrap JSON in prose or fences despite instructions. Pull out
// the first balanced JSON object rather than failing on a stray sentence.
function extractJson(text) {
  if (!text) throw new Error('Empty response');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start === -1) throw new Error('No JSON object in response');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const c = body[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return JSON.parse(body.slice(start, i + 1)); }
  }
  throw new Error('Unterminated JSON object in response');
}

// Guarantees every photo index appears exactly once. A malformed or partial
// model response must never silently drop a photo - missing indices become
// their own single-photo lots, which is visible and fixable in the review grid.
function repairGroups(groups, n) {
  const seen = new Set();
  const clean = [];
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!Array.isArray(g)) continue;
    const kept = [];
    for (const rawIdx of g) {
      const idx = Number(rawIdx);
      if (!Number.isInteger(idx) || idx < 0 || idx >= n || seen.has(idx)) continue;
      seen.add(idx);
      kept.push(idx);
    }
    if (kept.length) clean.push(kept);
  }
  for (let i = 0; i < n; i++) if (!seen.has(i)) clean.push([i]);
  return clean;
}

// ---------------------------------------------------------------------------
// 1. Grouping
// ---------------------------------------------------------------------------

async function groupPhotosSingleCall(thumbs) {
  const content = [];
  thumbs.forEach((t, i) => {
    content.push({ type: 'text', text: `Photo ${i}:` });
    content.push(toImageBlock(t));
  });
  content.push({
    type: 'text',
    text: `Group these ${thumbs.length} photos into lots and return the JSON object described in your instructions.`,
  });

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 4000,
    system: cacheableSystem(GROUPING_SYSTEM_PROMPT),
    messages: [{ role: 'user', content }],
  });

  let groups;
  try {
    groups = extractJson(textOf(response)).groups;
  } catch (e) {
    // Log the raw text so a parsing failure is diagnosable rather than silent.
    console.error('Grouping parse failed:', e.message, '| raw:', textOf(response).slice(0, 400));
    groups = [];
  }
  return repairGroups(groups, thumbs.length);
}

/**
 * thumbs: array of small downscaled JPEG thumbnails (data URLs or bare base64),
 * one per photo, in upload order.
 *
 * Batches over GROUPING_CHUNK_SIZE are split into sequential calls and stitched
 * back together with indices remapped to whole-batch numbering. A lot whose
 * photos straddle a chunk boundary comes back as two groups - rare, and the
 * host can merge them in the review grid.
 *
 * Returns [[0,1,2],[3,4]] with every index appearing exactly once.
 */
async function groupPhotos(thumbs, chunkSize = GROUPING_CHUNK_SIZE) {
  if (!thumbs || !thumbs.length) return [];
  if (thumbs.length <= chunkSize) return groupPhotosSingleCall(thumbs);

  const groups = [];
  for (let start = 0; start < thumbs.length; start += chunkSize) {
    const chunk = thumbs.slice(start, start + chunkSize);
    const chunkGroups = await groupPhotosSingleCall(chunk);
    for (const g of chunkGroups) groups.push(g.map(i => start + i));
  }
  return groups;
}

// ---------------------------------------------------------------------------
// 2. Per-lot analysis
// ---------------------------------------------------------------------------

/**
 * images:    array of base64 images (data URL or bare) for ONE lot.
 * condition: host-entered condition, e.g. "Good - minor wear".
 *
 * Every lot is a single listing. Where the photos show several objects sold
 * together (a box of tools, a set of glasses), TITLE RULE 3 still has the
 * model lead the title with the count - it reads that off the photos rather
 * than being told.
 */
async function analyzeLot(images, condition = '') {
  if (!images || !images.length) throw new Error('No images provided to analyze.');

  const content = images.map(toImageBlock);
  let prompt = 'Catalogue this lot and return the JSON object described in your instructions.';
  if (condition) {
    prompt += `\n\nHost's condition grade (context only - do not restate it in the description): ${condition}`;
  }
  content.push({ type: 'text', text: prompt });

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 1500,
    system: cacheableSystem(ANALYSIS_SYSTEM_PROMPT),
    messages: [{ role: 'user', content }],
  });

  const raw = textOf(response);
  try {
    const parsed = extractJson(raw);
    parsed.raw_text = raw;
    return parsed;
  } catch (e) {
    // Return a usable shell so the host can fix it by hand rather than losing
    // the whole batch to one bad response.
    console.error('Analysis parse failed:', e.message);
    return {
      title: '', description: raw.slice(0, 500), category: '', item_type: '',
      brand: '', model_or_style: '', material: '', color: '', dimensions: '',
      notable_features: [], visible_flaws: [], estimated_value_usd: '',
      confidence: 'low', raw_text: raw, parse_failed: true,
    };
  }
}

// ---------------------------------------------------------------------------
// 3. Description regeneration from a corrected title
// ---------------------------------------------------------------------------

async function regenerateDescription(correctedTitle, condition = '') {
  if (!correctedTitle) throw new Error('A corrected title is required.');

  let prompt = `The corrected lot title is: ${correctedTitle}`;
  if (condition) prompt += `\n\nHost's condition grade (context only - do not restate it): ${condition}`;

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: cacheableSystem(CORRECTION_SYSTEM_PROMPT),
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  });

  const raw = textOf(response);
  try {
    const parsed = extractJson(raw);
    parsed.raw_text = raw;
    return parsed;
  } catch (e) {
    console.error('Regeneration parse failed:', e.message);
    return { title: correctedTitle, description: raw.slice(0, 500), confidence: 'low', raw_text: raw, parse_failed: true };
  }
}

module.exports = {
  groupPhotos,
  analyzeLot,
  regenerateDescription,
  GROUPING_CHUNK_SIZE,
  PHOTO_SOFT_CAP,
  MODEL,
};
