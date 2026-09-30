const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;

const CACHE = new Map();
const CACHE_TTL = 60 * 1000;

// Yahoo session state
let yahooCookie = "";
let yahooCrumb = "";
let yahooSessionTime = 0;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function cleanTicker(symbol) {
  return String(symbol || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-^=]/g, "")
    .slice(0, 15);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpGet(url, headers = {}, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);

    const options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "GET",
      timeout,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive",
        ...headers
      }
    };

    const req = https.request(options, res => {
      let body = "";

      res.setEncoding("utf8");

      res.on("data", chunk => {
        body += chunk;
      });

      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body
        });
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error("Request timeout"));
    });

    req.on("error", reject);

    req.end();
  });
}

/*
 * Establish a Yahoo session.
 *
 * Yahoo sometimes requires a cookie/crumb combination before
 * accepting requests from server environments.
 */
async function establishYahooSession(force = false) {
  const now = Date.now();

  if (
    !force &&
    yahooCookie &&
    yahooCrumb &&
    now - yahooSessionTime < 20 * 60 * 1000
  ) {
    return true;
  }

  const hosts = [
    "https://fc.yahoo.com",
    "https://query1.finance.yahoo.com",
    "https://query2.finance.yahoo.com"
  ];

  let cookie = "";

  for (const base of hosts) {
    try {
      const r = await httpGet(base + "/");

      const setCookie = r.headers["set-cookie"];

      if (Array.isArray(setCookie)) {
        cookie = setCookie
          .map(x => x.split(";")[0])
          .join("; ");
      }

      if (cookie) break;
    } catch (_) {}
  }

  if (!cookie) {
    // Yahoo sometimes doesn't send a cookie from the root endpoint.
    // Continue and try crumb directly.
    cookie = yahooCookie || "";
  }

  let crumb = "";

  try {
    const r = await httpGet(
      "https://query1.finance.yahoo.com/v1/test/getcrumb",
      {
        Cookie: cookie
      }
    );

    if (r.status === 200 && r.body && !r.body.includes("<")) {
      crumb = r.body.trim();
    }
  } catch (_) {}

  if (!crumb) {
    try {
      const r = await httpGet(
        "https://query2.finance.yahoo.com/v1/test/getcrumb",
        {
          Cookie: cookie
        }
      );

      if (r.status === 200 && r.body && !r.body.includes("<")) {
        crumb = r.body.trim();
      }
    } catch (_) {}
  }

  if (crumb) {
    yahooCrumb = crumb;
    yahooCookie = cookie;
    yahooSessionTime = now;
    return true;
  }

  // Chart endpoint frequently works without a crumb.
  if (cookie) {
    yahooCookie = cookie;
    yahooSessionTime = now;
  }

  return false;
}

function buildYahooHeaders() {
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://finance.yahoo.com/",
    "Origin": "https://finance.yahoo.com"
  };

  if (yahooCookie) {
    headers.Cookie = yahooCookie;
  }

  return headers;
}

async function yahooChart(symbol, range = "2y") {
  await establishYahooSession();

  const hosts = [
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com"
  ];

  const errors = [];

  for (const host of hosts) {
    const params = new URLSearchParams({
      period1: String(Math.floor(Date.now() / 1000) - 2 * 365 * 24 * 60 * 60),
      period2: String(Math.floor(Date.now() / 1000)),
      interval: "1d",
      events: "div,splits",
      includeAdjustedClose: "true"
    });

    if (yahooCrumb) {
      params.set("crumb", yahooCrumb);
    }

    const url =
      `https://${host}/v8/finance/chart/` +
      encodeURIComponent(symbol) +
      "?" +
      params.toString();

    try {
      const r = await httpGet(url, buildYahooHeaders());

      if (r.status === 429) {
        errors.push(`${host}: HTTP 429`);

        // Force a fresh session before trying the next host.
        await establishYahooSession(true);
        continue;
      }

      if (r.status !== 200) {
        errors.push(`${host}: HTTP ${r.status}`);
        continue;
      }

      let json;

      try {
        json = JSON.parse(r.body);
      } catch {
        errors.push(`${host}: invalid JSON`);
        continue;
      }

      if (json.chart?.error) {
        errors.push(
          `${host}: ${json.chart.error.description || "Yahoo chart error"}`
        );
        continue;
      }

      if (!json.chart?.result?.[0]) {
        errors.push(`${host}: no chart result`);
        continue;
      }

      return json.chart.result[0];
    } catch (err) {
      errors.push(`${host}: ${err.message}`);
    }
  }

  throw new Error("Yahoo: " + errors.join(" | "));
}

