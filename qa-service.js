import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Codex } from '@openai/codex-sdk';
import {
    differenceInDays,
    isValid,
    parseISO,
    startOfDay,
} from 'date-fns';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);
const OCR_ENGINE = 'ocrmypdf';

const spellingPrompt = fs
    .readFileSync(path.join(__dirname, 'prompts', 'spelling_prompt.txt'), 'utf8')
    .trim();

const expirationPrompt = fs
    .readFileSync(path.join(__dirname, 'prompts', 'expiration_prompt.txt'), 'utf8')
    .trim();

const EXPIRATION_ITEM_SCHEMA_ANYOF = [
    {
        type: 'object',
        additionalProperties: false,
        required: [
            'expiration_phrase',
            'date_iso',
            'raw_text',
            'page',
            'label',
            'assumptions',
            'confidence',
        ],
        properties: {
            expiration_phrase: { type: 'boolean', enum: [false] },
            date_iso: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            raw_text: { type: 'string' },
            page: { type: 'integer', minimum: 1 },
            label: { type: 'string' },
            assumptions: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
    },
    {
        type: 'object',
        additionalProperties: false,
        required: [
            'expiration_phrase',
            'raw_text',
            'page',
            'label',
            'assumptions',
            'confidence',
        ],
        properties: {
            expiration_phrase: { type: 'boolean', enum: [true] },
            raw_text: { type: 'string' },
            page: { type: 'integer', minimum: 1 },
            label: { type: 'string' },
            assumptions: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
    },
];

const EXPIRATION_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['found_expiration_dates', 'warnings'],
    properties: {
        found_expiration_dates: {
            type: 'array',
            items: {
                anyOf: EXPIRATION_ITEM_SCHEMA_ANYOF,
            },
        },
        warnings: {
            type: 'array',
            items: { type: 'string' },
        },
    },
};

const SPELLING_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['spelling_issues', 'warnings'],
    properties: {
        spelling_issues: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['issue_text', 'suggestion', 'page', 'context_snippet', 'severity'],
                properties: {
                    issue_text: { type: 'string' },
                    suggestion: { type: 'string' },
                    page: { type: 'integer', minimum: 1 },
                    context_snippet: { type: 'string' },
                    severity: { type: 'string', enum: ['definite', 'maybe'] },
                },
            },
        },
        warnings: {
            type: 'array',
            items: { type: 'string' },
        },
    },
};

function ensureCodexApiKey() {
    if (!process.env.CODEX_API_KEY && !process.env.OPENAI_API_KEY) {
        throw new Error('Missing CODEX_API_KEY or OPENAI_API_KEY.');
    }
}

function parseJSONOrThrow(raw, contextLabel) {
    if (typeof raw !== 'string' || !raw.trim()) {
        throw new Error(`${contextLabel} did not return JSON text.`);
    }

    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(`${contextLabel} returned invalid JSON: ${error.message}`);
    }
}

function parsePositiveInteger(rawValue, fallbackValue) {
    const parsed = Number.parseInt(String(rawValue ?? ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function sanitizeTemporaryFilename(filename) {
    const baseName = path.basename(filename || 'upload.pdf');
    const sanitized = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!sanitized) {
        return 'upload.pdf';
    }

    if (sanitized.toLowerCase().endsWith('.pdf')) {
        return sanitized;
    }

    return `${sanitized}.pdf`;
}

function buildOcrArguments(inputPath, sidecarPath) {
    const args = [
        '--quiet',
        '--output-type',
        'none',
        '--sidecar',
        sidecarPath,
        '--mode',
        'force',
        '--rotate-pages',
        '--deskew',
        '--jobs',
        String(parsePositiveInteger(process.env.OCR_JOBS, 1)),
    ];

    const languages = typeof process.env.OCR_LANGUAGES === 'string'
        ? process.env.OCR_LANGUAGES.trim()
        : '';

    if (languages) {
        args.push('--language', languages);
    }

    args.push(inputPath, '-');

    return args;
}

function convertSidecarTextToPages(sidecarText) {
    if (typeof sidecarText !== 'string' || !sidecarText.length) {
        return [];
    }

    const normalized = sidecarText.replace(/\r\n?/g, '\n');
    const rawPages = normalized.split('\f');

    while (rawPages.length > 1 && rawPages.at(-1) === '') {
        rawPages.pop();
    }

    return rawPages.map((pageText, index) => ({
        page: index + 1,
        lines: pageText
            .split('\n')
            .map((line) => line.trimEnd())
            .filter((line) => line.trim().length > 0),
    }));
}

export async function extractPdfTextLocally({
    pdfBuffer,
    filename = 'upload.pdf',
}) {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-test-ocr-'));
    const inputPath = path.join(tempDir, sanitizeTemporaryFilename(filename));
    const sidecarPath = path.join(tempDir, 'ocr-output.txt');
    const timeoutMs = parsePositiveInteger(process.env.OCR_TIMEOUT_MS, 120000);

    try {
        await fsp.writeFile(inputPath, pdfBuffer);
        await execFileAsync('ocrmypdf', buildOcrArguments(inputPath, sidecarPath), {
            maxBuffer: 10 * 1024 * 1024,
            timeout: timeoutMs,
        });

        const sidecarText = await fsp.readFile(sidecarPath, 'utf8').catch((error) => {
            if (error?.code === 'ENOENT') {
                return '';
            }

            throw error;
        });

        const pages = convertSidecarTextToPages(sidecarText);
        const warnings = [];

        if (pages.length === 0) {
            warnings.push('OCR produced no text.');
        } else if (pages.every((page) => page.lines.length === 0)) {
            warnings.push('OCR completed but no readable text was extracted.');
        }

        return {
            found_expiration_dates: [],
            extracted_text: {
                pages,
            },
            warnings,
        };
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new Error('ocrmypdf is not installed or not available on PATH.');
        }

        const timeoutMessage = error?.killed
            ? `Local OCR timed out after ${timeoutMs}ms.`
            : '';
        const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
        const detail = timeoutMessage || stderr || error?.message || String(error);

        throw new Error(`Local OCR extraction failed: ${detail}`);
    } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
    }
}

