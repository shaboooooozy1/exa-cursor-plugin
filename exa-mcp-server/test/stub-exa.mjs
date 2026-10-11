// Offline stub of the Exa HTTP API (POST /search, /contents, /answer).
//
// Mimics the request/response shapes from the Exa docs closely enough to drive the MCP server
// end to end. Every non-control request is recorded (method, path, headers, parsed body) so tests
// can assert on what the server actually sent.
//
// Scenario selection, in priority order:
//   1. a marker in the request: query text containing "[[scenario:NAME]]", or a /contents URL whose
//      host starts with "scenario-NAME." (e.g. https://scenario-contents_partial.example.com/x)
//   2. the sticky scenario set through the control endpoint POST /__control/scenario {"name": "..."}
//   3. "normal"
//
// Control endpoints (never recorded):
//   POST /__control/scenario {"name"}   set the sticky scenario
//   POST /__control/reset               clear recorded requests and set scenario back to "normal"
//   GET  /__control/requests            recorded requests as JSON
//
// Scenarios: normal, null_fields, zero, large, contents_partial, contents_all_fail, answer_object,
//   answer_no_citations, answer_empty, http_400, http_401, http_401_echo_key, http_402, http_403,
//   http_429, http_500, http_503, http_502_html, invalid_json, slow, slow_body, reset_body.
//
// Run standalone with: node stub-exa.mjs   (prints the base URL)
import http from "node:http";
import { pathToFileURL } from "node:url";

const SEARCH_TYPES = new Set(["instant", "fast", "auto", "deep-lite", "deep", "deep-reasoning"]);
const CATEGORIES = new Set(["company", "publication", "news", "personal site", "financial report", "people"]);
const ANSWER_MODELS = new Set(["exa", "exa-pro", "exa-research", "exa-fast"]);
const SEARCH_KEYS = new Set([
  "query", "type", "numResults", "includeDomains", "excludeDomains", "startPublishedDate", "endPublishedDate",
  "startCrawlDate", "endCrawlDate", "category", "contents", "userLocation", "moderation", "additionalQueries",
]);
const CONTENTS_KEYS = new Set([
  "urls", "ids", "text", "highlights", "summary", "maxAgeHours", "livecrawl", "livecrawlTimeout", "subpages",
  "subpageTarget", "extras", "context",
]);
const ANSWER_KEYS = new Set(["query", "stream", "text", "model", "systemPrompt", "userLocation", "outputSchema"]);

const PARAGRAPH =
  "Commercial property insurance rates continued to firm in the first quarter as carriers priced in " +
  "elevated catastrophe losses, rising reinsurance costs, and replacement-cost inflation. ";

function filler(length, label = "") {
  let out = label ? `${label} ` : "";
  while (out.length < length) out += PARAGRAPH;
  return out.slice(0, length);
}

/** Real ISO 8601 date-time check: shape AND calendar validity (rejects 2026-04-31). */
function isValidIsoDateTime(value) {
  if (typeof value !== "string") return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function sendJson(res, status, obj) {
  const raw = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(raw) });
  res.end(raw);
}

function exaError(res, status, error, tag) {
  sendJson(res, status, { requestId: `req_err_${status}`, error, tag });
}

function wantedLength(spec, fallback) {
  if (spec && typeof spec === "object" && typeof spec.maxCharacters === "number") return spec.maxCharacters;
  return fallback;
}

// ---------------------------------------------------------------- validation (mimics Exa 400s)

function unknownKeys(body, allowed) {
  return Object.keys(body).filter((k) => !allowed.has(k));
}

