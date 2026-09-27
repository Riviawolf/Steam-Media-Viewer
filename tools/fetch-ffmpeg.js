'use strict';
// Downloads the ffmpeg binary that gets bundled into the installer.
//
// The binary is too large to keep in the repository, so it is fetched into
// vendor/ffmpeg before packaging. If a copy is already there the script exits
// straight away, so it is cheap to run before every build.
//
//   npm run fetch-ffmpeg
//
// The build is the LGPL variant from BtbN/FFmpeg-Builds. LGPL is enough here:
// clips are stream-copied rather than re-encoded, and thumbnails only need
// image decoding and scaling.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const RELEASE = 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest';
const ASSET = 'ffmpeg-n9.0-latest-win64-lgpl-9.0.zip';
const VENDOR = path.join(__dirname, '..', 'vendor', 'ffmpeg');
const EXE = path.join(VENDOR, 'ffmpeg.exe');

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https
      .get(url, { headers: { 'User-Agent': 'Steam-Media-Viewer-build' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(res.headers.location, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`${url} returned ${res.statusCode}`));
        }
        resolve(res);
      })
      .on('error', reject);
  });
}

async function readJson(url) {
  const res = await get(url);
  let body = '';
  res.setEncoding('utf8');
  for await (const chunk of res) body += chunk;
  return JSON.parse(body);
}

async function download(url, dest) {
  const res = await get(url);
  const total = Number(res.headers['content-length']) || 0;
  let done = 0;
  let lastShown = 0;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.on('data', (chunk) => {
      done += chunk.length;
      const pct = total ? Math.floor((done / total) * 100) : 0;
      if (pct >= lastShown + 10) {
        lastShown = pct;
        process.stdout.write(`  ${pct}%\r`);
      }
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  process.stdout.write('        \r');
}

async function main() {
  if (fs.existsSync(EXE)) {
    const mb = (fs.statSync(EXE).size / 1048576).toFixed(0);
    console.log(`ffmpeg already present (${mb} MB), skipping download`);
    return;
  }

  console.log(`fetching ${ASSET}`);
  const release = await readJson(RELEASE);
  const asset = (release.assets || []).find((a) => a.name === ASSET);
  if (!asset) throw new Error(`${ASSET} is not in the latest FFmpeg-Builds release`);

  fs.mkdirSync(VENDOR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'smv-ffmpeg-'));
  const zip = path.join(tmpDir, ASSET);

  await download(asset.browser_download_url, zip);
  console.log(`  downloaded ${(fs.statSync(zip).size / 1048576).toFixed(0)} MB, extracting`);

  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -Path '${zip}' -DestinationPath '${tmpDir}' -Force`],
    { stdio: 'ignore' },
  );

  // The zip contains one top-level folder; take ffmpeg.exe and the licence.
  const root = fs.readdirSync(tmpDir).map((d) => path.join(tmpDir, d)).find((d) => fs.statSync(d).isDirectory());
  if (!root) throw new Error('unexpected archive layout');

  fs.copyFileSync(path.join(root, 'bin', 'ffmpeg.exe'), EXE);
  const licence = path.join(root, 'LICENSE.txt');
  if (fs.existsSync(licence)) fs.copyFileSync(licence, path.join(VENDOR, 'LICENSE.txt'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`ffmpeg ready at vendor/ffmpeg (${(fs.statSync(EXE).size / 1048576).toFixed(0)} MB)`);
}

main().catch((err) => {
  console.error('fetch-ffmpeg failed:', err.message);
  process.exit(1);
});
