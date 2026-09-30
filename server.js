const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;
const CACHE = new Map();
const CACHE_TTL = 60 * 1000;
const ENRICH_TTL = 5 * 60 * 1000;

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
  return new Promise(r => setTimeout(r, ms));
}

function val(x) {
  if (x == null) return undefined;

  if (typeof x === "number") {
    return Number.isFinite(x) ? x : undefined;
  }

  if (typeof x === "object" && x.raw != null) {
    const n = Number(x.raw);
    return Number.isFinite(n) ? n : undefined;
  }

  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

function httpGet(url, headers = {}, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);

    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        timeout,

        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://finance.yahoo.com/",
          "Origin": "https://finance.yahoo.com",
          "Connection": "keep-alive",
          ...headers
        }
      },

      res => {
        let body = "";

        res.setEncoding("utf8");

        res.on("data", c => {
          body += c;
        });

        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Request timeout"));
    });

    req.on("error", reject);
    req.end();
  });
}

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

  let cookie = "";

  for (const base of [
    "https://fc.yahoo.com",
    "https://query1.finance.yahoo.com",
    "https://query2.finance.yahoo.com"
  ]) {
    try {
      const r = await httpGet(base + "/");

      const sc = r.headers["set-cookie"];

      if (Array.isArray(sc)) {
        cookie = sc.map(x => x.split(";")[0]).join("; ");
      }

      if (cookie) break;
    } catch (_) {}
  }

  if (!cookie) {
    cookie = yahooCookie || "";
  }

  let crumb = "";

  for (const host of [
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com"
  ]) {
    try {
      const r = await httpGet(
        `https://${host}/v1/test/getcrumb`,
        {
          Cookie: cookie
        }
      );

      if (
        r.status === 200 &&
        r.body &&
        !r.body.includes("<")
      ) {
        crumb = r.body.trim();
        break;
      }
    } catch (_) {}
  }

  if (cookie) {
    yahooCookie = cookie;
  }

  if (crumb) {
    yahooCrumb = crumb;
  }

  yahooSessionTime = now;

  return Boolean(crumb || cookie);
}

function yahooHeaders() {
  return yahooCookie
    ? { Cookie: yahooCookie }
    : {};
}

async function yahooJSON(url, retry = true) {
  await establishYahooSession();

  const r = await httpGet(
    url,
    yahooHeaders()
  );

  if (r.status === 429 && retry) {
    await establishYahooSession(true);

    await sleep(800);

    return yahooJSON(url, false);
  }

  if (r.status !== 200) {
    throw new Error(`Yahoo HTTP ${r.status}`);
  }

  let j;

  try {
    j = JSON.parse(r.body);
  } catch {
    throw new Error("Yahoo returned invalid JSON");
  }

  if (j?.finance?.error) {
    throw new Error(
      j.finance.error.description ||
      "Yahoo finance error"
    );
  }

  return j;
}

async function yahooChart(symbol) {
  const errors = [];

  for (const host of [
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com"
  ]) {
    const p = new URLSearchParams({
      period1: String(
        Math.floor(Date.now() / 1000) -
        2 * 365 * 24 * 60 * 60
      ),

      period2: String(
        Math.floor(Date.now() / 1000)
      ),

      interval: "1d",
      events: "div,splits",
      includeAdjustedClose: "true"
    });

    if (yahooCrumb) {
      p.set("crumb", yahooCrumb);
    }

    try {
      const j = await yahooJSON(
        `https://${host}/v8/finance/chart/${encodeURIComponent(
          symbol
        )}?${p}`
      );

      if (j.chart?.result?.[0]) {
        return j.chart.result[0];
      }

      errors.push(
        `${host}: no chart result`
      );
    } catch (e) {
      errors.push(
        `${host}: ${e.message}`
      );
    }
  }

  throw new Error(
    "Yahoo: " + errors.join(" | ")
  );
}

