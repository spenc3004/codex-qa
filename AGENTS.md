# codex-test service

This service exposes a PDF QA API that checks expiration dates and spelling.

## Purpose

- Accept a PDF and `input_date` (YYYY-MM-DD).
- Extract expiration dates/phrases + page text from the PDF.
- Run expiration and spelling QA using Codex SDK.
- Run deterministic date validation:
  - expiration must be in the future
  - expiration must be at least 28 days after `input_date`
- Return a consolidated QA report.

## Endpoints

- `GET /` -> service info
- `GET /health` -> health check
- `POST /qa` -> run QA

## POST /qa input modes

Use one of:

1. `multipart/form-data`
- `pdf` file field
- `input_date` text field

2. JSON body with path (local testing)
- `pdf_path` absolute/relative path to a PDF readable by server
- `input_date`

3. JSON body with base64
- `pdf_base64` base64 content (optionally data URL prefixed)
- `input_date`
- optional `filename`, `mime_type`

## Pipeline behavior

1. Upload PDF to OpenAI Files API (`purpose: user_data`).
2. Run Responses API extraction with strict JSON schema (OCR + page text extraction).
3. Pass extracted page text to Codex SDK for:
   - expiration item detection (dates/phrases)
   - spelling report
4. Run deterministic date checks in server code.
5. Delete temporary OpenAI file.

## Environment variables

- `OPENAI_API_KEY` (required)
- `EXTRACTION_MODEL` (optional, default: `gpt-5.2`)
- `CODEX_MODEL` (optional; if omitted Codex CLI default is used)
- `CODEX_API_KEY` (optional; falls back to `OPENAI_API_KEY`)
- `PORT` (optional, default: `3000`)

## Development

- Install deps: `npm install`
- Start server: `npm run start`
- Dev mode: `npm run devStart`

## Notes

- Keep the deterministic date logic in server code; do not move it into model-only logic.
- Keep schema contracts strict for both extraction and spelling stages.
- Keep prompt files in `prompts/` as the editable source of model behavior.
