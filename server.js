const http = require("http");
const https = require("https");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 10000;

const CACHE = new Map();

const CACHE_TTL = 60 * 1000;
const ENRICH_TTL = 5 * 60 * 1000;
const SESSION_TTL = 20 * 60 * 1000;

let yahooCookie = "";
let yahooCrumb = "";
let yahooSessionTime = 0;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/140.0.0.0 Safari/537.36";

/* =========================================================
   BASIC HELPERS
========================================================= */

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

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return undefined;
}

function dateFromUnix(value) {
  const n = val(value);

  if (!n) return undefined;

  try {
    return new Date(n * 1000)
      .toISOString()
      .slice(0, 10);
  } catch {
    return undefined;
  }
}

function todayUTC() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

function yahooDate(value) {
  if (value == null) return undefined;

  if (typeof value === "string") {
    const d = value.slice(0, 10);

    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      return d;
    }
  }

  return dateFromUnix(value);
}

function unwrapYahooValue(x) {
  if (x == null) return undefined;

  if (typeof x === "object") {
    if (x.raw != null) return val(x.raw);
    if (x.fmt != null) return x.fmt;
  }

  return val(x);
}

/* =========================================================
   HTTP
========================================================= */

function httpGet(url, headers = {}, timeout = 15000) {
  return new Promise((resolve, reject) => {
    let u;

    try {
      u = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }

    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        timeout,
        headers: {
          "User-Agent": USER_AGENT,
          "Accept":
            "application/json,text/plain,*/*",
          "Accept-Language":
            "en-US,en;q=0.9",
          "Referer":
            "https://finance.yahoo.com/",
          "Origin":
            "https://finance.yahoo.com",
          "Connection":
            "keep-alive",
          ...headers
        }
      },
      res => {
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
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Request timeout"));
    });

    req.on("error", reject);

    req.end();
  });
}

/* =========================================================
   YAHOO SESSION
========================================================= */