function yahooToTradeRadar(symbol, chart) {
  const meta = chart.meta || {};

  const timestamps =
    chart.timestamp || [];

  const q =
    chart.indicators?.quote?.[0] || {};

  const adj =
    chart.indicators?.adjclose?.[0]?.adjclose || [];

  const bars = [];

  for (
    let i = 0;
    i < timestamps.length;
    i++
  ) {
    const c =
      q.close?.[i] ??
      adj[i];

    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const v = q.volume?.[i];

    if (
      [o, h, l, c, v].every(
        x => Number.isFinite(Number(x))
      )
    ) {
      bars.push({
        d: new Date(
          timestamps[i] * 1000
        )
          .toISOString()
          .slice(0, 10),

        o: +o,
        h: +h,
        l: +l,
        c: +c,
        v: +v
      });
    }
  }

  if (!bars.length) {
    throw new Error(
      "Yahoo returned no usable price history"
    );
  }

  const price =
    val(meta.regularMarketPrice) ??
    val(meta.postMarketPrice) ??
    val(meta.previousClose) ??
    bars.at(-1).c;

  return {
    ticker: symbol,
    symbol,

    name:
      meta.longName ||
      meta.shortName ||
      symbol,

    asof: bars.at(-1).d,

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
      price,
      source: "Yahoo Finance"
    },

    bars,

    fundamentals: {
      marketCap: undefined,
      sharesOut: undefined,
      floatShares: undefined,
      high52: undefined,
      low52: undefined,
      beta: undefined,

      shortPctFloat: undefined,
      daysToCover: undefined,

      analystTarget: undefined,
      instOwnPct: undefined,

      pe: undefined,
      forwardPE: undefined,
      eps: undefined,

      revenueGrowth: undefined,
      profitMargin: undefined,

      analystConsensus: undefined
    },

    earnings: undefined,
    options: undefined,

    catalysts: [],
    news: [],
    social: undefined
  };
}

function firstDate(x) {
  if (!Array.isArray(x)) {
    return undefined;
  }

  for (const v of x) {
    const n = val(v);

    if (n) {
      return new Date(
        n * 1000
      )
        .toISOString()
        .slice(0, 10);
    }
  }
}

