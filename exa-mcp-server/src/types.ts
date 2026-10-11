export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export interface ExaCost {
  total?: number;
}

export interface ExaResult {
  id?: string;
  url: string;
  title?: string | null;
  publishedDate?: string | null;
  author?: string | null;
  text?: string;
  highlights?: string[];
  summary?: string;
}

export interface ExaSearchResponse {
  requestId?: string;
  results: ExaResult[];
  costDollars?: ExaCost;
}

export interface ExaContentStatus {
  id: string;
  status: "success" | "error";
  source?: "cached" | "crawled";
  error?: { tag?: string; httpStatusCode?: number };
}

export interface ExaContentsResponse {
  requestId?: string;
  results: ExaResult[];
  statuses?: ExaContentStatus[];
  costDollars?: ExaCost;
}

export interface ExaCitation {
  url: string;
  title?: string | null;
  publishedDate?: string | null;
  author?: string | null;
}

export interface ExaAnswerResponse {
  requestId?: string;
  answer: string | Record<string, unknown>;
  citations?: ExaCitation[];
  costDollars?: ExaCost;
}

/** Tool result shape returned by every tool handler. */
export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
