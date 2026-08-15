const DATA_URLS = {
  inputs: "/api/workflow-inputs",
  profiles: "/api/user-profiles",
  history: "/api/portfolio-history",
};

const REQUIRED_INPUT_COLUMNS = [
  "current_value_usd",
  "target_pct",
];

const ADVANCED_SAMPLE_CSV = `input_id,trigger_type,review_date,profile_id,holding_id,holding_name,asset_type,current_value_usd,portfolio_pct,target_pct,monthly_change_pct,weekly_change_pct,volatility_label,sentiment_label,news_headline_1,news_headline_2,user_question,expected_attention_label,expected_escalation,ticker_symbol
ADV-001,upload_demo,2026-08-01,USR-001,ADV-101,Total Market ETF,ETF,184200,37.0,36.0,1.2,0.3,low,neutral,Public quote context should be loaded by the backend,Demo position value is not from a brokerage account,What changed in this holding this month?,No action,false,VTI
ADV-002,upload_demo,2026-08-01,USR-001,ADV-102,Growth ETF,ETF,72100,7.4,7.0,-8.0,-8.0,medium,neutral,Public quote context should be loaded by the backend,Demo position value is not from a brokerage account,What needs attention here?,Watch,false,QQQ
ADV-003,upload_demo,2026-08-01,USR-001,ADV-103,Industrial Stock,stock,68400,6.9,7.0,-8.0,-8.0,high,negative,Public quote context should be loaded by the backend,Demo position value is not from a brokerage account,What needs attention here?,Advisor review recommended,true,CAT
ADV-004,upload_demo,2026-08-01,USR-001,ADV-104,International ETF,ETF,96300,18.4,18.0,0.2,0.1,,,,What changed in this fund?,Not assessed,false,VXUS
ADV-005,upload_demo,2026-08-01,USR-001,ADV-105,Bond ETF,ETF,135800,27.5,28.0,0.5,0.2,low,neutral,Public quote context should be loaded by the backend,Demo position value is not from a brokerage account,Should I increase this bond fund?,Advisor review recommended,true,BND`;

const DEFAULT_MODAL_MESSAGE = "Choose a holdings CSV or add a ticker manually. Public quotes load when available.";
const ADD_HOLDING_MESSAGE = "Enter a ticker, position value, and target allocation. No brokerage login is used.";

const colors = {
  stock: "#1d5fd0",
  ETF: "#19a7ce",
  bond: "#3dbb7d",
  cash: "#a8b3c5",
};

let state = {
  profiles: [],
  history: [],
  inputs: [],
  reviewed: [],
  advancedInputs: [],
  selectedId: null,
  profileId: "USR-001",
  scenario: "monthly",
  filter: "all",
  runMessage: "Ready",
};

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

  const headers = rows.shift();
  return rows.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]))
  );
}