async function enrichQuote(symbol, data) {
  try {
    const j = await yahooJSON(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(
        symbol
      )}`
    );

    const q =
      j.quoteResponse?.result?.[0];

    if (!q) return;

    const f =
      data.fundamentals;

    data.name =
      q.longName ||
      q.shortName ||
      data.name;

    data.sector =
      q.sector ||
      data.sector;

    data.industry =
      q.industry ||
      data.industry;

    if (
      val(q.regularMarketPrice) != null
    ) {
      data.quote.price =
        val(q.regularMarketPrice);
    }

    Object.assign(f, {
      marketCap:
        val(q.marketCap) ??
        f.marketCap,

      sharesOut:
        val(q.sharesOutstanding) ??
        f.sharesOut,

      floatShares:
        val(q.floatShares) ??
        f.floatShares,

      high52:
        val(q.fiftyTwoWeekHigh) ??
        f.high52,

      low52:
        val(q.fiftyTwoWeekLow) ??
        f.low52,

      beta:
        val(q.beta) ??
        f.beta,

      shortPctFloat:
        val(q.shortPercentOfFloat) != null
          ? val(q.shortPercentOfFloat) * 100
          : f.shortPctFloat,

      daysToCover:
        val(q.shortRatio) ??
        f.daysToCover,

      analystTarget:
        val(q.targetMeanPrice) ??
        f.analystTarget,

      instOwnPct:
        val(q.heldPercentInstitutions) != null
          ? val(q.heldPercentInstitutions) * 100
          : f.instOwnPct,

      pe:
        val(q.trailingPE) ??
        f.pe,

      forwardPE:
        val(q.forwardPE) ??
        f.forwardPE,

      eps:
        val(q.epsTrailingTwelveMonths) ??
        f.eps,

      dividendYield:
        val(q.dividendYield) != null
          ? val(q.dividendYield) * 100
          : f.dividendYield
    });

    if (
      q.targetMeanPrice ||
      q.targetHighPrice ||
      q.targetLowPrice
    ) {
      data.analyst = {
        targetMean:
          val(q.targetMeanPrice),

        targetHigh:
          val(q.targetHighPrice),

        targetLow:
          val(q.targetLowPrice)
      };
    }
  } catch (_) {}
}

async function enrichCalendar(symbol, data) {
  try {
    const modules =
      "calendarEvents,price,earningsTrend,defaultKeyStatistics,financialData";

    const u =
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
        symbol
      )}?modules=${modules}${
        yahooCrumb
          ? `&crumb=${encodeURIComponent(
              yahooCrumb
            )}`
          : ""
      }`;

    const j =
      await yahooJSON(u);

    const r =
      j.quoteSummary?.result?.[0];

    if (!r) return;

    const f =
      data.fundamentals;

    const d =
      r.defaultKeyStatistics || {};

    const fin =
      r.financialData || {};

    const cal =
      r.calendarEvents || {};

    f.marketCap =
      val(fin.marketCap) ??
      f.marketCap;

    f.sharesOut =
      val(d.sharesOutstanding) ??
      f.sharesOut;

    f.floatShares =
      val(d.floatShares) ??
      f.floatShares;

    f.shortPctFloat =
      val(d.shortPercentOfFloat) != null
        ? val(d.shortPercentOfFloat) * 100
        : f.shortPctFloat;

    f.daysToCover =
      val(d.shortRatio) ??
      f.daysToCover;

    f.analystTarget =
      val(fin.targetMeanPrice) ??
      f.analystTarget;

    f.beta =
      val(d.beta) ??
      f.beta;

    f.pe =
      val(d.trailingPE) ??
      f.pe;

    f.forwardPE =
      val(d.forwardPE) ??
      f.forwardPE;

    f.eps =
      val(fin.epsTrailingTwelveMonths) ??
      f.eps;

    f.revenueGrowth =
      val(fin.revenueGrowth) != null
        ? val(fin.revenueGrowth) * 100
        : f.revenueGrowth;

    f.profitMargin =
      val(fin.profitMargins) != null
        ? val(fin.profitMargins) * 100
        : f.profitMargin;

    f.instOwnPct =
      val(d.heldPercentInstitutions) != null
        ? val(d.heldPercentInstitutions) * 100
        : f.instOwnPct;

    const ed =
      firstDate(
        cal.earnings?.earningsDate
      );

    if (ed) {
      data.earnings = {
        ...(data.earnings || {}),
        date: ed
      };
    }

    const eps =
      cal.earnings?.earningsCallTime;

    if (
      data.earnings &&
      eps?.fmt
    ) {
      data.earnings.callTime =
        eps.fmt;
    }

    const trend =
      r.earningsTrend?.trend;

    const near =
      Array.isArray(trend)
        ? trend.find(
            x => x.period === "0q"
          ) || trend[0]
        : null;

    if (
      near?.earningsEstimate?.avg?.raw != null &&
      data.earnings
    ) {
      data.earnings.estimate =
        val(
          near.earningsEstimate.avg
        );
    }
  } catch (_) {}
}

