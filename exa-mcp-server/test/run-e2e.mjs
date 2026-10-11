// Offline end-to-end harness for the Exa MCP server (dist/index.js).
//
// Starts stub-exa.mjs on an ephemeral 127.0.0.1 port, launches the built server over stdio with the
// SDK's Client + StdioClientTransport (EXA_API_KEY=test-key-123, EXA_BASE_URL=<stub>), and checks
// tool listings, request bodies the server sends, rendered output, error mapping, truncation, key
// hygiene and startup failure. Prints one line per case and writes results.json next to this file.
//
// Run: node run-e2e.mjs        (exit code 0 = all cases passed, 1 = at least one failed)
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startStub } from "./stub-exa.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// E2E_SERVER lets the harness run against another build (e.g. a deliberately broken copy, to check the tests catch it).
const SERVER = process.env.E2E_SERVER ?? join(HERE, "..", "dist", "index.js");
const KEY = "test-key-123";
const LIMIT = 25_000;
const NOTE_ALLOWANCE = 200; // room for an appended "[Truncated at ...]" note

const HARD_DEADLINE = setTimeout(() => {
  console.error("Harness exceeded 180s; aborting.");
  process.exit(2);
}, 180_000);

// ------------------------------------------------------------------ case bookkeeping

const cases = [];
const allOutputs = []; // every tool result, scanned at the end for the API key
const stderrLogs = []; // server stderr from every launched server

async function runCase(name, fn) {
  const failures = [];
  const notes = [];
  const t = {
    check(cond, msg) {
      if (!cond) failures.push(msg);
      return Boolean(cond);
    },
    eq(actual, expected, msg) {
      const ok = isDeepStrictEqual(actual, expected);
      if (!ok) failures.push(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      return ok;
    },
    note(msg) {
      notes.push(msg);
    },
  };
  try {
    await fn(t);
  } catch (error) {
    failures.push(`threw: ${error?.stack ?? error}`);
  }
  const passed = failures.length === 0;
  const detail = passed ? notes.join(" | ") || "ok" : [...failures, ...notes].join(" | ");
  cases.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${passed ? "" : `\n      -> ${detail.slice(0, 600)}`}`);
}

// ------------------------------------------------------------------ stub + server plumbing

const stub = await startStub({ expectedKey: KEY });

async function ctl(path, body) {
  const res = await fetch(`${stub.baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}
const reset = () => ctl("/__control/reset", {});
const setScenario = (name) => ctl("/__control/scenario", { name });
const recorded = () => ctl("/__control/requests");

async function launch(env, label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env,
    stderr: "pipe",
  });
  const chunks = [];
  transport.stderr?.on("data", (c) => chunks.push(c.toString()));
  const client = new Client({ name: "exa-e2e-harness", version: "1.0.0" });
  await client.connect(transport);
  const log = { label, get text() { return chunks.join(""); } };
  stderrLogs.push(log);
  // listTools populates the client's output-schema validators, so later callTool() calls are
  // validated client-side exactly as a spec-following host would.
  const tools = await client.listTools();
  return { client, transport, tools, stderr: () => log.text };
}

async function call(client, name, args) {
  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (error) {
    result = { thrown: String(error?.message ?? error) };
  }
  allOutputs.push({ name, args, result });
  return result;
}

const textOf = (r) => (r?.content ?? []).map((c) => c.text ?? "").join("\n");
const headingCount = (text) => (text.match(/^### \d+\. /gm) ?? []).length;

function snakeKeys(value, path = "") {
  if (Array.isArray(value)) return value.flatMap((v, i) => snakeKeys(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [
      ...(k.includes("_") ? [`${path}.${k}`] : []),
      ...snakeKeys(v, `${path}.${k}`),
    ]);
  }
  return [];
}

function tryParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: String(error.message) };
  }
}

async function closedPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

const baseEnv = { EXA_API_KEY: KEY, EXA_BASE_URL: stub.baseUrl };
const main = await launch(baseEnv, "main");
const c = main.client;

// ================================================================== tools/list

await runCase("tools/list exposes exactly exa_search, exa_get_contents, exa_answer with valid schemas", async (t) => {
  const tools = main.tools.tools;
  t.eq(tools.map((x) => x.name).sort(), ["exa_answer", "exa_get_contents", "exa_search"], "tool names");
  const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
  const required = { exa_search: ["query"], exa_get_contents: ["urls"], exa_answer: ["query"] };
  for (const [name, req] of Object.entries(required)) {
    const tool = byName[name];
    if (!t.check(tool, `${name} missing`)) continue;
    t.eq(tool.inputSchema?.type, "object", `${name} inputSchema.type`);
    t.eq([...(tool.inputSchema?.required ?? [])].sort(), req, `${name} required inputs`);
    t.eq(tool.inputSchema?.additionalProperties, false, `${name} additionalProperties`);
    t.check(tool.inputSchema?.properties?.response_format?.enum?.includes("json"), `${name} response_format enum`);
    t.check(tool.outputSchema?.type === "object", `${name} has an outputSchema`);
    t.eq(tool.annotations?.readOnlyHint, true, `${name} readOnlyHint`);
    t.check((tool.description ?? "").length > 50, `${name} description present`);
  }
  const s = byName.exa_search?.inputSchema?.properties ?? {};
  t.eq(s.type?.enum, ["auto", "fast", "instant", "deep"], "search type enum");
  t.eq(s.content_mode?.enum, ["highlights", "text", "none"], "content_mode enum");
  t.check(s.category?.enum?.includes("financial report"), "category enum includes 'financial report'");
  t.note(`input schemas: search=${Object.keys(s).length} props`);
});

// ================================================================== exa_search

