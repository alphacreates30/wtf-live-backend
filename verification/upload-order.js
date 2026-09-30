// Photo order on the bulk upload screen: the photo's own date taken (EXIF DateTimeOriginal + sub-seconds, read in
// the browser before the upload strips metadata), then the file name in natural order, then last-modified; and
// moving a photo (drag to reorder). Tests ../wtf-live-frontend/src/photoOrder.js and the screen's source.
// Reads the owner's Drive copies READ-ONLY when the folder is there (it proves the bug and the fix on real files);
// never uploads or copies them, and makes no AI call. No database is touched.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const BE = path.resolve(__dirname, '..');
const FE = path.join(BE, '..', 'wtf-live-frontend');
const sharp = require(BE + '/node_modules/sharp');
const DRIVE = process.env.UPLOAD_ORDER_PHOTOS || 'G:/.shortcut-targets-by-id/1Z2mXWErPuOngPOJrdXx_23-oqWrxBKQA/Temp eBay/eBay 08 07';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const ab = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);

// A JPEG whose EXIF is built by hand, big-endian ("MM"), which many cameras write (sharp writes little-endian).
async function jpegBigEndian(date, sub) {
  const base = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#777' } }).jpeg().toBuffer();
  const str = s => Buffer.concat([Buffer.from(s, 'ascii'), Buffer.from([0])]);
  const dt = str(date), ss = str(sub);
  // TIFF: header(8) | IFD0: 1 entry (ExifIFD ptr) | Exif IFD: 2 entries | data
  const ifd0 = 8, exifIfd = ifd0 + 2 + 12 + 4, data = exifIfd + 2 + 24 + 4;
  const t = Buffer.alloc(data + dt.length + ss.length);
  t.write('MM', 0, 'ascii'); t.writeUInt16BE(42, 2); t.writeUInt32BE(ifd0, 4);
  t.writeUInt16BE(1, ifd0); t.writeUInt16BE(0x8769, ifd0 + 2); t.writeUInt16BE(4, ifd0 + 4); t.writeUInt32BE(1, ifd0 + 6); t.writeUInt32BE(exifIfd, ifd0 + 10);
  t.writeUInt16BE(2, exifIfd);
  let e = exifIfd + 2;
  t.writeUInt16BE(0x9003, e); t.writeUInt16BE(2, e + 2); t.writeUInt32BE(dt.length, e + 4); t.writeUInt32BE(data, e + 8); e += 12;
  if (ss.length <= 4) { t.writeUInt16BE(0x9291, e); t.writeUInt16BE(2, e + 2); t.writeUInt32BE(ss.length, e + 4); ss.copy(t, e + 8); }
  dt.copy(t, data);
  const app1 = Buffer.concat([Buffer.from([0xFF, 0xE1]), Buffer.alloc(2), Buffer.from('Exif\0\0', 'binary'), t]);
  app1.writeUInt16BE(app1.length - 2, 2);
  return Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]);
}
const jpegLittleEndian = (date, sub) => sharp({ create: { width: 8, height: 8, channels: 3, background: '#777' } }).jpeg()
  .withExif({ IFD2: { DateTimeOriginal: date, ...(sub ? { SubSecTimeOriginal: sub } : {}) } }).toBuffer();