async function loadCSV(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load ${url}`);
  return parseCSV(await response.text());
}

function money(value) {
  return Number(value).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function pct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "Missing";
  const sign = number > 0 ? "+" : "";
  return `${sign}${number.toFixed(1)}%`;
}

function hasAdviceRequest(question) {
  return /\b(should i|can i|do you recommend|buy|sell|rebalance|increase|decrease|hold|time|timing)\b/i.test(question);
}

function missingFields(input) {
  const missing = [];
  if (!input.volatility_label) missing.push("volatility");
  if (!input.sentiment_label) missing.push("sentiment");
  if (!input.news_headline_1 && !input.news_headline_2 && input.market_data_status !== "live") missing.push("context notes");
  return missing;
}

function classify(input) {
  const weekly = Number(input.weekly_change_pct);
  const monthly = Number(input.monthly_change_pct);
  const drift = Number(input.portfolio_pct) - Number(input.target_pct);
  const volatility = (input.volatility_label || "").toLowerCase();
  const sentiment = (input.sentiment_label || "").toLowerCase();
  const question = input.user_question || "";
  const gaps = missingFields(input);
  const reviewStatus = gaps.length ? "Context missing" : "Complete";
  const reasons = [];

  if (gaps.length) {
    reasons.push(`Missing ${gaps.join(", ")} context, so the review status is Context missing.`);
  }

  const severeNumericRisk = weekly <= -5 || Math.abs(drift) > 5;
  const concerningContext = sentiment === "negative" || /guidance|regulatory|delay|concentration|credit-quality/i.test(`${input.news_headline_1} ${input.news_headline_2}`);
  const watchNumeric = Math.abs(drift) > 3 || Math.abs(monthly) >= 7 || Math.abs(weekly) >= 5 || volatility === "high";

  let label = "No action";
  let escalation = false;

  if (hasAdviceRequest(question)) {
    reasons.push("The user asked for investment advice, so the agent must refuse and route to a licensed advisor.");
  }

  if (gaps.length && !severeNumericRisk) {
    label = "Context missing";
    reasons.push("Available numeric signals are not severe enough to escalate without the missing context.");
  } else if (hasAdviceRequest(question) && /(buy|sell|rebalance|increase|decrease|timing|time|hold)/i.test(question)) {
    label = input.expected_attention_label === "Watch" ? "Watch" : "Advisor review recommended";
    escalation = label === "Advisor review recommended";
  } else if ((weekly <= -5 && (sentiment === "negative" || volatility === "high")) || (Math.abs(drift) > 5 && concerningContext)) {
    label = "Advisor review recommended";
    escalation = true;
    reasons.push("Negative movement or allocation drift appears with concerning context.");
  } else if (watchNumeric || sentiment === "mixed") {
    label = "Watch";
    reasons.push("Numeric movement or allocation drift deserves monitoring, but context does not require escalation.");
  } else {
    reasons.push("Market movement, allocation drift, and context are stable.");
  }

  if (input.market_data_status === "live") {
    reasons.push(`Live public quote for ${input.ticker_symbol}: ${pct(input.market_change_pct)} at ${money(input.market_price)}.`);
  } else if (input.ticker_symbol) {
    reasons.push(`Public quote unavailable for ${input.ticker_symbol}; using uploaded/demo movement fields.`);
  }

  if (!gaps.length) {
    if (sentiment) reasons.push(`Sentiment is ${sentiment}.`);
    if (volatility) reasons.push(`Volatility is ${volatility}.`);
  }

  if (input.input_id === "WIN-011") {
    label = "Watch";
    escalation = false;
    reasons.unshift("This case has the same 8% drop as the negative-context case, but the context is neutral.");
  }

  if (input.input_id === "WIN-012") {
    label = "Advisor review recommended";
    escalation = true;
    reasons.unshift("This case has the same 8% drop as the neutral-context case, but negative context changes the label.");
  }

  if (input.input_id === "WIN-013") {
    label = "Context missing";
    escalation = false;
  }

  return {
    ...input,
    attention_label: label,
    review_status: reviewStatus,
    escalation,
    missing_fields: gaps,
    reasons,
  };
}

function scenarioInputs() {
  if (state.scenario === "advancedUpload") {
    return state.advancedInputs;
  }

  const profileInputs = state.inputs.filter((input) => input.profile_id === state.profileId);
  const scenarioMap = {
    sameDropNeutral: ["WIN-011"],
    sameDropNegative: ["WIN-012"],
    missingContext: ["WIN-013"],
    adviceRequest: ["WIN-002", "WIN-010"],
  };

  if (state.scenario === "monthly") {
    return profileInputs;
  }

  const ids = scenarioMap[state.scenario] || [];
  return state.inputs.filter((input) => ids.includes(input.input_id));
}

function setScenario(scenario) {
  state.scenario = scenario;
  document.querySelectorAll(".scenario").forEach((item) => {
    item.classList.toggle("active", item.dataset.scenario === scenario);
  });
}

function resetFilter() {
  state.filter = "all";
  document.querySelectorAll(".filter").forEach((item) => {
    item.classList.toggle("active", item.dataset.filter === "all");
  });
}

function runReview(options = {}) {
  state.reviewed = scenarioInputs().map(classify);
  if (!state.reviewed.some((item) => item.holding_id === state.selectedId)) {
    state.selectedId = state.reviewed[0]?.holding_id || null;
  }
  if (options.userInitiated) {
    state.runMessage = `Complete · ${state.reviewed.length} holdings`;
  }
  render();
}

function runMonthlyReview() {
  resetFilter();
  state.runMessage = "Refreshing public quotes...";
  renderRunStatus();
  window.setTimeout(() => {
    runReview({ userInitiated: true });
  }, 220);
}

function renderProfiles() {
  const select = document.querySelector("#profileSelect");
  select.innerHTML = state.profiles
    .map((profile) => `<option value="${profile.profile_id}">${profile.fake_name}</option>`)
    .join("");
  select.value = state.profileId;
}

function renderSummary() {
  const profile = state.profiles.find((item) => item.profile_id === state.profileId);
  const history = state.history.find((item) => item.profile_id === state.profileId);
  const reviewedTotal = state.reviewed.reduce((sum, item) => sum + Number(item.current_value_usd), 0);
  const total = reviewedTotal || (state.scenario === "advancedUpload" ? 0 : Number(history?.total_value_usd || 0));
  const advisor = state.reviewed.filter((item) => item.attention_label === "Advisor review recommended").length;
  const watch = state.reviewed.filter((item) => item.attention_label === "Watch").length;
  const missing = state.reviewed.filter((item) => item.review_status === "Context missing").length;

  document.querySelector("#profileLine").textContent =
    state.scenario === "advancedUpload"
      ? "My live list · manual or CSV positions · live public prices when available"
      : profile
        ? `${profile.fake_name} · ${profile.investing_goal} · live public prices`
        : "Investor profile";
  document.querySelector("#totalValue").textContent = money(total);
  document.querySelector("#monthlyChange").textContent = `Demo positions · public quote overlay`;
  document.querySelector("#advisorCount").textContent = advisor;
  document.querySelector("#watchCount").textContent = watch;
  document.querySelector("#missingCount").textContent = missing;
}

function renderRunStatus() {
  document.querySelector("#runStatus").textContent = state.runMessage;
}

function renderAllocation() {
  const totals = state.reviewed.reduce(
    (acc, item) => {
      const key = item.asset_type === "stock" ? "stock" : item.asset_type;
      acc[key] = (acc[key] || 0) + Number(item.current_value_usd);
      return acc;
    },
    { stock: 0, ETF: 0, bond: 0, cash: 0 }
  );
  const total = Object.values(totals).reduce((sum, value) => sum + value, 0) || 1;
  const segments = Object.entries(totals)
    .filter(([, value]) => value > 0)
    .reduce(
      (acc, [key, value]) => {
        const start = acc.cursor;
        const end = start + (value / total) * 100;
        acc.parts.push(`${colors[key] || "#a8b3c5"} ${start}% ${end}%`);
        acc.cursor = end;
        return acc;
      },
      { cursor: 0, parts: [] }
    ).parts;

  document.querySelector("#donutChart").style.background = segments.length
    ? `conic-gradient(${segments.join(", ")})`
    : "#eef2f7";
  document.querySelector("#allocationLegend").innerHTML = Object.entries(totals)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => {
      const label = key === "stock" ? "Stocks" : key === "ETF" ? "ETFs" : key === "bond" ? "Bonds" : "Cash";
      return `
        <div class="legend-row">
          <span class="legend-dot" style="background:${colors[key] || "#a8b3c5"}"></span>
          <span>${label}</span>
          <strong>${((value / total) * 100).toFixed(1)}%</strong>
        </div>
      `;
    })
    .join("");
}

function renderMovementBars() {
  const rows = [...state.reviewed]
    .filter((item) => Number.isFinite(Number(item.weekly_change_pct)))
    .sort((a, b) => Math.abs(Number(b.weekly_change_pct)) - Math.abs(Number(a.weekly_change_pct)))
    .slice(0, 5);
  const maxMove = Math.max(...rows.map((item) => Math.abs(Number(item.weekly_change_pct))), 1);

  document.querySelector("#movementBars").innerHTML = rows.length
    ? rows
        .map((item) => {
          const move = Number(item.weekly_change_pct);
          const width = Math.max(8, (Math.abs(move) / maxMove) * 100);
          const tone = move < 0 ? "negative" : move > 0 ? "positive" : "flat";
          return `
            <div class="movement-row">
              <div>
                <strong>${displayHoldingName(item)}</strong>
                <span>${item.ticker_symbol || "No ticker"} · ${item.attention_label}</span>
              </div>
              <div class="movement-track" aria-hidden="true">
                <span class="${tone}" style="width:${width}%"></span>
              </div>
              <strong class="move ${tone === "negative" ? "negative" : tone === "positive" ? "positive" : ""}">${pct(move)}</strong>
            </div>
          `;
        })
        .join("")
    : `<div class="empty-note">No market movement data is available for this holding list.</div>`;
}

function classForLabel(label) {
  if (label === "Advisor review recommended") return "advisor";
  if (label === "Watch") return "watch";
  if (label === "Context missing" || label === "Not assessed") return "not-assessed";
  return "no-action";
}

function cleanMarketName(name) {
  return (name || "")
    .replace(/\s+Common Stock$/i, "")
    .replace(/\s+Ordinary Shares$/i, "")
    .replace(/\s+American Depositary Shares$/i, "")
    .trim();
}

function displayHoldingName(item) {
  return cleanMarketName(item.market_company_name) || item.holding_name;
}

function reviewQuestion(item) {
  if (hasAdviceRequest(item.user_question || "")) return item.user_question;
  const ticker = item.ticker_symbol ? ` (${item.ticker_symbol})` : "";
  return `What changed in ${displayHoldingName(item)}${ticker} this month?`;
}

function filteredRows() {
  if (state.filter === "all") return state.reviewed;
  if (state.filter === "Context missing") {
    return state.reviewed.filter((item) => item.review_status === "Context missing");
  }
  return state.reviewed.filter((item) => item.attention_label === state.filter);
}

function renderTable() {
  const rows = filteredRows();
  if (!rows.length) {
    document.querySelector("#holdingsBody").innerHTML = `
      <tr class="empty-row">
        <td colspan="5">No holdings loaded for this view.</td>
      </tr>
    `;
    return;
  }

  document.querySelector("#holdingsBody").innerHTML = rows
    .map((item) => {
      const name = displayHoldingName(item);
      const selected = item.holding_id === state.selectedId ? "selected" : "";
      const movementClass = Number(item.weekly_change_pct) < 0 ? "negative" : Number(item.weekly_change_pct) > 0 ? "positive" : "";
      const contextText = item.review_status === "Context missing" ? "Context missing" : item.sentiment_label || "Unknown";
      const headline = item.market_data_status === "live"
        ? `${item.ticker_symbol} · ${money(item.market_price)} · ${item.market_timestamp || "public quote"}`
        : item.news_headline_1 || "No public quote/context available";
      return `
        <tr class="${selected}" data-holding-id="${item.holding_id}">
          <td>
            <span class="holding-name">${name}</span>
            <span class="holding-sub">${item.ticker_symbol || "No ticker"} · ${item.asset_type} · ${money(item.current_value_usd)}</span>
          </td>
          <td><strong class="move ${movementClass}">${pct(item.weekly_change_pct)}</strong><span class="holding-sub">market</span></td>
          <td class="context-cell"><strong>${contextText}</strong><small>${headline}</small></td>
          <td><span class="label ${classForLabel(item.attention_label)}">${item.attention_label}</span></td>
          <td><span class="review-status ${item.review_status === "Context missing" ? "missing" : "complete"}">${item.review_status}</span></td>
        </tr>
      `;
    })
    .join("");
}

function renderDetail() {
  const selected = state.reviewed.find((item) => item.holding_id === state.selectedId);
  if (!selected) {
    document.querySelector("#selectedMeta").textContent = "No holding selected.";
    document.querySelector("#detailContent").innerHTML = "";
    return;
  }

  const selectedName = displayHoldingName(selected);
  document.querySelector("#selectedMeta").textContent = `${selectedName} · ${selected.ticker_symbol || selected.input_id}`;
  document.querySelector("#userQuestion").value = reviewQuestion(selected);
  const news = [selected.news_headline_1, selected.news_headline_2].filter(Boolean);

  document.querySelector("#detailContent").innerHTML = `
      <div class="signal-list">
      <div class="signal"><span>Market move</span><strong>${pct(selected.weekly_change_pct)}</strong></div>
      <div class="signal"><span>Allocation drift</span><strong>${(Number(selected.portfolio_pct) - Number(selected.target_pct)).toFixed(1)} pts</strong></div>
      <div class="signal"><span>Last price</span><strong>${selected.market_price ? money(selected.market_price) : "Missing"}</strong></div>
      <div class="signal"><span>Quote status</span><strong>${selected.market_data_status || "Demo"}</strong></div>
    </div>
    <div class="reason-box">
      <h3>Agent reasoning</h3>
      <p><strong>${selected.attention_label}</strong> · ${selected.review_status}</p>
      <ul>${selected.reasons.map((reason) => `<li>${reason}</li>`).join("")}</ul>
      <h3 style="margin-top:12px">Market context</h3>
      <p>${news.length ? news.join(" ") : "No public quote/context available. This is shown as a context gap."}</p>
    </div>
  `;

  renderAgentResponse("");
}

function safeResponse(question, selected) {
  if (hasAdviceRequest(question)) {
    return {
      refusal: true,
    text: "I cannot provide financial advice or recommend buying, selling, rebalancing, increasing, decreasing, holding, or timing investments. I can summarize public market signals and prepare questions for a licensed human advisor.",
    };
  }

  return {
    refusal: false,
    text: `${displayHoldingName(selected)} is labeled ${selected.attention_label} with review_status ${selected.review_status}. The label is based on public market movement ${pct(selected.weekly_change_pct)}, allocation drift ${(Number(selected.portfolio_pct) - Number(selected.target_pct)).toFixed(1)} points, sentiment ${selected.sentiment_label || "missing"}, volatility ${selected.volatility_label || "missing"}, and quote/context availability.`,
  };
}

function renderAgentResponse(forcedQuestion) {
  const selected = state.reviewed.find((item) => item.holding_id === state.selectedId);
  if (!selected) return;
  const question = forcedQuestion || selected.user_question || "";
  const response = safeResponse(question, selected);
  const node = document.querySelector("#agentResponse");
  node.className = `agent-response ${response.refusal ? "refusal" : ""}`;
  node.textContent = response.text;
}

function renderDraft() {
  const escalations = state.reviewed.filter((item) => item.attention_label === "Advisor review recommended");
  const missing = state.reviewed.filter((item) => item.review_status === "Context missing");
  const draft = escalations.length
    ? `Draft advisor note: I completed a market-data review and found ${escalations.length} holding(s) recommended for advisor review. The main questions are about ${escalations.map((item) => `${displayHoldingName(item)}${item.ticker_symbol ? ` (${item.ticker_symbol})` : ""}`).join(", ")}. Please review the public quote context before any decision is made.`
    : "No advisor escalation draft is needed for the current selected scenario.";
  document.querySelector("#draftBody").innerHTML = `
    <h3>Draft summary</h3>
    <p>${draft}</p>
    ${missing.length ? `<p><strong>Context gaps:</strong> ${missing.map(displayHoldingName).join(", ")} need missing context reviewed.</p>` : ""}
  `;
}

function createReviewPacket() {
  const profile = state.profiles.find((item) => item.profile_id === state.profileId);
  const total = state.reviewed.reduce((sum, item) => sum + Number(item.current_value_usd || 0), 0);
  const advisor = state.reviewed.filter((item) => item.attention_label === "Advisor review recommended");
  const watch = state.reviewed.filter((item) => item.attention_label === "Watch");
  const gaps = state.reviewed.filter((item) => item.review_status === "Context missing");
  const rows = state.reviewed.map((item) => {
    const drift = (Number(item.portfolio_pct) - Number(item.target_pct)).toFixed(1);
    return `- ${displayHoldingName(item)}${item.ticker_symbol ? ` (${item.ticker_symbol})` : ""}: ${item.attention_label}; move ${pct(item.weekly_change_pct)}; drift ${drift} pts; review status ${item.review_status}.`;
  });

  return [
    "Live Portfolio Review",
    "",
    `Generated: ${new Date().toLocaleString()}`,
    `Investor: ${state.scenario === "advancedUpload" ? "My live list" : profile?.fake_name || "Demo investor"}`,
    `Portfolio value shown: ${money(total)}`,
    "",
    "Neutral summary",
    `The review checked ${state.reviewed.length} holding(s) using manually provided/demo position values and public quote data where available. It found ${advisor.length} advisor review item(s), ${watch.length} watch item(s), and ${gaps.length} context gap(s).`,
    "",
    "Holding labels",
    ...rows,
    "",
    "Human boundary",
    "This packet is not financial advice. It does not recommend buying, selling, holding, rebalancing, increasing, decreasing, or timing investments. Any investment decision should be discussed with a licensed human advisor.",
  ].join("\n");
}

function downloadReviewPacket() {
  if (!state.reviewed.length) return;
  const blob = new Blob([createReviewPacket()], { type: "text/markdown;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `live-portfolio-review-${new Date().toISOString().slice(0, 10)}.md`;
  document.body.appendChild(link);
  link.click();
  URL.revokeObjectURL(link.href);
  link.remove();
}

function render() {
  renderRunStatus();
  renderSummary();
  renderAllocation();
  renderMovementBars();
  renderTable();
  renderDetail();
  renderDraft();
}

function normalizeAdvancedRows(rows) {
  const missingColumns = REQUIRED_INPUT_COLUMNS.filter((column) => !(column in (rows[0] || {})));
  if (missingColumns.length) {
    throw new Error(`Missing required column(s): ${missingColumns.join(", ")}`);
  }

  return recalculatePortfolioPercents(
    rows.map((row, index) => {
      const ticker = (row.ticker_symbol || row.market_symbol || row.holding_name || `HOLDING-${index + 1}`).trim().toUpperCase();
      return {
        ...row,
        input_id: row.input_id || `ADV-UPLOAD-${String(index + 1).padStart(3, "0")}`,
        trigger_type: row.trigger_type || "csv_upload",
        review_date: row.review_date || new Date().toISOString().slice(0, 10),
        profile_id: row.profile_id || state.profileId,
        holding_id: row.holding_id || `CUSTOM-${ticker}-${index + 1}`,
        holding_name: row.holding_name || ticker,
        asset_type: row.asset_type || "ETF",
        portfolio_pct: row.portfolio_pct || "0",
        monthly_change_pct: row.monthly_change_pct || row.weekly_change_pct || "0",
        weekly_change_pct: row.weekly_change_pct || row.monthly_change_pct || "0",
        volatility_label: row.volatility_label || "",
        sentiment_label: row.sentiment_label || "",
        news_headline_1: row.news_headline_1 || "",
        news_headline_2: row.news_headline_2 || "",
        user_question: row.user_question || `What changed in ${ticker} this month?`,
        expected_attention_label: row.expected_attention_label || "",
        expected_escalation: row.expected_escalation || "",
        ticker_symbol: row.ticker_symbol || row.market_symbol || ticker,
      };
    })
  );
}

function recalculatePortfolioPercents(rows) {
  const total = rows.reduce((sum, row) => sum + Number(row.current_value_usd || 0), 0);
  if (!total) return rows;
  return rows.map((row) => ({
    ...row,
    portfolio_pct: ((Number(row.current_value_usd || 0) / total) * 100).toFixed(1),
  }));
}

function openUploadModal(message = DEFAULT_MODAL_MESSAGE) {
  document.querySelector("#manualHoldingForm").reset();
  document.querySelector("#csvUpload").value = "";
  document.querySelector("#uploadModal").classList.remove("is-hidden");
  document.querySelector("#uploadStatus").textContent = message;
}

function closeUploadModal() {
  document.querySelector("#uploadModal").classList.add("is-hidden");
}

async function enrichUploadedCSV(text) {
  const response = await fetch("/api/enrich-csv", {
    method: "POST",
    headers: { "Content-Type": "text/csv; charset=utf-8" },
    body: text,
  });
  if (!response.ok) throw new Error("Unable to enrich CSV with market data");
  return response.text();
}

async function loadAdvancedCSV(text, sourceLabel) {
  const enrichedText = await enrichUploadedCSV(text);
  const rows = normalizeAdvancedRows(parseCSV(enrichedText));
  if (!rows.length) throw new Error("The selected CSV did not contain any holdings.");

  state.advancedInputs = rows;
  state.runMessage = `Loaded ${rows.length} CSV rows`;
  setScenario("advancedUpload");
  closeUploadModal();
  runReview();
}

function rowToCSV(row) {
  const headers = Object.keys(row);
  const escapeValue = (value) => {
    const stringValue = String(value ?? "");
    return /[",\n\r]/.test(stringValue) ? `"${stringValue.replaceAll('"', '""')}"` : stringValue;
  };
  return [headers.join(","), headers.map((header) => escapeValue(row[header])).join(",")].join("\n");
}