await runCase("exa_search markdown (defaults): request body, x-api-key header, rendered output", async (t) => {
  await reset();
  const query = "commercial property rate trends 2026";
  const r = await call(c, "exa_search", { query });
  const reqs = await recorded();
  t.eq(reqs.length, 1, "requests sent");
  const req = reqs[0] ?? {};
  t.eq(req.method, "POST", "method");
  t.eq(req.path, "/search", "path");
  t.eq(req.headers?.["x-api-key"], KEY, "x-api-key header");
  t.check(String(req.headers?.["content-type"]).includes("application/json"), "content-type json");
  t.eq(req.body, { query, numResults: 5, type: "auto", contents: { highlights: { query, maxCharacters: 3000 } } }, "search body");
  t.check(!r.thrown, `client threw: ${r.thrown}`);
  t.check(!r.isError, "isError should be falsy");
  const text = textOf(r);
  for (const s of [
    `# Exa search: "${query}"`,
    "3 result(s).",
    "_Exa cost: $0.0050_",
    "### 1. NAIC Q1 2026 Property Market Report",
    "- **URL**: https://www.naic.org/reports/2026-q1-property-market",
    "- **Published**: 2026-01-15",
    "- **Author**: NAIC Research Staff",
    "### 2. Commercial Property Rates Climb Again\n",
    "- **Published**: 2026-01-20\n",
    "> [hl 1a] Commercial property insurance rates",
    "### 3. Travelers 2025 Form 10-K",
  ]) t.check(text.includes(s), `markdown missing ${JSON.stringify(s)}`);
  t.check(!/null|undefined/.test(text), "markdown contains 'null'/'undefined'");
  const sc = r.structuredContent ?? {};
  t.eq(sc.query, query, "structured query");
  t.eq(sc.result_count, 3, "structured result_count");
  t.eq(sc.cost_dollars, 0.005, "structured cost_dollars");
  t.eq(sc.results?.[1]?.published_date, "2026-01-20", "published_date sliced to YYYY-MM-DD");
  t.eq(sc.results?.[2]?.author, undefined, "null author omitted");
  t.eq(sc.truncated, undefined, "not truncated");
});

await runCase("exa_search json: text is valid JSON equal to structuredContent", async (t) => {
  await reset();
  const r = await call(c, "exa_search", { query: "Florida reinsurance renewals", response_format: "json" });
  t.check(!r.isError && !r.thrown, `unexpected error: ${r.thrown ?? textOf(r)}`);
  const parsed = tryParse(textOf(r));
  if (t.check(parsed.ok, `text not JSON: ${parsed.error}`)) t.eq(parsed.value, r.structuredContent, "JSON text vs structuredContent");
  t.eq(r.structuredContent?.results?.length, 3, "results");
});

await runCase("exa_search content_mode=text sends contents.text {maxCharacters} and no highlights", async (t) => {
  await reset();
  const r = await call(c, "exa_search", { query: "cyber insurance pricing", content_mode: "text", max_characters: 1500 });
  const [req] = await recorded();
  t.eq(req?.body?.contents, { text: { maxCharacters: 1500 } }, "contents");
  t.check(!r.isError, "isError");
  t.check(textOf(r).includes("[page 1] Commercial property"), "page text rendered");
  t.check(r.structuredContent?.results?.every((x) => typeof x.text === "string" && !x.highlights), "structured results carry text only");
});

await runCase("exa_search content_mode=none sends no contents object", async (t) => {
  await reset();
  const r = await call(c, "exa_search", { query: "list of surplus lines carriers", content_mode: "none" });
  const [req] = await recorded();
  t.check(req && !("contents" in req.body), `contents should be absent, body=${JSON.stringify(req?.body)}`);
  t.check(!r.isError, "isError");
  t.check(r.structuredContent?.results?.every((x) => !x.text && !x.highlights), "no content in results");
});

await runCase("exa_search filters: camelCase keys, date widening of bare dates, domains, category, type", async (t) => {
  await reset();
  const r = await call(c, "exa_search", {
    query: "hail losses Texas",
    num_results: 10,
    type: "deep",
    category: "news",
    include_domains: ["naic.org", "sec.gov"],
    exclude_domains: ["reddit.com"],
    start_published_date: "2026-01-01",
    end_published_date: "2026-01-31",
  });
  const [req] = await recorded();
  const b = req?.body ?? {};
  t.eq(b.numResults, 10, "numResults");
  t.eq(b.type, "deep", "type");
  t.eq(b.category, "news", "category");
  t.eq(b.includeDomains, ["naic.org", "sec.gov"], "includeDomains");
  t.eq(b.excludeDomains, ["reddit.com"], "excludeDomains");
  t.eq(b.startPublishedDate, "2026-01-01T00:00:00.000Z", "startPublishedDate widened to start of day");
  t.eq(b.endPublishedDate, "2026-01-31T23:59:59.999Z", "endPublishedDate widened to end of day");
  t.eq(snakeKeys(b), [], "snake_case keys in body");
  t.check(!r.isError, `isError: ${textOf(r)}`);
});

await runCase("exa_search normalizes full ISO date-times to canonical UTC; same-day bare range allowed", async (t) => {
  await reset();
  await call(c, "exa_search", { query: "q", start_published_date: "2026-01-01T09:30:00Z", end_published_date: "2026-01-02T17:00:00+05:00" });
  await call(c, "exa_search", { query: "q", start_published_date: "2026-01-15", end_published_date: "2026-01-15" });
  await call(c, "exa_search", { query: "q", start_published_date: "2026-01-31T10:00", end_published_date: "2026-02-01T10:00:00+0530" });
  const reqs = await recorded();
  t.eq(reqs[0]?.body?.startPublishedDate, "2026-01-01T09:30:00.000Z", "start normalized");
  t.eq(reqs[0]?.body?.endPublishedDate, "2026-01-02T12:00:00.000Z", "end offset converted to UTC");
  t.eq([reqs[1]?.body?.startPublishedDate, reqs[1]?.body?.endPublishedDate], ["2026-01-15T00:00:00.000Z", "2026-01-15T23:59:59.999Z"], "same-day window");
  t.eq([reqs[2]?.body?.startPublishedDate, reqs[2]?.body?.endPublishedDate], ["2026-01-31T10:00:00.000Z", "2026-02-01T04:30:00.000Z"], "no-offset read as UTC; colon-less offset handled");
});

