import { CHARACTER_LIMIT } from "../constants.js";
import { ResponseFormat, type ExaCost, type ExaResult, type ToolResult } from "../types.js";

/** A result trimmed to the fields worth showing the model. */
export interface FormattedResult {
  title: string;
  url: string;
  published_date?: string;
  author?: string;
  summary?: string;
  highlights?: string[];
  text?: string;
}

/** Structured payload for a tool response; `results` is the part that gets trimmed when too long. */
export interface Payload {
  [key: string]: unknown;
  results?: FormattedResult[];
}

export interface RespondOptions {
  /** How the caller can see what was trimmed, e.g. "lower num_results or max_characters to see more". */
  moreHint: string;
  /** List the URLs of results dropped for length, so the caller can request them separately. */
  listOmittedUrls?: boolean;
}

const CUT_MARKER = " … [cut to fit]";

export function toFormattedResult(result: ExaResult): FormattedResult {
  return {
    title: result.title?.trim() || result.url,
    url: result.url,
    ...(result.publishedDate ? { published_date: result.publishedDate.slice(0, 10) } : {}),
    ...(result.author ? { author: result.author } : {}),
    ...(result.summary ? { summary: result.summary } : {}),
    ...(result.highlights?.length ? { highlights: result.highlights } : {}),
    ...(result.text ? { text: result.text } : {}),
  };
}

export function resultToMarkdown(result: FormattedResult, index: number): string {
  const lines = [`### ${index + 1}. ${result.title}`, `- **URL**: ${result.url}`];
  if (result.published_date) lines.push(`- **Published**: ${result.published_date}`);
  if (result.author) lines.push(`- **Author**: ${result.author}`);
  if (result.summary) lines.push("", `**Summary**: ${result.summary}`);
  if (result.highlights) lines.push("", ...result.highlights.map((h) => `> ${h.replace(/\s+/g, " ").trim()}`));
  if (result.text) lines.push("", result.text.trim());
  return lines.join("\n");
}

/** Cost in dollars, or undefined when Exa did not report one. */
export function costTotal(cost?: ExaCost): number | undefined {
  return typeof cost?.total === "number" ? cost.total : undefined;
}

export function costLine(cost?: number): string {
  return cost === undefined ? "" : `_Exa cost: $${cost.toFixed(4)}_`;
}

/** Cut a string to at most `length` UTF-16 units without splitting a surrogate pair. */
export function safeSlice(value: string, length: number): string {
  if (value.length <= length) return value;
  let cut = Math.max(0, length);
  const last = value.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  return value.slice(0, cut);
}

function addNote(payload: Payload, note: string): Payload {
  const existing = typeof payload.truncation_message === "string" ? `${payload.truncation_message} ` : "";
  return { ...payload, truncated: true, truncation_message: `${existing}${note}` };
}

/** Keep the first `kept` results and explain what was dropped. */
function keepFirst(payload: Payload, kept: number, options: RespondOptions): Payload {
  const all = payload.results ?? [];
  const omitted = all.slice(kept);
  let note = `Showing ${kept} of ${all.length} results to stay under ${CHARACTER_LIMIT} characters; ${options.moreHint}.`;
  if (options.listOmittedUrls && omitted.length) {
    note += ` Not shown: ${omitted.map((r) => r.url).join(", ")}. Request them in a separate call.`;
  }
  return addNote({ ...payload, results: all.slice(0, kept) }, note);
}

/**
 * Shorten the single longest text field (a result's text or summary, or a string answer)
 * by roughly `overflow` characters. Returns undefined when nothing is long enough to cut.
 */