function validateSearch(body) {
  const unknown = unknownKeys(body, SEARCH_KEYS);
  if (unknown.length) return `Unrecognized key(s) in object: ${unknown.map((k) => `'${k}'`).join(", ")}`;
  if (typeof body.query !== "string" || !body.query.trim()) return "query is required";
  if (body.type !== undefined && !SEARCH_TYPES.has(body.type)) return `Invalid type '${body.type}'`;
  if (body.numResults !== undefined && !(Number.isInteger(body.numResults) && body.numResults >= 1 && body.numResults <= 100))
    return "numResults must be an integer between 1 and 100";
  if (body.category !== undefined && !CATEGORIES.has(body.category)) return `Invalid category '${body.category}'`;
  for (const k of ["includeDomains", "excludeDomains"]) {
    if (body[k] !== undefined && !(Array.isArray(body[k]) && body[k].length <= 1200)) return `${k} must be an array (max 1200)`;
  }
  for (const k of ["startPublishedDate", "endPublishedDate"]) {
    if (body[k] !== undefined && !isValidIsoDateTime(body[k])) return `${k} must be a valid ISO 8601 date-time`;
  }
  if (body.category === "company" || body.category === "people") {
    for (const k of ["startPublishedDate", "endPublishedDate", "excludeDomains"]) {
      if (body[k] !== undefined) return `${k} is not supported for category '${body.category}'`;
    }
  }
  return null;
}

function validateContents(body) {
  const unknown = unknownKeys(body, CONTENTS_KEYS);
  if (unknown.length) return `Unrecognized key(s) in object: ${unknown.map((k) => `'${k}'`).join(", ")}`;
  const list = body.urls ?? body.ids;
  if (!Array.isArray(list) || list.length < 1 || list.length > 100) return "urls or ids must contain 1-100 entries";
  if (body.maxAgeHours !== undefined && !(Number.isInteger(body.maxAgeHours) && body.maxAgeHours >= -1 && body.maxAgeHours <= 720))
    return "maxAgeHours must be between -1 and 720";
  return null;
}

function validateAnswer(body) {
  const unknown = unknownKeys(body, ANSWER_KEYS);
  if (unknown.length) return `Unrecognized key(s) in object: ${unknown.map((k) => `'${k}'`).join(", ")}`;
  if (typeof body.query !== "string" || !body.query.trim()) return "query is required";
  if (body.model !== undefined && !ANSWER_MODELS.has(body.model)) return `Invalid model '${body.model}'`;
  return null;
}

// ---------------------------------------------------------------- response builders

const SAMPLE_PAGES = [
  {
    url: "https://www.naic.org/reports/2026-q1-property-market",
    title: "NAIC Q1 2026 Property Market Report",
    publishedDate: "2026-01-15",
    author: "NAIC Research Staff",
  },
  {
    url: "https://www.insurancejournal.com/news/2026/01/20/commercial-rates",
    title: "  Commercial Property Rates Climb Again  ",
    publishedDate: "2026-01-20T08:30:00.000Z",
    author: "Jane Doe",
  },
  {
    url: "https://www.sec.gov/Archives/edgar/data/0000086312/10k-2025.htm",
    title: "Travelers 2025 Form 10-K",
    publishedDate: "2026-02-12",
    author: null,
  },
];

function buildResult(page, contents, { lengthMode = "natural", index = 0 } = {}) {
  const result = {
    id: page.url,
    url: page.url,
    title: page.title,
    publishedDate: page.publishedDate,
    author: page.author,
    image: `${new URL(page.url).origin}/og.png`,
    favicon: `${new URL(page.url).origin}/favicon.ico`,
  };
  if (contents.text) {
    const max = wantedLength(contents.text, 10_000);
    const len = lengthMode === "full" ? max : Math.min(max, 1_200);
    result.text = filler(len, `[page ${index + 1}]`);
  }
  if (contents.highlights) {
    const max = wantedLength(contents.highlights, 2_000);
    const each = lengthMode === "full" ? Math.floor(max / 2) : Math.min(180, max);
    result.highlights = [filler(each, `[hl ${index + 1}a]\n`), filler(each, `[hl ${index + 1}b]   `)];
    result.highlightScores = [0.91, 0.84];
  }
  if (contents.summary) {
    result.summary = `Summary for "${contents.summary.query ?? "page"}": rates up 7% year over year.`;
  }
  return result;
}