await runCase("exa_search: impossible calendar dates (Feb 29 2026, Feb 30, 25:00) rejected locally with a clear reason", async (t) => {
  await reset();
  const a = await call(c, "exa_search", { query: "q", end_published_date: "2026-02-29" });
  const b = await call(c, "exa_search", { query: "q", start_published_date: "2026-02-30", end_published_date: "2026-03-01" });
  const d = await call(c, "exa_search", { query: "q", start_published_date: "2026-01-01T25:00:00Z" });
  const leap = await call(c, "exa_search", { query: "q", end_published_date: "2028-02-29" });
  t.check(a.isError && textOf(a).includes("is not a real date"), `Feb 29 2026: ${textOf(a)}`);
  t.check(b.isError && textOf(b).includes("start_published_date '2026-02-30' is not a real date"), `Feb 30 must not be reported as 'swap the dates': ${textOf(b)}`);
  t.check(d.isError && textOf(d).includes("is not a real date"), `25:00: ${textOf(d)}`);
  t.check(!leap.isError, `2028-02-29 is a real leap day: ${textOf(leap)}`);
  const reqs = await recorded();
  t.eq(reqs.length, 1, "only the valid leap-day search reached Exa");
});

await runCase("exa_search guard: category 'company' + date filters rejected locally (no request sent)", async (t) => {
  await reset();
  const r = await call(c, "exa_search", { query: "Acme Mutual", category: "company", start_published_date: "2026-01-01", end_published_date: "2026-02-01" });
  t.eq(r.isError, true, "isError");
  const text = textOf(r);
  t.check(text.includes("start_published_date") && text.includes("end_published_date") && text.includes("'company'"), `message: ${text}`);
  t.eq((await recorded()).length, 0, "requests sent");
});

await runCase("exa_search guard: category 'people' + exclude_domains rejected locally (no request sent)", async (t) => {
  await reset();
  const r = await call(c, "exa_search", { query: "chief actuary", category: "people", exclude_domains: ["linkedin.com"] });
  t.eq(r.isError, true, "isError");
  t.check(textOf(r).includes("exclude_domains") && textOf(r).includes("'people'"), `message: ${textOf(r)}`);
  t.eq((await recorded()).length, 0, "requests sent");
});

await runCase("exa_search guard: category 'company' with include_domains only is allowed", async (t) => {
  await reset();
  const r = await call(c, "exa_search", { query: "Acme Mutual", category: "company", include_domains: ["acme.com"] });
  const [req] = await recorded();
  t.check(!r.isError, `isError: ${textOf(r)}`);
  t.eq([req?.body?.category, req?.body?.includeDomains], ["company", ["acme.com"]], "body");
});

await runCase("exa_search: start_published_date after end_published_date rejected locally", async (t) => {
  await reset();
  const r = await call(c, "exa_search", { query: "q", start_published_date: "2026-03-01", end_published_date: "2026-02-01" });
  t.eq(r.isError, true, "isError");
  t.check(/after end_published_date/.test(textOf(r)), `message: ${textOf(r)}`);
  t.eq((await recorded()).length, 0, "requests sent");
});

await runCase("exa_search: malformed date (2026-13-01) rejected locally", async (t) => {
  await reset();
  const r = await call(c, "exa_search", { query: "q", start_published_date: "2026-13-01" });
  t.eq(r.isError, true, "isError");
  t.check(textOf(r).includes("is not a real date"), `message: ${textOf(r)}`);
  t.eq((await recorded()).length, 0, "requests sent");
});

await runCase("exa_search: impossible calendar date (2026-04-31) is not forwarded to Exa", async (t) => {
  await reset();
  const r = await call(c, "exa_search", { query: "Q1 hail claims", start_published_date: "2026-04-01", end_published_date: "2026-04-31" });
  const reqs = await recorded();
  t.check(
    reqs.length === 0,
    `server forwarded endPublishedDate=${JSON.stringify(reqs[0]?.body?.endPublishedDate)} to Exa (Date.parse rolls it to May 1, so the local 'not a valid date' check never fires)`,
  );
  t.check(r.isError === true, "should be an error");
  t.note(`server response: ${textOf(r).slice(0, 160)}`);
});

await runCase("exa_search: null/empty title and null author/date fall back cleanly", async (t) => {
  await reset();
  await setScenario("null_fields");
  const r = await call(c, "exa_search", { query: "q" });
  t.check(!r.thrown, `client threw (output schema): ${r.thrown}`);
  t.check(!r.isError, `isError: ${textOf(r)}`);
  const sc = r.structuredContent ?? {};
  t.eq(sc.results?.[0]?.title, "https://www.naic.org/reports/2026-q1-property-market", "null title -> URL");
  t.eq(sc.results?.[1]?.title, "https://www.insurancejournal.com/news/2026/01/20/commercial-rates", "empty title -> URL");
  t.eq([sc.results?.[0]?.author, sc.results?.[0]?.published_date], [undefined, undefined], "null author/date omitted");
  t.check(!/\bnull\b|undefined/.test(textOf(r)), "markdown contains null/undefined");
});

await runCase("exa_search: zero results is a normal (non-error) response with guidance", async (t) => {
  await reset();
  await setScenario("zero");
  const r = await call(c, "exa_search", { query: "nonexistent thing" });
  t.check(!r.isError && !r.thrown, `unexpected error: ${r.thrown ?? textOf(r)}`);
  t.check(textOf(r).includes("0 result(s).") && textOf(r).includes("No results."), `text: ${textOf(r)}`);
  t.eq([r.structuredContent?.result_count, r.structuredContent?.results], [0, []], "structured");
});

function truncationChecks(t, r, { total, format }) {
  const text = textOf(r);
  const sc = r.structuredContent ?? {};
  t.check(!r.isError && !r.thrown, `unexpected error: ${r.thrown ?? text.slice(0, 200)}`);
  t.check(text.length <= LIMIT + NOTE_ALLOWANCE, `text length ${text.length} > ${LIMIT} (+note)`);
  t.eq(sc.truncated, true, "structured truncated flag");
  t.check(typeof sc.truncation_message === "string" && sc.truncation_message.includes(`of ${total} results`), `truncation_message: ${sc.truncation_message}`);
  if (format === "markdown") {
    t.check(text.includes(String(sc.truncation_message)), "truncation note shown in markdown text");
    t.eq(headingCount(text), sc.results?.length, "results shown in text vs structuredContent.results");
    t.check(text.includes(`${sc.results?.length} result(s)`) || text.includes(`${sc.results?.length} retrieved`), "count line matches shown results");
  } else {
    const parsed = tryParse(text);
    if (t.check(parsed.ok, `JSON text not parseable: ${parsed.error}`)) t.eq(parsed.value, sc, "JSON text vs structuredContent");
  }
  const structuredSize = JSON.stringify(sc).length;
  t.check(structuredSize <= LIMIT + 5_000, `structuredContent is ${structuredSize} chars, far above the ${LIMIT} cap applied to text`);
  t.note(`text=${text.length} chars, shown ${sc.results?.length}/${total}, structured=${structuredSize} chars`);
  return { text, sc };
}

