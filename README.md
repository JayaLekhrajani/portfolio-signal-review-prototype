# Live Portfolio Review

Live Portfolio Review is a Version 1 working prototype for reviewing a manually entered or CSV-uploaded investment holding list with public market quote data.

The app does not connect to Vanguard or any brokerage account. Users provide position values and tickers manually or through CSV, and the local Node backend enriches those tickers with public quote data.

## Screenshots

Desktop dashboard:

![Portfolio Signal Review desktop dashboard](docs/screenshots/portfolio-signal-review-desktop.png)

CSV upload flow:

![Portfolio Signal Review CSV upload flow](docs/screenshots/portfolio-signal-review-upload-modal.png)

Mobile layout:

![Portfolio Signal Review mobile layout](docs/screenshots/portfolio-signal-review-mobile.png)

## What The Prototype Shows

- Manual ticker entry for a live review list
- CSV upload flow for sample or user-provided holdings
- Portfolio overview with current public quote movement
- Allocation and market-move charts
- Holdings triage table with attention labels
- Holding detail and reasoning panel
- Advisor escalation draft that requires human approval
- Downloadable neutral review packet
- Public quote enrichment for mapped or entered tickers
- Refusal behavior for buy, sell, rebalance, timing, increase, decrease, or hold advice requests

## Run Locally

From this project folder:

```bash
npm start
```

Then open the URL printed in the terminal, usually:

```text
http://127.0.0.1:5174/website/
```

If port `5174` is busy, the server automatically tries the next available port and prints the correct URL.

## CSV Upload Sample

Use this sample file to test the CSV upload flow:

```text
data/portfolio_signal_review/mock_upload_sample.csv
```

In the app:

1. Click `Upload CSV`.
2. Click `Choose CSV`.
3. Select `data/portfolio_signal_review/mock_upload_sample.csv`.
4. The backend enriches mapped tickers with public quote data.

At minimum, a custom CSV needs:

```csv
ticker_symbol,current_value_usd,target_pct
AAPL,25000,10
VTI,85000,40
BND,45000,25
```

Optional columns such as `asset_type`, `sentiment_label`, `volatility_label`, and `news_headline_1` improve the attention labels.

## Market Data

The backend fetches public quote data for mapped tickers and adds fields such as:

- `ticker_symbol`
- `market_company_name`
- `market_price`
- `market_change_pct`
- `market_timestamp`
- `market_data_source`
- `market_data_status`

The position values and allocation percentages are supplied by the user or demo CSV. They are not brokerage data.

## Important Boundary

This prototype is not a financial advisor and does not provide investment advice. It should not recommend buying, selling, rebalancing, holding, increasing, decreasing, or timing investments.

It is designed to summarize market signals and prepare questions for human review.

## GitHub Hosting Note

GitHub Pages can host static websites only. This prototype uses a Node backend for `/api/...` routes, so GitHub Pages alone cannot run the live quote version.

Recommended paths:

- Use GitHub as the source repository.
- Deploy the Node app to a service that supports backend code.
- Use GitHub Pages only for a static fallback demo.