function searchResponse(body, scenario) {
  const contents = body.contents ?? {};
  const n = body.numResults ?? 10;
  let results;
  if (scenario === "zero") {
    results = [];
  } else if (scenario === "null_fields") {
    results = [
      { ...buildResult(SAMPLE_PAGES[0], contents), title: null, author: null, publishedDate: null },
      { ...buildResult(SAMPLE_PAGES[1], contents), title: "", author: null },
    ];
  } else if (scenario === "large") {
    results = Array.from({ length: n }, (_, i) =>
      buildResult(
        { url: `https://example.com/large/${i + 1}`, title: `Large result ${i + 1}`, publishedDate: "2026-03-01", author: "Bulk Author" },
        contents,
        { lengthMode: "full", index: i },
      ),
    );
  } else {
    results = SAMPLE_PAGES.slice(0, Math.min(n, SAMPLE_PAGES.length)).map((p, i) => buildResult(p, contents, { index: i }));
  }
  return {
    requestId: "req_search_123",
    resolvedSearchType: "neural",
    results,
    costDollars: { total: 0.005, search: { neural: 0.005 } },
    searchTime: 412.5,
  };
}

function contentsResponse(body, scenario) {
  const urls = body.urls ?? body.ids;
  const contents = { text: body.text, highlights: body.highlights, summary: body.summary };
  const results = [];
  const statuses = [];
  urls.forEach((url, i) => {
    const fail =
      scenario === "contents_all_fail" || (scenario === "contents_partial" && i > 0);
    if (fail) {
      const error = i % 2 === 0
        ? { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 }
        : { tag: "SOURCE_NOT_AVAILABLE", httpStatusCode: 403 };
      statuses.push({ id: url, status: "error", error });
      return;
    }
    const page = { url, title: `Page ${i + 1} at ${new URL(url).hostname}`, publishedDate: "2026-02-01", author: "Staff Writer" };
    results.push(buildResult(page, contents, { lengthMode: scenario === "large" ? "full" : "natural", index: i }));
    statuses.push({ id: url, status: "success", source: body.maxAgeHours === 0 ? "crawled" : "cached" });
  });
  return {
    requestId: "req_contents_123",
    results,
    statuses,
    costDollars: { total: 0.001 * results.length, contents: { text: 0.001 * results.length } },
    searchTime: 88.1,
  };
}

function answerResponse(body, scenario) {
  const citations = [
    {
      id: "https://www.travelers.com/ir/2025-annual",
      url: "https://www.travelers.com/ir/2025-annual",
      title: "Travelers 2025 Annual Results",
      publishedDate: "2026-01-22T00:00:00.000Z",
      author: "Travelers IR",
    },
    {
      id: "https://www.ambest.com/news/2026/travelers",
      url: "https://www.ambest.com/news/2026/travelers",
      title: null,
      publishedDate: null,
      author: null,
    },
  ];
  if (body.text === true) citations.forEach((c) => (c.text = filler(800)));
  const base = { requestId: "req_answer_123", costDollars: { total: 0.005 } };
  if (scenario === "answer_object") {
    return { ...base, answer: { combined_ratio: 94.2, fiscal_year: 2025, source_count: 2 }, citations };
  }
  if (scenario === "answer_no_citations") return { ...base, answer: "Roughly 94%.", citations: [] };
  if (scenario === "answer_empty") return { ...base, answer: "", citations: [] };
  return {
    ...base,
    answer: "  Travelers reported a 2025 combined ratio of about 94.2%, an improvement on 2024.  ",
    citations,
  };
}

// ---------------------------------------------------------------- server

