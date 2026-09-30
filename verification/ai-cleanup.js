// C2 (wtf-handoff SMALL_FIXES_C2_C3_BRIEF.md): the cleanup pass over AI catalogue text and the "Needs a look" rules.
// Pure unit tests: no database, no AI call, nothing spent.
const path = require('path');
const BE = path.resolve(__dirname, '..');
const { fixMakers, fixPunctuation, clean, cleanLot, reviewFlags, MIN_WORDS } = require(BE + '/ai_cleanup');
const src = require('./guard').readSource(BE + '/ai_lots.js');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const eq = (got, want, m) => ok(got === want, `${m}: "${got}"${got === want ? '' : ` (wanted "${want}")`}`);

console.log('== Maker spellings ==');
eq(fixMakers('Slideshow 1:4 Frankenstein Statue'), 'Sideshow 1:4 Frankenstein Statue', 'Slideshow -> Sideshow');
eq(fixMakers('slideshow collectibles premium format'), 'Sideshow Collectibles premium format', 'maker with its full name, any case');
eq(fixMakers('Side Show figure'), 'Sideshow figure', 'Side Show -> Sideshow');
eq(fixMakers('neca, mcfarlane toys and mc farlane'), 'NECA, McFarlane Toys and McFarlane', 'NECA / McFarlane casing and spacing');
eq(fixMakers('hot toys, funco, polarlights, kotobukia, matel, kener, lionell'), 'Hot Toys, Funko, Polar Lights, Kotobukiya, Mattel, Kenner, Lionel', 'the rest of the list');
eq(fixMakers('aurora model kit by marx'), 'Aurora model kit by Marx', 'correct names in the wrong case');
eq(fixMakers('A slideshowing presentation'), 'A slideshowing presentation', 'whole words only');
eq(fixMakers('Hasbro Star Wars figure'), 'Hasbro Star Wars figure', 'already right: unchanged');

console.log('\n== Punctuation and possessives ==');
eq(fixPunctuation('Frankensteins Monster figure'), "Frankenstein's Monster figure", 'Frankensteins Monster');
eq(fixPunctuation('Bride of Frankenstein figure'), 'Bride of Frankenstein figure', 'no possessive where none belongs');
eq(fixPunctuation("Draculas cape and Frankenstein 's bolts"), "Dracula's cape and Frankenstein's bolts", 'Draculas / stray space before \'s');
eq(fixPunctuation('A childrens book and a collectors edition'), "A children's book and a collector's edition", "children's, collector's edition");
eq(fixPunctuation('Its a boxed figure. Its paint is clean.'), "It's a boxed figure. Its paint is clean.", "It's only where it means 'it is'");
eq(fixPunctuation('Set of 3 Hammers , lightly used .'), 'Set of 3 Hammers, lightly used.', 'plural tools stay plural; stray spaces go');
eq(fixPunctuation('Collectors will love it'), 'Collectors will love it', 'plural "Collectors" left alone');
eq(clean("slideshow frankensteins monster"), "Sideshow frankensteins monster", 'lower-case names are not guessed at');
const lot = cleanLot({ title: 'Slideshow Frankensteins Monster Statue', description: 'Its a statue.', brand: 'slideshow', notable_features: ['neca base'], visible_flaws: ['Draculas cape torn'], confidence: 'high' });
ok(lot.title === "Sideshow Frankenstein's Monster Statue" && lot.brand === 'Sideshow' && lot.description === "It's a statue." && lot.notable_features[0] === 'NECA base' && lot.visible_flaws[0] === "Dracula's cape torn",
  'cleanLot fixes title, description, brand, features and flaws');

console.log('\n== Needs a look ==');
const long = 'This is a detailed and specific description of the figure with its sculpt, paint and base all described clearly for the bidder. The paint is clean with no visible chips anywhere.';
ok(long.split(/\s+/).length >= MIN_WORDS && reviewFlags({ title: 'X', description: long, confidence: 'high' }).length === 0, 'a full, sure description: no flag');
ok(/Short description \(\d+ words\)/.test(reviewFlags({ title: 'X', description: 'Zombie figure.', confidence: 'high' })[0]), `under ${MIN_WORDS} words: flagged`);
ok(reviewFlags({ title: 'X', description: long + ' It appears to be a Mezco figure.', confidence: 'high' }).some(r => r.includes('appears to be')), '"appears to be": flagged, with the words quoted');
ok(reviewFlags({ title: 'X', description: long + ' The specific character is not clearly identifiable from the sculpt.', confidence: 'medium' }).some(r => r.includes('not clearly identifiable')), 'not clearly identifiable: flagged');
ok(reviewFlags({ title: 'X', description: long, confidence: 'low' }).some(r => /Low confidence/.test(r)), 'low confidence: flagged');
for (const said of ['A 12-inch scale action figure', 'Frankenstein 1:6 Figure', 'Statue, 8 inches tall', 'a 30 cm bust', 'Sixth-scale figure', 'a 12" figure'])
  ok(reviewFlags({ title: 'X', description: long + ' ' + said, confidence: 'high' }).some(r => /size or scale/.test(r)), `a stated size or scale is flagged: "${said}"`);
ok(!reviewFlags({ title: 'Lot of 2 Figures', description: long + ' Made in 1999 by Sideshow.', confidence: 'high' }).some(r => /size or scale/.test(r)), 'a count or a year is not a size');
ok(reviewFlags({ parse_failed: true })[0] === 'The AI answer could not be read' && reviewFlags({ title: '', description: long }).includes('No title'), 'unreadable answer or no title: flagged');

console.log('\n== The prompts ==');
ok(/NEVER INVENT FACTS/.test(src) && /grade, an edition size or number, a\s+production year or date, provenance/.test(src) && /"appears to be"/.test(src), 'analysis prompt: never invent grades, editions, dates, provenance or values; hedge or leave out');
ok(/Maker \+ item \+ character\/subject \+ size, scale or edition when visible/.test(src) && /as the last sentence, the condition you can SEE/.test(src) && /Sideshow Collectibles, not "Slideshow"/.test(src),
  'title form, 2-4 sentences ending in visible condition, exact maker spelling');
ok((src.match(/cleanLot\(extractJson\(raw\)\)/g) || []).length === 2 && (src.match(/needs_look = reviewFlags\(parsed\)/g) || []).length === 2, 'both AI calls (analyse, regenerate) go through the cleanup and the flags');
ok(!/goldin|auction ?ninja|whatnot|ebay/i.test(src), 'no other auction house named in the prompts');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
