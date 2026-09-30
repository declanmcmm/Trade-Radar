const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {}
}

loadDotEnv(path.join(__dirname, '.env'));

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
  fs.createReadStream(file)
    .on('error', () => {
      res.writeHead(404);
      res.end('Not found');
    })
    .pipe(res);
}

async function getText(url, headers = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Trade-Radar/1.0',
        Accept: '*/*',
        ...headers
      },
      signal: controller.signal
    });

    const text = await r.text();

    if (!r.ok) {
      throw new Error(`Upstream HTTP ${r.status}`);
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function getJSON(url, headers = {}) {
  const text = await getText(url, headers);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Upstream returned invalid JSON');
  }
}

function finite(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function stamp() {
  return new Date().toISOString();
}

function cleanBars(timestamps, q) {
  const ts = timestamps || [];

  const o = q?.open || [];
  const h = q?.high || [];
  const l = q?.low || [];
  const c = q?.close || [];
  const v = q?.volume || [];

  return ts
    .map((x, i) => ({
      d: new Date(Number(x) * 1000).toISOString().slice(0, 10),
      o: finite(o[i]),
      h: finite(h[i]),
      l: finite(l[i]),
      c: finite(c[i]),
      v: finite(v[i])
    }))
    .filter(b =>
      b.d &&
      [b.o, b.h, b.l, b.c, b.v].every(Number.isFinite)
    );
}

/* -----------------------------
   YAHOO FINANCE
----------------------------- */

async function yahooBase(t) {
  let lastError;

  for (const host of [
    'query1.finance.yahoo.com',
    'query2.finance.yahoo.com'
  ]) {
    try {
      const url =
        `https://${host}/v8/finance/chart/` +
        `${encodeURIComponent(t)}` +
        `?range=2y&interval=1d&events=div%2Csplits`;

      const data = await getJSON(url);

      const result = data?.chart?.result?.[0];

      if (!result) {
        throw new Error('Ticker not found');
      }

      const meta = result.meta || {};

      const price =
        meta.regularMarketPrice ??
        meta.postMarketPrice ??
        meta.previousClose;

      const bars = cleanBars(
        result.timestamp,
        result.indicators?.quote?.[0]
      );

      if (!bars.length || !Number.isFinite(Number(price))) {
        throw new Error('No usable quote/history');
      }

      const now = stamp();

      return {
        ticker: t,
        name: meta.longName || meta.shortName || t,
        asof: bars.at(-1).d,

        sector: undefined,
        industry: undefined,

        provenance: {
          quote: {
            source: 'Yahoo Finance chart via Trade Radar backend',
            ts: now
          },
          bars: {
            source: 'Yahoo Finance chart via Trade Radar backend',
            ts: now
          }
        },

        quote: {
          price: Number(price),
          source: 'Yahoo Finance via backend'
        },

        bars,

        fundamentals: {
          marketCap: finite(meta.marketCap),
          sharesOut: undefined,
          floatShares: undefined,
          high52: undefined,
          low52: undefined,
          beta: undefined
        },

        earnings: undefined,
        options: undefined,
        catalysts: [],
        news: [],

        dataMode: 'automatic'
      };

    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Yahoo Finance unavailable');
}

/* -----------------------------
   STOOQ FALLBACK
----------------------------- */

async function stooqBase(t) {
  const symbol = `${t.toLowerCase()}.us`;

  const url =
    `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}` +
    `&d1=20240101&d2=20991231&i=d`;

  const csv = await getText(url);

  if (
    !csv ||
    csv.toLowerCase().includes('no data') ||
    csv.toLowerCase().includes('symbol not found')
  ) {
    throw new Error('Stooq has no data for this ticker');
  }

  const lines = csv.trim().split(/\r?\n/);

  if (lines.length < 3) {
    throw new Error('Stooq returned insufficient history');
  }

  const bars = [];

  for (const line of lines.slice(1)) {
    const parts = line.split(',');

    if (parts.length < 6) continue;

    const [date, open, high, low, close, volume] = parts;

    const bar = {
      d: date,
      o: finite(open),
      h: finite(high),
      l: finite(low),
      c: finite(close),
      v: finite(volume)
    };

    if (
      bar.d &&
      [bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite)
    ) {
      bars.push(bar);
    }
  }

  if (!bars.length) {
    throw new Error('Stooq returned no usable bars');
  }

  const last = bars.at(-1);

  return {
    ticker: t,
    name: t,
    asof: last.d,

    sector: undefined,
    industry: undefined,

    provenance: {
      quote: {
        source: 'Stooq via Trade Radar backend',
        ts: stamp()
      },
      bars: {
        source: 'Stooq via Trade Radar backend',
        ts: stamp()
      }
    },

    quote: {
      price: last.c,
      source: 'Stooq via backend'
    },

    bars,

    fundamentals: {
      marketCap: undefined,
      sharesOut: undefined,
      floatShares: undefined,
      high52: undefined,
      low52: undefined,
      beta: undefined
    },

    earnings: undefined,
    options: undefined,
    catalysts: [],
    news: [],

    dataMode: 'automatic'
  };
}

/* -----------------------------
   ALPHA VANTAGE ENRICHMENT
----------------------------- */

async function alpha(t, rec) {
  if (!AV_KEY) return rec;

  const base = 'https://www.alphavantage.co/query';

  const call = fn =>
    getJSON(
      `${base}?function=${fn}` +
      `&symbol=${encodeURIComponent(t)}` +
      `&apikey=${encodeURIComponent(AV_KEY)}`
    );

  const [overview, earnings, news] =
    await Promise.allSettled([
      call('OVERVIEW'),
      call('EARNINGS_CALENDAR'),
      call('NEWS_SENTIMENT')
    ]);

  /* Company overview */

  if (overview.status === 'fulfilled') {
    const o = overview.value;

    if (o && !o.Note && !o.Information) {
      rec.name = o.Name || rec.name;
      rec.sector = o.Sector || rec.sector;
      rec.industry = o.Industry || rec.industry;

      const f = rec.fundamentals || {};

      const fields = [
        ['marketCap', 'MarketCapitalization'],
        ['sharesOut', 'SharesOutstanding'],
        ['floatShares', 'SharesFloat'],
        ['high52', '52WeekHigh'],
        ['low52', '52WeekLow'],
        ['beta', 'Beta']
      ];

      for (const [destination, source] of fields) {
        const value = finite(o[source]);

        if (value !== undefined) {
          f[destination] = value;
        }
      }

      const target = finite(o.AnalystTargetPrice);

      if (target !== undefined) {
        f.analystTarget = target;
      }

      const rating =
        o.AnalystRating ||
        o.RecommendationMean;

      if (rating) {
        f.analystConsensus = String(rating);
      }

      const inst = finite(o.InstitutionalOwnership);

      if (inst !== undefined) {
        f.instOwnPct = inst;
      }

      rec.fundamentals = f;

      rec.provenance.fundamentals = {
        source: 'Alpha Vantage OVERVIEW',
        ts: stamp()
      };
    }
  }

  /* Earnings */

  if (
    earnings.status === 'fulfilled' &&
    Array.isArray(earnings.value)
  ) {
    const rows = earnings.value.filter(
      x =>
        String(x.symbol || '').toUpperCase() === t
    );

    if (rows.length) {
      const x = rows[0];

      rec.earnings = {
        date:
          x.reportDate ||
          x.date ||
          undefined,

        expectedMovePct: undefined
      };

      rec.provenance.earnings = {
        source: 'Alpha Vantage EARNINGS_CALENDAR',
        ts: stamp()
      };
    }
  }

  /* News */

  if (news.status === 'fulfilled') {
    const feed = news.value?.feed;

    if (Array.isArray(feed)) {
      rec.news = feed.slice(0, 20).map(x => ({
        headline: x.title || '',
        date: x.time_published
          ? `${x.time_published.slice(0, 4)}-` +
            `${x.time_published.slice(4, 6)}-` +
            `${x.time_published.slice(6, 8)}`
          : undefined,

        type: 'fact',

        sentiment:
          finite(x.overall_sentiment_score) || 0,

        source: x.source || ''
      }));

      rec.provenance.news = {
        source: 'Alpha Vantage NEWS_SENTIMENT',
        ts: stamp()
      };
    }
  }

  return rec;
}

/* -----------------------------
   FINNHUB ENRICHMENT
----------------------------- */

async function finnhub(t, rec) {
  if (!FINNHUB_KEY) return rec;

  const base = 'https://finnhub.io/api/v1';

  const get = endpoint =>
    getJSON(
      `${base}${endpoint}` +
      `${endpoint.includes('?') ? '&' : '?'}token=` +
      encodeURIComponent(FINNHUB_KEY)
    );

  const today = new Date();

  const from = new Date(
    Date.now() - 7 * 86400000
  );

  const earningsFrom = new Date(
    Date.now() - 30 * 86400000
  );

  const earningsTo = new Date(
    Date.now() + 120 * 86400000
  );

  const fmt = d =>
    d.toISOString().slice(0, 10);

  const [
    profile,
    earnings,
    news,
    shorts
  ] = await Promise.allSettled([
    get(`/stock/profile2?symbol=${encodeURIComponent(t)}`),

    get(
      `/calendar/earnings?symbol=${encodeURIComponent(t)}` +
      `&from=${fmt(earningsFrom)}` +
      `&to=${fmt(earningsTo)}`
    ),

    get(
      `/company-news?symbol=${encodeURIComponent(t)}` +
      `&from=${fmt(from)}` +
      `&to=${fmt(today)}`
    ),

    get(
      `/stock/short-interest?symbol=${encodeURIComponent(t)}`
    )
  ]);

  /* Profile */

  if (profile.status === 'fulfilled') {
    const p = profile.value;

    rec.name = p.name || rec.name;

    rec.sector =
      p.finnhubIndustry ||
      rec.sector;

    const f = rec.fundamentals || {};

    const marketCap =
      finite(p.marketCapitalization);

    if (marketCap !== undefined) {
      f.marketCap = marketCap * 1e6;
    }

    const shares =
      finite(p.shareOutstanding);

    if (shares !== undefined) {
      f.sharesOut = shares * 1e6;
    }

    rec.fundamentals = f;
  }

  /* Earnings */

  if (
    earnings.status === 'fulfilled' &&
    Array.isArray(
      earnings.value?.earningsCalendar
    ) &&
    earnings.value.earningsCalendar.length
  ) {
    const x =
      earnings.value.earningsCalendar[0];

    rec.earnings = {
      date: x.date,
      expectedMovePct: undefined
    };
  }

  /* News */

  if (
    news.status === 'fulfilled' &&
    Array.isArray(news.value)
  ) {
    rec.news = news.value
      .slice(0, 20)
      .map(x => ({
        headline: x.headline || '',
        date: x.datetime
          ? new Date(
              x.datetime * 1000
            ).toISOString().slice(0, 10)
          : undefined,

        type: 'fact',
        sentiment: 0,
        source: x.source || 'Finnhub'
      }));
  }

  /* Short interest */

  if (
    shorts.status === 'fulfilled' &&
    Array.isArray(shorts.value?.data) &&
    shorts.value.data.length
  ) {
    const x = shorts.value.data[0];

    const f = rec.fundamentals || {};

    const shortShares =
      finite(x.shortInterest);

    if (shortShares !== undefined) {
      f.shortShares = shortShares;
    }

    const shortPct =
      finite(x.shortInterestPercentOfFloat);

    if (shortPct !== undefined) {
      f.shortPctFloat = shortPct;
    }

    rec.fundamentals = f;
  }

  return rec;
}

/* -----------------------------
   MAIN STOCK PIPELINE
----------------------------- */

async function stock(ticker) {
  const t = ticker
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, '');

  if (!/^[A-Z0-9.\-]{1,12}$/.test(t)) {
    throw new Error('Invalid ticker');
  }

  const cached = cache.get(t);

  if (
    cached &&
    Date.now() - cached.ts < CACHE_MS
  ) {
    return cached.data;
  }

  let rec;
  let primarySource = '';

  /* Try Yahoo first */

  try {
    rec = await yahooBase(t);
    primarySource = 'Yahoo Finance';
  } catch (yahooError) {

    /* Try Stooq if Yahoo fails */

    try {
      rec = await stooqBase(t);
      primarySource = 'Stooq';

      rec.warnings = [
        `Yahoo Finance unavailable: ${yahooError.message}`,
        'Using Stooq fallback data.'
      ];

    } catch (stooqError) {

      throw new Error(
        `TR-206: Market data unavailable. ` +
        `Yahoo: ${yahooError.message}. ` +
        `Stooq: ${stooqError.message}.`
      );
    }
  }

  /* Optional Alpha Vantage enrichment */

  try {
    rec = await alpha(t, rec);
  } catch (error) {
    rec.warnings = [
      ...(rec.warnings || []),
      `Alpha Vantage enrichment unavailable: ${error.message}`
    ];
  }

  /* Optional Finnhub enrichment */

  try {
    rec = await finnhub(t, rec);
  } catch (error) {
    rec.warnings = [
      ...(rec.warnings || []),
      `Finnhub enrichment unavailable: ${error.message}`
    ];
  }

  rec.dataMode = 'automatic';

  rec.provenance = {
    ...(rec.provenance || {}),
    primary: {
      source: primarySource,
      ts: stamp()
    }
  };

  cache.set(t, {
    ts: Date.now(),
    data: rec
  });

  return rec;
}

/* -----------------------------
   SERVER
----------------------------- */

const server = http.createServer(
  async (req, res) => {
    try {
      const url = new URL(
        req.url,
        `http://${req.headers.host || 'localhost'}`
      );

      /* Health check */

      if (url.pathname === '/api/health') {
        return json(res, 200, {
          ok: true,
          service: 'trade-radar',
          time: stamp(),

          providers: {
            yahoo: true,
            stooq: true,
            alphaVantage: Boolean(AV_KEY),
            finnhub: Boolean(FINNHUB_KEY)
          }
        });
      }

      /* Stock API */

      if (url.pathname === '/api/stock') {
        const symbol =
          url.searchParams.get('symbol');

        if (!symbol) {
          return json(res, 400, {
            ok: false,
            error: 'Missing symbol'
          });
        }

        const data =
          await stock(symbol);

        return json(res, 200, {
          ok: true,
          data
        });
      }

      /* Website */

      if (
        url.pathname === '/' ||
        url.pathname === '/index.html'
      ) {
        return sendFile(res, INDEX);
      }

      /* Assets */

      if (url.pathname.startsWith('/assets/')) {
        const safePath =
          path.normalize(
            path.join(ROOT, url.pathname)
          );

        if (!safePath.startsWith(ROOT)) {
          res.writeHead(403);
          return res.end('Forbidden');
        }

        return sendFile(res, safePath);
      }

      res.writeHead(404);
      res.end('Not found');

    } catch (error) {
      console.error(error);

      return json(res, 500, {
        ok: false,
        error:
          error.message ||
          'Server error'
      });
    }
  }
);

server.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `Trade Radar running on port ${PORT}`
    );
  }
);