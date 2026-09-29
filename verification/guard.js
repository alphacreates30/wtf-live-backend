// Every script in this folder writes to a database, using clearly-named
// throwaway rows that it deletes afterwards. By default that is the TEST
// project (wtf-test, credentials in .env.test). Production (.env) is reachable
// only with an explicit flag, and every run prints which project it is hitting.
//
// Loading order matters: the chosen file is loaded here, first, with override,
// so SUPABASE_URL / SUPABASE_KEY / JWT_SECRET come from it. dotenv never
// overwrites a key that is already set, so the suites' own later
// `dotenv.config()` (which reads .env) and the local servers they spawn (which
// inherit this environment) cannot switch the database back to production.
const PROD_FLAGS = ['--yes-production', '--yes-run-against-the-real-database'];
const REQUIRED = ['SUPABASE_URL', 'SUPABASE_KEY', 'JWT_SECRET'];
module.exports = function guard(file) {
  const path = require('path');
  const fs = require('fs');
  const dotenv = require('dotenv');
  const root = path.resolve(__dirname, '..');
  const name = path.basename(file);
  const read = f => fs.existsSync(path.join(root, f)) ? dotenv.parse(fs.readFileSync(path.join(root, f))) : null;
  const host = u => { try { return new URL(u).host; } catch { return null; } };
  const die = msg => { console.error('\n' + name + ': ' + msg + '\nSee verification/README.md.\n'); process.exit(2); };

  const prodEnv = read('.env');
  const prodHost = prodEnv && host(prodEnv.SUPABASE_URL);
  const wantProd = PROD_FLAGS.some(f => process.argv.includes(f));
  const envFile = wantProd ? '.env' : '.env.test';
  const chosen = read(envFile);
  if (!chosen) die(`${envFile} not found in ${root}.` + (wantProd ? '' : ' It holds the wtf-test credentials (test only).'));
  const missing = REQUIRED.filter(k => !chosen[k]);
  if (missing.length) die(`${envFile} is missing ${missing.join(', ')}.`);
  const target = host(chosen.SUPABASE_URL);
  if (!target) die(`SUPABASE_URL in ${envFile} is not a URL.`);
  if (!wantProd && prodHost && target === prodHost) {
    die(`.env.test points at PRODUCTION (${target}). Refusing.\nFix .env.test, or pass --yes-production if you really mean production.`);
  }
  for (const k of REQUIRED) process.env[k] = chosen[k];
  // The local servers the suites start inherit this: rate limits (review #5) don't apply to requests from
  // loopback, since a suite fires many logins/bids from localhost. rate-limits.js deletes it to test the limits.
  process.env.RATE_LIMIT_EXEMPT_LOOPBACK = '1';

  const isProd = wantProd || (prodHost && target === prodHost);
  console.log(isProd
    ? `Target database: ${target}  ** PRODUCTION ** (throwaway ZZTEST_ rows, cleaned up afterwards)\n`
    : `Target database: ${target}  (test project, from .env.test)\n`);
};

// Source the suites patch and match markers against. Normalised to LF once,
// here, so a CRLF checkout (core.autocrlf=true on Windows) can never turn a
// multi-line marker into a false "marker not found" (#49).
const lf = s => s.replace(/\r\n/g, '\n');
module.exports.readSource = file => lf(require('fs').readFileSync(file, 'utf8'));
module.exports.sourceAt = (commit, cwd) => lf(require('child_process').execSync('git show ' + commit + ':server.js', { cwd, maxBuffer: 50e6 }).toString());
