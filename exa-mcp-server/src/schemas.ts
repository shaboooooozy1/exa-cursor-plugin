import { z } from "zod";
import { ResponseFormat } from "./types.js";

const responseFormat = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("'markdown' for readable output (default) or 'json' for structured data");

/** YYYY-MM-DD, optionally followed by THH:MM[:SS[.fff]] and an optional Z or ±HH:MM / ±HHMM offset. */
export const DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const isoDate = z.string().regex(DATE_PATTERN, "Use ISO 8601, e.g. '2026-01-31' or '2026-01-31T00:00:00Z'");

const domainList = z.array(z.string().min(1).max(253)).min(1).max(50);

export const SEARCH_CATEGORIES = [
  "news",
  "company",
  "financial report",
  "publication",
  "people",
  "personal site",
] as const;

/** Categories for which Exa rejects date filters and exclude_domains. */
export const RESTRICTED_CATEGORIES: ReadonlySet<string> = new Set(["company", "people"]);

export const SearchInputSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe("Natural-language description of what to find, e.g. 'commercial property rate trends 2026'"),
    num_results: z.number().int().min(1).max(25).default(5).describe("Number of results (1-25, default 5)"),
    type: z
      .enum(["auto", "fast", "instant", "deep"])
      .default("auto")
      .describe("'auto' (default, best balance), 'fast'/'instant' (lower latency), 'deep' (slower, more thorough)"),
    category: z
      .enum(SEARCH_CATEGORIES)
      .optional()
      .describe(
        "Restrict to a content type. 'company' and 'people' cannot be combined with date filters or exclude_domains",
      ),
    include_domains: domainList
      .optional()
      .describe("Only return results from these domains, e.g. ['naic.org', 'sec.gov']"),
    exclude_domains: domainList.optional().describe("Never return results from these domains"),
    start_published_date: isoDate.optional().describe("Only results published on or after this date (ISO 8601)"),
    end_published_date: isoDate.optional().describe("Only results published on or before this date (ISO 8601)"),
    content_mode: z
      .enum(["highlights", "text", "none"])
      .default("highlights")
      .describe(
        "'highlights' (default): key excerpts; 'text': page text up to max_characters; 'none': titles and URLs only",
      ),
    max_characters: z
      .number()
      .int()
      .min(200)
      .max(20000)
      .default(3000)
      .describe("Maximum characters of content per result (default 3000)"),
    response_format: responseFormat,
  })
  .strict();

export const ContentsInputSchema = z
  .object({
    urls: z
      .array(z.string().url("Each entry must be a full URL including https://"))
      .min(1)
      .max(10)
      .describe("1-10 page URLs to read"),
    max_characters: z
      .number()
      .int()
      .min(200)
      .max(20000)
      .optional()
      .describe(
        "Maximum characters of text per page (200-20000). Default: up to 10000, shrinking with more URLs (and when summary_query is set) so every page fits in one response",
      ),
    max_age_hours: z
      .number()
      .int()
      .min(-1)
      .max(720)
      .optional()
      .describe(
        "Cache freshness: 0 forces a fresh fetch, N accepts a cached copy younger than N hours, -1 uses the cache only. Omit for Exa's default",
      ),
    summary_query: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .optional()
      .describe("If set, also return an AI summary of each page focused on this question"),
    response_format: responseFormat,
  })
  .strict();

export const AnswerInputSchema = z
  .object({
    query: z.string().trim().min(1).max(2000).describe("The question to answer from live web sources"),
    model: z
      .enum(["exa", "exa-pro"])
      .default("exa")
      .describe("'exa' (default, faster) or 'exa-pro' (more thorough, higher cost)"),
    system_prompt: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .optional()
      .describe("Optional guidance, e.g. 'Prefer regulator and carrier filings; answer in 3 bullet points'"),
    response_format: responseFormat,
  })
  .strict();

const ResultOutput = z.object({
  title: z.string(),
  url: z.string(),
  published_date: z.string().optional(),
  author: z.string().optional(),
  summary: z.string().optional(),
  highlights: z.array(z.string()).optional(),
  text: z.string().optional(),
});

const truncationOutput = {
  truncated: z.boolean().optional(),
  truncation_message: z.string().optional(),
};

export const SearchOutputShape = {
  query: z.string(),
  result_count: z.number().int(),
  results: z.array(ResultOutput),
  cost_dollars: z.number().optional(),
  ...truncationOutput,
};

export const ContentsOutputShape = {
  results: z.array(ResultOutput),
  failed: z.array(z.object({ url: z.string(), error: z.string() })),
  cost_dollars: z.number().optional(),
  ...truncationOutput,
};

export const AnswerOutputShape = {
  query: z.string(),
  answer: z.union([z.string(), z.record(z.unknown())]),
  citations: z.array(z.object({ title: z.string(), url: z.string(), published_date: z.string().optional() })),
  cost_dollars: z.number().optional(),
  ...truncationOutput,
};

export type SearchInput = z.infer<typeof SearchInputSchema>;
export type ContentsInput = z.infer<typeof ContentsInputSchema>;
export type AnswerInput = z.infer<typeof AnswerInputSchema>;