async function establishYahooSession(force = false) {
  const now = Date.now();

  if (
    !force &&
    yahooCookie &&
    yahooCrumb &&
    now - yahooSessionTime < SESSION_TTL
  ) {
    return true;
  }

  let cookie = "";

  const cookieHosts = [
    "https://fc.yahoo.com/",
    "https://query1.finance.yahoo.com/",
    "https://query2.finance.yahoo.com/"
  ];

  for (const base of cookieHosts) {
    try {
      const r = await httpGet(base);

      const setCookie =
        r.headers["set-cookie"];

      if (
        Array.isArray(setCookie) &&
        setCookie.length
      ) {
        cookie = setCookie
          .map(x => x.split(";")[0])
          .join("; ");
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
        cookie
          ? { Cookie: cookie }
          : {}
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

  return Boolean(
    yahooCookie || yahooCrumb
  );
}

function yahooHeaders() {
  const headers = {};

  if (yahooCookie) {
    headers.Cookie = yahooCookie;
  }

  return headers;
}

/* =========================================================
   GENERIC YAHOO JSON
========================================================= */

async function yahooJSON(url, retry = true) {
  await establishYahooSession();

  let finalUrl = url;

  /*
    Yahoo's authenticated endpoints can require the crumb.
    Add it unless the caller already supplied one.
  */

  if (
    yahooCrumb &&
    !/[?&]crumb=/.test(finalUrl)
  ) {
    finalUrl +=
      (finalUrl.includes("?") ? "&" : "?") +
      "crumb=" +
      encodeURIComponent(yahooCrumb);
  }

  const r = await httpGet(
    finalUrl,
    yahooHeaders()
  );

  if (
    (r.status === 401 ||
      r.status === 403 ||
      r.status === 429) &&
    retry
  ) {
    await establishYahooSession(true);
    await sleep(1200);

    return yahooJSON(
      url,
      false
    );
  }

  if (r.status !== 200) {
    throw new Error(
      `Yahoo HTTP ${r.status}`
    );
  }

  let j;

  try {
    j = JSON.parse(r.body);
  } catch {
    throw new Error(
      "Yahoo returned invalid JSON"
    );
  }

  if (j?.finance?.error) {
    throw new Error(
      j.finance.error.description ||
      "Yahoo finance error"
    );
  }

  return j;
}

async function yahooJSONAny(pathname) {
  const hosts = [
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com"
  ];

  const errors = [];

  for (const host of hosts) {
    try {
      return await yahooJSON(
        `https://${host}${pathname}`
      );
    } catch (e) {
      errors.push(
        `${host}: ${e.message}`
      );
    }
  }

  throw new Error(
    errors.join(" | ")
  );
}

/* =========================================================
   PRICE HISTORY
========================================================= */

async function yahooChart(symbol) {
  const errors = [];

  const period2 =
    Math.floor(Date.now() / 1000);

  const period1 =
    period2 -
    2 * 365 * 24 * 60 * 60;

  const p = new URLSearchParams({
    period1: String(period1),
    period2: String(period2),
    interval: "1d",
    events: "div,splits",
    includeAdjustedClose: "true"
  });

  for (const host of [
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com"
  ]) {
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
    "Yahoo chart failed: " +
    errors.join(" | ")
  );
}

/* =========================================================
   CONVERT CHART
========================================================= */

function yahooToTradeRadar(symbol, chart) {
  const meta = chart.meta || {};

  const timestamps =
    chart.timestamp || [];

  const q =
    chart.indicators?.quote?.[0] || {};

  const adj =
    chart.indicators
      ?.adjclose?.[0]
      ?.adjclose || [];

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
        x =>
          Number.isFinite(
            Number(x)
          )
      )
    ) {
      const bar = {
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
      };

      if (
        bar.h >=
          Math.max(
            bar.o,
            bar.c
          ) &&
        bar.l <=
          Math.min(
            bar.o,
            bar.c
          ) &&
        bar.h >= bar.l
      ) {
        bars.push(bar);
      }
    }
  }

  if (!bars.length) {
    throw new Error(
      "Yahoo returned no usable price history"
    );
  }

  const price = firstDefined(
    val(meta.regularMarketPrice),
    val(meta.postMarketPrice),
    val(meta.previousClose),
    bars.at(-1).c
  );

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
        source:
          "Yahoo Finance chart",
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

/* =========================================================
   ENRICHMENT STATUS
========================================================= */

function setEnrichment(
  data,
  name,
  ok,
  hasData,
  error
) {
  data.enrichment[name] = {
    ok,
    hasData,
    ...(error
      ? { error: String(error).slice(0, 700) }
      : {})
  };

  if (error) {
    data.enrichment.errors.push({
      source: name,
      error: String(error).slice(0, 700)
    });
  }
}

/* =========================================================
   QUOTE / FUNDAMENTALS
========================================================= */

async function enrichQuote(
  symbol,
  data
) {
  try {
    const j = await yahooJSONAny(
      `/v7/finance/quote?symbols=${encodeURIComponent(
        symbol
      )}`
    );

    const q =
      j.quoteResponse
        ?.result?.[0];

    if (!q) {
      throw new Error(
        "Yahoo quote returned no result"
      );
    }

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

    const marketPrice =
      val(
        q.regularMarketPrice
      );

    if (marketPrice != null) {
      data.quote.price =
        marketPrice;
    }

    Object.assign(f, {
      marketCap: firstDefined(
        val(q.marketCap),
        f.marketCap
      ),

      sharesOut: firstDefined(
        val(q.sharesOutstanding),
        f.sharesOut
      ),

      floatShares: firstDefined(
        val(q.floatShares),
        f.floatShares
      ),

      high52: firstDefined(
        val(q.fiftyTwoWeekHigh),
        f.high52
      ),

      low52: firstDefined(
        val(q.fiftyTwoWeekLow),
        f.low52
      ),

      beta: firstDefined(
        val(q.beta),
        f.beta
      ),

      shortPctFloat:
        val(q.shortPercentOfFloat) != null
          ? val(q.shortPercentOfFloat) * 100
          : f.shortPctFloat,

      daysToCover: firstDefined(
        val(q.shortRatio),
        f.daysToCover
      ),

      analystTarget: firstDefined(
        val(q.targetMeanPrice),
        f.analystTarget
      ),

      instOwnPct:
        val(q.heldPercentInstitutions) != null
          ? val(q.heldPercentInstitutions) * 100
          : f.instOwnPct,

      pe: firstDefined(
        val(q.trailingPE),
        f.pe
      ),

      forwardPE: firstDefined(
        val(q.forwardPE),
        f.forwardPE
      ),

      eps: firstDefined(
        val(q.epsTrailingTwelveMonths),
        f.eps
      )
    });

    if (
      val(q.dividendYield) != null
    ) {
      f.dividendYield =
        val(q.dividendYield) * 100;
    }

    if (
      q.targetMeanPrice != null ||
      q.targetHighPrice != null ||
      q.targetLowPrice != null
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

    setEnrichment(
      data,
      "quote",
      true,
      true
    );

  } catch (e) {
    setEnrichment(
      data,
      "quote",
      false,
      false,
      e.message
    );
  }
}

/* =========================================================
   QUOTE SUMMARY / EARNINGS
========================================================= */

async function enrichCalendar(
  symbol,
  data
) {
  const moduleSets = [
    [
      "calendarEvents",
      "price",
      "earningsTrend",
      "defaultKeyStatistics",
      "financialData"
    ],

    [
      "calendarEvents",
      "earningsTrend",
      "defaultKeyStatistics"
    ],

    [
      "calendarEvents"
    ]
  ];

  let lastError;

  for (
    const modules of moduleSets
  ) {
    try {
      const pathname =
        `/v10/finance/quoteSummary/${encodeURIComponent(
          symbol
        )}?modules=${encodeURIComponent(
          modules.join(",")
        )}`;

      const j =
        await yahooJSONAny(
          pathname
        );

      const r =
        j.quoteSummary
          ?.result?.[0];

      if (!r) {
        throw new Error(
          "Yahoo quoteSummary returned no result"
        );
      }

      const f =
        data.fundamentals;

      const d =
        r.defaultKeyStatistics || {};

      const fin =
        r.financialData || {};

      const cal =
        r.calendarEvents || {};

      f.marketCap =
        firstDefined(
          unwrapYahooValue(
            fin.marketCap
          ),
          f.marketCap
        );

      f.sharesOut =
        firstDefined(
          unwrapYahooValue(
            d.sharesOutstanding
          ),
          f.sharesOut
        );

      f.floatShares =
        firstDefined(
          unwrapYahooValue(
            d.floatShares
          ),
          f.floatShares
        );

      const shortPct =
        firstDefined(
          unwrapYahooValue(
            d.shortPercentOfFloat
          ),
          unwrapYahooValue(
            d.shortPercentOfSharesOutstanding
          )
        );

      if (shortPct != null) {
        /*
          Yahoo normally supplies this as a decimal.
        */

        f.shortPctFloat =
          shortPct <= 1
            ? shortPct * 100
            : shortPct;
      }

      f.daysToCover =
        firstDefined(
          unwrapYahooValue(
            d.shortRatio
          ),
          f.daysToCover
        );

      f.analystTarget =
        firstDefined(
          unwrapYahooValue(
            fin.targetMeanPrice
          ),
          f.analystTarget
        );

      f.beta =
        firstDefined(
          unwrapYahooValue(d.beta),
          f.beta
        );

      f.pe =
        firstDefined(
          unwrapYahooValue(
            d.trailingPE
          ),
          f.pe
        );

      f.forwardPE =
        firstDefined(
          unwrapYahooValue(
            d.forwardPE
          ),
          f.forwardPE
        );

      f.eps =
        firstDefined(
          unwrapYahooValue(
            fin.epsTrailingTwelveMonths
          ),
          f.eps
        );

      if (
        unwrapYahooValue(
          fin.revenueGrowth
        ) != null
      ) {
        f.revenueGrowth =
          unwrapYahooValue(
            fin.revenueGrowth
          ) * 100;
      }

      if (
        unwrapYahooValue(
          fin.profitMargins
        ) != null
      ) {
        f.profitMargin =
          unwrapYahooValue(
            fin.profitMargins
          ) * 100;
      }

      if (
        unwrapYahooValue(
          d.heldPercentInstitutions
        ) != null
      ) {
        f.instOwnPct =
          unwrapYahooValue(
            d.heldPercentInstitutions
          ) * 100;
      }

      /*
        Earnings date.
        Yahoo has returned several shapes over time,
        so check all common forms.
      */

      let earningsDate;

      const earnings =
        cal.earnings;

      if (earnings) {
        earningsDate =
          firstDateFromArray(
            earnings.earningsDate
          ) ||
          yahooDate(
            earnings.earningsDate
          );
      }

      if (!earningsDate) {
        earningsDate =
          firstDateFromArray(
            cal.earningsDate
          ) ||
          yahooDate(
            cal.earningsDate
          );
      }

      if (earningsDate) {
        data.earnings = {
          ...(data.earnings || {}),
          date: earningsDate,
          source:
            "Yahoo Finance"
        };
      }

      /*
        Earnings call time.
      */

      const callTime =
        earnings?.earningsCallTime;

      if (
        data.earnings &&
        callTime
      ) {
        data.earnings.callTime =
          callTime.fmt ||
          callTime.raw ||
          callTime;
      }

      /*
        EPS estimate.
      */

      const trend =
        r.earningsTrend?.trend;

      if (Array.isArray(trend)) {
        const near =
          trend.find(
            x =>
              x.period === "0q"
          ) ||
          trend.find(
            x =>
              x.period === "+1q"
          ) ||
          trend[0];

        const estimate =
          unwrapYahooValue(
            near
              ?.earningsEstimate
              ?.avg
          );

        if (estimate != null) {
          data.earnings =
            data.earnings || {};

          data.earnings.estimate =
            estimate;
        }
      }

      /*
        Earnings catalyst.
      */

      if (
        data.earnings?.date
      ) {
        const exists =
          data.catalysts.some(
            x =>
              x.event ===
              "Earnings"
          );

        if (!exists) {
          data.catalysts.push({
            event: "Earnings",
            date:
              data.earnings.date,
            impact: "High",
            why:
              "Quarterly results and guidance can materially change expectations.",
            up:
              "Beat and/or stronger guidance",
            down:
              "Miss and/or weaker guidance",
            confidence: "Medium",
            source:
              "Yahoo Finance"
          });
        }
      }

      const hasFundamentals =
        Object.values(f).some(
          x =>
            x !== undefined &&
            x !== null
        );

      setEnrichment(
        data,
        "calendar",
        true,
        Boolean(
          data.earnings ||
          hasFundamentals
        )
      );

      return;

    } catch (e) {
      lastError = e;
    }
  }

  setEnrichment(
    data,
    "calendar",
    false,
    false,
    lastError?.message ||
      "Yahoo earnings endpoint failed"
  );
}

function firstDateFromArray(x) {
  if (!Array.isArray(x)) {
    return undefined;
  }

  for (const value of x) {
    const d =
      yahooDate(value);

    if (d) return d;
  }

  return undefined;
}

/* =========================================================
   OPTIONS
========================================================= */

async function enrichOptions(
  symbol,
  data
) {
  try {
    const first =
      await yahooJSONAny(
        `/v7/finance/options/${encodeURIComponent(
          symbol
        )}`
      );

    const r =
      first.optionChain
        ?.result?.[0];

    if (!r) {
      throw new Error(
        "Yahoo options returned no option chain"
      );
    }

    const expirations =
      (r.expirationDates || [])
        .map(Number)
        .filter(
          Number.isFinite
        )
        .sort(
          (a, b) => a - b
        );

    const now =
      Math.floor(
        Date.now() / 1000
      );

    const exp =
      expirations.find(
        x => x >= now
      );

    if (!exp) {
      throw new Error(
        "Yahoo returned no future option expiration"
      );
    }

    const second =
      await yahooJSONAny(
        `/v7/finance/options/${encodeURIComponent(
          symbol
        )}?date=${exp}`
      );

    const x =
      second.optionChain
        ?.result?.[0];

    if (!x) {
      throw new Error(
        "Yahoo returned no option chain for expiration"
      );
    }

    const calls =
      x.options?.[0]?.calls ||
      [];

    const puts =
      x.options?.[0]?.puts ||
      [];

    const sum = (
      arr,
      key
    ) =>
      arr.reduce(
        (total, item) =>
          total +
          (val(item[key]) || 0),
        0
      );

    const callVol =
      sum(calls, "volume");

    const putVol =
      sum(puts, "volume");

    const callOI =
      sum(
        calls,
        "openInterest"
      );

    const putOI =
      sum(
        puts,
        "openInterest"
      );

    const price =
      Number(data.quote?.price);

    function nearestIV(
      arr
    ) {
      return arr
        .filter(
          z =>
            val(
              z.impliedVolatility
            ) != null &&
            val(z.strike) != null
        )
        .sort(
          (a, b) =>
            Math.abs(
              val(a.strike) -
              price
            ) -
            Math.abs(
              val(b.strike) -
              price
            )
        )
        .slice(0, 3)
        .map(
          z =>
            val(
              z.impliedVolatility
            )
        );
    }

    const ivs =
      nearestIV(calls)
        .concat(
          nearestIV(puts)
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
        (exp - now) /
          86400
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

      openInterest:
        callOI + putOI,

      putCall:
        callVol > 0
          ? putVol / callVol
          : undefined,

      /*
        Intentionally undefined.
        Yahoo does not provide a reliable
        historical options-volume baseline
        in this endpoint.
      */

      volVsAvg:
        undefined,

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

    setEnrichment(
      data,
      "options",
      true,
      true
    );

  } catch (e) {
    setEnrichment(
      data,
      "options",
      false,
      false,
      e.message
    );
  }
}

/* =========================================================
   NEWS
========================================================= */

function sentimentFromHeadline(
  title = ""
) {
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
    "revenue growth",
    "outperform"
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
    "recall",
    "underperform"
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

function classifyNews(
  title = ""
) {
  const s =
    title.toLowerCase();

  if (
    /earnings|quarter|guidance|revenue|eps/.test(
      s
    )
  ) {
    return "fact";
  }

  if (
    /analyst|price target|upgrade|downgrade|rating/.test(
      s
    )
  ) {
    return "analyst";
  }

  if (
    /could|may|might|potential|rumor|speculation/.test(
      s
    )
  ) {
    return "speculation";
  }

  return "unclassified";
}

async function enrichNews(
  symbol,
  data
) {
  try {
    const j =
      await yahooJSONAny(
        `/v1/finance/search?q=${encodeURIComponent(
          symbol
        )}&newsCount=12&quotesCount=0`
      );

    const rows =
      Array.isArray(j.news)
        ? j.news
        : [];

    data.news =
      rows
        .map(x => {
          const headline =
            x.title ||
            x.headline ||
            "";

          const date =
            dateFromUnix(
              x.providerPublishTime
            );

          return {
            headline,

            date,

            type:
              classifyNews(
                headline
              ),

            sentiment:
              sentimentFromHeadline(
                headline
              ),

            source:
              x.publisher ||
              "Yahoo Finance",

            url:
              x.link ||
              x.canonicalUrl?.url
          };
        })
        .filter(
          x =>
            x.headline &&
            x.date
        );

    for (
      const item of data.news
    ) {
      const s =
        item.headline.toLowerCase();

      const isCatalyst =
        /earnings|guidance|acquisition|acquire|merger|approval|contract|partnership|lawsuit|investigation|launch|product|recall|buyback|dividend|analyst|upgrade|downgrade/.test(
          s
        );

      if (!isCatalyst) continue;

      const exists =
        data.catalysts.some(
          c =>
            c.date === item.date &&
            c.event ===
              item.headline
        );

      if (exists) continue;

      let impact = "Medium";

      if (
        /earnings|merger|acquisition|approval|investigation|lawsuit/.test(
          s
        )
      ) {
        impact = "High";
      }

      data.catalysts.push({
        event:
          item.headline,

        date:
          item.date,

        impact,

        why:
          "Dated company-related news that may affect expectations or price.",

        up:
          item.sentiment > 0
            ? "Headline contains positive language"
            : "Direction depends on subsequent details",

        down:
          item.sentiment < 0
            ? "Headline contains negative language"
            : "Direction depends on subsequent details",

        confidence:
          "Low to Medium",

        source:
          item.source
      });
    }

    setEnrichment(
      data,
      "news",
      true,
      data.news.length > 0
    );

  } catch (e) {
    setEnrichment(
      data,
      "news",
      false,
      false,
      e.message
    );
  }
}

/* =========================================================
   EVENT RISK
========================================================= */

function calculateEventRisk(data) {
  const today =
    new Date(
      `${todayUTC()}T00:00:00Z`
    );

  const events = [];

  if (
    data.earnings?.date
  ) {
    const d =
      new Date(
        `${data.earnings.date}T00:00:00Z`
      );

    if (
      !Number.isNaN(
        d.getTime()
      )
    ) {
      const days =
        Math.round(
          (
            d - today
          ) /
          86400000
        );

      if (days >= 0) {
        events.push({
          type: "Earnings",
          date:
            data.earnings.date,
          days
        });
      }
    }
  }

  for (
    const c of
    data.catalysts || []
  ) {
    if (!c.date) continue;

    const d =
      new Date(
        `${c.date}T00:00:00Z`
      );

    if (
      Number.isNaN(
        d.getTime()
      )
    ) {
      continue;
    }

    const days =
      Math.round(
        (d - today) /
        86400000
      );

    if (days >= 0) {
      events.push({
        type:
          c.event || "Catalyst",
        date: c.date,
        days,
        impact:
          c.impact || "Medium"
      });
    }
  }

  events.sort(
    (a, b) =>
      a.days - b.days
  );

  const next =
    events[0];

  if (!next) {
    return {
      level: "Unavailable",
      score: null,
      why:
        "No dated upcoming earnings or catalysts were supplied.",
      nextEvent: null
    };
  }

  let score = 20;

  if (next.days <= 3) {
    score = 95;
  } else if (next.days <= 7) {
    score = 85;
  } else if (next.days <= 14) {
    score = 70;
  } else if (next.days <= 30) {
    score = 50;
  } else if (next.days <= 60) {
    score = 30;
  }

  if (
    next.type === "Earnings"
  ) {
    score =
      Math.min(
        100,
        score + 5
      );
  }

  if (
    next.impact === "High"
  ) {
    score =
      Math.min(
        100,
        score + 10
      );
  }

  let level;

  if (score >= 80) {
    level = "Extreme";
  } else if (score >= 60) {
    level = "High";
  } else if (score >= 35) {
    level = "Medium";
  } else {
    level = "Low";
  }

  return {
    level,
    score,
    why:
      `${next.type} is ${next.days} day${
        next.days === 1
          ? ""
          : "s"
      } away (${next.date}).`,
    nextEvent: next
  };
}

/* =========================================================
   ENRICHMENT COORDINATOR
========================================================= */

async function enrich(
  symbol,
  data
) {
  const key =
    `enrich:${symbol}`;

  const cached =
    CACHE.get(key);

  if (
    cached &&
    Date.now() -
      cached.time <
      ENRICH_TTL
  ) {
    return cached.data;
  }

  data.enrichment = {
    quote: {
      ok: false,
      hasData: false
    },

    calendar: {
      ok: false,
      hasData: false
    },

    options: {
      ok: false,
      hasData: false
    },

    news: {
      ok: false,
      hasData: false
    },

    errors: []
  };

  await enrichQuote(
    symbol,
    data
  );

  await sleep(300);

  await enrichCalendar(
    symbol,
    data
  );

  await sleep(300);

  await enrichOptions(
    symbol,
    data
  );

  await sleep(300);

  await enrichNews(
    symbol,
    data
  );

  if (
    data.options?.expectedMovePct != null &&
    data.earnings
  ) {
    data.earnings.expectedMovePct =
      data.options.expectedMovePct;
  }

  data.eventRisk =
    calculateEventRisk(
      data
    );

  if (
    data.enrichment.quote.hasData ||
    data.enrichment.calendar.hasData
  ) {
    data.provenance.fundamentals = {
      source:
        "Yahoo Finance quote/quoteSummary",
      ts:
        new Date().toISOString()
    };
  }

  if (data.earnings) {
    data.provenance.earnings = {
      source:
        "Yahoo Finance calendarEvents",
      ts:
        new Date().toISOString()
    };
  }

  if (data.options) {
    data.provenance.options = {
      source:
        "Yahoo Finance option chain",
      ts:
        new Date().toISOString()
    };
  }

  if (
    Array.isArray(data.news) &&
    data.news.length
  ) {
    data.provenance.news = {
      source:
        "Yahoo Finance news search",
      ts:
        new Date().toISOString(),
      sentiment:
        "rule-based headline heuristic"
    };
  }

  data.enrichment.summary = {
    quote:
      !!data.enrichment.quote.hasData,

    earnings:
      !!data.earnings,

    options:
      !!data.options,

    news:
      data.news.length > 0,

    shortInterest:
      data.fundamentals
        ?.shortPctFloat != null,

    catalysts:
      data.catalysts.length,

    eventRisk:
      data.eventRisk?.level !==
      "Unavailable"
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

/* =========================================================
   GET STOCK
========================================================= */

async function getStock(
  symbol
) {
  const key =
    `stock:${symbol}`;

  const cached =
    CACHE.get(key);

  if (
    cached &&
    Date.now() -
      cached.time <
      CACHE_TTL
  ) {
    return cached.data;
  }

  let lastError;

  for (
    let attempt = 0;
    attempt < 2;
    attempt++
  ) {
    try {
      const chart =
        await yahooChart(
          symbol
        );

      const data =
        yahooToTradeRadar(
          symbol,
          chart
        );

      await enrich(
        symbol,
        data
      );

      CACHE.set(
        key,
        {
          time:
            Date.now(),
          data
        }
      );

      return data;

    } catch (e) {
      lastError = e;

      if (
        attempt === 0
      ) {
        await sleep(1500);
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "Yahoo unavailable"
    )
  );
}

/* =========================================================
   RESPONSE
========================================================= */

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

/* =========================================================
   HTML
========================================================= */

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

/* =========================================================
   SERVER
========================================================= */

const server =
  http.createServer(
    async (req, res) => {
      try {
        const u =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );

        /*
          HEALTH
        */

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

        /*
          STOCK
        */

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
            const data =
              await getStock(
                symbol
              );

            return sendJSON(
              res,
              200,
              {
                ok: true,
                data
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

        /*
          WEBSITE
        */

        if (
          u.pathname === "/" ||
          u.pathname ===
            "/index.html" ||
          u.pathname ===
            "/trade-radar.html"
        ) {
          return serveHTML(
            res
          );
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

/* =========================================================
   START
========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Trade Radar running on port ${PORT}`
    );
  }
);