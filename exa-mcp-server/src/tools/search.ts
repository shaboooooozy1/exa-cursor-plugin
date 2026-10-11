import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DATE_PATTERN,
  RESTRICTED_CATEGORIES,
  SearchInputSchema,
  SearchOutputShape,
  type SearchInput,
} from "../schemas.js";
import { errorMessage, exaPost } from "../services/exa-client.js";
import {
  costLine,
  costTotal,
  errorResult,
  respond,
  resultToMarkdown,
  toFormattedResult,
  type Payload,
} from "../services/format.js";
import type { ExaSearchResponse, ToolResult } from "../types.js";

/**
 * Validate an ISO 8601 date or date-time and return it as a canonical UTC date-time
 * ("YYYY-MM-DDTHH:mm:ss.sssZ"), or undefined if it is not a real calendar date/time.
 * A bare date is widened to the start or end of that day; a time without an offset is read as UTC.
 */
export function normalizeDate(value: string, edge: "start" | "end"): string | undefined {
  const m = DATE_PATTERN.exec(value);
  if (!m) return undefined;
  const [year, month, day] = [m[1], m[2], m[3]].map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    return undefined;
  }
  if (m[4] === undefined) {
    return `${m[1]}-${m[2]}-${m[3]}${edge === "start" ? "T00:00:00.000Z" : "T23:59:59.999Z"}`;
  }
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6] ?? 0) > 59) return undefined;

  const offset = m[7];
  const base = offset ? value.slice(0, -offset.length) : value;
  const normalizedOffset = !offset || offset === "Z" ? "Z" : offset.includes(":") ? offset : `${offset.slice(0, 3)}:${offset.slice(3)}`;
  const ms = Date.parse(base + normalizedOffset);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

export function buildSearchBody(params: SearchInput): Record<string, unknown> {
  const contents =
    params.content_mode === "highlights"
      ? { highlights: { query: params.query, maxCharacters: params.max_characters } }
      : params.content_mode === "text"
        ? { text: { maxCharacters: params.max_characters } }
        : undefined;

  const body: Record<string, unknown> = {
    query: params.query,
    numResults: params.num_results,
    type: params.type,
    category: params.category,
    includeDomains: params.include_domains,
    excludeDomains: params.exclude_domains,
    startPublishedDate: params.start_published_date && normalizeDate(params.start_published_date, "start"),
    endPublishedDate: params.end_published_date && normalizeDate(params.end_published_date, "end"),
    contents,
  };
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

function searchMarkdown(payload: Payload): string {
  const results = payload.results ?? [];
  const lines = [`# Exa search: "${String(payload.query)}"`, "", `${results.length} result(s).`];
  const cost = costLine(payload.cost_dollars as number | undefined);
  if (cost) lines.push(cost);
  if (payload.truncation_message) lines.push("", `_${String(payload.truncation_message)}_`);
  if (results.length === 0) {
    lines.push("", "No results. Try broader wording, a wider date range, or fewer domain filters.");
  }
  results.forEach((r, i) => lines.push("", resultToMarkdown(r, i)));
  return lines.join("\n");
}

export async function runSearch(params: SearchInput): Promise<ToolResult> {
  if (params.category && RESTRICTED_CATEGORIES.has(params.category)) {
    const blocked = [
      params.start_published_date && "start_published_date",
      params.end_published_date && "end_published_date",
      params.exclude_domains && "exclude_domains",
    ].filter(Boolean);
    if (blocked.length) {
      return errorResult(
        `Error: Exa does not allow ${blocked.join(", ")} with category '${params.category}'. ` +
          "Remove those filters, or drop the category and describe the target in the query instead.",
      );
    }
  }
  const start = params.start_published_date && normalizeDate(params.start_published_date, "start");
  const end = params.end_published_date && normalizeDate(params.end_published_date, "end");
  if (params.start_published_date && !start) {
    return errorResult(`Error: start_published_date '${params.start_published_date}' is not a real date. Use YYYY-MM-DD.`);
  }
  if (params.end_published_date && !end) {
    return errorResult(`Error: end_published_date '${params.end_published_date}' is not a real date. Use YYYY-MM-DD.`);
  }
  if (start && end && start > end) {
    return errorResult("Error: start_published_date is after end_published_date. Swap or widen the dates.");
  }

  try {
    const data = await exaPost<ExaSearchResponse>("/search", buildSearchBody(params));
    const results = (data.results ?? []).map(toFormattedResult);
    const payload: Payload = {
      query: params.query,
      result_count: results.length,
      results,
      ...(costTotal(data.costDollars) !== undefined ? { cost_dollars: costTotal(data.costDollars) } : {}),
    };
    return respond(params.response_format, payload, searchMarkdown, {
      moreHint: "lower num_results or max_characters to see more",
    });
  } catch (error) {
    return errorResult(errorMessage(error));
  }
}

export function registerSearchTool(server: McpServer): void {
  server.registerTool(
    "exa_search",
    {
      title: "Exa Web Search",
      description: `Search the live web with Exa and return ranked results with titles, URLs, publish dates and relevant excerpts.

Use for current events, company and carrier research, regulatory updates, market trends, or finding source documents. Write the query as a natural-language description of the page you want, not keywords. Narrow with category ('news', 'company', 'financial report', ...), include_domains, and published-date filters. To read a full page you already have the URL for, use exa_get_contents instead; for a direct cited answer to a question, use exa_answer.

Args:
  - query (string): what to find
  - num_results (1-25, default 5)
  - type ('auto' | 'fast' | 'instant' | 'deep', default 'auto')
  - category (optional): 'news' | 'company' | 'financial report' | 'publication' | 'people' | 'personal site'. 'company' and 'people' reject date filters and exclude_domains
  - include_domains / exclude_domains (optional string arrays)
  - start_published_date / end_published_date (optional ISO dates, e.g. '2026-01-01')
  - content_mode ('highlights' default | 'text' | 'none') and max_characters of content per result (default 3000)
  - response_format ('markdown' default | 'json')

Returns: { query, result_count, results: [{ title, url, published_date?, author?, highlights?, text? }], cost_dollars? }. result_count is the number Exa returned. Responses over 25,000 characters are trimmed (fewer results shown, then long text shortened) with truncated=true and a truncation_message.`,
      inputSchema: SearchInputSchema,
      outputSchema: SearchOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => runSearch(params),
  );
}
