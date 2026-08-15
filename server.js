const http = require("http");
const fs = require("fs");
const path = require("path");

const START_PORT = Number(process.env.PORT || 5174);
const HOST = "127.0.0.1";
const ROOT = __dirname;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

const SYMBOL_MAP = {
  "HLD-101": ["VTI", "etf"],
  "HLD-102": ["MSFT", "stocks"],
  "HLD-203": ["BND", "etf"],
  "HLD-304": ["VXUS", "etf"],
  "HLD-405": ["PFE", "stocks"],
  "HLD-506": ["MUB", "etf"],
  "HLD-207": ["IWM", "etf"],
  "HLD-308": ["XLU", "etf"],
  "HLD-409": ["AOR", "etf"],
  "HLD-510": ["QQQ", "etf"],
  "HLD-111": ["NKE", "stocks"],
  "HLD-112": ["AAPL", "stocks"],
  "HLD-313": ["VTI", "etf"],
  "ADV-101": ["VTI", "etf"],
  "ADV-102": ["QQQ", "etf"],
  "ADV-103": ["CAT", "stocks"],
  "ADV-104": ["VXUS", "etf"],
  "ADV-105": ["BND", "etf"],
};

const quoteCache = new Map();
const CACHE_MS = 60 * 1000;

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const headers = rows.shift() || [];
  return rows.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]))
  );
}

function csvEscape(value) {
  const stringValue = String(value ?? "");
  if (/[",\n\r]/.test(stringValue)) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }
  return stringValue;
}

function toCSV(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n");
}

function parseMoney(value) {
  const number = Number(String(value || "").replace(/[$,%\s,]/g, ""));
  return Number.isFinite(number) ? number : null;
}

async function fetchNasdaqQuote(symbol, assetClass) {
  const cacheKey = `${symbol}:${assetClass}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_MS) return cached.quote;

  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=${encodeURIComponent(assetClass)}`;
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 PortfolioSignalReviewPrototype/1.0",
    },
  });

  if (!response.ok) throw new Error(`Nasdaq quote ${response.status}`);
  const payload = await response.json();
  const data = payload.data || {};
  const primary = data.primaryData || {};
  const secondary = data.secondaryData || {};
  const quoteBlock = primary.lastSalePrice ? primary : secondary;

  const price = parseMoney(quoteBlock.lastSalePrice);
  const changePct = parseMoney(quoteBlock.percentageChange);
  const change = parseMoney(quoteBlock.netChange);

  if (price == null || changePct == null) throw new Error(`Quote unavailable for ${symbol}`);

  const quote = {
    symbol,
    companyName: data.companyName || symbol,
    price,
    change,
    changePct,
    timestamp: quoteBlock.lastTradeTimestamp || "",
    source: "Nasdaq public quote",
    status: "live",
  };

  quoteCache.set(cacheKey, { quote, cachedAt: Date.now() });
  return quote;
}

async function quoteForHolding(row) {
  const explicitSymbol = row.ticker_symbol || row.market_symbol;
  const [mappedSymbol, mappedAssetClass] = SYMBOL_MAP[row.holding_id] || [];
  const symbol = explicitSymbol || mappedSymbol;
  const assetClass = row.market_asset_class || mappedAssetClass || (row.asset_type === "stock" ? "stocks" : "etf");

  if (!symbol) {
    return {
      symbol: "",
      companyName: "",
      price: "",
      change: "",
      changePct: "",
      timestamp: "",
      source: "No mapped ticker",
      status: "missing",
    };
  }

  try {
    return await fetchNasdaqQuote(symbol, assetClass);
  } catch (error) {
    return {
      symbol,
      companyName: "",
      price: "",
      change: "",
      changePct: "",
      timestamp: "",
      source: error.message,
      status: "unavailable",
    };
  }
}

