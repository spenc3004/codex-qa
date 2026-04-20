# codex-qa

`codex-qa` is a local Express service that accepts a PDF, an `input_date`, and a `noTagline` flag, extracts artwork text with local OCR, detects expiration dates and phrases, runs spelling QA, and returns a consolidated QA report.

## What It Does

- Accepts a PDF plus `input_date` in `YYYY-MM-DD` format and required `noTagline` boolean input.
- Extracts page text from the PDF locally with `ocrmypdf`.
- Uses the Codex SDK to:
  - detect expiration-related dates and phrases from the extracted text
  - run spelling QA on the extracted text
- Runs deterministic validation in server code:
  - expiration must be in the future
  - expiration must be at least 28 days after `input_date`
  - Mail Shark tagline presence must match the `noTagline` flag
- Returns a JSON QA report.

## Requirements

- Node.js 18+
- `ocrmypdf` installed and available on `PATH`
- Tesseract OCR and Ghostscript available on `PATH` via your `ocrmypdf` install
- A Codex-compatible API key via `OPENAI_API_KEY` or `CODEX_API_KEY`

## Setup

After cloning the repository:

```bash
cd codex-test
npm install
```

Create or update `.env`:

```env
PORT=3000
HOST=127.0.0.1
OPENAI_API_KEY=your-api-key-here
# Optional:
# CODEX_API_KEY=your-api-key-here
# CODEX_MODEL=gpt-5-codex
# SERVICE_API_KEY=replace-with-a-shared-secret
# TRUST_PROXY=false
# ALLOW_PDF_PATH=false
# PDF_INPUT_ROOT=/absolute/path/for/local-test-pdfs
# MAX_PDF_BYTES=10485760
# MAX_QA_CONCURRENCY=2
# RATE_LIMIT_PER_MINUTE=10
# JSON_BODY_LIMIT=15mb
# OCR_LANGUAGES=eng
# OCR_JOBS=1
# OCR_TIMEOUT_MS=120000
```

## Running The Service

Start normally:

```bash
npm run start
```

Start with auto-reload during development:

```bash
npm run devStart
```

By default the service listens on:

```text
http://127.0.0.1:3000
```

`HOST` controls which network interface the Node process binds to. The default `127.0.0.1` keeps the service local-only, which is the safest default for development.

## Endpoints

- `GET /`
  - Basic service info and a simple liveness check.
- `POST /qa`
  - Runs the full PDF QA pipeline.

## POST /qa Input Modes

The service supports three input modes.

### 1. Multipart Upload

Send the actual PDF file in the request.

Form fields:

- `input_date`
- `noTagline`
- `pdf`

Use this when the client should upload the file bytes directly.

### 2. JSON Path Mode

Send a JSON body with a local file path.

```json
{
  "input_date": "2026-04-15",
  "noTagline": false,
  "pdf_path": "/absolute/path/to/file.pdf"
}
```

Use this only when the server process can read that file path on the same machine. This mode is disabled unless `ALLOW_PDF_PATH=true`, and the resolved path must stay inside `PDF_INPUT_ROOT`.

### 3. JSON Base64 Mode

Send a JSON body with a base64-encoded PDF. The `pdf_base64` value may be raw base64 or a data URL.

```json
{
  "input_date": "2026-04-15",
  "noTagline": false,
  "filename": "sample.pdf",
  "mime_type": "application/pdf",
  "pdf_base64": "<base64 string>"
}
```

## Bruno Requests

The repo includes a Bruno collection in:

- [bruno/opencollection.yml](bruno/opencollection.yml)

Available requests:

- [bruno/Health.yml](bruno/Health.yml)
- [bruno/QA Report (Path).yml](bruno/QA%20Report%20(Path).yml)
- [bruno/QA Report (Multipart).yml](bruno/QA%20Report%20(Multipart).yml)

### How To Use The Bruno Requests

Open the `bruno` folder in Bruno:

```text
bruno
```

Use `GET /` first to confirm the server is running.

Use `QA Report (Path)` when:

- Bruno and the server are both running on your local machine
- the server can read the file path directly

Before sending, update the `pdf_path` field in [bruno/QA Report (Path).yml](bruno/QA%20Report%20(Path).yml) or override it in Bruno.

Use `QA Report (Multipart)` when:

- you want Bruno to upload the PDF file itself
- the server is not guaranteed to have direct filesystem access to the file

Before sending, update the file entry in [bruno/QA Report (Multipart).yml](bruno/QA%20Report%20(Multipart).yml) to your PDF path.

The multipart request uses Bruno's file-list shape, so the `pdf` field is stored as an array even for a single file.

## curl Examples

Basic info:

```bash
curl http://127.0.0.1:3000/
```

Path mode:

```bash
curl -X POST http://localhost:3000/qa \
  -H "Content-Type: application/json" \
  -d '{
    "input_date": "2026-04-15",
    "noTagline": false,
    "pdf_path": "/absolute/path/to/file.pdf"
  }'
```

Multipart mode:

```bash
curl -X POST http://localhost:3000/qa \
  -F "input_date=2026-04-15" \
  -F "noTagline=false" \
  -F "pdf=@/absolute/path/to/file.pdf"
```

With API key protection enabled:

