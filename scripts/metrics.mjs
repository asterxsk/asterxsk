#!/usr/bin/env node
// scripts/metrics.mjs
// Self-owned telemetry strip generator for the profile README.
// Dependency-free: uses only Node globals (fetch, fs/promises, URL) — no npm installs.
//
// Hard rules enforced here:
//   - Any metric that resolves to 0, null, or NaN is OMITTED (never rendered as 0).
//   - Layout re-flows: x positions are computed from the filtered array, never hardcoded.
//   - Output is deterministic: metrics are sorted by label, numbers are formatted with a
//     fixed routine, and no timestamps/randomness enter the file, so CI produces a
//     byte-identical SVG when nothing changed (the workflow only commits on diff).
//   - NO <script>, NO external href, NO web fonts. SMIL-only animation.

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const USER = 'asterxsk';
const NPM_PACKAGES = ['@asterxsk/kiln', '@asterxsk/croctui'];

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

const GH_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'asterxsk-telemetry',
};

async function getJSON(url, headers = {}, retries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(400 * 2 ** attempt);
    }
  }
  throw lastError;
}

async function fetchPublicRepos(token) {
  const headers = token ? { ...GH_HEADERS, Authorization: `Bearer ${token}` } : GH_HEADERS;
  const json = await getJSON(`https://api.github.com/users/${USER}`, headers);
  return json.public_repos;
}

async function fetchNpm() {
  const results = await Promise.all(
    NPM_PACKAGES.map(async (name) => {
      try {
        const json = await getJSON(`https://api.npmjs.org/downloads/point/last-month/${name}`);
        return Number(json.downloads);
      } catch {
        return null;
      }
    }),
  );
  const usable = results.filter((n) => Number.isFinite(n));
  return {
    packageCount: usable.length,
    downloads: usable.reduce((a, b) => a + b, 0),
  };
}

async function fetchContributions(token) {
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{totalContributions}}}}`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'asterxsk-telemetry',
    },
    body: JSON.stringify({ query, variables: { login: USER } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for graphql`);
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));
  return json.data?.user?.contributionsCollection?.contributionCalendar?.totalContributions;
}

// ---------------------------------------------------------------------------
// Metric assembly
// ---------------------------------------------------------------------------