function createCodexThread() {
    const codex = new Codex({
        apiKey: process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY,
    });

    return codex.startThread({
        workingDirectory: process.cwd(),
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
        sandboxMode: 'read-only',
        networkAccessEnabled: false,
        webSearchMode: 'disabled',
        modelReasoningEffort: 'low',
        model: process.env.CODEX_MODEL || undefined,
    });
}

async function runCodexAnalysis(extractedTextPayload) {
    const thread = createCodexThread();

    const expirationTurn = await thread.run(
        [
            expirationPrompt,
            '',
            'Input JSON:',
            JSON.stringify(extractedTextPayload),
        ].join('\n'),
        {
            outputSchema: EXPIRATION_SCHEMA,
        },
    );

    const spellingTurn = await thread.run(
        [
            spellingPrompt,
            '',
            'Input JSON:',
            JSON.stringify(extractedTextPayload),
        ].join('\n'),
        {
            outputSchema: SPELLING_SCHEMA,
        },
    );

    return {
        threadId: thread.id,
        expiration: parseJSONOrThrow(expirationTurn.finalResponse, 'Codex expiration stage'),
        spelling: parseJSONOrThrow(spellingTurn.finalResponse, 'Codex spelling stage'),
    };
}

function validateDates(spelling, foundDates, inputDateISO) {
    const inputDate = parseISO(inputDateISO);
    if (!isValid(inputDate)) {
        return { ok: false, message: 'Invalid input date; expected YYYY-MM-DD format.' };
    }

    const today = startOfDay(new Date());
    const spellingIssuesRaw = spelling?.spelling_issues ?? [];
    const spellingIssues = Array.isArray(spellingIssuesRaw)
        ? spellingIssuesRaw
        : [spellingIssuesRaw].filter(Boolean);
    const hasSpellingIssues = spellingIssues.length > 0;
    const spellingIssuesMessage = hasSpellingIssues
        ? `Spelling issues detected: ${spellingIssues.map((issue) => issue?.issue_text ?? String(issue)).join('; ')}`
        : '';

    const checks = (foundDates ?? []).map((d) => {
        if (d.expiration_phrase === true) {
            const reasons = ['Explicit expiration phrase detected in text'];
            let status = 'pass_expiration_phrase';

            if (hasSpellingIssues) {
                status = 'fail_spelling_issues';
                reasons.push(spellingIssuesMessage);
            }

            return {
                ...d,
                days_from_today: null,
                days_after_input: null,
                status,
                reasons,
            };
        }

        const exp = parseISO(d.date_iso);
        const valid = isValid(exp);
        const reasons = [];

        if (!valid) {
            let status = 'fail_invalid_date';
            reasons.push('Invalid date format');

            if (hasSpellingIssues) {
                status = 'fail_spelling_issues';
                reasons.push(spellingIssuesMessage);
            }

            return { ...d, status, details: 'Invalid date format', reasons };
        }

        const daysFromToday = differenceInDays(exp, today);
        const daysAfterInput = differenceInDays(exp, inputDate);

        const inFuture = daysFromToday > 0;
        const atLeast4WeeksAfterInput = daysAfterInput >= 28;

        let status = 'pass';

        if (!inFuture) {
            status = 'fail_not_in_future';
            reasons.push(`Expiration date is not in the future (days from today: ${daysFromToday})`);
        }
        if (!atLeast4WeeksAfterInput) {
            status = 'fail_too_close_to_input';
            reasons.push(`Expiration date is not at least 4 weeks after input date (${inputDateISO}) (days after input date: ${daysAfterInput})`);
        }
        if (hasSpellingIssues) {
            status = 'fail_spelling_issues';
            reasons.push(spellingIssuesMessage);
        }

        return {
            ...d,
            days_from_today: daysFromToday,
            days_after_input: daysAfterInput,
            status,
            reasons,
        };
    });

    const noDatesFound = checks.length === 0;
    const anyFail = hasSpellingIssues || checks.some((c) => c.status !== 'pass' && c.status !== 'pass_expiration_phrase');
    const ok = !anyFail;

    return {
        ok,
        summary: {
            total_expiration_dates: checks.length,
            no_dates_found: noDatesFound,
            any_fail: anyFail,
            spelling_issues_count: spellingIssues.length,
        },
        reasons: hasSpellingIssues ? [spellingIssuesMessage] : [],
        checks,
    };
}

export async function runQaReport({
    pdfBuffer,
    filename = 'upload.pdf',
    inputDateISO,
}) {
    ensureCodexApiKey();

    const extracted = await extractPdfTextLocally({
        pdfBuffer,
        filename,
    });
    const extractedText = { pages: extracted?.extracted_text?.pages ?? [] };

    const {
        expiration: codexExpiration,
        spelling,
        threadId,
    } = await runCodexAnalysis(extractedText);
    const deterministic = validateDates(spelling, codexExpiration?.found_expiration_dates, inputDateISO);

    return {
        ok: deterministic.ok,
        input_date: inputDateISO,
        extraction_model: OCR_ENGINE,
        codex_model: process.env.CODEX_MODEL || null,
        codex_thread_id: threadId,
        extracted,
        codex_expiration: codexExpiration,
        spelling,
        deterministic,
    };
}