async function enrichRows(rows) {
  return Promise.all(
    rows.map(async (row) => {
      const quote = await quoteForHolding(row);
      const hasLiveMove = Number.isFinite(Number(quote.changePct));
      return {
        ...row,
        ticker_symbol: quote.symbol,
        market_company_name: quote.companyName,
        market_price: quote.price,
        market_change_pct: quote.changePct,
        market_change_abs: quote.change,
        market_timestamp: quote.timestamp,
        market_data_source: quote.source,
        market_data_status: quote.status,
        weekly_change_pct: hasLiveMove ? String(quote.changePct) : row.weekly_change_pct,
        monthly_change_pct: hasLiveMove ? String(quote.changePct) : row.monthly_change_pct,
        news_headline_1: hasLiveMove
          ? row.news_headline_1 || `${quote.symbol} public quote: ${quote.changePct >= 0 ? "up" : "down"} ${Math.abs(quote.changePct).toFixed(2)}% at ${quote.price.toFixed(2)}`
          : row.news_headline_1,
        news_headline_2: hasLiveMove
          ? `${quote.symbol} public quote: ${quote.changePct >= 0 ? "up" : "down"} ${Math.abs(quote.changePct).toFixed(2)}% at ${quote.price.toFixed(2)} · ${quote.source}${quote.timestamp ? ` · ${quote.timestamp}` : ""}`
          : row.news_headline_2,
      };
    })
  );
}

async function enrichedWorkflowInputs() {
  const filePath = path.join(ROOT, "data", "portfolio_signal_review", "workflow_inputs.csv");
  const rows = parseCSV(await fs.promises.readFile(filePath, "utf8"));
  const enriched = await enrichRows(rows);
  return toCSV(enriched);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/health") {
    send(res, 200, JSON.stringify({ ok: true, provider: "Nasdaq public quote" }), "application/json; charset=utf-8");
    return;
  }

  if (pathname === "/api/workflow-inputs") {
    send(res, 200, await enrichedWorkflowInputs(), "text/csv; charset=utf-8");
    return;
  }

  if (pathname === "/api/enrich-csv" && req.method === "POST") {
    const rows = parseCSV(await readBody(req));
    const enriched = await enrichRows(rows);
    send(res, 200, toCSV(enriched), "text/csv; charset=utf-8");
    return;
  }

  if (pathname === "/api/user-profiles") {
    const body = await fs.promises.readFile(path.join(ROOT, "data", "portfolio_signal_review", "user_profiles.csv"));
    send(res, 200, body, "text/csv; charset=utf-8");
    return;
  }

  if (pathname === "/api/portfolio-history") {
    const body = await fs.promises.readFile(path.join(ROOT, "data", "portfolio_signal_review", "portfolio_history.csv"));
    send(res, 200, body, "text/csv; charset=utf-8");
    return;
  }

  send(res, 404, JSON.stringify({ error: "API route not found" }), "application/json; charset=utf-8");
}

function safeStaticPath(pathname) {
  const requested = pathname === "/" ? "/website/index.html" : pathname;
  const filePath = path.normalize(path.join(ROOT, requested));
  if (!filePath.startsWith(ROOT)) return null;
  return filePath;
}

async function handleStatic(req, res, pathname) {
  const filePath = safeStaticPath(pathname);
  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }

  try {
    const stat = await fs.promises.stat(filePath);
    const finalPath = stat.isDirectory() ? path.join(filePath, "index.html") : filePath;
    const ext = path.extname(finalPath);
    const body = await fs.promises.readFile(finalPath);
    send(res, 200, body, MIME_TYPES[ext] || "application/octet-stream");
  } catch (error) {
    send(res, 404, "Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
    } else {
      await handleStatic(req, res, url.pathname);
    }
  } catch (error) {
    send(res, 500, JSON.stringify({ error: error.message }), "application/json; charset=utf-8");
  }
});

function listen(port) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE" && !process.env.PORT) {
      listen(port + 1);
      return;
    }
    throw error;
  });

  server.listen(port, HOST, () => {
    console.log(`Portfolio Signal Review running at http://${HOST}:${port}/website/`);
    console.log("Market data provider: Nasdaq public quote endpoint");
  });
}

listen(START_PORT);