await runCase("exa_search truncation (25 results x 3000 chars, markdown): under limit, note present, structuredContent consistent", async (t) => {
  await reset();
  await setScenario("large");
  const r = await call(c, "exa_search", { query: "everything", num_results: 25, content_mode: "text", max_characters: 3000 });
  const { sc } = truncationChecks(t, r, { total: 25, format: "markdown" });
  t.eq(sc.results?.map((x) => x.url), Array.from({ length: sc.results?.length ?? 0 }, (_, i) => `https://example.com/large/${i + 1}`), "kept results are the top-ranked ones in order");
});

await runCase("exa_search truncation (25 results x 3000 chars, json): valid JSON under limit and equal to structuredContent", async (t) => {
  await reset();
  await setScenario("large");
  const r = await call(c, "exa_search", { query: "everything", num_results: 25, content_mode: "text", max_characters: 3000, response_format: "json" });
  truncationChecks(t, r, { total: 25, format: "json" });
});

await runCase("exa_search truncation keeps as many results as fit (10 results x 3000 chars text)", async (t) => {
  await reset();
  await setScenario("large");
  const r = await call(c, "exa_search", { query: "everything", num_results: 10, content_mode: "text", max_characters: 3000 });
  const text = textOf(r);
  const kept = headingCount(text);
  const firstBlock = text.indexOf("\n\n### 1. ");
  const header = text.slice(0, firstBlock);
  const perResult = (text.length - header.length) / Math.max(kept, 1);
  const fit = Math.min(10, Math.floor((LIMIT - header.length) / perResult));
  t.check(
    kept >= fit,
    `kept ${kept} of 10 results (${text.length} chars) although ${fit} fit under ${LIMIT} (~${Math.round(perResult)} chars each); halving discarded ${fit - kept} paid results`,
  );
  t.note(`kept=${kept}, fit=${fit}, text=${text.length}`);
});

// ================================================================== exa_get_contents

const URL_A = "https://www.naic.org/reports/cat-model-2026";
const URL_B = "https://www.iii.org/fact-statistic/facts-statistics-homeowners";

await runCase("exa_get_contents markdown (defaults): body {urls, text.maxCharacters=10000}, no maxAgeHours/summary", async (t) => {
  await reset();
  const r = await call(c, "exa_get_contents", { urls: [URL_A, URL_B] });
  const reqs = await recorded();
  t.eq(reqs.length, 1, "requests");
  t.eq(reqs[0]?.path, "/contents", "path");
  t.eq(reqs[0]?.headers?.["x-api-key"], KEY, "x-api-key");
  t.eq(reqs[0]?.body, { urls: [URL_A, URL_B], text: { maxCharacters: 10000 } }, "contents body");
  t.check(!r.isError && !r.thrown, `unexpected error: ${r.thrown ?? textOf(r)}`);
  const text = textOf(r);
  t.check(text.startsWith("# Page contents (2 retrieved)"), `header: ${text.split("\n")[0]}`);
  t.check(text.includes("_Exa cost: $0.0020_"), "cost line");
  t.check(text.includes(`- **URL**: ${URL_A}`) && text.includes(`- **URL**: ${URL_B}`), "both URLs listed");
  t.eq(r.structuredContent?.failed, [], "failed");
});

await runCase("exa_get_contents: max_age_hours (0, -1, 720) and summary_query map to maxAgeHours / summary.query", async (t) => {
  await reset();
  const r0 = await call(c, "exa_get_contents", { urls: [URL_A], max_age_hours: 0, summary_query: "What changed in cat modeling?" });
  await call(c, "exa_get_contents", { urls: [URL_A], max_age_hours: -1 });
  await call(c, "exa_get_contents", { urls: [URL_A], max_age_hours: 720, max_characters: 500 });
  const reqs = await recorded();
  t.eq(reqs[0]?.body, { urls: [URL_A], text: { maxCharacters: 10000 }, maxAgeHours: 0, summary: { query: "What changed in cat modeling?" } }, "body #1 (0 must not be dropped)");
  t.eq(reqs[1]?.body?.maxAgeHours, -1, "maxAgeHours -1");
  t.eq([reqs[2]?.body?.maxAgeHours, reqs[2]?.body?.text], [720, { maxCharacters: 500 }], "maxAgeHours 720 + maxCharacters");
  t.check(textOf(r0).includes('**Summary**: Summary for "What changed in cat modeling?"'), "summary rendered");
  t.eq(snakeKeys(reqs[0]?.body), [], "snake_case keys");
});

await runCase("exa_get_contents json: text is valid JSON equal to structuredContent", async (t) => {
  await reset();
  const r = await call(c, "exa_get_contents", { urls: [URL_A], response_format: "json" });
  const parsed = tryParse(textOf(r));
  if (t.check(parsed.ok, `not JSON: ${parsed.error}`)) t.eq(parsed.value, r.structuredContent, "JSON vs structured");
  t.eq(r.structuredContent?.results?.[0]?.url, URL_A, "result url");
});

await runCase("exa_get_contents: one success + one per-URL error -> success with failure listed", async (t) => {
  await reset();
  await setScenario("contents_partial");
  const r = await call(c, "exa_get_contents", { urls: [URL_A, URL_B] });
  t.check(!r.isError && !r.thrown, `unexpected error: ${r.thrown ?? textOf(r)}`);
  const text = textOf(r);
  t.check(text.startsWith("# Page contents (1 retrieved, 1 failed)"), `header: ${text.split("\n")[0]}`);
  t.check(text.includes("**Could not retrieve:**") && text.includes(`- ${URL_B} (SOURCE_NOT_AVAILABLE, HTTP 403)`), "failure listed in markdown");
  t.eq(r.structuredContent?.failed, [{ url: URL_B, error: "SOURCE_NOT_AVAILABLE, HTTP 403" }], "structured failed");
  t.eq(r.structuredContent?.results?.length, 1, "results");
  const j = await call(c, "exa_get_contents", { urls: [URL_A, URL_B], response_format: "json" });
  t.eq(tryParse(textOf(j)).value?.failed, [{ url: URL_B, error: "SOURCE_NOT_AVAILABLE, HTTP 403" }], "json failed list");
});

