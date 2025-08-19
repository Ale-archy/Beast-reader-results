import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';

const app = express();
app.use(cors());

// --- robust digit grabber (handles different page structures) ---
async function fetchDigits(url, howMany) {
  const html = (await axios.get(url, { timeout: 15000 })).data;
  const $ = cheerio.load(html);

  // Try 1: the “Latest numbers” list block (common across LotteryUSA)
  let digits = $('h2:contains("Latest numbers")')
    .first()
    .nextAll()
    .find('li')
    .slice(0, howMany)
    .map((i, el) => $(el).text().trim())
    .get();

  // Try 2: generic “winning number” spans (used on some pages)
  if (digits.length !== howMany) {
    digits = $('[class*="winning"], [data-automation-id*="winning"]')
      .filter((i, el) => /^\d$/.test($(el).text().trim()))
      .slice(0, howMany)
      .map((i, el) => $(el).text().trim())
      .get();
  }

  // Try 3: fallback — first N single digits found near the top
  if (digits.length !== howMany) {
    const text = $('main').text().replace(/\s+/g, ' ');
    const rx = new RegExp(
      `(?:\\D|^)(\\d)(?:\\D+)(\\d)(?:\\D+)(\\d)` + (howMany === 4 ? '(?:\\D+)(\\d)' : '')
    );
    const m = text.match(rx);
    if (m) digits = m.slice(1, howMany + 1);
  }

  const joined = digits.join('');
  return /^\d+$/.test(joined) && joined.length === howMany ? joined : null;
}

async function tryPaths(base, paths, n) {
  for (const p of paths) {
    try {
      const v = await fetchDigits(`${base}${p}/`, n);
      if (v) return v;
    } catch { /* keep trying */ }
  }
  return null;
}

// --- state configs (LotteryUSA slugs + path candidates) ---
const CFG = {
  ny: {
    slug: 'new-york',
    p3: { mid: ['midday-numbers'],            eve: ['numbers'] },
    p4: { mid: ['midday-win-4'],              eve: ['win-4']   }
  },
  nj: {
    slug: 'new-jersey',
    p3: { mid: ['midday-pick-3', 'midday-numbers'], eve: ['pick-3', 'numbers'] },
    p4: { mid: ['midday-pick-4', 'midday-win-4'],   eve: ['pick-4', 'win-4']   }
  },
  ct: {
    slug: 'connecticut', // CT uses Play 3/Play 4 and Day/Night
    p3: { mid: ['play-3-day', 'midday-play-3', 'day-numbers', 'midday-numbers'],
           eve: ['play-3-night', 'evening-play-3', 'night-numbers', 'evening-numbers'] },
    p4: { mid: ['play-4-day', 'midday-play-4', 'day-win-4', 'midday-win-4'],
           eve: ['play-4-night', 'evening-play-4', 'night-win-4', 'evening-win-4'] }
  },
  fl: {
    slug: 'florida',
    p3: { mid: ['midday-pick-3', 'midday-numbers'], eve: ['pick-3', 'numbers'] },
    p4: { mid: ['midday-pick-4', 'midday-win-4'],   eve: ['pick-4', 'win-4']   }
  }
};

function makeGetter(cfg) {
  return async () => {
    const base = `https://www.lotteryusa.com/${cfg.slug}/`;
    const [mid3, mid4, eve3, eve4] = await Promise.all([
      tryPaths(base, cfg.p3.mid, 3),
      tryPaths(base, cfg.p4.mid, 4),
      tryPaths(base, cfg.p3.eve, 3),
      tryPaths(base, cfg.p4.eve, 4)
    ]);
    const dateISO = dayjs().hour(12).minute(0).second(0).millisecond(0).toDate().toISOString();
    return {
      dateISO,
      midday:  mid3 && mid4 ? `${mid3}-${mid4}` : null,
      evening: eve3 && eve4 ? `${eve3}-${eve4}` : null
    };
  };
}

const getters = {
  ny: makeGetter(CFG.ny),
  nj: makeGetter(CFG.nj),
  ct: makeGetter(CFG.ct),
  fl: makeGetter(CFG.fl)
};

// --- routes ---
app.get('/api/:state/latest', async (req, res) => {
  const state = String(req.params.state || '').toLowerCase();
  const getter = getters[state];
  if (!getter) return res.status(404).json({ error: 'unsupported_state' });
  try {
    const out = await getter();
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: 'scrape_failed', detail: String(e?.message || e) });
  }
});

// Backwards-compat alias for existing frontend
app.get('/api/ny/latest', async (_req, res) => {
  try { res.json(await getters.ny()); } catch (e) { res.status(502).json({ error: 'scrape_failed', detail: String(e?.message || e) }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bridge up on http://localhost:' + PORT));