export async function startStub({ expectedKey = "test-key-123", port = 0 } = {}) {
  const state = { scenario: "normal", requests: [] };
  const timers = new Set();
  const later = (ms, fn) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url, "http://stub");

      // ---- control plane
      if (url.pathname.startsWith("/__control/")) {
        if (req.method === "GET" && url.pathname === "/__control/requests") return sendJson(res, 200, state.requests);
        if (req.method === "POST" && url.pathname === "/__control/reset") {
          state.requests = [];
          state.scenario = "normal";
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/__control/scenario") {
          state.scenario = JSON.parse(raw || "{}").name ?? "normal";
          return sendJson(res, 200, { ok: true, scenario: state.scenario });
        }
        return sendJson(res, 404, { error: "unknown control endpoint" });
      }

      // ---- data plane
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = undefined;
      }
      state.requests.push({ method: req.method, path: url.pathname, headers: req.headers, body, raw });

      if (req.method !== "POST" || !["/search", "/contents", "/answer"].includes(url.pathname)) {
        return exaError(res, 404, `No route ${req.method} ${url.pathname}`, "NOT_FOUND");
      }
      if (body === undefined) return exaError(res, 400, "Request body is not valid JSON", "INVALID_REQUEST_BODY");

      // scenario resolution
      let scenario = state.scenario;
      const marker = typeof body.query === "string" && body.query.match(/\[\[scenario:([\w-]+)\]\]/);
      if (marker) scenario = marker[1];
      const urlList = body.urls ?? body.ids;
      if (Array.isArray(urlList)) {
        for (const u of urlList) {
          const m = String(u).match(/^https?:\/\/scenario-([\w-]+)\./);
          if (m) scenario = m[1];
        }
      }

      // auth (Exa accepts x-api-key or Authorization: Bearer)
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const key = req.headers["x-api-key"] ?? bearer;
      if (key !== expectedKey) return exaError(res, 401, "Invalid API key", "INVALID_API_KEY");

      switch (scenario) {
        case "http_400":
          return exaError(res, 400, "Invalid request body: numResults must be <= 100", "INVALID_REQUEST_BODY");
        case "http_401":
          return exaError(res, 401, "Invalid API key", "INVALID_API_KEY");
        case "http_401_echo_key":
          return exaError(res, 401, `Invalid API key: ${key}`, "INVALID_API_KEY");
        case "http_402":
          return exaError(res, 402, "You have exceeded your credit limit", "NO_MORE_CREDITS");
        case "http_403":
          return exaError(res, 403, "This API key does not have access to exa-pro", "ACCESS_DENIED");
        case "http_429":
          return exaError(res, 429, "Rate limit exceeded", "RATE_LIMIT_EXCEEDED");
        case "http_500":
          return exaError(res, 500, "Internal server error", "INTERNAL_ERROR");
        case "http_503":
          return exaError(res, 503, "Service temporarily unavailable", "SERVICE_UNAVAILABLE");
        case "http_502_html": {
          const html = "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body><center><h1>502 Bad Gateway</h1></center></body>\r\n</html>\r\n";
          res.writeHead(502, { "content-type": "text/html" });
          return res.end(html);
        }
        case "invalid_json":
          res.writeHead(200, { "content-type": "application/json" });
          return res.end("{\"results\": [ {\"url\": \"https://x.example\" ");
        case "slow":
          // Responds only after 3s. The harness shrinks the server's timeouts so this trips them.
          return later(3_000, () => {
            if (!res.destroyed) sendJson(res, 200, searchResponse({ query: "slow" }, "normal"));
          });
        case "slow_body":
          // Headers and the start of the body arrive at once, then the body stalls for 3s.
          res.writeHead(200, { "content-type": "application/json" });
          res.write("{\"requestId\":\"req_slow\",\"results\":[");
          return later(3_000, () => {
            if (!res.destroyed) res.end("]}");
          });
        case "reset_body":
          // Headers and part of the body, then the connection drops (e.g. a proxy resets it).
          res.writeHead(200, { "content-type": "application/json", "content-length": "5000" });
          res.write("{\"requestId\":\"req_reset\",\"results\":[");
          return later(50, () => res.socket?.destroy());
        default:
          break;
      }

      if (url.pathname === "/search") {
        const problem = validateSearch(body);
        if (problem) return exaError(res, 400, problem, "INVALID_REQUEST_BODY");
        return sendJson(res, 200, searchResponse(body, scenario));
      }
      if (url.pathname === "/contents") {
        const problem = validateContents(body);
        if (problem) return exaError(res, 400, problem, "INVALID_REQUEST_BODY");
        return sendJson(res, 200, contentsResponse(body, scenario));
      }
      const problem = validateAnswer(body);
      if (problem) return exaError(res, 400, problem, "INVALID_REQUEST_BODY");
      return sendJson(res, 200, answerResponse(body, scenario));
    });
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: actualPort } = server.address();
  const baseUrl = `http://127.0.0.1:${actualPort}`;

  return {
    baseUrl,
    port: actualPort,
    state,
    async close() {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const stub = await startStub({ port: Number(process.env.PORT ?? 0) });
  console.log(`stub Exa listening at ${stub.baseUrl}`);
}
