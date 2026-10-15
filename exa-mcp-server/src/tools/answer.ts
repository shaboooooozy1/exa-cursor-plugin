import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ANSWER_TIMEOUT_MS } from "../constants.js";
import { AnswerInputSchema, AnswerOutputShape, type AnswerInput } from "../schemas.js";
import { errorMessage, exaPost } from "../services/exa-client.js";
import { costLine, costTotal, errorResult, respond, type Payload } from "../services/format.js";
import type { ExaAnswerResponse, ToolResult } from "../types.js";

interface Citation {
  title: string;
  url: string;
  published_date?: string;
}

export function buildAnswerBody(params: AnswerInput): Record<string, unknown> {
  return {
    query: params.query,
    model: params.model,
    text: false,
    ...(params.system_prompt ? { systemPrompt: params.system_prompt } : {}),
  };
}

function answerMarkdown(payload: Payload): string {
  const answer = payload.answer;
  const citations = (payload.citations as Citation[] | undefined) ?? [];
  const lines = [
    `# Answer: ${String(payload.query)}`,
    "",
    typeof answer === "string" ? answer.trim() : JSON.stringify(answer, null, 2),
  ];
  if (payload.truncation_message) lines.push("", `_${String(payload.truncation_message)}_`);
  const cost = costLine(payload.cost_dollars as number | undefined);
  if (cost) lines.push("", cost);
  lines.push("", "## Sources");
  if (citations.length === 0) {
    lines.push("Exa returned no citations for this answer; verify it with exa_search before relying on it.");
  }
  citations.forEach((c, i) => {
    lines.push(`${i + 1}. [${c.title}](${c.url})${c.published_date ? ` (${c.published_date})` : ""}`);
  });
  return lines.join("\n");
}

export async function runAnswer(params: AnswerInput): Promise<ToolResult> {
  try {
    const data = await exaPost<ExaAnswerResponse>("/answer", buildAnswerBody(params), ANSWER_TIMEOUT_MS);
    if (data.answer === undefined || data.answer === null || data.answer === "") {
      return errorResult("Error: Exa returned an empty answer. Rephrase the question or use exa_search instead.");
    }
    const citations: Citation[] = (data.citations ?? []).map((c) => ({
      title: c.title?.trim() || c.url,
      url: c.url,
      ...(c.publishedDate ? { published_date: c.publishedDate.slice(0, 10) } : {}),
    }));
    const payload: Payload = {
      query: params.query,
      answer: data.answer,
      citations,
      ...(costTotal(data.costDollars) !== undefined ? { cost_dollars: costTotal(data.costDollars) } : {}),
    };
    return respond(params.response_format, payload, answerMarkdown, {
      moreHint: "ask a narrower question for a complete answer",
    });
  } catch (error) {
    return errorResult(errorMessage(error));
  }
}

export function registerAnswerTool(server: McpServer): void {
  server.registerTool(
    "exa_answer",
    {
      title: "Exa Cited Answer",
      description: `Answer a factual question from live web sources, returning a short answer plus the pages it was drawn from.

Use for direct questions with a factual answer ("What was Travelers' 2025 combined ratio?", "When does the new Florida reinsurance rule take effect?"). Use exa_search instead when you need to survey many sources or apply domain or date filters. Always cite the returned sources and treat an answer without citations as unverified.

Args:
  - query (string): the question
  - model ('exa' default | 'exa-pro'): exa-pro is more thorough and costs more
  - system_prompt (optional): guidance on sources, format or length
  - response_format ('markdown' default | 'json')

Returns: { query, answer, citations: [{ title, url, published_date? }], cost_dollars? }.`,
      inputSchema: AnswerInputSchema,
      outputSchema: AnswerOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => runAnswer(params),
  );
}