await runCase("exa_get_contents: all URLs fail -> isError listing each URL and reason", async (t) => {
  await reset();
  await setScenario("contents_all_fail");
  const r = await call(c, "exa_get_contents", { urls: [URL_A, URL_B] });
  t.eq(r.isError, true, "isError");
  const text = textOf(r);
  t.check(text.includes(`${URL_A} (CRAWL_NOT_FOUND, HTTP 404)`) && text.includes(`${URL_B} (SOURCE_NOT_AVAILABLE, HTTP 403)`), `text: ${text}`);
  t.check(!text.includes("max_age_hours"), `advice mentions max_age_hours although it was not set: ${text}`);
  const cacheOnly = await call(c, "exa_get_contents", { urls: [URL_A], max_age_hours: -1 });
  t.check(textOf(cacheOnly).includes("crawl the pages live"), `-1 advice: ${textOf(cacheOnly)}`);
  const fresh = await call(c, "exa_get_contents", { urls: [URL_A], max_age_hours: 0 });
  t.check(textOf(fresh).includes("fall back to a cached copy"), `0 advice: ${textOf(fresh)}`);
});

await runCase("exa_get_contents default page budget shrinks with URL count so every page fits (10 URLs, no max_characters)", async (t) => {
  await reset();
  await setScenario("large");
  const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/long/${i + 1}`);
  const r = await call(c, "exa_get_contents", { urls });
  const [req] = await recorded();
  t.eq(req?.body?.text, { maxCharacters: 1900 }, "per-page budget = floor((22000 - 10*300) / 10)");
  t.check(!r.isError, `unexpected error: ${textOf(r).slice(0, 200)}`);
  t.check(textOf(r).length <= LIMIT, `text length ${textOf(r).length}`);
  t.eq(r.structuredContent?.results?.length, 10, "all 10 paid-for pages shown");
  t.check(!r.structuredContent?.truncated, `unexpected truncation: ${r.structuredContent?.truncation_message}`);
  await reset();
  await call(c, "exa_get_contents", { urls: urls.slice(0, 3) });
  t.eq((await recorded())[0]?.body?.text, { maxCharacters: 7033 }, "3 URLs -> 7033 each");
  // With summaries and in JSON mode, every page must still fit (summaries are not counted by maxCharacters).
  for (const extra of [{ summary_query: "What changed?" }, { response_format: "json" }, { summary_query: "What changed?", response_format: "json" }]) {
    await reset();
    await setScenario("large");
    const rr = await call(c, "exa_get_contents", { urls, ...extra });
    t.check(!rr.isError && textOf(rr).length <= LIMIT, `${JSON.stringify(extra)}: error or too long (${textOf(rr).length})`);
    t.eq(rr.structuredContent?.results?.length, 10, `${JSON.stringify(extra)}: all 10 pages shown`);
  }
});

await runCase("respond(): oversized highlights are shortened, and links-only fallback keeps every link", async (t) => {
  const mod = await import(pathToFileURL(SERVER.replace(/index\.js$/, "services/format.js")).href);
  const md = (p) => (p.results ?? []).map((r) => `### ${r.title}\n${r.url}\n${(r.highlights ?? []).join("\n")}${r.text ?? ""}`).join("\n\n") + (p.truncation_message ? `\n_${p.truncation_message}_` : "");
  const results = Array.from({ length: 5 }, (_, i) => ({ title: `R${i + 1}`, url: `https://example.com/r${i + 1}`, highlights: ["h".repeat(15000), "k".repeat(15000)] }));
  const res = mod.respond("markdown", { query: "q", result_count: 5, results }, md, { moreHint: "lower max_characters" });
  t.check(res.content[0].text.length <= LIMIT, `text ${res.content[0].text.length}`);
  t.check((res.structuredContent.results?.[0]?.highlights ?? []).some((h) => h.length > 1000), "first result kept (shortened) highlights instead of dropping to links only");
  const bigAuthor = Array.from({ length: 3 }, (_, i) => ({ title: `A${i + 1}`, url: `https://example.com/a${i + 1}`, author: "x".repeat(30000) }));
  const mdA = (p) => (p.results ?? []).map((r) => `### ${r.title}\n${r.url}\n${r.author ?? ""}`).join("\n\n");
  const resA = mod.respond("json", { query: "q", result_count: 3, results: bigAuthor }, mdA, { moreHint: "lower max_characters" });
  t.check(resA.content[0].text.length <= LIMIT, `author case text ${resA.content[0].text.length}`);
  t.eq(resA.structuredContent.results?.map((r) => r.url), bigAuthor.map((r) => r.url), "links-only keeps all 3 links");
  t.check(!/Showing 1 of 3/.test(resA.structuredContent.truncation_message ?? ""), `stale note: ${resA.structuredContent.truncation_message}`);
});

await runCase("exa_get_contents truncation (10 URLs x explicit 10000 chars): under limit, note present, structuredContent consistent", async (t) => {
  await reset();
  await setScenario("large");
  const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/long/${i + 1}`);
  const r = await call(c, "exa_get_contents", { urls, max_characters: 10000 });
  truncationChecks(t, r, { total: 10, format: "markdown" });
  const j = await call(c, "exa_get_contents", { urls, max_characters: 10000, response_format: "json" });
  truncationChecks(t, j, { total: 10, format: "json" });
});

await runCase("exa_get_contents truncation advice names only parameters exa_get_contents accepts, and lists omitted URLs", async (t) => {
  await reset();
  await setScenario("large");
  const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/long/${i + 1}`);
  const r = await call(c, "exa_get_contents", { urls, max_characters: 10000 });
  const msg = String(r.structuredContent?.truncation_message ?? "");
  t.check(msg.length > 0, "no truncation message");
  t.check(!msg.includes("num_results"), `message mentions num_results: "${msg}"`);
  const shown = new Set((r.structuredContent?.results ?? []).map((x) => x.url));
  const omitted = urls.filter((u) => !shown.has(u));
  t.check(omitted.length > 0 && omitted.every((u) => msg.includes(u)), `omitted URLs not all listed: ${msg}`);
});