// A metric counts only if it is a finite number strictly greater than zero.
// 0, null, undefined, NaN, Infinity, and negative values are all omitted.
function isRenderable(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

async function collectMetrics() {
  const metrics = [];
  const skipped = [];

  // 1. Public repos (GitHub REST).
  try {
    const repos = await fetchPublicRepos(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '');
    if (isRenderable(repos)) metrics.push({ label: 'public repos', value: repos });
    else skipped.push(`public repos -> ${repos}`);
  } catch (error) {
    skipped.push(`public repos -> ${error.message}`);
  }

  // 2. npm packages published + rolling 30-day downloads.
  const npm = await fetchNpm();
  if (isRenderable(npm.packageCount)) metrics.push({ label: 'npm packages', value: npm.packageCount });
  else skipped.push(`npm packages -> ${npm.packageCount}`);
  if (isRenderable(npm.downloads)) metrics.push({ label: 'downloads / 30d', value: npm.downloads });
  else skipped.push(`downloads / 30d -> ${npm.downloads}`);

  // 3. Contribution total — ONLY when a token is present. Never a stale/hardcoded value.
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (token) {
    try {
      const contributions = await fetchContributions(token);
      if (isRenderable(contributions)) metrics.push({ label: 'contributions / yr', value: contributions });
      else skipped.push(`contributions / yr -> ${contributions}`);
    } catch (error) {
      skipped.push(`contributions / yr -> ${error.message}`);
    }
  } else {
    skipped.push('contributions / yr -> no GH_TOKEN, skipped');
  }

  // Deterministic, sorted output: order is fixed by label regardless of fetch timing.
  metrics.sort((a, b) => a.label.localeCompare(b.label, 'en'));
  return { metrics, skipped };
}

// ---------------------------------------------------------------------------
// SVG rendering — one template, palette is the only variable
// ---------------------------------------------------------------------------

// Squared, Zed-style: no radii, no gradients, hairline rules, one muted accent.
const PALETTES = {
  dark: {
    id: 'dark',
    bg: '#0d1117',
    fg: '#e6edf3',
    muted: '#7d8590',
    hairline: '#21262d',
    border: '#30363d',
    accent: '#ff6b1a',
  },
  light: {
    id: 'light',
    bg: '#ffffff',
    fg: '#1f2328',
    muted: '#656d76',
    hairline: '#d8dee4',
    border: '#d0d7de',
    accent: '#e8590c',
  },
};

const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
const SANS = '-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif';

const W = 880;
const H = 120;
const PAD = 36;

function formatNumber(n) {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render(palette, metrics) {
  const n = metrics.length;
  const cellW = n > 0 ? (W - PAD * 2) / n : W - PAD * 2;
  const id = (suffix) => `tm-${palette.id}-${suffix}`;

  // x positions are derived from the filtered array — never hardcoded.
  const cells = metrics.map((m, i) => {
    const cx = PAD + cellW * (i + 0.5);
    const ruleW = Math.min(cellW * 0.56, 132);
    return { ...m, cx, ruleW, begin: (0.12 + i * 0.09).toFixed(2) };
  });

  const dividers = [];
  for (let j = 1; j < n; j += 1) {
    const x = (PAD + cellW * j).toFixed(2);
    dividers.push(
      `<rect x="${x}" y="54" width="1" height="50" fill="${palette.hairline}" shape-rendering="crispEdges"/>`,
    );
  }

  const figureParts = [];
  for (const c of cells) {
    const x1 = (c.cx - c.ruleW / 2).toFixed(2);
    figureParts.push(
      [
        `<text x="${c.cx.toFixed(2)}" y="68" text-anchor="middle" font-family="${MONO}" font-size="11" letter-spacing="1.4" fill="${palette.muted}">${esc(c.label.toUpperCase())}</text>`,
        `<text x="${c.cx.toFixed(2)}" y="99" text-anchor="middle" font-family="${MONO}" font-size="32" font-weight="700" fill="${palette.fg}">${esc(formatNumber(c.value))}</text>`,
        `<rect x="${x1}" y="106" height="2" width="0" fill="${palette.accent}">` +
          `<animate attributeName="width" from="0" to="${c.ruleW.toFixed(2)}" begin="${c.begin}s" dur="0.5s" fill="freeze"/>` +
          `</rect>`,
      ].join(''),
    );
  }

  const desc = metrics.map((m) => `${formatNumber(m.value)} ${m.label}`).join(', ');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="${id('title')} ${id('desc')}" font-family="${SANS}">`,
    `<title id="${id('title')}">asterxsk live telemetry</title>`,
    `<desc id="${id('desc')}">${esc(desc || 'no metrics available')}</desc>`,
    `<rect x="0" y="0" width="${W}" height="${H}" fill="${palette.bg}"/>`,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="${palette.border}" stroke-width="1" shape-rendering="crispEdges"/>`,
    `<rect x="${PAD}" y="20" width="7" height="7" fill="${palette.accent}">`,
    '<animate attributeName="opacity" values="1;0" dur="1.06s" calcMode="discrete" repeatCount="indefinite"/>',
    '</rect>',
    `<text x="${PAD + 15}" y="27" font-family="${MONO}" font-size="10" letter-spacing="1.6" fill="${palette.muted}">TELEMETRY</text>`,
    `<text x="${W - PAD}" y="27" text-anchor="end" font-family="${MONO}" font-size="10" letter-spacing="1.2" fill="${palette.muted}">${
      metrics.length ? 'GENERATED DAILY &#183; SELF-OWNED' : 'AWAITING DATA'
    }</text>`,
    `<rect x="${PAD}" y="38" width="${W - PAD * 2}" height="1" fill="${palette.hairline}" shape-rendering="crispEdges"/>`,
    ...dividers,
    ...figureParts,
    '</svg>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { metrics, skipped } = await collectMetrics();

  console.log(`metrics rendered: ${metrics.length}`);
  for (const m of metrics) console.log(`  ${formatNumber(m.value).padStart(6)}  ${m.label}`);
  if (skipped.length) {
    console.log('omitted (0 / null / NaN / unavailable):');
    for (const s of skipped) console.log(`  - ${s}`);
  }

  await mkdir(ASSETS, { recursive: true });
  for (const key of ['dark', 'light']) {
    const svg = render(PALETTES[key], metrics);
    const file = path.join(ASSETS, `telemetry-${key}.svg`);
    await writeFile(file, svg, 'utf8');
    console.log(`wrote ${path.relative(ROOT, file)}  ${Buffer.byteLength(svg, 'utf8')} bytes`);
  }
}

main().catch((error) => {
  console.error(`metrics.mjs failed: ${error.message}`);
  process.exitCode = 1;
});
