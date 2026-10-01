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

        path:
          u.pathname +
          u.search,

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
            status:
              res.statusCode || 0,

            headers:
              res.headers,

            body
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(
        new Error("Request timeout")
      );
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
    now - yahooSessionTime <
      20 * 60 * 1000
  ) {
    return true;
  }

  let cookie = "";

  const cookieHosts = [
    "https://fc.yahoo.com",
    "https://query1.finance.yahoo.com",
    "https://query2.finance.yahoo.com"
  ];

  for (const base of cookieHosts) {
    try {
      const r =
        await httpGet(base + "/");

      const setCookie =
        r.headers["set-cookie"];

      if (
        Array.isArray(setCookie) &&
        setCookie.length
      ) {
        const pieces =
          setCookie.map(
            x => x.split(";")[0]
          );

        cookie =
          pieces.join("; ");
      }

      if (cookie) break;
    } catch (_) {}
  }

  if (!cookie) {
    cookie =
      yahooCookie || "";
  }

  let crumb = "";

  const crumbHosts = [
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com"
  ];

  for (const host of crumbHosts) {
    try {
      const r =
        await httpGet(
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
        crumb =
          r.body.trim();

        break;
      }
    } catch (_) {}
  }

  if (cookie) {
    yahooCookie =
      cookie;
  }

  if (crumb) {
    yahooCrumb =
      crumb;
  }

  yahooSessionTime =
    now;

  return Boolean(
    yahooCookie ||
    yahooCrumb
  );
}

function yahooHeaders() {
  const headers = {};

  if (yahooCookie) {
    headers.Cookie =
      yahooCookie;
  }

  return headers;
}

/* =========================================================
   GENERIC YAHOO JSON
========================================================= */

async function yahooJSON(
  url,
  retry = true
) {
  await establishYahooSession();

  const r =
    await httpGet(
      url,
      yahooHeaders()
    );

  if (
    r.status === 429 &&
    retry
  ) {
    await establishYahooSession(
      true
    );

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
    j =
      JSON.parse(r.body);
  } catch {
    throw new Error(
      "Yahoo returned invalid JSON"
    );
  }

  if (
    j?.finance?.error
  ) {
    throw new Error(
      j.finance.error.description ||
      "Yahoo finance error"
    );
  }

  return j;
}

/*
  Try both Yahoo query servers.
  This is important because Yahoo can reject one
  host while the other still works.
*/

