# Trade Radar — automatic version

Trade Radar now runs as a normal web app instead of depending on an uploaded data file.

## What happens when you use it

1. Open the Trade Radar website.
2. Enter a ticker such as `NVDA` or `PLTR`.
3. The browser calls `/api/stock?symbol=...`.
4. The server pulls 1 year of daily price/volume data automatically.
5. Optional provider keys add fundamentals, earnings, news, and short-interest enrichment.

No stock-data upload is required.

## Run locally

Requires Node.js 18+.

```bash
node server.js
```

Then open `http://localhost:3000`.

## Optional data-provider keys

Copy `.env.example` to `.env` and configure keys in the hosting provider's environment settings. The server does not send keys to the browser.

- Alpha Vantage: fundamentals, earnings calendar, news sentiment.
- Finnhub: additional profile/earnings/news/short-interest enrichment where the account/endpoint provides it.

The basic Yahoo Finance chart feed is used server-side for price and daily OHLCV so the app can work without an API key.

## Deploy

This is a standard Node HTTP server. It can be deployed to a Node-compatible host such as Render, Railway, Fly.io, or another service that supports a long-running Node process.

Set the start command to:

```bash
node server.js
```

Set any provider API keys as environment variables on the host.

## Important

A stock-market game tool should never pretend missing data is real. Trade Radar labels unavailable enrichment and uses its existing data-quality logic rather than inventing options, short interest, earnings, or news.
