const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
function loadDotEnv(file){
  try{
    for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
      const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if(m && !process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['\"]|['\"]$/g,'');
    }
  }catch{}
}
loadDotEnv(path.join(__dirname,'.env'));
const AV_KEY = process.env.ALPHA_VANTAGE_API_KEY || '';
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
const ROOT = __dirname;
const INDEX = path.join(ROOT, 'trade-radar.html');

const cache = new Map();
const CACHE_MS = 60 * 1000;

function json(res, status, body) {
  const out = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(out);
}
function sendFile(res, file) {
  fs.createReadStream(file).on('error', () => { res.writeHead(404); res.end('Not found'); }).pipe(res);
}
async function getJSON(url, headers={}) {
  const r = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Upstream returned non-JSON (${r.status})`); }
  if (!r.ok) throw new Error(`Upstream HTTP ${r.status}`);
  return data;
}

function finite(x) { const n = Number(x); return Number.isFinite(n) ? n : undefined; }
function stamp() { return new Date().toISOString(); }
function cleanBars(timestamps, q) {
  const ts = timestamps || [];
  const o = q?.open || [], h = q?.high || [], l = q?.low || [], c = q?.close || [], v = q?.volume || [];
  return ts.map((x,i)=>({
    d:new Date(Number(x)*1000).toISOString().slice(0,10),
    o:finite(o[i]), h:finite(h[i]), l:finite(l[i]), c:finite(c[i]), v:finite(v[i])
  })).filter(b=>b.d && [b.o,b.h,b.l,b.c,b.v].every(Number.isFinite));
}

async function yahooBase(t) {
  let last;
  for (const host of ['query1.finance.yahoo.com','query2.finance.yahoo.com']) {
    try {
      const u=`https://${host}/v8/finance/chart/${encodeURIComponent(t)}?range=1y&interval=1d&events=div%2Csplits`;
      const j=await getJSON(u);
      const r=j?.chart?.result?.[0];
      if (!r) throw new Error('Ticker not found');
      const meta=r.meta||{}, q=meta.regularMarketPrice ?? meta.postMarketPrice ?? meta.previousClose;
      const bars=cleanBars(r.timestamp, r.indicators?.quote?.[0]);
      if (!bars.length || !Number.isFinite(Number(q))) throw new Error('No usable quote/history');
      const now=stamp();
      return {
        ticker:t,
        name:meta.longName||meta.shortName||t,
        asof:bars.at(-1).d,
        sector:undefined,
        industry:undefined,
        provenance:{quote:{source:'Yahoo Finance chart via Trade Radar backend',ts:now},bars:{source:'Yahoo Finance chart via Trade Radar backend',ts:now}},
        quote:{price:Number(q),source:'Yahoo Finance chart via backend'},
        bars,
        fundamentals:{marketCap:finite(meta.marketCap),sharesOut:undefined,floatShares:undefined,high52:undefined,low52:undefined,beta:undefined},
        earnings:undefined,options:undefined,catalysts:[],news:[],
        dataMode:'automatic',
      };
    } catch(e){ last=e; }
  }
  throw last || new Error('Yahoo Finance unavailable');
}

async function alpha(t, rec) {
  if (!AV_KEY) return rec;
  const base='https://www.alphavantage.co/query';
  const call=async fn=>getJSON(`${base}?function=${fn}&symbol=${encodeURIComponent(t)}&apikey=${encodeURIComponent(AV_KEY)}`);
  const [ov,earn,news] = await Promise.allSettled([call('OVERVIEW'),call('EARNINGS_CALENDAR'),call('NEWS_SENTIMENT')]);
  const o=ov.status==='fulfilled'?ov.value:null;
  if (o && !o.Note && !o.Information) {
    rec.name=o.Name||rec.name; rec.sector=o.Sector||rec.sector; rec.industry=o.Industry||rec.industry;
    const f=rec.fundamentals||{};
    for (const [dst,key] of [['marketCap','MarketCapitalization'],['sharesOut','SharesOutstanding'],['floatShares','SharesFloat'],['high52','52WeekHigh'],['low52','52WeekLow'],['beta','Beta']]) {
      const n=finite(o[key]); if(n!==undefined) f[dst]=n;
    }
    const target=finite(o.AnalystTargetPrice); if(target!==undefined) f.analystTarget=target;
    const rating=o.AnalystRating||o.RecommendationMean; if(rating) f.analystConsensus=String(rating);
    const inst=finite(o.InstitutionalOwnership); if(inst!==undefined) f.instOwnPct=inst;
    rec.fundamentals=f;
    rec.provenance.fundamentals={source:'Alpha Vantage OVERVIEW via Trade Radar backend',ts:stamp()};
  }
  if (earn.status==='fulfilled' && Array.isArray(earn.value)) {
    const rows=earn.value.filter(x=>String(x.symbol||'').toUpperCase()===t);
    if(rows.length){
      const x=rows[0]; rec.earnings={date:x.reportDate||x.estimatedEPS||x.date,expectedMovePct:undefined};
      rec.provenance.earnings={source:'Alpha Vantage EARNINGS_CALENDAR via Trade Radar backend',ts:stamp()};
    }
  }
  if (news.status==='fulfilled') {
    const feed=news.value?.feed;
    if(Array.isArray(feed)) rec.news=feed.slice(0,20).map(x=>({headline:x.title||'',date:x.time_published?`${x.time_published.slice(0,4)}-${x.time_published.slice(4,6)}-${x.time_published.slice(6,8)}`:undefined,type:'fact',sentiment:finite(x.overall_sentiment_score)||0,source:x.source||''}));
    rec.provenance.news={source:'Alpha Vantage NEWS_SENTIMENT via Trade Radar backend',ts:stamp()};
  }
  return rec;
}