async function yahooJSONAny(
  pathname,
  retry = true
) {
  const hosts = [
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com"
  ];

  const errors = [];

  for (const host of hosts) {
    try {
      return await yahooJSON(
        `https://${host}${pathname}`,
        retry
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
    Math.floor(
      Date.now() / 1000
    );

  const period1 =
    period2 -
    2 *
      365 *
      24 *
      60 *
      60;

  const p =
    new URLSearchParams({
      period1:
        String(period1),

      period2:
        String(period2),

      interval:
        "1d",

      events:
        "div,splits",

      includeAdjustedClose:
        "true"
    });

  if (yahooCrumb) {
    p.set(
      "crumb",
      yahooCrumb
    );
  }

  for (const host of [
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com"
  ]) {
    try {
      const j =
        await yahooJSON(
          `https://${host}/v8/finance/chart/${encodeURIComponent(
            symbol
          )}?${p}`
        );

      if (
        j.chart?.result?.[0]
      ) {
        return (
          j.chart.result[0]
        );
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
   CONVERT YAHOO CHART TO TRADE RADAR
========================================================= */

function yahooToTradeRadar(
  symbol,
  chart
) {
  const meta =
    chart.meta || {};

  const timestamps =
    chart.timestamp || [];

  const q =
    chart.indicators
      ?.quote?.[0] || {};

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
    /*
      IMPORTANT:
      Use regular close before adjusted close.

      Mixing adjusted close with regular
      OHLC values can create impossible
      OHLC combinations and trigger TR-105.
    */

    const c =
      q.close?.[i] ??
      adj[i];

    const o =
      q.open?.[i];

    const h =
      q.high?.[i];

    const l =
      q.low?.[i];

    const v =
      q.volume?.[i];

    if (
      [
        o,
        h,
        l,
        c,
        v
      ].every(
        x =>
          Number.isFinite(
            Number(x)
          )
      )
    ) {
      const bar = {
        d:
          new Date(
            timestamps[i] *
              1000
          )
            .toISOString()
            .slice(0, 10),

        o: +o,
        h: +h,
        l: +l,
        c: +c,
        v: +v
      };

      /*
        Basic OHLC safety validation.
      */

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

  const price =
    firstDefined(
      val(
        meta.regularMarketPrice
      ),
      val(
        meta.postMarketPrice
      ),
      val(
        meta.previousClose
      ),
      bars.at(-1).c
    );

  return {
    ticker:
      symbol,

    symbol:
      symbol,

    name:
      meta.longName ||
      meta.shortName ||
      symbol,

    asof:
      bars.at(-1).d,

    sector:
      undefined,

    industry:
      undefined,

    provenance: {
      quote: {
        source:
          "Yahoo Finance",

        ts:
          new Date().toISOString()
      },

      bars: {
        source:
          "Yahoo Finance chart",

        ts:
          new Date().toISOString()
      }
    },

    quote: {
      price,
      source:
        "Yahoo Finance"
    },

    bars,

    fundamentals: {
      marketCap:
        undefined,

      sharesOut:
        undefined,

      floatShares:
        undefined,

      high52:
        undefined,

      low52:
        undefined,

      beta:
        undefined,

      shortPctFloat:
        undefined,

      daysToCover:
        undefined,

      analystTarget:
        undefined,

      instOwnPct:
        undefined,

      pe:
        undefined,

      forwardPE:
        undefined,

      eps:
        undefined,

      revenueGrowth:
        undefined,

      profitMargin:
        undefined,

      analystConsensus:
        undefined
    },

    earnings:
      undefined,

    options:
      undefined,

    catalysts:
      [],

    news:
      [],

    social:
      undefined
  };
}

/* =========================================================
   DATE HELPERS
========================================================= */

function firstDate(x) {
  if (
    !Array.isArray(x)
  ) {
    return undefined;
  }

  for (const v of x) {
    const date =
      dateFromUnix(v);

    if (date) {
      return date;
    }
  }

  return undefined;
}

/* =========================================================
   QUOTE / FUNDAMENTALS
========================================================= */

async function enrichQuote(
  symbol,
  data
) {
  try {
    const pathname =
      `/v7/finance/quote?symbols=${encodeURIComponent(
        symbol
      )}`;

    const j =
      await yahooJSONAny(
        pathname
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

    if (
      val(
        q.regularMarketPrice
      ) != null
    ) {
      data.quote.price =
        val(
          q.regularMarketPrice
        );
    }

    Object.assign(
      f,
      {
        marketCap:
          firstDefined(
            val(q.marketCap),
            f.marketCap
          ),

        sharesOut:
          firstDefined(
            val(
              q.sharesOutstanding
            ),
            f.sharesOut
          ),

        floatShares:
          firstDefined(
            val(
              q.floatShares
            ),
            f.floatShares
          ),

        high52:
          firstDefined(
            val(
              q.fiftyTwoWeekHigh
            ),
            f.high52
          ),

        low52:
          firstDefined(
            val(
              q.fiftyTwoWeekLow
            ),
            f.low52
          ),

        beta:
          firstDefined(
            val(q.beta),
            f.beta
          ),

        shortPctFloat:
          val(
            q.shortPercentOfFloat
          ) != null
            ? val(
                q.shortPercentOfFloat
              ) * 100
            : f.shortPctFloat,

        daysToCover:
          firstDefined(
            val(
              q.shortRatio
            ),
            f.daysToCover
          ),

        analystTarget:
          firstDefined(
            val(
              q.targetMeanPrice
            ),
            f.analystTarget
          ),

        instOwnPct:
          val(
            q.heldPercentInstitutions
          ) != null
            ? val(
                q.heldPercentInstitutions
              ) * 100
            : f.instOwnPct,

        pe:
          firstDefined(
            val(q.trailingPE),
            f.pe
          ),

        forwardPE:
          firstDefined(
            val(q.forwardPE),
            f.forwardPE
          ),

        eps:
          firstDefined(
            val(
              q.epsTrailingTwelveMonths
            ),
            f.eps
          )
      }
    );

    if (
      val(q.dividendYield) != null
    ) {
      f.dividendYield =
        val(
          q.dividendYield
        ) * 100;
    }

    if (
      q.targetMeanPrice != null ||
      q.targetHighPrice != null ||
      q.targetLowPrice != null
    ) {
      data.analyst = {
        targetMean:
          val(
            q.targetMeanPrice
          ),

        targetHigh:
          val(
            q.targetHighPrice
          ),

        targetLow:
          val(
            q.targetLowPrice
          )
      };
    }

    data.enrichment.quote =
      {
        ok: true,
        hasData: true
      };

  } catch (e) {
    data.enrichment.quote =
      {
        ok: false,
        hasData: false,
        error:
          String(
            e?.message ||
            e
          ).slice(
            0,
            500
          )
      };

    data.enrichment.errors.push({
      source:
        "quote",
      error:
        data.enrichment
          .quote.error
    });
  }
}

/* =========================================================
   QUOTE SUMMARY / EARNINGS
========================================================= */

async function enrichCalendar(
  symbol,
  data
) {
  try {
    const modules =
      [
        "calendarEvents",
        "price",
        "earningsTrend",
        "defaultKeyStatistics",
        "financialData"
      ].join(",");

    const pathname =
      `/v10/finance/quoteSummary/${encodeURIComponent(
        symbol
      )}?modules=${encodeURIComponent(
        modules
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
      r.defaultKeyStatistics ||
      {};

    const fin =
      r.financialData ||
      {};

    const cal =
      r.calendarEvents ||
      {};

    /*
      Fill fundamental data from quoteSummary
      when quote endpoint doesn't provide it.
    */

    f.marketCap =
      firstDefined(
        val(fin.marketCap),
        f.marketCap
      );

    f.sharesOut =
      firstDefined(
        val(
          d.sharesOutstanding
        ),
        f.sharesOut
      );

    f.floatShares =
      firstDefined(
        val(
          d.floatShares
        ),
        f.floatShares
      );

    if (
      val(
        d.shortPercentOfFloat
      ) != null
    ) {
      f.shortPctFloat =
        val(
          d.shortPercentOfFloat
        ) * 100;
    }

    f.daysToCover =
      firstDefined(
        val(d.shortRatio),
        f.daysToCover
      );

    f.analystTarget =
      firstDefined(
        val(
          fin.targetMeanPrice
        ),
        f.analystTarget
      );

    f.beta =
      firstDefined(
        val(d.beta),
        f.beta
      );

    f.pe =
      firstDefined(
        val(d.trailingPE),
        f.pe
      );

    f.forwardPE =
      firstDefined(
        val(d.forwardPE),
        f.forwardPE
      );

    f.eps =
      firstDefined(
        val(
          fin.epsTrailingTwelveMonths
        ),
        f.eps
      );

    if (
      val(fin.revenueGrowth) !=
      null
    ) {
      f.revenueGrowth =
        val(
          fin.revenueGrowth
        ) * 100;
    }

    if (
      val(fin.profitMargins) !=
      null
    ) {
      f.profitMargin =
        val(
          fin.profitMargins
        ) * 100;
    }

    if (
      val(
        d.heldPercentInstitutions
      ) != null
    ) {
      f.instOwnPct =
        val(
          d.heldPercentInstitutions
        ) * 100;
    }

    /*
      Earnings date.
    */

    const ed =
      firstDate(
        cal.earnings
          ?.earningsDate
      );

    if (ed) {
      data.earnings = {
        ...(data.earnings || {}),

        date:
          ed,

        source:
          "Yahoo Finance"
      };
    }

    /*
      Earnings call time.
    */

    const callTime =
      cal.earnings
        ?.earningsCallTime;

    if (
      data.earnings &&
      callTime
    ) {
      data.earnings.callTime =
        callTime.fmt ||
        callTime.raw ||
        undefined;
    }

    /*
      EPS estimate.
    */

    const trend =
      r.earningsTrend
        ?.trend;

    const near =
      Array.isArray(trend)
        ? (
            trend.find(
              x =>
                x.period ===
                "0q"
            ) ||
            trend[0]
          )
        : null;

    if (
      near
        ?.earningsEstimate
        ?.avg
        ?.raw != null
    ) {
      data.earnings =
        data.earnings || {};

      data.earnings.estimate =
        val(
          near
            .earningsEstimate
            .avg
        );
    }

    /*
      Add earnings catalyst.
    */

    if (
      data.earnings?.date
    ) {
      const existing =
        data.catalysts
          .some(
            x =>
              x.event ===
              "Earnings"
          );

      if (!existing) {
        data.catalysts.push({
          event:
            "Earnings",

          date:
            data.earnings.date,

          impact:
            "High",

          why:
            "Quarterly results and guidance can materially change expectations.",

          up:
            "Beat and/or stronger guidance",

          down:
            "Miss and/or weaker guidance",

          confidence:
            "Medium",

          source:
            "Yahoo Finance"
        });
      }
    }

    data.enrichment.calendar =
      {
        ok: true,

        hasData:
          !!data.earnings ||
          Object.values(f).some(
            x =>
              x !== undefined &&
              x !== null
          )
      };

  } catch (e) {
    data.enrichment.calendar =
      {
        ok: false,

        hasData: false,

        error:
          String(
            e?.message ||
            e
          ).slice(
            0,
            500
          )
      };

    data.enrichment.errors.push({
      source:
        "calendar",
      error:
        data.enrichment
          .calendar.error
    });
  }
}

/* =========================================================
   OPTIONS
========================================================= */

async function enrichOptions(
  symbol,
  data
) {
  try {
    const pathname =
      `/v7/finance/options/${encodeURIComponent(
        symbol
      )}`;

    const j =
      await yahooJSONAny(
        pathname
      );

    const r =
      j.optionChain
        ?.result?.[0];

    if (!r) {
      throw new Error(
        "Yahoo options returned no option chain"
      );
    }

    const expirations =
      (
        r.expirationDates ||
        []
      )
        .map(Number)
        .filter(
          Number.isFinite
        )
        .sort(
          (a, b) =>
            a - b
        );

    const now =
      Math.floor(
        Date.now() / 1000
      );

    const exp =
      expirations.find(
        x =>
          x >= now
      );

    if (!exp) {
      throw new Error(
        "Yahoo returned no future option expiration"
      );
    }

    const pathname2 =
      `/v7/finance/options/${encodeURIComponent(
        symbol
      )}?date=${exp}`;

    const j2 =
      await yahooJSONAny(
        pathname2
      );

    const x =
      j2.optionChain
        ?.result?.[0];

    if (!x) {
      throw new Error(
        "Yahoo returned no option chain for expiration"
      );
    }

    const calls =
      x.options?.[0]
        ?.calls || [];

    const puts =
      x.options?.[0]
        ?.puts || [];

    const sum =
      (arr, key) =>
        arr.reduce(
          (total, item) =>
            total +
            (
              val(item[key]) ||
              0
            ),
          0
        );

    const callVol =
      sum(
        calls,
        "volume"
      );

    const putVol =
      sum(
        puts,
        "volume"
      );

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
      data.quote.price;

    /*
      Find contracts closest to the current price.
    */

    function closestIV(
      arr
    ) {
      return arr
        .filter(
          z =>
            val(
              z.impliedVolatility
            ) != null &&
            val(
              z.strike
            ) != null
        )
        .sort(
          (a, b) =>
            Math.abs(
              val(
                a.strike
              ) -
                price
            ) -
            Math.abs(
              val(
                b.strike
              ) -
                price
            )
        )
        .slice(
          0,
          3
        )
        .map(
          z =>
            val(
              z.impliedVolatility
            )
        );
    }

    const ivs =
      closestIV(
        calls
      ).concat(
        closestIV(
          puts
        )
      );

    const iv =
      ivs.length
        ? ivs.reduce(
            (a, b) =>
              a + b,
            0
          ) /
          ivs.length
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

    /*
      We deliberately do NOT invent volVsAvg.
      Yahoo's single option chain does not provide
      a trustworthy historical options-volume baseline.
    */

    data.options = {
      available:
        true,

      callVol,

      putVol,

      callOI,

      putOI,

      openInterest:
        callOI + putOI,

      putCall:
        callVol > 0
          ? putVol /
            callVol
          : undefined,

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
          .slice(
            0,
            10
          )
    };

    if (
      data.earnings &&
      expectedMovePct != null
    ) {
      data.earnings
        .expectedMovePct =
        expectedMovePct;
    }

    data.enrichment.options =
      {
        ok: true,
        hasData: true
      };

  } catch (e) {
    data.enrichment.options =
      {
        ok: false,

        hasData: false,

        error:
          String(
            e?.message ||
            e
          ).slice(
            0,
            500
          )
      };

    data.enrichment.errors.push({
      source:
        "options",
      error:
        data.enrichment
          .options.error
    });
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
      w =>
        s.includes(w)
    ).length;

  const n =
    neg.filter(
      w =>
        s.includes(w)
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
    const pathname =
      `/v1/finance/search?q=${encodeURIComponent(
        symbol
      )}&newsCount=12&quotesCount=0`;

    const j =
      await yahooJSONAny(
        pathname
      );

    const rows =
      Array.isArray(
        j.news
      )
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
            x.providerPublishTime
              ? dateFromUnix(
                  x.providerPublishTime
                )
              : undefined;

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
              x.canonicalUrl
                ?.url
          };
        })
        .filter(
          x =>
            x.headline &&
            x.date
        );

    /*
      Turn clearly dated, relevant news into
      catalysts. We only do this when the
      headline itself contains a recognizable
      event. We do not pretend every headline
      is a catalyst.
    */

    for (
      const item of
      data.news
    ) {
      const s =
        item.headline
          .toLowerCase();

      const isCatalyst =
        /earnings|guidance|acquisition|acquire|merger|approval|contract|partnership|lawsuit|investigation|launch|product|recall|buyback|dividend|analyst|upgrade|downgrade/.test(
          s
        );

      if (!isCatalyst) {
        continue;
      }

      const already =
        data.catalysts
          .some(
            c =>
              c.date ===
                item.date &&
              c.event ===
                item.headline
          );

      if (already) {
        continue;
      }

      let impact =
        "Medium";

      if (
        /earnings|merger|acquisition|approval|investigation|lawsuit/.test(
          s
        )
      ) {
        impact =
          "High";
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

    data.enrichment.news =
      {
        ok: true,

        hasData:
          data.news.length >
          0
      };

  } catch (e) {
    data.enrichment.news =
      {
        ok: false,

        hasData: false,

        error:
          String(
            e?.message ||
            e
          ).slice(
            0,
            500
          )
      };

    data.enrichment.errors.push({
      source:
        "news",
      error:
        data.enrichment
          .news.error
    });
  }
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

  /*
    IMPORTANT:
    Run these sequentially rather than
    Promise.allSettled().

    This greatly reduces the chance of
    Yahoo rate-limiting Render.
  */

  await enrichQuote(
    symbol,
    data
  );

  await sleep(250);

  await enrichCalendar(
    symbol,
    data
  );

  await sleep(250);

  await enrichOptions(
    symbol,
    data
  );

  await sleep(250);

  await enrichNews(
    symbol,
    data
  );

  /*
    Earnings expected move.
  */

  if (
    data.options
      ?.expectedMovePct !=
      null &&
    data.earnings
  ) {
    data.earnings
      .expectedMovePct =
      data.options
        .expectedMovePct;
  }

  /*
    Provenance is only claimed when the
    corresponding data actually exists.
  */

  if (
    data.enrichment.quote
      ?.hasData ||
    data.enrichment.calendar
      ?.hasData
  ) {
    data.provenance
      .fundamentals = {
        source:
          "Yahoo Finance quote/quoteSummary",

        ts:
          new Date().toISOString()
      };
  }

  if (
    data.earnings
  ) {
    data.provenance
      .earnings = {
        source:
          "Yahoo Finance calendarEvents",

        ts:
          new Date().toISOString()
      };
  }

  if (
    data.options
  ) {
    data.provenance
      .options = {
        source:
          "Yahoo Finance option chain",

        ts:
          new Date().toISOString()
      };
  }

  if (
    Array.isArray(
      data.news
    ) &&
    data.news.length
  ) {
    data.provenance
      .news = {
        source:
          "Yahoo Finance news search",

        ts:
          new Date().toISOString(),

        sentiment:
          "rule-based headline heuristic"
      };
  }

  /*
    Helpful diagnostic status.
  */

  data.enrichment.summary = {
    quote:
      !!data.enrichment
        .quote.hasData,

    earnings:
      !!data.earnings,

    options:
      !!data.options,

    news:
      Array.isArray(
        data.news
      ) &&
      data.news.length > 0,

    shortInterest:
      data.fundamentals
        ?.shortPctFloat !=
        null,

    catalysts:
      Array.isArray(
        data.catalysts
      )
        ? data.catalysts.length
        : 0
  };

  CACHE.set(
    key,
    {
      time:
        Date.now(),

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
      lastError =
        e;

      if (
        attempt === 0
      ) {
        await sleep(
          1200
        );
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
    JSON.stringify(
      data
    )
  );
}

/* =========================================================
   HTML
========================================================= */

function serveHTML(
  res
) {
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

    res.end(
      file
    );

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
    async (
      req,
      res
    ) => {
      try {
        const u =
          new URL(
            req.url,
            `http://${req.headers.host}`
          );

        /* -------------------------
           HEALTH
        ------------------------- */

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
                yahoo:
                  true,

                quote:
                  true,

                options:
                  true,

                earnings:
                  true,

                news:
                  true
              }
            }
          );
        }

        /* -------------------------
           STOCK
        ------------------------- */

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

        /* -------------------------
           WEBSITE
        ------------------------- */

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

        /* -------------------------
           NOT FOUND
        ------------------------- */

        return sendJSON(
          res,
          404,
          {
            ok: false,

            error:
              "Not found"
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