```bash
curl -X POST http://localhost:3000/qa \
  -H "x-api-key: $SERVICE_API_KEY" \
  -F "input_date=2026-04-15" \
  -F "noTagline=false" \
  -F "pdf=@/absolute/path/to/file.pdf"
```

## Security And Deployment

The server includes a few security controls in code today:

- The process binds to `HOST`, which defaults to `127.0.0.1`.
- `POST /qa` can require `x-api-key` when `SERVICE_API_KEY` is set.
- Requests are rate-limited with `RATE_LIMIT_PER_MINUTE`.
- JSON and upload sizes are capped with `JSON_BODY_LIMIT` and `MAX_PDF_BYTES`.
- `pdf_path` mode is opt-in and constrained to `PDF_INPUT_ROOT`.

### Local Development

Use the default bind address:

```env
HOST=127.0.0.1
```

This means only processes on the same machine can reach the service. Other servers cannot call it directly.

### Internal Server-To-Server Deployment

If this service runs on its own server and needs to accept calls from other servers, bind it to a reachable private interface:

```env
HOST=0.0.0.0
SERVICE_API_KEY=replace-with-a-shared-secret
```

When deployed this way:

- Prefer a private network or private subnet over public internet exposure.
- Restrict inbound access with firewall rules or security groups so only known callers can connect.
- Keep `SERVICE_API_KEY` enabled and require callers to send `x-api-key`.
- Leave `ALLOW_PDF_PATH=false` unless you explicitly need local path testing on that host.

### Reverse Proxy Deployment

If you put Nginx, Caddy, or a load balancer in front of the app, you can keep Node bound to loopback:

```env
HOST=127.0.0.1
TRUST_PROXY=true
```

Only set `TRUST_PROXY=true` when the app is actually behind a trusted reverse proxy that you control. Do not enable it on a directly exposed Node process.

### Host Allowlists

An HTTP host allowlist can be useful as defense in depth at the reverse proxy or load balancer layer, but it should not be treated as the primary authorization control for this service.

Use it to reject unexpected hostnames. Do not rely on it instead of:

- network restrictions
- API key enforcement
- private deployment boundaries

## Configuration Reference

Security and request handling:

- `HOST`: interface/address to bind the server to. Default: `127.0.0.1`.
- `PORT`: HTTP port. Default: `3000`.
- `SERVICE_API_KEY`: when set, `POST /qa` requires `x-api-key` to match.
- `TRUST_PROXY`: set to `true` only behind a trusted reverse proxy.
- `ALLOW_PDF_PATH`: enables `pdf_path` JSON mode. Default: `false`.
- `PDF_INPUT_ROOT`: base directory used to constrain `pdf_path`. Default: current working directory.
- `MAX_PDF_BYTES`: max upload size in bytes. Default: `10485760` (10 MiB).
- `MAX_QA_CONCURRENCY`: max concurrent QA jobs in process. Default: `2`.
- `RATE_LIMIT_PER_MINUTE`: per-IP request cap for `POST /qa`. Default: `10`.
- `JSON_BODY_LIMIT`: Express JSON body size limit. Default: `15mb`.

Model and OCR:

- `OPENAI_API_KEY` or `CODEX_API_KEY`: one is required.
- `CODEX_MODEL`: optional model override for the Codex SDK call.
- `OCR_LANGUAGES`: OCR language pack string such as `eng` or `eng+spa`.
- `OCR_JOBS`: OCR worker count.
- `OCR_TIMEOUT_MS`: timeout for the OCR stage in milliseconds.

## Response Shape

The `POST /qa` response includes:

- `input_date`
- `noTagline`
- `request_source`
- `codex_thread_ids`
- `warnings`
- `report`

`report` contains the final pass/fail logic and date validation details:

- `pass`
- `summary`
- `tagline_check`
- `expiration_details`
- `spelling_details`

`report.summary` contains:

- `total_expiration_dates`
- `no_dates_found`
- `any_fail`
- `spelling_issues_count`
- `reasons`

`report.summary.reasons` aggregates unique reasons from the expiration, spelling, and tagline evaluation so callers do not need to inspect each item to understand the overall outcome.

`report.tagline_check` contains the deterministic Mail Shark tagline validation, including:

- `status`
- `no_tagline_requested`
- `tagline_found`
- `searched_text`
- `matching_pages`
- `reason`

`report.expiration_details` contains one entry per expiration match returned by the expiration stage. Each entry includes the source fields from detection, plus deterministic validation fields such as:

- `is_expiration_phrase`
- `date_iso` for explicit dates
- `page`
- `raw_text`
- `days_from_today`
- `days_after_input`
- `status`

The `page` and `raw_text` fields are included to help locate the expiration item in the original PDF.

`report.spelling_details` contains the spelling issues returned by the spelling stage, including fields such as:

- `page`
- `context_snippet`
- `issue_text`
- `suggestion`
- `severity`

The `page` and `context_snippet` fields are included to help locate the spelling issue in the original PDF.

## Implementation Notes

- Main server entrypoint: [server.js](server.js)
- QA pipeline: [qa-service.js](qa-service.js)
- Project guidance: [AGENTS.md](AGENTS.md)
- Bruno collection: [bruno/opencollection.yml](bruno/opencollection.yml)
- Prompts:
  - [prompts/expiration_prompt.txt](prompts/expiration_prompt.txt)
  - [prompts/spelling_prompt.txt](prompts/spelling_prompt.txt)