function shortenLongestField(payload: Payload, overflow: number, options: RespondOptions): Payload | undefined {
  type Target = { length: number; apply: (cut: number) => Payload; label: string };
  const targets: Target[] = [];

  const replaceResult = (i: number, next: FormattedResult): Payload => {
    const results = [...(payload.results ?? [])];
    results[i] = next;
    return { ...payload, results };
  };
  (payload.results ?? []).forEach((r, i) => {
    for (const field of ["text", "summary"] as const) {
      const value = r[field];
      if (!value) continue;
      targets.push({
        length: value.length,
        label: `'${r.title}'`,
        apply: (cut) => replaceResult(i, { ...r, [field]: safeSlice(value, cut) + CUT_MARKER }),
      });
    }
    r.highlights?.forEach((value, j) => {
      targets.push({
        length: value.length,
        label: `a highlight from '${r.title}'`,
        apply: (cut) => {
          const highlights = [...(r.highlights ?? [])];
          highlights[j] = safeSlice(value, cut) + CUT_MARKER;
          return replaceResult(i, { ...r, highlights });
        },
      });
    });
  });
  if (typeof payload.answer === "string") {
    const answer = payload.answer;
    targets.push({
      length: answer.length,
      label: "the answer",
      apply: (cut) => ({ ...payload, answer: safeSlice(answer, cut) + CUT_MARKER }),
    });
  }

  const longest = targets.sort((a, b) => b.length - a.length)[0];
  if (!longest || longest.length <= 200) return undefined;
  const cut = Math.max(100, longest.length - overflow - 400);
  const alreadyNoted = String(payload.truncation_message ?? "").includes("was cut to fit");
  const next = longest.apply(cut);
  return alreadyNoted
    ? next
    : addNote(next, `The text of ${longest.label} was cut to fit under ${CHARACTER_LIMIT} characters; ${options.moreHint}.`);
}

/** Drop content fields so only titles, URLs and dates remain. Used only if field shortening could not fit. */
function linksOnly(payload: Payload, options: RespondOptions): Payload {
  const results = payload.results?.map(({ title, url, published_date }) => ({
    title,
    url,
    ...(published_date ? { published_date } : {}),
  }));
  return addNote(
    { ...payload, ...(results ? { results } : {}) },
    `Page content was too long to show within ${CHARACTER_LIMIT} characters, so only links are listed; ${options.moreHint}.`,
  );
}

/**
 * Render a payload as markdown or JSON, keeping the text under CHARACTER_LIMIT.
 * Trimming is applied to the payload itself, so the text and structuredContent always agree
 * and JSON output stays valid: drop whole results from the end, then shorten the longest
 * remaining text field, then (rarely) fall back to links only.
 */
export function respond(
  format: ResponseFormat,
  payload: Payload,
  toMarkdown: (p: Payload) => string,
  options: RespondOptions,
): ToolResult {
  const render = (p: Payload): string => (format === ResponseFormat.JSON ? JSON.stringify(p, null, 2) : toMarkdown(p));

  let current = payload;
  let text = render(current);

  const total = payload.results?.length ?? 0;
  for (let kept = total - 1; text.length > CHARACTER_LIMIT && kept >= 1; kept--) {
    current = keepFirst(payload, kept, options);
    text = render(current);
  }

  for (let attempt = 0; text.length > CHARACTER_LIMIT && attempt < 10; attempt++) {
    const shorter = shortenLongestField(current, text.length - CHARACTER_LIMIT, options);
    if (!shorter) break;
    current = shorter;
    text = render(current);
  }

  if (text.length > CHARACTER_LIMIT) {
    // Start again from every original result: links for all of them beat content for one.
    const links = linksOnly(payload, options);
    current = links;
    text = render(current);
    for (let kept = (links.results?.length ?? 0) - 1; text.length > CHARACTER_LIMIT && kept >= 1; kept--) {
      current = keepFirst(links, kept, options);
      text = render(current);
    }
  }

  if (text.length > CHARACTER_LIMIT) {
    // Only reachable with an enormous structured answer; markdown is the safe last resort.
    const note = `\n\n[Cut at ${CHARACTER_LIMIT} characters.]`;
    text = safeSlice(toMarkdown(current), CHARACTER_LIMIT - note.length) + note;
  }

  return { content: [{ type: "text", text }], structuredContent: current };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
