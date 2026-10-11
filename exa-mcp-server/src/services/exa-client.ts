import { EXA_BASE_URL, REQUEST_TIMEOUT_MS } from "../constants.js";

/** An Exa API failure, carrying a message written for the model to act on. */
export class ExaApiError extends Error {}

/** Read and sanity-check the key. Never include the key itself in any message. */
function apiKey(): string {
  const key = process.env.EXA_API_KEY?.trim();
  if (!key) {
    throw new ExaApiError(
      "Error: EXA_API_KEY is not set. Add your key (https://dashboard.exa.ai/api-keys) to this MCP server's configuration and restart Claude.",
    );
  }
  if (!/^[\x21-\x7E]+$/.test(key)) {
    throw new ExaApiError(
      "Error: EXA_API_KEY contains characters an API key cannot have (spaces, line breaks, curly quotes or invisible characters, usually from copy-paste). " +
        "Re-copy it from https://dashboard.exa.ai/api-keys into this server's configuration and restart Claude.",
    );
  }
  return key;
}

function describeFailure(status: number, detail: string): string {
  const suffix = detail ? ` Exa said: ${detail}` : "";
  switch (status) {
    case 400:
      return `Error: Exa rejected the request (400).${suffix} Adjust the parameters and try again.`;
    case 401:
      return "Error: Exa rejected the API key (401). Check that EXA_API_KEY is correct (https://dashboard.exa.ai/api-keys).";
    case 402:
      return `Error: The Exa account is out of credits or over its budget (402).${suffix} Top up at https://dashboard.exa.ai.`;
    case 403:
      return `Error: This Exa key is not allowed to use that feature (403).${suffix}`;
    case 429:
      return "Error: Exa rate limit reached (429). Wait a few seconds, then retry with fewer parallel requests.";
    default:
      return status >= 500
        ? `Error: Exa is temporarily unavailable (${status}). Retry shortly.${suffix}`
        : `Error: Exa request failed with status ${status}.${suffix}`;
  }
}

/** Turn a fetch/body-read failure into an actionable message, surfacing the underlying network cause. */
function describeNetworkError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return `Error: Exa did not respond within ${timeoutMs / 1000}s. Retry, or ask for fewer results.`;
  }
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : "";
  if (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code)) {
    return (
      `Error: Could not make a secure connection to Exa (${code}). Your network appears to inspect HTTPS traffic (for example a corporate proxy). ` +
      "Ask IT for the company root certificate, set NODE_EXTRA_CA_CERTS=/path/to/cert.pem in this server's environment, and restart Claude."
    );
  }
  const reason =
    code ||
    (typeof cause?.message === "string" ? cause.message : "") ||
    (error instanceof Error ? error.message : String(error));
  return `Error: Could not reach Exa at ${EXA_BASE_URL} (${reason}). Check the internet connection or firewall, then retry.`;
}

/** POST a JSON body to an Exa endpoint and return the parsed response. */
export async function exaPost<T>(
  path: string,
  body: Record<string, unknown>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const key = apiKey();
  let response: Response;
  let raw: string;
  try {
    response = await fetch(`${EXA_BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    raw = await response.text();
  } catch (error) {
    throw new ExaApiError(describeNetworkError(error, timeoutMs));
  }

  if (!response.ok) {
    // Redact before any slicing, so a key that straddles the excerpt boundary cannot leak in part.
    const clean = raw.split(key).join("[redacted]");
    let detail = clean.slice(0, 500);
    try {
      const parsed = JSON.parse(clean) as { error?: unknown };
      if (typeof parsed.error === "string") detail = parsed.error.slice(0, 500);
    } catch {
      // Non-JSON error body: keep the raw excerpt.
    }
    throw new ExaApiError(describeFailure(response.status, detail));
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ExaApiError("Error: Exa returned a response that was not valid JSON. Retry the request.");
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ExaApiError) return error.message;
  return `Error: Unexpected failure: ${error instanceof Error ? error.message : String(error)}`;
}
