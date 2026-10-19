// The chat filters (live phase 5, LIVE_SHOWS_PHASE5_BRIEF.md; audit §5), on top of send_chat's length and rate
// limits. A refused message is never stored or shown to anyone; only the sender is told why (chat_error code).
//   link   a web address (http://, www., or name.tld)
//   email  an email address
//   phone  a phone number (7 or more digits, spaces, dots, dashes or brackets between them)
//   word   a word on the short list below (whole words, ignoring case and the usual 0/1/3/4/5/@/$ swaps)
// Our own wording (placeholders for Cowork: LIVE_SHOWS_PHASE5_RUNBOOK.md).

const TLDS = 'com|net|org|io|co|shop|store|live|me|ly|gg|xyz|info|biz|us|uk|ca|app|site|link|tv|to|be|cc|ru|de';
const LINK = new RegExp(`(https?:\\/\\/|\\bwww\\.|\\b[a-z0-9][a-z0-9-]*\\.(${TLDS})\\b)`, 'i');
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PHONE = /(?:\+?\d[\s().-]*){7,}/;
// A short list in code (no table in v1). Whole words only, so "Scunthorpe" or "class" pass. Words that are also
// names or things people sell (a Philip K. Dick novel) are left off.
const BANNED = ['fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'cunt', 'bitch', 'asshole', 'bastard',
  'pussy', 'whore', 'slut', 'retard', 'retarded', 'fag', 'faggot', 'nigger', 'nigga', 'spic', 'kike', 'chink', 'tranny'];
const SWAPS = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
const unswap = s => s.toLowerCase().replace(/[013457@$]/g, c => SWAPS[c]);
const WORD = new RegExp(`(^|[^a-z])(${BANNED.join('|')})s?(?=$|[^a-z])`);

const MESSAGES = {
  link: "Links can't be posted in the chat.",
  email: "Email addresses can't be posted in the chat. Keep contact details private.",
  phone: "Phone numbers can't be posted in the chat. Keep contact details private.",
  word: "That message wasn't sent: please keep the chat friendly.",
};

// null = fine; otherwise { code, message }.
function refuse(text) {
  const t = String(text || '');
  const code = EMAIL.test(t) ? 'email' : LINK.test(t) ? 'link' : PHONE.test(t) ? 'phone' : WORD.test(unswap(t)) ? 'word' : null;
  return code ? { code: 'chat_' + code, message: MESSAGES[code] } : null;
}

// The host's one-tap pinned replies built in (placeholders for Cowork). The host can add their own in the room.
const PINNED_REPLIES = [
  'Everything you win in this show ships together in one box.',
  'Bids are binding: your card is charged when the lot sells.',
  "No buyer's premium in live shows.",
];

module.exports = { refuse, PINNED_REPLIES, MESSAGES, BANNED };