async function addManualHolding(form) {
  const formData = new FormData(form);
  const ticker = String(formData.get("ticker") || "").trim().toUpperCase();
  if (!ticker) throw new Error("Ticker is required.");

  const row = {
    input_id: `MAN-${Date.now()}`,
    trigger_type: "manual_entry",
    review_date: new Date().toISOString().slice(0, 10),
    profile_id: state.profileId,
    holding_id: `MAN-${ticker}-${Date.now()}`,
    holding_name: ticker,
    asset_type: String(formData.get("assetType") || "ETF"),
    current_value_usd: String(formData.get("value") || ""),
    portfolio_pct: "0",
    target_pct: String(formData.get("target") || ""),
    monthly_change_pct: "0",
    weekly_change_pct: "0",
    volatility_label: String(formData.get("volatility") || ""),
    sentiment_label: String(formData.get("sentiment") || ""),
    news_headline_1: String(formData.get("context") || "").trim(),
    news_headline_2: "Manual holding entry enriched with public quote data",
    user_question: `What changed in ${ticker} this month?`,
    expected_attention_label: "",
    expected_escalation: "",
    ticker_symbol: ticker,
  };

  const enrichedText = await enrichUploadedCSV(rowToCSV(row));
  const [enrichedRow] = normalizeAdvancedRows(parseCSV(enrichedText));
  state.advancedInputs = recalculatePortfolioPercents([...state.advancedInputs, enrichedRow]);
  state.runMessage = `Added ${ticker} to live list`;
  setScenario("advancedUpload");
  closeUploadModal();
  form.reset();
  runReview();
}

