import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ContentsInputSchema, ContentsOutputShape, type ContentsInput } from "../schemas.js";
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
import type { ExaContentStatus, ExaContentsResponse, ToolResult } from "../types.js";

/**
 * Per-page text budget: the caller's value, or a default that lets every requested page fit in one
 * response, leaving room for titles, URLs, summaries (not counted by Exa's maxCharacters) and JSON overhead.
 */
export function pageBudget(params: ContentsInput): number {
  if (params.max_characters !== undefined) return params.max_characters;
  const n = params.urls.length;
  const total = params.response_format === "json" ? 20_000 : 22_000;
  const perPageOverhead = 300 + (params.summary_query ? 900 : 0);
  return Math.max(200, Math.min(10_000, Math.floor((total - n * perPageOverhead) / n)));
}

export function buildContentsBody(params: ContentsInput): Record<string, unknown> {
  return {
    urls: params.urls,
    text: { maxCharacters: pageBudget(params) },
    ...(params.max_age_hours !== undefined ? { maxAgeHours: params.max_age_hours } : {}),
    ...(params.summary_query ? { summary: { query: params.summary_query } } : {}),
  };
}

function describeStatus(status: ExaContentStatus): string {
  const parts = [status.error?.tag, status.error?.httpStatusCode ? `HTTP ${status.error.httpStatusCode}` : undefined];
  return parts.filter(Boolean).join(", ") || "unknown error";
}

/** Recovery advice that depends on the cache setting the caller actually used. */
function retryHint(params: ContentsInput): string {
  if (params.max_age_hours === -1) {
    return "No cached copy was available; retry with max_age_hours omitted so Exa can crawl the pages live.";
  }
  if (params.max_age_hours === 0) {
    return "The live crawl failed; retry with max_age_hours omitted so Exa can fall back to a cached copy.";
  }
  return "Check that each URL is correct and publicly reachable (404 = not found, 401/403 = login or paywall), or use exa_search to find another source.";
}

function contentsMarkdown(payload: Payload): string {
  const results = payload.results ?? [];
  const failed = (payload.failed as { url: string; error: string }[] | undefined) ?? [];
  const lines = [`# Page contents (${results.length} retrieved${failed.length ? `, ${failed.length} failed` : ""})`];
  const cost = costLine(payload.cost_dollars as number | undefined);
  if (cost) lines.push(cost);
  if (payload.truncation_message) lines.push("", `_${String(payload.truncation_message)}_`);
  if (failed.length) {
    lines.push("", "**Could not retrieve:**", ...failed.map((f) => `- ${f.url} (${f.error})`));
  }
  results.forEach((r, i) => lines.push("", resultToMarkdown(r, i)));
  return lines.join("\n");
}

export async function runContents(params: ContentsInput): Promise<ToolResult> {
  try {
    const data = await exaPost<ExaContentsResponse>("/contents", buildContentsBody(params));
    const results = (data.results ?? []).map(toFormattedResult);
    const failed = (data.statuses ?? [])
      .filter((s) => s.status === "error")
      .map((s) => ({ url: s.id, error: describeStatus(s) }));

    if (results.length === 0) {
      const detail = failed.length ? failed.map((f) => `${f.url} (${f.error})`).join("; ") : "no content returned";
      return errorResult(`Error: Could not retrieve any of the requested pages: ${detail}. ${retryHint(params)}`);
    }

    const payload: Payload = {
      results,
      failed,
      ...(costTotal(data.costDollars) !== undefined ? { cost_dollars: costTotal(data.costDollars) } : {}),
    };
    return respond(params.response_format, payload, contentsMarkdown, {
      moreHint: "lower max_characters or request fewer URLs per call to see more",
      listOmittedUrls: true,
    });
  } catch (error) {
    return errorResult(errorMessage(error));
  }
}

export function registerContentsTool(server: McpServer): void {
  server.registerTool(
    "exa_get_contents",
    {
      title: "Exa Get Page Contents",
      description: `Read the clean text of one or more web pages through Exa (handles JavaScript-heavy pages and PDFs).

Use after exa_search to read a promising result in full, or when the user gives you a URL. Do not use to discover pages; use exa_search for that.

Args:
  - urls (string[], 1-10): full URLs including https://
  - max_characters (optional, 200-20000): text per page. Default up to 10000, shrinking with more URLs (and when summary_query is set) so all pages fit in one response. Long documents (e.g. a 10-K) are returned only up to this length
  - max_age_hours (optional, -1 to 720): 0 forces a fresh crawl; N accepts a cached copy younger than N hours; -1 cache only
  - summary_query (optional): also return a summary of each page focused on this question
  - response_format ('markdown' default | 'json')

Returns: { results: [{ title, url, published_date?, author?, summary?, text }], failed: [{ url, error }], cost_dollars? }. Pages Exa could not retrieve are listed in failed rather than dropped. If every page fails, the tool returns an error. If the combined text exceeds 25,000 characters, truncation_message names any pages left out so you can request them separately.`,
      inputSchema: ContentsInputSchema,
      outputSchema: ContentsOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => runContents(params),
  );
}