function yahooToTradeRadar(symbol, chart) {
  const meta = chart.meta || {};
  const timestamps = chart.timestamp || [];
  const quote = chart.indicators?.quote?.[0] || {};
  const adjClose = chart.indicators?.adjclose?.[0]?.adjclose || [];

  const bars = [];

  for (let i = 0; i < timestamps.length; i++) {
    const close = adjClose[i] ?? quote.close?.[i];

    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const v = quote.volume?.[i];

    if (
      Number.isFinite(Number(o)) &&
      Number.isFinite(Number(h)) &&
      Number.isFinite(Number(l)) &&
      Number.isFinite(Number(close)) &&
      Number.isFinite(Number(v))
    ) {
      bars.push({
        d: new Date(timestamps[i] * 1000)
          .toISOString()
          .slice(0, 10),
        o: Number(o),
        h: Number(h),
        l: Number(l),
        c: Number(close),
        v: Number(v)
      });
    }
  }

  if (!bars.length) {
    throw new Error("Yahoo returned no usable price history");
  }

  const price =
    Number(meta.regularMarketPrice) ||
    Number(meta.postMarketPrice) ||
    Number(meta.previousClose) ||
    bars[bars.length - 1].c;

  return {
    ticker: symbol,
    name: meta.longName || meta.shortName || symbol,
    asof: bars[bars.length - 1].d,

    sector: undefined,
    industry: undefined,

    provenance: {
      quote: {
        source: "Yahoo Finance",
        ts: new Date().toISOString()
      },
      bars: {
        source: "Yahoo Finance chart",
        ts: new Date().toISOString()
      }
    },

    quote: {
      price: price,
      source: "Yahoo Finance"
    },

    bars: bars,

    fundamentals: {
      marketCap: Number.isFinite(Number(meta.marketCap))
        ? Number(meta.marketCap)
        : undefined,

      sharesOut: undefined,
      floatShares: undefined,
      high52: undefined,
      low52: undefined,
      beta: undefined,

      shortPctFloat: undefined,
      daysToCover: undefined,
      analystTarget: undefined,
      instOwnPct: undefined
    },

    earnings: undefined,

    options: undefined,

    catalysts: [],

    news: []
  };
}

async function getYahoo(symbol) {
  const key = `yahoo:${symbol}`;

  const cached = CACHE.get(key);

  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached.data;
  }

  let lastError;

  // Only two attempts. This prevents a 429 from turning into
  // dozens of requests against Yahoo.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const chart = await yahooChart(symbol);
      const data = yahooToTradeRadar(symbol, chart);

      CACHE.set(key, {
        time: Date.now(),
        data
      });

      return data;
    } catch (err) {
      lastError = err;

      if (attempt === 0) {
        await sleep(1500);
      }
    }
  }

  throw lastError || new Error("Yahoo unavailable");
}

/*
 * Optional Alpha Vantage enrichment.
 * This does NOT make Alpha Vantage required.
 */
async function alphaVantage(symbol, baseData) {
  const key = process.env.ALPHA_VANTAGE_API_KEY;

  if (!key) return baseData;

  try {
    const url =
      "https://www.alphavantage.co/query?" +
      new URLSearchParams({
        function: "OVERVIEW",
        symbol,
        apikey: key
      }).toString();

    const r = await httpGet(url);

    if (r.status !== 200) return baseData;

    const j = JSON.parse(r.body);

    baseData.fundamentals = {
      ...baseData.fundamentals,

      marketCap: Number(j.MarketCapitalization) || null,
      pe: Number(j.PERatio) || null,
      forwardPE: Number(j.ForwardPE) || null,
      eps: Number(j.EPS) || null,
      revenueGrowth: Number(j.QuarterlyRevenueGrowthYOY) || null,
      profitMargin: Number(j.ProfitMargin) || null,
      beta: Number(j.Beta) || null,
      dividendYield: Number(j.DividendYield) || null,
      analystTarget: Number(j.AnalystTargetPrice) || null
    };

    return baseData;
  } catch (_) {
    return baseData;
  }
}

async function getStock(symbol) {
  const yahoo = await getYahoo(symbol);

  // Optional enrichment.
  return await alphaVantage(symbol, yahoo);
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });

  res.end(body);
}

function serveHTML(res) {
  const fs = require("fs");
  const path = require("path");

  try {
    const file = fs.readFileSync(
      path.join(__dirname, "trade-radar.html"),
      "utf8"
    );

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache"
    });

    res.end(file);
  } catch (err) {
    sendJSON(res, 500, {
      ok: false,
      error: "Unable to load Trade Radar HTML"
    });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/api/health") {
      sendJSON(res, 200, {
        ok: true,
        service: "trade-radar",
        time: new Date().toISOString(),
        providers: {
          yahoo: true,
          yahooSession: Boolean(yahooCookie),
          yahooCrumb: Boolean(yahooCrumb),
          alphaVantage: Boolean(process.env.ALPHA_VANTAGE_API_KEY)
        }
      });

      return;
    }

    if (url.pathname === "/api/stock") {
      const symbol = cleanTicker(url.searchParams.get("symbol"));

      if (!symbol) {
        sendJSON(res, 400, {
          ok: false,
          error: "TR-201: Missing stock symbol"
        });

        return;
      }

      try {
        const data = await getStock(symbol);

        sendJSON(res, 200, {
          ok: true,
          data
        });
      } catch (err) {
        sendJSON(res, 502, {
          ok: false,
          error: "TR-206: Market data unavailable. " + err.message
        });
      }

      return;
    }

    if (
      url.pathname === "/" ||
      url.pathname === "/index.html" ||
      url.pathname === "/trade-radar.html"
    ) {
      serveHTML(res);
      return;
    }

    sendJSON(res, 404, {
      ok: false,
      error: "Not found"
    });
  } catch (err) {
    sendJSON(res, 500, {
      ok: false,
      error: "TR-500: " + err.message
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Trade Radar running on port ${PORT}`);
});