async function enrichOptions(symbol, data) {
  try {
    const j =
      await yahooJSON(
        `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(
          symbol
        )}`
      );

    const r =
      j.optionChain?.result?.[0];

    if (!r) return;

    const expirations =
      (r.expirationDates || [])
        .map(Number)
        .filter(Boolean)
        .sort((a, b) => a - b);

    const now =
      Math.floor(
        Date.now() / 1000
      );

    const exp =
      expirations.find(
        x => x >= now
      );

    if (!exp) return;

    const u =
      `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(
        symbol
      )}?date=${exp}`;

    const j2 =
      await yahooJSON(u);

    const x =
      j2.optionChain?.result?.[0];

    if (!x) return;

    const calls =
      x.options?.[0]?.calls || [];

    const puts =
      x.options?.[0]?.puts || [];

    const sum = (a, k) =>
      a.reduce(
        (s, z) =>
          s + (val(z[k]) || 0),
        0
      );

    const callVol =
      sum(calls, "volume");

    const putVol =
      sum(puts, "volume");

    const callOI =
      sum(calls, "openInterest");

    const putOI =
      sum(puts, "openInterest");

    const price =
      data.quote.price;

    const atm = arr =>
      arr
        .filter(
          z =>
            val(z.impliedVolatility) != null &&
            val(z.strike) != null
        )
        .sort(
          (a, b) =>
            Math.abs(
              val(a.strike) - price
            ) -
            Math.abs(
              val(b.strike) - price
            )
        )
        .slice(0, 3)
        .map(
          z =>
            val(
              z.impliedVolatility
            )
        );

    const ivs =
      atm(calls).concat(
        atm(puts)
      );

    const iv =
      ivs.length
        ? ivs.reduce(
            (a, b) => a + b,
            0
          ) / ivs.length
        : undefined;

    const days =
      Math.max(
        1,
        (exp - now) / 86400
      );

    const expectedMovePct =
      iv != null
        ? iv *
          Math.sqrt(
            days / 365
          ) *
          100
        : undefined;

    data.options = {
      available: true,

      callVol,
      putVol,

      callOI,
      putOI,

      putCall:
        callVol > 0
          ? putVol / callVol
          : undefined,

      volVsAvg: undefined,

      iv:
        iv != null
          ? iv * 100
          : undefined,

      expectedMovePct,

      nearestExpiration:
        new Date(
          exp * 1000
        )
          .toISOString()
          .slice(0, 10)
    };

    if (
      data.earnings &&
      expectedMovePct != null
    ) {
      data.earnings.expectedMovePct =
        expectedMovePct;
    }
  } catch (_) {}
}

function sentimentFromHeadline(title = "") {
  const s =
    title.toLowerCase();

  const pos = [
    "beat",
    "beats",
    "raise",
    "raised",
    "upgrade",
    "surge",
    "growth",
    "record",
    "strong",
    "bullish",
    "approval",
    "wins",
    "partnership",
    "buyback",
    "profit",
    "revenue growth"
  ];

  const neg = [
    "miss",
    "misses",
    "cut",
    "cuts",
    "downgrade",
    "drop",
    "falls",
    "decline",
    "weak",
    "bearish",
    "lawsuit",
    "probe",
    "warning",
    "loss",
    "layoff",
    "recall"
  ];

  const p =
    pos.filter(
      w => s.includes(w)
    ).length;

  const n =
    neg.filter(
      w => s.includes(w)
    ).length;

  return p > n
    ? 1
    : n > p
      ? -1
      : 0;
}