await runCase("exa_get_contents max_characters above 20000 rejected by validation; 20000-char page in JSON stays valid and consistent", async (t) => {
  await reset();
  await setScenario("large");
  const bad = await call(c, "exa_get_contents", { urls: [URL_A], max_characters: 50000 });
  t.check(bad.isError || bad.thrown, `50000 accepted: ${textOf(bad).slice(0, 120)}`);
  t.eq((await recorded()).length, 0, "no request sent for invalid input");
  const r = await call(c, "exa_get_contents", { urls: [URL_A], max_characters: 20000, response_format: "json" });
  const text = textOf(r);
  t.check(text.length <= LIMIT, `text length ${text.length}`);
  const parsed = tryParse(text);
  if (t.check(parsed.ok, `not JSON: ${parsed.error}`)) t.eq(parsed.value, r.structuredContent, "JSON vs structured");
});

await runCase("respond(): single oversized field is shortened in the payload (markdown + json), never split mid-surrogate", async (t) => {
  const { respond, CHARACTER_LIMIT_FOR_TEST } = await (async () => {
    const mod = await import(pathToFileURL(SERVER.replace(/index\.js$/, "services/format.js")).href);
    return { respond: mod.respond, CHARACTER_LIMIT_FOR_TEST: LIMIT };
  })();
  // Text full of emoji (surrogate pairs) and quotes/newlines (JSON escaping), 60k units long.
  const unit = '😀"\n';
  const big = unit.repeat(Math.ceil(60_000 / unit.length));
  const payload = { query: "q", result_count: 1, results: [{ title: "Huge", url: "https://example.com/huge", text: big }] };
  const md = (p) => p.results.map((r) => `### ${r.title}\n${r.text ?? ""}`).join("\n") + (p.truncation_message ? `\n_${p.truncation_message}_` : "");
  for (const format of ["markdown", "json"]) {
    const res = respond(format, payload, md, { moreHint: "lower max_characters to see more" });
    const text = res.content[0].text;
    t.check(text.length <= CHARACTER_LIMIT_FOR_TEST, `${format}: text ${text.length} > limit`);
    t.check(res.structuredContent.truncated === true, `${format}: truncated flag`);
    t.check(/cut to fit/.test(res.structuredContent.truncation_message ?? ""), `${format}: message ${res.structuredContent.truncation_message}`);
    t.check(JSON.stringify(res.structuredContent).length <= CHARACTER_LIMIT_FOR_TEST * 1.6, `${format}: structured not trimmed`);
    t.check(text.isWellFormed?.() ?? !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), `${format}: lone surrogate in text`);
    if (format === "json") {
      const parsed = tryParse(text);
      if (t.check(parsed.ok, `json invalid: ${parsed.error}`)) t.eq(parsed.value, res.structuredContent, "json text vs structured");
    } else {
      t.check(text.includes(res.structuredContent.results[0].text.slice(0, 1000)), "markdown shows the shortened structured text");
    }
  }
});

// ================================================================== exa_answer

const QUESTION = "What was Travelers' 2025 combined ratio?";

await runCase("exa_answer markdown (defaults): body {query, model:'exa', text:false}, answer + numbered sources", async (t) => {
  await reset();
  const r = await call(c, "exa_answer", { query: QUESTION });
  const [req] = await recorded();
  t.eq(req?.path, "/answer", "path");
  t.eq(req?.headers?.["x-api-key"], KEY, "x-api-key");
  t.eq(req?.body, { query: QUESTION, model: "exa", text: false }, "answer body (no stream, no systemPrompt)");
  t.check(!r.isError && !r.thrown, `unexpected error: ${r.thrown ?? textOf(r)}`);
  const text = textOf(r);
  for (const s of [
    `# Answer: ${QUESTION}`,
    "\nTravelers reported a 2025 combined ratio of about 94.2%, an improvement on 2024.\n",
    "_Exa cost: $0.0050_",
    "## Sources",
    "1. [Travelers 2025 Annual Results](https://www.travelers.com/ir/2025-annual) (2026-01-22)",
    "2. [https://www.ambest.com/news/2026/travelers](https://www.ambest.com/news/2026/travelers)",
  ]) t.check(text.includes(s), `markdown missing ${JSON.stringify(s)}`);
});

await runCase("exa_answer: model exa-pro + system_prompt -> model/systemPrompt in body, text:false", async (t) => {
  await reset();
  await call(c, "exa_answer", { query: QUESTION, model: "exa-pro", system_prompt: "Prefer carrier filings. Answer in 3 bullets." });
  const [req] = await recorded();
  t.eq(req?.body, { query: QUESTION, model: "exa-pro", text: false, systemPrompt: "Prefer carrier filings. Answer in 3 bullets." }, "body");
});

await runCase("exa_answer json: valid JSON equal to structuredContent; null citation title falls back to URL", async (t) => {
  await reset();
  const r = await call(c, "exa_answer", { query: QUESTION, response_format: "json" });
  const parsed = tryParse(textOf(r));
  if (t.check(parsed.ok, `not JSON: ${parsed.error}`)) t.eq(parsed.value, r.structuredContent, "JSON vs structured");
  t.eq(r.structuredContent?.citations, [
    { title: "Travelers 2025 Annual Results", url: "https://www.travelers.com/ir/2025-annual", published_date: "2026-01-22" },
    { title: "https://www.ambest.com/news/2026/travelers", url: "https://www.ambest.com/news/2026/travelers" },
  ], "citations");
  t.eq(r.structuredContent?.answer, "  Travelers reported a 2025 combined ratio of about 94.2%, an improvement on 2024.  ", "answer (raw in JSON)");
});

