# exa-mcp-server

A local MCP server that gives Claude live web research through the [Exa](https://exa.ai) search API, using your own Exa API key. It runs on your computer (over stdio), so your key never leaves your machine except in calls to Exa.

## Tools

| Tool | What it does | Typical use |
|------|--------------|-------------|
| `exa_search` | Ranked web search with excerpts, filtered by category, domain and publish date | "Commercial property rate news from the last 90 days", "10-K filings mentioning social inflation" |
| `exa_get_contents` | Reads the text of up to 10 pages (up to 20,000 characters each), with an optional focused summary | Reading a carrier press release, a regulator bulletin, or a PDF report |
| `exa_answer` | Gives a direct answer to a factual question, with numbered source citations | "What was the 2025 Florida reinsurance renewal rate change?" |

All three tools are read-only. Each response shows Exa's cost for that call (for example, `Exa cost: $0.0050`) and is capped at 25,000 characters so it doesn't flood Claude's context.

**Search filters available in `exa_search`:**
- `category`: `news`, `company`, `financial report`, `publication`, `people`, `personal site`
- `include_domains` / `exclude_domains`, e.g. `["naic.org", "sec.gov", "iii.org"]`
- `start_published_date` / `end_published_date`, e.g. `2026-01-01`
- `content_mode`: `highlights` (default), full `text`, or `none` (titles and links only)

Exa does not allow date filters or `exclude_domains` with the `company` or `people` categories. The server explains this instead of failing.

## Setup

### 1. Get an Exa API key
Create one at https://dashboard.exa.ai/api-keys.

### 2. Build the server
Requires Node.js 18 or later.

```bash
cd exa-mcp-server
npm install
npm run build
```

### 3. Connect it to Claude

**Claude Code** (run once; replace the key and path):

```bash
claude mcp add exa-local -e EXA_API_KEY=your-key-here -- node /full/path/to/exa-mcp-server/dist/index.js
```

**Claude Desktop**: open *Settings → Developer → Edit Config* and add this to `claude_desktop_config.json`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "exa-local": {
      "command": "node",
      "args": ["/full/path/to/exa-mcp-server/dist/index.js"],
      "env": { "EXA_API_KEY": "your-key-here" }
    }
  }
}
```

If `EXA_API_KEY` is missing or was pasted with stray spaces or quotes, Claude reports it with setup instructions the first time it uses a tool.

## Example prompts

- "Use exa_search for news in the last 90 days on commercial property rate changes for mid-market accounts, and summarize the trend with sources."
- "Search sec.gov financial reports from 2026 that discuss reserve strengthening for commercial auto, then read the two most relevant filings."
- "Use exa_answer: when does the next federal terrorism insurance (TRIA) reauthorization deadline fall? Cite sources."
- "Read this bulletin and summarize what it means for our contractor clients: <URL>"

## Configuration

| Variable | Required | Purpose |
|----------|----------|---------|
| `EXA_API_KEY` | Yes | Your Exa API key |
| `EXA_BASE_URL` | No | Override the API address (default `https://api.exa.ai`); only needed for testing |

## Troubleshooting

| Message | Meaning |
|---------|---------|
| `Exa rejected the API key (401)` | The key is wrong or revoked; check it in the dashboard |
| `out of credits or over its budget (402)` | Add credits at https://dashboard.exa.ai |
| `rate limit reached (429)` | Too many calls at once; wait a few seconds |
| `Could not reach Exa` | No network connection, or a proxy is blocking api.exa.ai |

## Evaluation

`evaluation.xml` holds 10 research questions with verified answers about the insurance industry (in the format the mcp-builder skill uses). Use them to check that Claude can use this server to research end to end.

## Development

```bash
npm run build   # compile TypeScript to dist/
npm run dev     # run from source with tsx
npm test        # build, then run the offline end-to-end tests (no Exa key or network needed)
```

The tests in `test/` start a local stub of the Exa API and drive the built server through a real MCP client: request bodies, every error status, truncation, date validation, and that the API key never appears in output.

Source layout: `src/index.ts` (startup), `src/tools/` (one file per tool), `src/services/exa-client.ts` (HTTP calls and error messages), `src/services/format.ts` (output formatting and truncation), `src/schemas.ts` (input and output schemas).
