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

// Source the suites patch and match markers against. Normalised to LF once,
// here, so a CRLF checkout (core.autocrlf=true on Windows) can never turn a
// multi-line marker into a false "marker not found" (#49).
const lf = s => s.replace(/\r\n/g, '\n');
module.exports.readSource = file => lf(require('fs').readFileSync(file, 'utf8'));
module.exports.sourceAt = (commit, cwd) => lf(require('child_process').execSync('git show ' + commit + ':server.js', { cwd, maxBuffer: 50e6 }).toString());
