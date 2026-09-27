'use strict';
// Update checking and downloading, against the project's GitHub releases.
//
// A check reports what is available and collects the notes from every release
// newer than the running build, so a user several versions behind sees all of
// it. Downloading is only ever started by the user, and the finished file is
// checked against the sha512 published in the release before it is run.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const USER_AGENT = 'Steam-Media-Viewer';
const TIMEOUT_MS = 15000;

/** "v1.2.3", "1.2.3", "SMV-1.2.3" all parse to [1, 2, 3]. */
function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Positive when a is newer than b. */
function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] - vb[i];
  }
  return 0;
}

/** Turns "https://github.com/owner/name.git" or "owner/name" into {owner, name}. */
function parseRepo(repository) {
  const raw = typeof repository === 'string' ? repository : repository && repository.url;
  if (!raw) return null;
  const m = /github\.com[/:]([^/]+)\/([^/.\s]+)/.exec(raw) || /^([\w.-]+)\/([\w.-]+)$/.exec(raw);
  return m ? { owner: m[1], name: m[2].replace(/\.git$/, '') } : null;
}

function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(
      url,
      { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, timeout: TIMEOUT_MS },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(request(res.headers.location, redirects + 1));
        }
        resolve(res);
      },
    );
    req.on('timeout', () => req.destroy(new Error('Timed out contacting GitHub')));
    req.on('error', reject);
  });
}

async function readBody(url, limit = 2_000_000) {
  const res = await request(url);
  if (res.statusCode === 404) {
    res.resume();
    return { notFound: true };
  }
  if (res.statusCode === 403) {
    res.resume();
    throw new Error('GitHub rate limit reached, try again later');
  }
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`GitHub returned ${res.statusCode}`);
  }
  let body = '';
  res.setEncoding('utf8');
  for await (const chunk of res) {
    body += chunk;
    if (body.length > limit) throw new Error('response too large');
  }
  return { body };
}

/** Pulls one asset's sha512 out of an electron-builder latest.yml. */
function sha512FromYml(yml, assetName) {
  if (!yml) return null;
  const lines = String(yml).split(/\r?\n/);
  let seen = false;
  for (const line of lines) {
    if (new RegExp(`url:\\s*${assetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(line)) {
      seen = true;
      continue;
    }
    if (seen) {
      const m = /^\s*sha512:\s*(\S+)/.exec(line);
      if (m) return m[1];
      if (/^\s*-\s*url:/.test(line)) seen = false; // moved on to the next asset
    }
  }
  const top = /^sha512:\s*(\S+)/m.exec(yml);
  return top ? top[1] : null;
}

/**
 * @param {{currentVersion: string, repository: string|object, allowNetwork: boolean}} opts
 * @returns {Promise<object>} always resolves; failures come back as status 'error'
 */
async function checkForUpdates({ currentVersion, repository, allowNetwork }) {
  const base = { current: currentVersion, checkedAt: Date.now() };

  if (!allowNetwork) {
    return { ...base, status: 'disabled', message: 'Update checks are off while lookups are disabled.' };
  }

  const repo = parseRepo(repository);
  if (!repo) {
    return { ...base, status: 'error', message: 'No repository is configured for this build.' };
  }
  const releasesUrl = `https://github.com/${repo.owner}/${repo.name}/releases`;

  try {
    const res = await readBody(`https://api.github.com/repos/${repo.owner}/${repo.name}/releases?per_page=30`);
    if (res.notFound) {
      return { ...base, status: 'none', releasesUrl, message: 'No releases have been published yet.' };
    }

    const releases = JSON.parse(res.body)
      .filter((r) => !r.draft && !r.prerelease && parseVersion(r.tag_name || r.name))
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name));

    if (!releases.length) {
      return { ...base, status: 'none', releasesUrl, message: 'No releases have been published yet.' };
    }

    const latest = releases[0];
    const latestVersion = parseVersion(latest.tag_name).join('.');
    if (compareVersions(latest.tag_name, currentVersion) <= 0) {
      return {
        ...base,
        status: 'current',
        latest: latestVersion,
        releasesUrl,
        url: latest.html_url,
        message: 'You are on the latest version.',
      };
    }

    // Everything newer than what is running, so someone several versions behind
    // sees the whole story rather than just the last entry.
    const newer = releases.filter((r) => compareVersions(r.tag_name, currentVersion) > 0);
    const notes = newer.map((r) => ({
      version: parseVersion(r.tag_name).join('.'),
      publishedAt: r.published_at || null,
      body: typeof r.body === 'string' ? r.body.trim().slice(0, 8000) : '',
    }));

    const installer = (latest.assets || []).find((a) => /\.exe$/i.test(a.name));
    const ymlAsset = (latest.assets || []).find((a) => /^latest\.yml$/i.test(a.name));

    let sha512 = null;
    if (installer && ymlAsset) {
      try {
        const yml = await readBody(ymlAsset.browser_download_url, 200_000);
        sha512 = sha512FromYml(yml.body, installer.name);
      } catch {
        // Without it the download falls back to a size check.
      }
    }

    return {
      ...base,
      status: 'available',
      latest: latestVersion,
      publishedAt: latest.published_at || null,
      url: latest.html_url || releasesUrl,
      releasesUrl,
      notes,
      asset: installer
        ? { name: installer.name, url: installer.browser_download_url, size: installer.size, sha512 }
        : null,
    };
  } catch (err) {
    return { ...base, status: 'error', releasesUrl, message: (err && err.message) || 'Update check failed.' };
  }
}

function sha512OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('base64')));
  });
}

/**
 * Downloads a release asset and checks it before handing back the path.
 * @param {{name: string, url: string, size: number, sha512: string|null}} asset
 * @param {string} destDir
 * @param {(fraction: number, received: number, total: number) => void} [onProgress]
 */
async function downloadUpdate(asset, destDir, onProgress) {
  if (!asset || !asset.url) throw new Error('This release has no installer attached.');

  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(asset.name));
  const partial = `${dest}.part`;

  const res = await request(asset.url);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`Download failed with ${res.statusCode}`);
  }

  const total = Number(res.headers['content-length']) || asset.size || 0;
  let received = 0;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(partial);
    res.on('data', (chunk) => {
      received += chunk.length;
      if (onProgress && total) onProgress(received / total, received, total);
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });

  const size = fs.statSync(partial).size;
  if (asset.size && size !== asset.size) {
    fs.rmSync(partial, { force: true });
    throw new Error(`Downloaded file is ${size} bytes, expected ${asset.size}`);
  }

  if (asset.sha512) {
    const actual = await sha512OfFile(partial);
    if (actual !== asset.sha512) {
      fs.rmSync(partial, { force: true });
      throw new Error('Downloaded file failed its checksum and was discarded.');
    }
  }

  fs.rmSync(dest, { force: true });
  fs.renameSync(partial, dest);
  return { path: dest, size, verified: Boolean(asset.sha512) };
}

module.exports = {
  checkForUpdates,
  downloadUpdate,
  compareVersions,
  parseVersion,
  parseRepo,
  sha512FromYml,
};
