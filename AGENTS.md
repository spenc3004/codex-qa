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

1. Write the uploaded PDF to a temporary local file.
2. Run `ocrmypdf` locally in force mode to OCR every page and emit sidecar text.
3. Normalize OCR sidecar text into page-based `lines[]` payloads.
4. Pass extracted page text to Codex SDK for:
   - expiration item detection (dates/phrases)
   - spelling report
5. Run deterministic date checks in server code.
6. Delete temporary local OCR files.

## Environment variables

- `OPENAI_API_KEY` or `CODEX_API_KEY` (one required)
- `CODEX_MODEL` (optional; if omitted Codex CLI default is used)
- `OCR_LANGUAGES` (optional; example: `eng` or `eng+spa`)
- `OCR_JOBS` (optional; default: `1`)
- `OCR_TIMEOUT_MS` (optional; default: `120000`)
- `PORT` (optional, default: `3000`)

## Development

- Install deps: `npm install`
- Start server: `npm run start`
- Dev mode: `npm run devStart`

## Notes

- Keep the deterministic date logic in server code; do not move it into model-only logic.
- Keep schema contracts strict for the expiration and spelling stages.
- Keep runtime model behavior editable in `prompts/expiration_prompt.txt` and `prompts/spelling_prompt.txt`.
- The OCR stage is local and does not use the OpenAI Files API or Responses API.