await runCase("exa_answer: object answer renders in markdown and passes output schema", async (t) => {
  await reset();
  await setScenario("answer_object");
  const r = await call(c, "exa_answer", { query: QUESTION });
  t.check(!r.isError && !r.thrown, `unexpected error: ${r.thrown ?? textOf(r)}`);
  t.check(textOf(r).includes('"combined_ratio": 94.2'), "object rendered as JSON in markdown");
  t.eq(r.structuredContent?.answer, { combined_ratio: 94.2, fiscal_year: 2025, source_count: 2 }, "structured answer object");
  const j = await call(c, "exa_answer", { query: QUESTION, response_format: "json" });
  t.eq(tryParse(textOf(j)).value?.answer?.combined_ratio, 94.2, "json answer object");
});

await runCase("exa_answer: no citations -> unverified warning; empty answer -> isError", async (t) => {
  await reset();
  await setScenario("answer_no_citations");
  const r = await call(c, "exa_answer", { query: QUESTION });
  t.check(!r.isError, "isError");
  t.check(textOf(r).includes("Exa returned no citations"), `text: ${textOf(r)}`);
  await setScenario("answer_empty");
  const e = await call(c, "exa_answer", { query: QUESTION });
  t.eq(e.isError, true, "empty answer isError");
  t.check(textOf(e).includes("empty answer"), `text: ${textOf(e)}`);
});

// ================================================================== error mapping

const ERROR_EXPECTATIONS = [
  ["http_400", ["(400)", "Invalid request body: numResults must be <= 100", "Adjust the parameters"]],
  ["http_401", ["(401)", "EXA_API_KEY"]],
  ["http_402", ["(402)", "out of credits", "You have exceeded your credit limit"]],
  ["http_403", ["(403)", "This API key does not have access to exa-pro"]],
  ["http_429", ["(429)", "rate limit"]],
  ["http_500", ["(500)", "temporarily unavailable"]],
  ["http_503", ["(503)", "temporarily unavailable"]],
  ["http_502_html", ["(502)", "temporarily unavailable"]],
  ["invalid_json", ["not valid JSON"]],
];

for (const [scenario, needles] of ERROR_EXPECTATIONS) {
  await runCase(`error mapping ${scenario}: isError=true with a clear message on all three tools`, async (t) => {
    const calls = [
      ["exa_search", { query: "q" }],
      ["exa_get_contents", { urls: [URL_A] }],
      ["exa_answer", { query: QUESTION }],
    ];
    for (const [tool, args] of calls) {
      await reset();
      await setScenario(scenario);
      const r = await call(c, tool, args);
      t.check(!r.thrown, `${tool}: client threw ${r.thrown}`);
      t.eq(r.isError, true, `${tool} isError`);
      t.check(r.structuredContent === undefined, `${tool}: error result carries structuredContent`);
      const text = textOf(r);
      t.check(text.startsWith("Error:"), `${tool}: message should start with 'Error:' (${text.slice(0, 80)})`);
      for (const n of needles) t.check(text.toLowerCase().includes(n.toLowerCase()), `${tool}: missing ${JSON.stringify(n)} in ${JSON.stringify(text.slice(0, 300))}`);
      t.eq((await recorded()).length, 1, `${tool}: exactly one request (no retries)`);
      if (scenario === "http_502_html" && tool === "exa_search") t.note(`502 message: ${JSON.stringify(text)}`);
    }
  });
}

await runCase("error mapping: 401 whose body echoes the key does not leak the key", async (t) => {
  await reset();
  await setScenario("http_401_echo_key");
  const r = await call(c, "exa_search", { query: "q" });
  t.eq(r.isError, true, "isError");
  t.check(!JSON.stringify(r).includes(KEY), "key leaked");
});

await runCase("network failure mid-body: connection dropped after headers -> isError with a network message", async (t) => {
  await reset();
  await setScenario("reset_body");
  const r = await call(c, "exa_search", { query: "q" });
  t.eq(r.isError, true, "isError");
  t.check(
    /Could not reach Exa|network/i.test(textOf(r)),
    `body-read failure bypasses exaPost's network-error mapping: ${JSON.stringify(textOf(r))}`,
  );
});

// ================================================================== input validation (SDK + zod)

await runCase("input validation: bad arguments rejected as isError before any request", async (t) => {
  await reset();
  const bad = [
    ["exa_search", { query: "q", foo: 1 }, "unknown key"],
    ["exa_search", { query: "q", num_results: 26 }, "num_results 26"],
    ["exa_search", { query: "   " }, "blank query"],
    ["exa_search", { query: "q", type: "deep-reasoning" }, "type outside enum"],
    ["exa_search", { query: "q", start_published_date: "Jan 1 2026" }, "non-ISO date"],
    ["exa_get_contents", { urls: ["naic.org/report"] }, "URL without scheme"],
    ["exa_get_contents", { urls: [] }, "empty urls"],
    ["exa_get_contents", { urls: [URL_A], max_age_hours: 721 }, "max_age_hours 721"],
    ["exa_answer", { query: "q", model: "exa-research" }, "model outside enum"],
  ];
  for (const [tool, args, label] of bad) {
    const r = await call(c, tool, args);
    t.check(r.isError === true && /Input validation error/.test(textOf(r)), `${label}: ${JSON.stringify(r).slice(0, 200)}`);
  }
  t.eq((await recorded()).length, 0, "requests sent");
});

// ================================================================== separate server instances

await runCase("network failure: unreachable EXA_BASE_URL -> isError 'Could not reach Exa'", async (t) => {
  const port = await closedPort();
  const s = await launch({ EXA_API_KEY: KEY, EXA_BASE_URL: `http://127.0.0.1:${port}` }, "unreachable");
  try {
    const r = await call(s.client, "exa_search", { query: "q" });
    t.eq(r.isError, true, "isError");
    t.check(textOf(r).includes("Could not reach Exa"), `text: ${textOf(r)}`);
    t.note(textOf(r));
  } finally {
    await s.client.close();
  }
});

await runCase("EXA_BASE_URL with a trailing slash still hits /search", async (t) => {
  await reset();
  const s = await launch({ EXA_API_KEY: KEY, EXA_BASE_URL: `${stub.baseUrl}/` }, "trailing-slash");
  try {
    const r = await call(s.client, "exa_search", { query: "q" });
    t.check(!r.isError, `isError: ${textOf(r)}`);
    t.eq((await recorded()).map((x) => x.path), ["/search"], "paths");
  } finally {
    await s.client.close();
  }
});

