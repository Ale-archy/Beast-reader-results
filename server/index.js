import express from 'express';
import cors from 'cors';
import pino from 'pino';
import axios from 'axios';
import * as cheerio from 'cheerio';
import dayjs from 'dayjs';
import { chromium } from 'playwright';

const log = pino({ level: process.env.LOG_LEVEL || 'info' });
const app = express();
app.use(cors());

let cache = { payload:null, ts:0 }; // 60s TTL
const ttlMs = 60 * 1000;

// ---- Source A: LotteryUSA (fast, static HTML) ----
async function fromLotteryUSA(){
  // Midday Numbers: 3 digits
  const midHTML = (await axios.get('https://www.lotteryusa.com/new-york/midday-numbers/', {timeout: 15000})).data;
  const $m = cheerio.load(midHTML);
  const mid3 = $m('h2:contains("Latest numbers")').first()
                .nextAll().find('li').slice(0,3).map((i,el)=>$m(el).text().trim()).get().join('');
  // Midday Win4: 4 digits
  const w4mHTML = (await axios.get('https://www.lotteryusa.com/new-york/midday-win-4/', {timeout: 15000})).data;
  const $w4m = cheerio.load(w4mHTML);
  const mid4 = $w4m('h2:contains("Latest numbers")').first()
                 .nextAll().find('li').slice(0,4).map((i,el)=>$w4m(el).text().trim()).get().join('');

  // Evening pages
  const eveHTML = (await axios.get('https://www.lotteryusa.com/new-york/numbers/', {timeout: 15000})).data;
  const $e = cheerio.load(eveHTML);
  const eve3 = $e('h2:contains("Latest numbers")').first()
               .nextAll().find('li').slice(0,3).map((i,el)=>$e(el).text().trim()).get().join('');
  const w4eHTML = (await axios.get('https://www.lotteryusa.com/new-york/win-4/', {timeout: 15000})).data;
  const $w4e = cheerio.load(w4eHTML);
  const eve4 = $w4e('h2:contains("Latest numbers")').first()
               .nextAll().find('li').slice(0,4).map((i,el)=>$w4e(el).text().trim()).get().join('');

  // Date: prefer today ET at noon for stability
  const dateISO = dayjs().hour(12).minute(0).second(0).millisecond(0).toDate().toISOString();
  const out = { dateISO, midday: `${mid3}-${mid4}`, evening: `${eve3}-${eve4}` };
  if(!/^\d{3}-\d{4}$/.test(out.midday)) out.midday = null;
  if(!/^\d{3}-\d{4}$/.test(out.evening)) out.evening = null;
  return out;
}

// ---- Source B: NY official site (JS; use Playwright) ----
async function fromNYOfficial(){
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ javaScriptEnabled:true });
  // Numbers page
  await page.goto('https://nylottery.ny.gov/draw-game/?game=numbers', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Try to sniff the JSON call (site is an SPA)
  const apiResp = await page.waitForResponse(r =>
    r.url().includes('nylottery.ny.gov') &&
    /application\/json/i.test(r.headers()['content-type'] || ''), { timeout: 15000 }).catch(()=>null);

  let mid3=null, eve3=null;
  try {
    if (apiResp) {
      const data = await apiResp.json();
      // adapt these two lines after you inspect the structure:
      mid3 = String((data.midday?.winningNumbers||[]).join('')||'');
      eve3 = String((data.evening?.winningNumbers||[]).join('')||'');
    }
  } catch {}
  // Win4
  await page.goto('https://nylottery.ny.gov/draw-game/?game=win4', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const apiResp2 = await page.waitForResponse(r =>
    r.url().includes('nylottery.ny.gov') &&
    /application\/json/i.test(r.headers()['content-type'] || ''), { timeout: 15000 }).catch(()=>null);

  let mid4=null, eve4=null;
  try {
    if (apiResp2) {
      const data = await apiResp2.json();
      mid4 = String((data.midday?.winningNumbers||[]).join('')||'');
      eve4 = String((data.evening?.winningNumbers||[]).join('')||'');
    }
  } catch {}
  await browser.close();

  const out = {
    dateISO: new Date().toISOString(),
    midday:  mid3 && mid4 ? `${mid3}-${mid4}` : null,
    evening: eve3 && eve4 ? `${eve3}-${eve4}` : null
  };
  return out;
}

// ---- Aggregator with fallback + short cache ----
async function getNY(){
  const now = Date.now();
  if (cache.payload && now - cache.ts < ttlMs) return cache.payload;

  let a=null, b=null;
  try { a = await fromLotteryUSA(); } catch(e){ log.warn({msg:'lotteryusa failed', e:e.message}); }
  // Use official only if something missing (or near draw time you can prefer it)
  if(!a?.midday || !a?.evening){
    try { b = await fromNYOfficial(); } catch(e){ log.warn({msg:'nyofficial failed', e:e.message}); }
  }
  const best = {
    dateISO: (a?.dateISO || b?.dateISO || new Date().toISOString()),
    midday:  a?.midday  || b?.midday  || null,
    evening: a?.evening || b?.evening || null
  };
  cache = { payload: best, ts: now };
  return best;
}

app.get('/api/ny/latest', async (req,res)=>{
  try { res.json(await getNY()); }
  catch(e){ res.status(502).json({error:'upstream failed', detail:e.message}); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> log.info({msg:'lotto-bridge up', port:PORT}));