'use strict';
// Rasterises build/icon.svg into build/icon.ico (and a 512px PNG for Linux
// packaging) using Electron's own renderer, so there is no image-toolchain
// dependency to install.
//
//   npx electron tools/make-icon.js
//
// Windows accepts PNG-compressed frames inside an .ico, so each size is a PNG
// blob wrapped in an ICONDIR / ICONDIRENTRY header.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const BUILD_DIR = path.join(__dirname, '..', 'build');
const SVG_FILE = path.join(BUILD_DIR, 'icon.svg');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Packs PNG buffers into a single .ico container. */
function buildIco(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(frames.length, 4);

  const directory = Buffer.alloc(16 * frames.length);
  let offset = header.length + directory.length;

  frames.forEach((frame, i) => {
    const entry = i * 16;
    // 0 means 256 in the one-byte width/height fields.
    directory.writeUInt8(frame.size >= 256 ? 0 : frame.size, entry + 0);
    directory.writeUInt8(frame.size >= 256 ? 0 : frame.size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette size
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(frame.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frame.data.length;
  });

  return Buffer.concat([header, directory, ...frames.map((f) => f.data)]);
}

const MASTER = 512;

/**
 * Renders the SVG once at 512px and returns a nativeImage. Creating a fresh
 * transparent window per size fails after the first one, so every icon size is
 * derived from this single master by resizing.
 */
async function renderMaster(svg, scratchFile) {
  const html = `<!doctype html><meta charset="utf-8">
    <style>
      html,body{margin:0;padding:0;background:transparent;overflow:hidden}
      svg{display:block;width:${MASTER}px;height:${MASTER}px}
    </style>${svg}`;
  fs.writeFileSync(scratchFile, html);

  const win = new BrowserWindow({
    width: MASTER,
    height: MASTER,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  await win.loadFile(scratchFile);
  await new Promise((r) => setTimeout(r, 250)); // let the SVG lay out
  const image = await win.webContents.capturePage();
  win.destroy();

  if (image.isEmpty()) throw new Error('captured an empty image');
  return image;
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const svg = fs.readFileSync(SVG_FILE, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const scratch = path.join(app.getPath('temp'), 'steam-clips-icon-render.html');

    const master = await renderMaster(svg, scratch);
    console.log(`rendered master at ${master.getSize().width}px`);

    const frames = SIZES.map((size) => {
      const resized = master.resize({ width: size, height: size, quality: 'best' });
      return { size, data: resized.toPNG() };
    });
    console.log(`derived sizes: ${SIZES.join(', ')}`);

    const ico = path.join(BUILD_DIR, 'icon.ico');
    fs.writeFileSync(ico, buildIco(frames));
    console.log(`wrote ${ico} (${fs.statSync(ico).size} bytes, ${frames.length} sizes)`);

    const png = path.join(BUILD_DIR, 'icon.png');
    fs.writeFileSync(png, master.toPNG());
    console.log(`wrote ${png} (${fs.statSync(png).size} bytes)`);
    fs.rmSync(scratch, { force: true });
  } catch (err) {
    console.error('icon build failed:', err);
    app.exit(1);
    return;
  }
  app.exit(0);
});