// Timeouts: REQUEST_TIMEOUT_MS=60s / ANSWER_TIMEOUT_MS=120s are not configurable, so this server
// instance is started with a preload that divides AbortSignal.timeout() by 200 (60s -> 300ms,
// 120s -> 600ms). The stub's slow scenarios wait 3s.
const scaledEnv = {
  ...baseEnv,
  E2E_TIMEOUT_SCALE: "200",
  NODE_OPTIONS: `--import ${pathToFileURL(join(HERE, "shrink-timeouts.mjs")).href}`,
};
const scaled = await launch(scaledEnv, "scaled-timeouts");

await runCase("timeout: no response within the request timeout -> isError 'did not respond within 60s' (search) / 120s (answer)", async (t) => {
  await reset();
  await setScenario("slow");
  const t0 = Date.now();
  const r = await call(scaled.client, "exa_search", { query: "q" });
  const ms = Date.now() - t0;
  t.eq(r.isError, true, "search isError");
  t.check(textOf(r).includes("did not respond within 60s"), `search text: ${textOf(r)}`);
  t.check(ms < 2_500, `search took ${ms}ms (timeout did not fire before the stub answered)`);
  const a = await call(scaled.client, "exa_answer", { query: QUESTION });
  t.eq(a.isError, true, "answer isError");
  t.check(textOf(a).includes("did not respond within 120s"), `answer text: ${textOf(a)}`);
  t.note(`search ${ms}ms`);
});

await runCase("timeout: headers arrive but the body stalls -> same clear timeout message", async (t) => {
  await reset();
  await setScenario("slow_body");
  const r = await call(scaled.client, "exa_search", { query: "q" });
  t.eq(r.isError, true, "isError");
  t.check(
    textOf(r).includes("did not respond within"),
    `body-read timeout escapes exaPost's timeout handling (response.text() is outside the try/catch): ${JSON.stringify(textOf(r))}`,
  );
});
await scaled.client.close();

// ================================================================== key hygiene + stderr

await runCase("API key 'test-key-123' never appears in any tool output", async (t) => {
  const blob = JSON.stringify(allOutputs);
  t.check(allOutputs.length > 40, `only ${allOutputs.length} outputs captured`);
  t.check(!blob.includes(KEY), "key found in tool output");
  t.note(`${allOutputs.length} tool results scanned`);
});

await runCase("server stderr: startup banner goes to stderr and never contains the key", async (t) => {
  const mainErr = main.stderr();
  t.check(mainErr.includes("exa-mcp-server 1.0.0 running on stdio"), `stderr: ${mainErr.slice(0, 200)}`);
  for (const log of stderrLogs) t.check(!log.text.includes(KEY), `key in stderr of ${log.label}`);
});

await main.client.close();

// ================================================================== startup without a key

function runServerRaw(env, ms = 10_000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: "timeout", stdout, stderr });
    }, ms);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

await runCase("ad-hoc server: huge markdown answer shows the truncation note; key straddling the 500-char excerpt is fully redacted", async (t) => {
  const http = await import("node:http");
  const STRADDLE_KEY = "sk-straddle-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (req.url === "/answer") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ answer: "w".repeat(30000), citations: [{ title: "A", url: "https://a.com" }], costDollars: { total: 0.005 } }));
      } else {
        res.writeHead(502, { "content-type": "text/html" });
        // 470 + "x-api-key: " (11) puts the first 19 key characters inside the 500-char excerpt.
        res.end(`${"x".repeat(470)}x-api-key: ${req.headers["x-api-key"]} more proxy text`);
      }
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const s = await launch({ PATH: process.env.PATH, HOME: process.env.HOME, EXA_API_KEY: STRADDLE_KEY, EXA_BASE_URL: base }, "adhoc");
  const a = await call(s.client, "exa_answer", { query: "long report" });
  const text = textOf(a);
  t.check(!a.isError && text.length <= LIMIT, `answer error or too long: ${text.length}`);
  t.check(text.includes("was cut to fit") && text.includes("ask a narrower question"), "truncation note visible in markdown answer");
  const e = await call(s.client, "exa_search", { query: "q" });
  const etext = textOf(e);
  t.eq(e.isError, true, "502 isError");
  t.check(!etext.includes(STRADDLE_KEY.slice(0, 8)), `partial key leaked: ${etext.slice(-160)}`);
  t.check(etext.includes("[redacted]"), `redaction marker missing: ${etext.slice(-160)}`);
  await s.client.close();
  srv.close();
});

async function keyCase(name, key, expectText) {
  await runCase(name, async (t) => {
    await reset();
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, EXA_BASE_URL: stub.baseUrl };
    if (key !== undefined) env.EXA_API_KEY = key;
    const srv = await launch(env, `key:${name}`);
    t.check(srv.stderr().includes("WARNING: EXA_API_KEY is not set") || key !== undefined, `stderr warning: ${srv.stderr()}`);
    const r = await call(srv.client, "exa_search", { query: "q" });
    t.eq(r.isError, true, "isError");
    t.check(textOf(r).includes(expectText), `text: ${textOf(r)}`);
    if (key) t.check(!textOf(r).includes(key.trim()) || key.trim().length < 3, "key echoed in output");
    t.eq((await recorded()).length, 0, "no request sent to Exa");
    await srv.client.close();
  });
}

await keyCase("startup: EXA_API_KEY unset -> server stays up, warns on stderr, tool returns setup instructions", undefined, "EXA_API_KEY is not set");
await keyCase("startup: EXA_API_KEY whitespace-only -> treated as unset", "   ", "EXA_API_KEY is not set");
await keyCase("EXA_API_KEY with a stray space or curly quote -> clear copy-paste error, key not echoed", "abc“def ghi", "contains characters an API key cannot have");

// ================================================================== report

await stub.close();
clearTimeout(HARD_DEADLINE);
const failed = cases.filter((x) => !x.passed);
writeFileSync(join(HERE, process.env.E2E_SERVER ? "results-mutant.json" : "results.json"), JSON.stringify({ cases, passed: cases.length - failed.length, failed: failed.length }, null, 2));
console.log(`\n${cases.length - failed.length}/${cases.length} cases passed; results written to ${join(HERE, "results.json")}`);
process.exit(failed.length ? 1 : 0);
