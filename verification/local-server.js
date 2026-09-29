// Boots a copy of server.js (any source: the working tree, or a pinned commit) on a local port, for the suites.
// It inherits this process's environment, so after guard() it points at the database guard chose (wtf-test by
// default). Stripe and Resend are always blanked: nothing is charged and no email is sent.
//   timers: 'stubbed' (default) - setInterval is a no-op; the auto-close job still runs once at boot.
//           'real'    - setInterval works (so live-mode timers really fire), but the auto-close job is removed.
//   log:    true to capture the server's stdout+stderr (read it with .log()).
const fs = require('fs');
const { spawn } = require('child_process');
const BE = require('path').resolve(__dirname, '..').replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const AUTOCLOSE = 'setInterval(autoCloseStandardItems, 30000)\nautoCloseStandardItems()';

module.exports = async function boot(name, port, source, { timers = 'stubbed', log = false } = {}) {
  if (timers === 'real') {
    if (!source.includes(AUTOCLOSE)) throw new Error('auto-close marker not found in source');
    source = source.replace(AUTOCLOSE, '');
  }
  const file = `${BE}/server.tmp-${name}.js`, runner = `${BE}/run.tmp-${name}.js`;
  fs.writeFileSync(file, source);
  fs.writeFileSync(runner, (timers === 'real' ? '' : 'global.setInterval = () => 0; ')
    + `process.env.PORT='${port}'; process.env.STRIPE_SECRET_KEY=''; process.env.RESEND_API_KEY=''; require('./server.tmp-${name}.js');`);
  const child = spawn(process.execPath, [runner], { cwd: BE, stdio: ['ignore', log ? 'pipe' : 'ignore', log ? 'pipe' : 'ignore'] });
  let out = '';
  if (log) { child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d); }
  let exited = null;
  child.on('exit', code => { exited = code; });
  for (let i = 0; i < 30; i++) { try { await fetch(`http://localhost:${port}/version`); break; } catch { await sleep(1000); } }
  return {
    url: `http://localhost:${port}`,
    log: () => out,
    alive: () => exited === null,
    stop: () => { child.kill(); try { fs.unlinkSync(file); fs.unlinkSync(runner); } catch {} },
  };
};
module.exports.BE = BE;
module.exports.sleep = sleep;
