export const SERVER_NAME = "exa-mcp-server";
export const SERVER_VERSION = "1.0.0";

/** Overridable so the server can be pointed at a local stub for testing. */
export const EXA_BASE_URL = (process.env.EXA_BASE_URL ?? "https://api.exa.ai").replace(/\/+$/, "");

/** Maximum characters returned to the model in a single tool response. */
export const CHARACTER_LIMIT = 25_000;

export const REQUEST_TIMEOUT_MS = 60_000;
export const ANSWER_TIMEOUT_MS = 120_000;