(async () => {
  const po = await import(pathToFileURL(path.join(FE, 'src', 'photoOrder.js')).href);
  console.log('== Reading the date taken ==');
  const local = (y, mo, d, h, mi, s, ms = 0) => new Date(y, mo - 1, d, h, mi, s).getTime() + ms;
  ok(po.exifDateTakenFromBuffer(ab(await jpegLittleEndian('2026:08:07 17:49:25', '469'))) === local(2026, 8, 7, 17, 49, 25, 469), 'little-endian EXIF (sharp): date and sub-seconds, local time');
  ok(po.exifDateTakenFromBuffer(ab(await jpegBigEndian('2026:08:07 17:49:25', '47'))) === local(2026, 8, 7, 17, 49, 25, 470), 'big-endian EXIF (hand-built, as many cameras write it)');
  const plain = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#777' } }).jpeg().toBuffer();
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#777' } }).png().toBuffer();
  ok(po.exifDateTakenFromBuffer(ab(plain)) === null && po.exifDateTakenFromBuffer(ab(png)) === null && po.exifDateTakenFromBuffer(ab(Buffer.from('not a photo'))) === null
    && po.exifDateTakenFromBuffer(ab(await jpegLittleEndian('0000:00:00 00:00:00'))) === null && po.exifDateTakenFromBuffer(new ArrayBuffer(0)) === null,
    'no EXIF, a PNG, junk, an unset "0000:00:00" date, an empty file: null, never an error');
  const cut = await jpegLittleEndian('2026:08:07 17:49:25', '469');
  ok(po.exifDateTakenFromBuffer(ab(cut.subarray(0, 30))) === null, 'a truncated file: null');
  const f = new File([await jpegLittleEndian('2026:01:02 03:04:05')], 'x.jpg', { type: 'image/jpeg', lastModified: 1 });
  ok(await po.exifDateTaken(f) === local(2026, 1, 2, 3, 4, 5), 'exifDateTaken reads a File (only its first 256 KB)');

  console.log('\n== The order ==');
  const it = (name, taken, lastModified = 0) => ({ name, taken, lastModified });
  const names = xs => po.shootingOrder(xs).map(x => x.name).join(' ');
  ok(names([it('b', 300), it('a', 200), it('c', 100)]) === 'c a b', 'date taken first, whatever the names');
  ok(names([it('IMG_10', 5), it('IMG_9', 5), it('IMG_8101', 5)]) === 'IMG_9 IMG_10 IMG_8101', 'same date: natural name order (9 before 10)');
  ok(names([it('IMG_10', null), it('IMG_9', null), it('shot', 1)]) === 'shot IMG_9 IMG_10', 'no date: after the dated ones, by name');
  ok(names([it('a', null, 30), it('a', null, 10), it('b', null, 0)]) === 'a a b' && po.shootingOrder([it('a', null, 30), it('a', null, 10)])[0].lastModified === 10, 'same name and no date: last-modified decides');
  ok(names([it('img_2', null), it('IMG_1', null)]) === 'IMG_1 img_2', 'name order ignores case');
  const files = [
    new File([await jpegLittleEndian('2026:08:07 10:00:02')], 'late.jpg', { lastModified: 1 }),
    new File([await jpegBigEndian('2026:08:07 10:00:01', '5')], 'mid.jpg', { lastModified: 2 }),
    new File([plain], 'IMG_2.jpg', { lastModified: 3 }), new File([plain], 'IMG_10.jpg', { lastModified: 0 }),
    new File([await jpegBigEndian('2026:08:07 10:00:01', '1')], 'early.jpg', { lastModified: 9 }),
  ];
  ok((await po.sortFilesByShootingOrder(files)).map(x => x.name).join(' ') === 'early.jpg mid.jpg late.jpg IMG_2.jpg IMG_10.jpg', 'files: by date taken (sub-seconds too), then undated by name; file times ignored while a date exists');

  console.log('\n== Moving a photo ==');
  const o = [0, 1, 2, 3, 4];
  ok(po.moveInOrder(o, 4, 0).join('') === '40123' && po.moveInOrder(o, 0, 4, true).join('') === '12340' && po.moveInOrder(o, 1, 3, false).join('') === '02134'
    && po.moveInOrder(o, 2, 2).join('') === '01234' && po.moveInOrder(o, 9, 1).join('') === '01234' && o.join('') === '01234',
    'before/after a target; no-ops for itself or an unknown photo; the input is not changed');

  console.log('\n== The upload screen ==');
  const screen = fs.readFileSync(path.join(FE, 'src', 'pages', 'BulkLotUpload.jsx'), 'utf8');
  ok(/files = await sortFilesByShootingOrder\(files\)/.test(screen) && !/a\.lastModified - b\.lastModified/.test(screen), 'files are sorted by photoOrder (date taken), no longer by last-modified first');
  ok(/className="blu-cell-name"/.test(screen) && /onPointerDown=\{e => onCellPointerDown\(e, idx\)\}/.test(screen) && /setTimeout\(\(\) => \{ if \(drag\.current === d\) startDrag\(d\) \}, 350\)/.test(screen) && /altKey/.test(screen),
    'each photo shows its file name; drag to reorder (touch after a 350 ms hold; Alt+arrows on the keyboard)');
  ok(/\.sort\(byOrder\(order\)\)/.test(screen) && !/\.sort\(\(a, b\) => a - b\)/.test(screen), 'photos coming back from a lot return to the (possibly re-ordered) display order');

  console.log('\n== The owner\'s Drive copies (read-only) ==');
  if (!fs.existsSync(DRIVE)) {
    console.log(`  skipped: ${DRIVE} is not available on this machine (set UPLOAD_ORDER_PHOTOS to a folder of camera JPEGs)`);
  } else {
    const list = fs.readdirSync(DRIVE).filter(n => /\.jpe?g$/i.test(n));
    const items = list.map(n => {
      const fd = fs.openSync(path.join(DRIVE, n), 'r'); const b = Buffer.alloc(256 * 1024); const r = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
      return { name: n, lastModified: fs.statSync(path.join(DRIVE, n)).mtimeMs, taken: po.exifDateTakenFromBuffer(ab(b.subarray(0, r))) };
    });
    const natural = [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(x => x.name);
    const byDate = po.shootingOrder(items).map(x => x.name);
    const byMtime = [...items].sort((a, b) => a.lastModified - b.lastModified || a.name.localeCompare(b.name, undefined, { numeric: true })).map(x => x.name);
    const off = (x, y) => x.filter((n, i) => n !== y[i]).length;
    ok(items.length > 20 && items.every(x => x.taken != null), `${items.length} Drive copies: every one has its date taken`);
    ok(off(byDate, natural) === 0, 'sorted by date taken = the camera\'s own numbering (IMG_8094, 8095, ...)');
    ok(off(byMtime, natural) > items.length / 2, `the old order (last-modified) scrambles ${off(byMtime, natural)} of ${items.length} positions  <- the bug, on real files`);
    const i8101 = byDate.findIndex(n => n.startsWith('IMG_8101_'));
    ok(i8101 > 0 && byDate[i8101 - 1].startsWith('IMG_8100_') && byDate[i8101 + 1].startsWith('IMG_8102_'), "IMG_8101 (the Creature's base stamp) sits between 8100 and 8102");
  }
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.log('ERR', e); process.exit(1); });
