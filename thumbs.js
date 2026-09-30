// Photo thumbnails (F1a, migration v): one recipe, shared by POST /upload-image
// (server.js) and scripts/backfill-thumbs.js, so old and new photos get the
// same small version.
const sharp = require('sharp');

const THUMB_WIDTH = 480;

// About 480px wide WebP. sharp writes no metadata unless asked, so the
// thumbnail carries no EXIF/GPS whatever the input had; rotate() applies any
// orientation tag first (older, pre-#13 photos can still have one).
function makeThumb(buffer) {
  return sharp(buffer, { limitInputPixels: 60e6 }).rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer();
}

// items/1790-abc.jpg -> items/thumbs/1790-abc.webp (same bucket, next to the full photo).
function thumbPathFor(path) {
  const slash = path.lastIndexOf('/');
  return path.slice(0, slash + 1) + 'thumbs/' + path.slice(slash + 1).replace(/\.[^./]+$/, '') + '.webp';
}

module.exports = { THUMB_WIDTH, makeThumb, thumbPathFor };
