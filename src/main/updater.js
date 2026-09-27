'use strict';
// Update check against the project's GitHub releases.
//
// It only ever reads the releases API and reports what it finds. Nothing is
// downloaded or installed automatically; the user decides whether to open the
// release page and install the new build.

const https = require('https');

const USER_AGENT = 'Steam-Media-Viewer';
const TIMEOUT_MS = 10000;

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

/**
 * Turns "https://github.com/owner/name.git" or "owner/name" into {owner, name}.
 */
function parseRepo(repository) {
  const raw = typeof repository === 'string' ? repository : repository && repository.url;
  if (!raw) return null;
  const m = /github\.com[/:]([^/]+)\/([^/.\s]+)/.exec(raw) || /^([\w.-]+)\/([\w.-]+)$/.exec(raw);
  return m ? { owner: m[1], name: m[2].replace(/\.git$/, '') } : null;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/vnd.github+json',
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const { statusCode } = res;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1_000_000) req.destroy(new Error('response too large'));
        });
        res.on('end', () => {
          if (statusCode === 404) return resolve({ notFound: true });
          if (statusCode === 403) return reject(new Error('GitHub rate limit reached, try again later'));
          if (statusCode !== 200) return reject(new Error(`GitHub returned ${statusCode}`));
          try {
            resolve({ data: JSON.parse(body) });
          } catch {
            reject(new Error('Could not read the response from GitHub'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Timed out contacting GitHub')));
    req.on('error', reject);
  });
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
    const res = await getJson(`https://api.github.com/repos/${repo.owner}/${repo.name}/releases/latest`);
    if (res.notFound) {
      return { ...base, status: 'none', releasesUrl, message: 'No releases have been published yet.' };
    }

    const release = res.data;
    const latest = release.tag_name || release.name || '';
    const newer = compareVersions(latest, currentVersion) > 0;
    // Prefer the installer if the release carries one.
    const installer = (release.assets || []).find((a) => /\.exe$/i.test(a.name));

    return {
      ...base,
      status: newer ? 'available' : 'current',
      latest: parseVersion(latest) ? parseVersion(latest).join('.') : latest,
      name: release.name || latest,
      notes: typeof release.body === 'string' ? release.body.slice(0, 4000) : '',
      publishedAt: release.published_at || null,
      url: release.html_url || releasesUrl,
      releasesUrl,
      assetName: installer ? installer.name : null,
      message: newer ? null : 'You are on the latest version.',
    };
  } catch (err) {
    return { ...base, status: 'error', releasesUrl, message: (err && err.message) || 'Update check failed.' };
  }
}

module.exports = { checkForUpdates, compareVersions, parseVersion, parseRepo };