async function finnhub(t, rec) {
  if (!FINNHUB_KEY) return rec;
  const h={}; const base='https://finnhub.io/api/v1';
  const get=(p)=>getJSON(`${base}${p}${p.includes('?')?'&':'?'}token=${encodeURIComponent(FINNHUB_KEY)}`,h);
  const now=Math.floor(Date.now()/1000), from=now-365*86400;
  const [profile,earn,news,shorts] = await Promise.allSettled([
    get(`/stock/profile2?symbol=${encodeURIComponent(t)}`),
    get(`/calendar/earnings?symbol=${encodeURIComponent(t)}&from=${new Date(Date.now()-86400000*30).toISOString().slice(0,10)}&to=${new Date(Date.now()+86400000*120).toISOString().slice(0,10)}`),
    get(`/company-news?symbol=${encodeURIComponent(t)}&from=${new Date(Date.now()-86400000*7).toISOString().slice(0,10)}&to=${new Date().toISOString().slice(0,10)}`),
    get(`/stock/short-interest?symbol=${encodeURIComponent(t)}`)
  ]);
  if(profile.status==='fulfilled'){
    const p=profile.value; rec.name=p.name||rec.name; rec.sector=p.finnhubIndustry||rec.sector;
    const f=rec.fundamentals||{}; if(finite(p.marketCapitalization)!==undefined) f.marketCap=Number(p.marketCapitalization)*1e6; if(finite(p.shareOutstanding)!==undefined) f.sharesOut=Number(p.shareOutstanding)*1e6; rec.fundamentals=f;
  }
  if(earn.status==='fulfilled' && Array.isArray(earn.value?.earningsCalendar) && earn.value.earningsCalendar.length){ const x=earn.value.earningsCalendar[0]; rec.earnings={date:x.date,expectedMovePct:undefined}; }
  if(news.status==='fulfilled' && Array.isArray(news.value)) rec.news=news.value.slice(0,20).map(x=>({headline:x.headline,date:new Date(x.datetime*1000).toISOString().slice(0,10),type:'fact',sentiment:0,source:x.source||'Finnhub'}));
  if(shorts.status==='fulfilled' && Array.isArray(shorts.value?.data) && shorts.value.data.length){ const x=shorts.value.data[0], f=rec.fundamentals||{}; if(finite(x.shortInterest)!==undefined) f.shortShares=Number(x.shortInterest); if(finite(x.shortInterestPercentOfFloat)!==undefined) f.shortPctFloat=Number(x.shortInterestPercentOfFloat); rec.fundamentals=f; }
  return rec;
}

async function stock(t) {
  t=t.toUpperCase().replace(/[^A-Z0-9.\-]/g,'');
  if(!/^[A-Z0-9.\-]{1,12}$/.test(t)) throw new Error('Invalid ticker');
  const hit=cache.get(t); if(hit && Date.now()-hit.ts<CACHE_MS) return hit.data;
  let rec=await yahooBase(t);
  // Optional enrichment. Basic automatic market data works without API keys.
  try { rec=await alpha(t,rec); } catch(e) { rec.warnings=(rec.warnings||[]).concat('Alpha Vantage enrichment unavailable: '+e.message); }
  try { rec=await finnhub(t,rec); } catch(e) { rec.warnings=(rec.warnings||[]).concat('Finnhub enrichment unavailable: '+e.message); }
  cache.set(t,{ts:Date.now(),data:rec});
  return rec;
}

const server=http.createServer(async (req,res)=>{
  try {
    const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(u.pathname==='/api/health') return json(res,200,{ok:true,service:'trade-radar',time:stamp(),providers:{yahoo:true,alphaVantage:!!AV_KEY,finnhub:!!FINNHUB_KEY}});
    if(u.pathname==='/api/stock'){
      const symbol=u.searchParams.get('symbol');
      if(!symbol) return json(res,400,{ok:false,error:'Missing symbol'});
      const data=await stock(symbol);
      return json(res,200,{ok:true,data});
    }
    if(u.pathname==='/' || u.pathname==='/index.html') return sendFile(res,INDEX);
    if(u.pathname.startsWith('/assets/')) return sendFile(res,path.join(ROOT,u.pathname));
    res.writeHead(404);res.end('Not found');
  } catch(e) { json(res,500,{ok:false,error:e.message||'Server error'}); }
});
server.listen(PORT,HOST,()=>console.log(`Trade Radar running at http://localhost:${PORT}`));