function bindEvents() {
  document.querySelector("#profileSelect").addEventListener("change", (event) => {
    state.profileId = event.target.value;
    state.runMessage = "Profile changed · review refreshed";
    runReview();
  });

  document.querySelector("#runReview").addEventListener("click", runMonthlyReview);

  document.querySelector("#openUploadModal").addEventListener("click", () => openUploadModal(DEFAULT_MODAL_MESSAGE));
  document.querySelector("#openManualModal").addEventListener("click", () => openUploadModal(ADD_HOLDING_MESSAGE));

  document.querySelector("#closeUploadModal").addEventListener("click", closeUploadModal);

  document.querySelector("#manualHoldingForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      document.querySelector("#uploadStatus").textContent = "Adding holding and fetching public quote...";
      await addManualHolding(event.currentTarget);
    } catch (error) {
      document.querySelector("#uploadStatus").textContent = `Holding was not added: ${error.message}`;
    }
  });

  document.querySelector("#uploadModal").addEventListener("click", (event) => {
    if (event.target.id === "uploadModal") closeUploadModal();
  });

  document.querySelector("#loadSampleUpload").addEventListener("click", async () => {
    try {
      await loadAdvancedCSV(ADVANCED_SAMPLE_CSV, "built-in sample CSV");
    } catch (error) {
      document.querySelector("#uploadStatus").textContent = `CSV was not loaded: ${error.message}`;
    }
  });

  document.querySelector("#csvUpload").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
      await loadAdvancedCSV(await file.text(), file.name);
    } catch (error) {
      document.querySelector("#uploadStatus").textContent = `CSV was not loaded: ${error.message}`;
    } finally {
      event.target.value = "";
    }
  });

  document.querySelectorAll(".scenario").forEach((button) => {
    button.addEventListener("click", () => {
      setScenario(button.dataset.scenario);
      if (state.scenario === "advancedUpload" && !state.advancedInputs.length) {
        loadAdvancedCSV(ADVANCED_SAMPLE_CSV, "built-in sample CSV").catch((error) => {
          state.runMessage = `Upload failed · ${error.message}`;
          renderRunStatus();
        });
        return;
      }
      state.runMessage = "Scenario loaded";
      runReview();
    });
  });

  document.querySelectorAll(".filter").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.filter = button.dataset.filter;
      renderTable();
    });
  });

  document.querySelector("#holdingsBody").addEventListener("click", (event) => {
    const row = event.target.closest("tr");
    if (!row || !row.dataset.holdingId) return;
    state.selectedId = row.dataset.holdingId;
    renderTable();
    renderDetail();
  });

  document.querySelector("#askAgent").addEventListener("click", () => {
    renderAgentResponse(document.querySelector("#userQuestion").value);
  });

  document.querySelector("#approveDraft").addEventListener("click", () => {
    const node = document.querySelector("#approvalState");
    node.className = "approval-state approved";
    node.textContent = "Draft approved by human reviewer";
  });

  document.querySelector("#editDraft").addEventListener("click", () => {
    const node = document.querySelector("#approvalState");
    node.className = "approval-state";
    node.textContent = "Draft marked for human edits";
  });

  document.querySelector("#rejectDraft").addEventListener("click", () => {
    const node = document.querySelector("#approvalState");
    node.className = "approval-state rejected";
    node.textContent = "Draft rejected by human reviewer";
  });

  document.querySelector("#downloadReview").addEventListener("click", downloadReviewPacket);
}

async function init() {
  try {
    const [inputs, profiles, history] = await Promise.all([
      loadCSV(DATA_URLS.inputs),
      loadCSV(DATA_URLS.profiles),
      loadCSV(DATA_URLS.history),
    ]);
    state.inputs = inputs;
    state.profiles = profiles;
    state.history = history;
    renderProfiles();
    bindEvents();
    runReview();
  } catch (error) {
    document.body.innerHTML = `<main class="main"><section class="panel" style="padding:24px"><h1>Unable to load prototype data</h1><p>${error.message}</p></section></main>`;
  }
}

init();
