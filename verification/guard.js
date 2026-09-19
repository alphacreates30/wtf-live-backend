// Every script in this folder writes to the REAL database (the one in .env),
// using clearly-named throwaway rows that it deletes afterwards. It refuses to
// run unless you say so explicitly, and prints what it is about to touch.
const FLAG = '--yes-run-against-the-real-database';
module.exports = function guard(file) {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });
  const url = process.env.SUPABASE_URL;
  if (!url) { console.error('SUPABASE_URL not set - run from a checkout with a .env'); process.exit(2); }
  if (!process.argv.includes(FLAG)) {
    console.error(`\n${path.basename(file)} writes to the REAL database at ${new URL(url).host}\n(throwaway ZZTEST_ rows, cleaned up afterwards - but it is the real database).\nRe-run with ${FLAG} if that is what you want. See verification/README.md.\n`);
    process.exit(2);
  }
  console.log(`Target database: ${new URL(url).host}\n`);
};