async function enrichNews(symbol, data) {
  try {
    const u =
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
        symbol
      )}&newsCount=12&quotesCount=0`;

    const j =
      await yahooJSON(u);

    const rows =
      Array.isArray(j.news)
        ? j.news
        : [];

    data.news =
      rows
        .map(x => ({
          headline:
            x.title ||
            x.headline ||
            "",

          date:
            x.providerPublishTime
              ? new Date(
                  x.providerPublishTime *
                    1000
                )
                  .toISOString()
                  .slice(0, 10)
              : undefined,

          type:
            "unclassified",

          sentiment:
            sentimentFromHeadline(
              x.title ||
              x.headline ||
              ""
            ),

          source:
            x.publisher ||
            "Yahoo Finance",

          url:
            x.link ||
            x.canonicalUrl?.url
        }))
        .filter(
          x =>
            x.headline &&
            x.date
        );
  } catch (_) {}
}

async function enrich(symbol, data) {
  const key =
    `enrich:${symbol}`;

  const cached =
    CACHE.get(key);

  if (
    cached &&
    Date.now() - cached.time <
      ENRICH_TTL
  ) {
    return cached.data;
  }

  await Promise.allSettled([
    enrichQuote(symbol, data),
    enrichCalendar(symbol, data),
    enrichOptions(symbol, data),
    enrichNews(symbol, data)
  ]);

  if (
    data.options?.expectedMovePct != null &&
    data.earnings
  ) {
    data.earnings.expectedMovePct =
      data.options.expectedMovePct;
  }

  data.provenance.fundamentals = {
    source:
      "Yahoo Finance quote/quoteSummary",
    ts:
      new Date().toISOString()
  };

  data.provenance.earnings = {
    source:
      "Yahoo Finance calendarEvents",
    ts:
      new Date().toISOString()
  };

  data.provenance.options = {
    source:
      "Yahoo Finance option chain",
    ts:
      new Date().toISOString()
  };

  data.provenance.news = {
    source:
      "Yahoo Finance news search",

    ts:
      new Date().toISOString(),

    sentiment:
      "rule-based headline heuristic"
  };

  CACHE.set(
    key,
    {
      time: Date.now(),
      data
    }
  );

  return data;
}

async function getStock(symbol) {
  const key =
    `stock:${symbol}`;

  const cached =
    CACHE.get(key);

  if (
    cached &&
    Date.now() - cached.time <
      CACHE_TTL
  ) {
    return cached.data;
  }

  let last;

  for (
    let i = 0;
    i < 2;
    i++
  ) {
    try {
      const d =
        yahooToTradeRadar(
          symbol,
          await yahooChart(symbol)
        );

      await enrich(
        symbol,
        d
      );

      CACHE.set(
        key,
        {
          time: Date.now(),
          data: d
        }
      );

      return d;
    } catch (e) {
      last = e;

      if (i === 0) {
        await sleep(1000);
      }
    }
  }

  throw (
    last ||
    new Error(
      "Yahoo unavailable"
    )
  );
}

function sendJSON(
  res,
  status,
  data
) {
  res.writeHead(
    status,
    {
      "Content-Type":
        "application/json; charset=utf-8",

      "Cache-Control":
        "no-store",

      "Access-Control-Allow-Origin":
        "*"
    }
  );

  res.end(
    JSON.stringify(data)
  );
}

function serveHTML(res) {
  try {
    const file =
      fs.readFileSync(
        path.join(
          __dirname,
          "trade-radar.html"
        ),
        "utf8"
      );

    res.writeHead(
      200,
      {
        "Content-Type":
          "text/html; charset=utf-8",

        "Cache-Control":
          "no-cache"
      }
    );

    res.end(file);
  } catch (e) {
    sendJSON(
      res,
      500,
      {
        ok: false,
        error:
          "Unable to load Trade Radar HTML"
      }
    );
  }
}

const server =
  http.createServer(
    async (req, res) => {
      try {
        const u =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );

        if (
          u.pathname ===
          "/api/health"
        ) {
          return sendJSON(
            res,
            200,
            {
              ok: true,

              service:
                "trade-radar",

              time:
                new Date().toISOString(),

              providers: {
                yahoo: true,
                quote: true,
                options: true,
                earnings: true,
                news: true
              }
            }
          );
        }

        if (
          u.pathname ===
          "/api/stock"
        ) {
          const symbol =
            cleanTicker(
              u.searchParams.get(
                "symbol"
              )
            );

          if (!symbol) {
            return sendJSON(
              res,
              400,
              {
                ok: false,
                error:
                  "TR-201: Missing stock symbol"
              }
            );
          }

          try {
            return sendJSON(
              res,
              200,
              {
                ok: true,
                data:
                  await getStock(
                    symbol
                  )
              }
            );
          } catch (e) {
            return sendJSON(
              res,
              502,
              {
                ok: false,

                error:
                  "TR-206: Market data unavailable. " +
                  e.message
              }
            );
          }
        }

        if (
          u.pathname === "/" ||
          u.pathname ===
            "/index.html" ||
          u.pathname ===
            "/trade-radar.html"
        ) {
          return serveHTML(res);
        }

        return sendJSON(
          res,
          404,
          {
            ok: false,
            error: "Not found"
          }
        );
      } catch (e) {
        return sendJSON(
          res,
          500,
          {
            ok: false,
            error:
              "TR-500: " +
              e.message
          }
        );
      }
    }
  );

server.listen(
  PORT,
  "0.0.0.0",
  () =>
    console.log(
      `Trade Radar running on port ${PORT}`
    )
);