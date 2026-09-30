// A small cleanup pass over what the AI cataloguer writes (wtf-handoff SMALL_FIXES_C2_C3_BRIEF.md, C2), plus the
// "Needs a look" check for the review screen. Pure functions: no API, no database; verification/ai-cleanup.js
// tests them.
//
// EDIT THESE LISTS FREELY. Each maker entry is the spelling we want, then the wrong spellings seen or expected (as
// regex sources, matched case-insensitively on whole words). A correct spelling in the wrong case is fixed too.

const MAKERS = [
  ['Sideshow Collectibles', ['side ?show collectables', 'slideshow collectibles', 'slide ?show collectables']],
  ['Sideshow', ['slide ?show', 'side show']],
  ['Mezco', ['mesco', 'mezko']],
  ['NECA', []],
  ['McFarlane Toys', ['mc ?farlane toys', 'macfarlane toys', 'mcfarlan toys']],
  ['McFarlane', ['mc farlane', 'macfarlane', 'mcfarlan']],
  ['Hot Toys', ['hottoys', 'hot toy']],
  ['Funko', ['funco']],
  ['Aurora', []],
  ['Polar Lights', ['polarlights', 'polar light']],
  ['Kotobukiya', ['kotobukia', 'kotobukya']],
  ['Hasbro', ['hasboro']],
  ['Mattel', ['matel', 'mattell']],
  ['Kenner', ['kener']],
  ['Marx', []],
  ['Lionel', ['lionell']],
  ['Moebius Models', ['mobius models']],
  ['Monogram', []],
  ['Revell', ['revel']],
  ['Mego', []],
  ['Tamiya', []],
  ['Bandai', []],
  ['Super7', ['super ?7']],
];

// Possessives. Singular names that are followed by what belongs to them: "Frankensteins Monster" ->
// "Frankenstein's Monster". Only these names (a plural like "Toys" is left alone). Keep out words that are also
// ordinary plurals: "Hammers" in a tool lot, "Collectors will love it".
const POSSESSIVE_NAMES = ['Frankenstein', 'Dracula', 'Godzilla', 'Karloff', 'Lugosi', 'Chaney', 'Tolkien', 'Disney',
  'Moreau', 'Jekyll', 'Hyde'];
// Fixed plurals that always take an apostrophe before the s.
const FIXED = [
  [/\bchildrens\b/gi, "children's"], [/\bmens\b(?= (?:\w+))/gi, "men's"], [/\bwomens\b/gi, "women's"],
  [/\bcollectors (edition|item|series|club)\b/gi, "collector's $1"],
];

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keepCase = (orig, fix) => (orig === orig.toUpperCase() && orig.length > 3 && fix !== fix.toUpperCase() ? fix.toUpperCase() : fix);

function fixMakers(text) {
  let out = text;
  for (const [good, wrong] of MAKERS) {
    const variants = [escapeRe(good), ...wrong];
    const re = new RegExp(`\\b(?:${variants.join('|')})\\b`, 'gi');
    out = out.replace(re, m => (m === good ? m : keepCase(m, good)));
  }
  return out;
}

function fixPunctuation(text) {
  let out = text;
  for (const name of POSSESSIVE_NAMES) {
    // "Frankensteins Monster" / "Frankensteins monster" -> "Frankenstein's ...", not before punctuation or end.
    out = out.replace(new RegExp(`\\b(${name})s(?= [A-Za-z])`, 'g'), "$1's");
    out = out.replace(new RegExp(`\\b(${name}) ?['’]s\\b`, 'g'), "$1's");
  }
  for (const [re, rep] of FIXED) out = out.replace(re, (m, g1) => {
    const r = rep.replace('$1', g1 || '');
    return m[0] === m[0].toUpperCase() ? r[0].toUpperCase() + r.slice(1) : r;
  });
  out = out.replace(/\bIts (a|an|the|not|been|missing|still|in)\b/g, "It's $1");   // "Its a figure" -> "It's a figure"
  out = out.replace(/(\w) +'s\b/g, "$1's");                                           // "Frankenstein 's" -> "Frankenstein's"
  out = out.replace(/ +([,.;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();          // stray spaces
  return out;
}

const clean = text => (typeof text === 'string' && text ? fixPunctuation(fixMakers(text)) : text);

// Applies the pass to the fields buyers read (and the ones the review screen shows).
function cleanLot(result) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };
  for (const k of ['title', 'description', 'brand', 'model_or_style', 'item_type']) out[k] = clean(out[k]);
  if (Array.isArray(out.notable_features)) out.notable_features = out.notable_features.map(clean);
  if (Array.isArray(out.visible_flaws)) out.visible_flaws = out.visible_flaws.map(clean);
  return out;
}

// "Needs a look" (review screen): the host checks these before creating the lots. Nothing publishes by itself.
const MIN_WORDS = 25;
const HEDGES = /\b(appears to be|appear to be|possibly|may be|might be|likely|unclear|unidentified|not sure|cannot confirm|can't confirm|uncertain|not (?:clearly |readily |easily )?identifiable|could not be identified|cannot be identified|unknown (?:maker|character|manufacturer))\b/i;
const SIZE = /\b\d+(?:\.\d+)?(?:\s?-?\s?(?:inch(?:es)?|in\b|cm|mm)|["”])|\b1\s?:\s?\d+\b|\b(?:sixth|quarter)[- ]scale\b/i;
function reviewFlags(result) {
  const reasons = [];
  if (!result || result.parse_failed) return ['The AI answer could not be read'];
  const words = String(result.description || '').trim().split(/\s+/).filter(Boolean).length;
  if (words < MIN_WORDS) reasons.push(`Short description (${words} words)`);
  const hedge = `${result.title || ''} ${result.description || ''}`.match(HEDGES);
  if (hedge) reasons.push(`Unsure wording ("${hedge[0].toLowerCase()}")`);
  if (result.confidence === 'low') reasons.push('Low confidence in the identification');
  // A size or scale is easy to guess from a photo and wrong more often than not (a 12-inch figure was called
  // "8-inch scale" in testing, 2026-09-30). Always a human check: keep it only if a label, stamp or ruler shows it.
  const size = `${result.title || ''} ${result.description || ''}`.match(SIZE);
  if (size) reasons.push(`States a size or scale ("${size[0]}"): keep it only if a label or ruler shows it`);
  if (!String(result.title || '').trim()) reasons.push('No title');
  return reasons;
}

module.exports = { MAKERS, POSSESSIVE_NAMES, MIN_WORDS, fixMakers, fixPunctuation, clean, cleanLot, reviewFlags };
