# codex-test

`codex-test` is a local Express service that accepts a PDF and an `input_date`, extracts artwork text with local OCR, detects expiration dates and phrases, runs spelling QA, and returns a consolidated QA report.

## What It Does

- Accepts a PDF plus `input_date` in `YYYY-MM-DD` format.
- Extracts page text from the PDF locally with `ocrmypdf`.
- Uses the Codex SDK to:
  - detect expiration-related dates and phrases from the extracted text
  - run spelling QA on the extracted text
- Runs deterministic validation in server code:
  - expiration must be in the future
  - expiration must be at least 28 days after `input_date`
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
OPENAI_API_KEY=your-api-key-here
# Optional:
# CODEX_API_KEY=your-api-key-here
# CODEX_MODEL=gpt-5-codex
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
http://localhost:3000
```

## Endpoints

- `GET /`
  - Basic service info.
- `GET /health`
  - Health check endpoint.
- `POST /qa`
  - Runs the full PDF QA pipeline.

## POST /qa Input Modes

The service supports three input modes.

### 1. Multipart Upload

Send the actual PDF file in the request.

Form fields:

- `input_date`
- `pdf`

Use this when the client should upload the file bytes directly.

### 2. JSON Path Mode

Send a JSON body with a local file path.

```json
{
  "input_date": "2026-04-15",
  "pdf_path": "/absolute/path/to/file.pdf"
}
```

Use this only when the server process can read that file path on the same machine.

### 3. JSON Base64 Mode

Send a JSON body with a base64-encoded PDF. The `pdf_base64` value may be raw base64 or a data URL.

```json
{
  "input_date": "2026-04-15",
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

Use `Health` first to confirm the server is running.

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

Health check:

```bash
curl http://localhost:3000/health
```

Path mode:

```bash
curl -X POST http://localhost:3000/qa \
  -H "Content-Type: application/json" \
  -d '{
    "input_date": "2026-04-15",
    "pdf_path": "/absolute/path/to/file.pdf"
  }'
```

Multipart mode:

```bash
curl -X POST http://localhost:3000/qa \
  -F "input_date=2026-04-15" \
  -F "pdf=@/absolute/path/to/file.pdf"
```

## Response Shape

The `POST /qa` response includes:

- `input_date`
- `request_source`
- `codex_thread_id`
- `report`

`report` contains the final pass/fail logic and date validation details:

- `pass`
- `summary`
- `expiration_details`
- `spelling_details`

`report.summary` contains:

- `total_expiration_dates`
- `no_dates_found`
- `any_fail`
- `spelling_issues_count`
- `reasons`

`report.summary.reasons` aggregates unique reasons from the expiration and spelling evaluation so callers do not need to inspect each item to understand the overall outcome.

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
