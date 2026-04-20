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
const MAIL_SHARK_TAGLINE = '©Mail Shark® www.GoMailShark.com 484-652-7990';
const MAIL_SHARK_TAGLINE_OCR_WARNING = 'No text detected by OCR cannot confirm check for Mail Shark tagline presence';

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
            'is_expiration_phrase',
            'date_iso',
            'raw_text',
            'page',
            'assumptions',
            'confidence',
        ],
        properties: {
            is_expiration_phrase: { type: 'boolean', enum: [false] },
            date_iso: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            raw_text: { type: 'string' },
            page: { type: 'integer', minimum: 1 },
            assumptions: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
    },
    {
        type: 'object',
        additionalProperties: false,
        required: [
            'is_expiration_phrase',
            'raw_text',
            'page',
            'assumptions',
            'confidence',
        ],
        properties: {
            is_expiration_phrase: { type: 'boolean', enum: [true] },
            raw_text: { type: 'string' },
            page: { type: 'integer', minimum: 1 },
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
        const hasReadableOcrText = pages.some((page) => page.lines.length > 0);

        if (pages.length === 0) {
            warnings.push('OCR produced no text.');
            warnings.push(MAIL_SHARK_TAGLINE_OCR_WARNING);
        } else if (!hasReadableOcrText) {
            warnings.push('OCR completed but no readable text was extracted.');
            warnings.push(MAIL_SHARK_TAGLINE_OCR_WARNING);
        }

        return {
            found_expiration_dates: [],
            extracted_text: {
                pages,
            },
            ocr_text: sidecarText,
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
    const expirationThread = createCodexThread();
    const spellingThread = createCodexThread();

    const expirationInput = [
        expirationPrompt,
        '',
        'Input JSON:',
        JSON.stringify(extractedTextPayload),
    ].join('\n');

    const spellingInput = [
        spellingPrompt,
        '',
        'Input JSON:',
        JSON.stringify(extractedTextPayload),
    ].join('\n');

    const [expirationTurn, spellingTurn] = await Promise.all([
        expirationThread.run(expirationInput, {
            outputSchema: EXPIRATION_SCHEMA,
        }),
        spellingThread.run(spellingInput, {
            outputSchema: SPELLING_SCHEMA,
        }),
    ]);

    return {
        threadIds: {
            expiration: expirationThread.id,
            spelling: spellingThread.id,
        },
        expiration: parseJSONOrThrow(expirationTurn.finalResponse, 'Codex expiration stage'),
        spelling: parseJSONOrThrow(spellingTurn.finalResponse, 'Codex spelling stage'),
    };
}


function validateDates({
    spelling,
    foundDates,
    inputDateISO,
    noTagline,
    ocrText,
    pages,
}) {
    const taglineCheck = buildTaglineCheck({
        noTagline,
        ocrText,
        pages,
    });
    const inputDate = parseISO(inputDateISO);
    if (!isValid(inputDate)) {
        return buildInvalidInputDateResult(taglineCheck);
    }

    const today = startOfDay(new Date());
    const spellingContext = getSpellingContext(spelling);

    const evaluations = (foundDates ?? []).map((item) =>
        evaluateFoundDate(item, {
            today,
            inputDate,
            inputDateISO,
            spellingContext,
        }),
    );

    return buildValidationReport({
        evaluations,
        spellingIssues: spellingContext.issues,
        spellingIssuesMessage: spellingContext.message,
        taglineCheck,
    });
}

function buildInvalidInputDateResult(taglineCheck) {
    const message = 'Invalid input date; expected YYYY-MM-DD format.';
    const reasons = [
        message,
        ...(taglineCheck?.reason ? [taglineCheck.reason] : []),
    ];

    return {
        pass: false,
        summary: {
            total_expiration_dates: 0,
            no_dates_found: true,
            any_fail: true,
            spelling_issues_count: 0,
            reasons,
        },
        tagline_check: taglineCheck,
        expiration_details: [],
        spelling_details: [],
    };
}

function buildTaglineCheck({ noTagline, ocrText, pages }) {
    const matchingPages = Array.isArray(pages)
        ? pages
            .map((page) => {
                const pageText = Array.isArray(page?.lines) ? page.lines.join('\n') : '';
                return pageText.includes(MAIL_SHARK_TAGLINE) ? page?.page : null;
            })
            .filter((pageNumber) => Number.isInteger(pageNumber))
        : [];

    const taglineFound = typeof ocrText === 'string'
        ? ocrText.includes(MAIL_SHARK_TAGLINE)
        : matchingPages.length > 0;

    let reason = null;
    if (taglineFound && noTagline) {
        reason = 'MS tagline is present, but client has indicated No Tagline';
    } else if (!taglineFound && !noTagline) {
        reason = 'MS tagling is not present, but client has not indicated No Tagline';
    }

    return {
        status: reason ? 'fail' : 'pass',
        no_tagline_requested: noTagline,
        tagline_found: taglineFound,
        searched_text: MAIL_SHARK_TAGLINE,
        matching_pages: matchingPages,
        reason,
    };
}

function getSpellingContext(spelling) {
    const spellingIssuesRaw = spelling?.spelling_issues ?? [];
    const issues = Array.isArray(spellingIssuesRaw)
        ? spellingIssuesRaw
        : [spellingIssuesRaw].filter(Boolean);

    const message = issues.length > 0
        ? `Spelling issues detected: ${issues.map((issue) => issue?.issue_text ?? String(issue)).join('; ')}`
        : '';

    return {
        issues,
        hasIssues: issues.length > 0,
        message,
    };
}

function evaluateFoundDate(item, context) {
    if (item.is_expiration_phrase === true) {
        return evaluateExpirationPhrase(item, context.spellingContext);
    }

    return evaluateExplicitDate(item, context);
}

function evaluateExpirationPhrase(item, spellingContext) {
    const reasons = ['Explicit expiration phrase detected in text'];
    let status = 'pass_expiration_phrase';

    if (spellingContext.hasIssues) {
        status = 'fail';
        reasons.push(spellingContext.message);
    }

    const expiration_details = {
        ...item,
        days_from_today: null,
        days_after_input: null,
        status,
    };

    return { expiration_details, reasons };
}

function evaluateExplicitDate(item, { today, inputDate, inputDateISO, spellingContext }) {
    const dateIso = typeof item.date_iso === 'string' ? item.date_iso : '';
    const exp = parseISO(dateIso);
    const reasons = [];

    if (!isValid(exp)) {
        reasons.push('Invalid date format');

        if (spellingContext.hasIssues) {
            reasons.push(spellingContext.message);
        }

        return {
            expiration_details: {
                ...item,
                status: 'fail',
                details: 'Invalid date format',
            },
            reasons,
        };
    }

    const daysFromToday = differenceInDays(exp, today);
    const daysAfterInput = differenceInDays(exp, inputDate);
    let status = 'pass';

    if (daysFromToday <= 0) {
        status = 'fail';
        reasons.push(`Expiration date is not in the future (days from today: ${daysFromToday})`);
    }

    if (daysAfterInput < 28) {
        status = 'fail';
        reasons.push(`Expiration date is not at least 4 weeks after input date (${inputDateISO}) (days after input date: ${daysAfterInput})`);
    }

    if (spellingContext.hasIssues) {
        status = 'fail';
        reasons.push(spellingContext.message);
    }

    return {
        expiration_details: {
            ...item,
            days_from_today: daysFromToday,
            days_after_input: daysAfterInput,
            status,
        },
        reasons,
    };
}

function buildValidationReport({
    evaluations,
    spellingIssues,
    spellingIssuesMessage,
    taglineCheck,
}) {
    const expiration_details = evaluations
        .map((evaluation) => evaluation.expiration_details)
        .filter(Boolean);
    const noDatesFound = expiration_details.length === 0;

    const anyFail = spellingIssues.length > 0
        || taglineCheck?.status === 'fail'
        || expiration_details.some((expiration) => expiration.status !== 'pass' && expiration.status !== 'pass_expiration_phrase');

    const pass = !anyFail;

    const reasons = [
        ...new Set(
            [
                ...(spellingIssues.length > 0 ? [spellingIssuesMessage] : []),
                ...(taglineCheck?.reason ? [taglineCheck.reason] : []),
                ...evaluations.flatMap((evaluation) => evaluation.reasons ?? []),
            ].filter(Boolean),
        ),
    ];

    return {
        pass,
        summary: {
            total_expiration_dates: expiration_details.length,
            no_dates_found: noDatesFound,
            any_fail: anyFail,
            spelling_issues_count: spellingIssues.length,
            reasons,
        },
        tagline_check: taglineCheck,
        expiration_details,
        spelling_details: spellingIssues,
    };
}

export async function runQaReport({
    pdfBuffer,
    filename = 'upload.pdf',
    inputDateISO,
    noTagline,
}) {
    ensureCodexApiKey();

    if (typeof noTagline !== 'boolean') {
        throw new Error('noTagline must be provided as a boolean.');
    }

    const extracted = await extractPdfTextLocally({
        pdfBuffer,
        filename,
    });
    const extractedText = { pages: extracted?.extracted_text?.pages ?? [] };

    const {
        expiration: codexExpiration,
        spelling,
        threadIds,
    } = await runCodexAnalysis(extractedText);

    const report = validateDates({
        spelling,
        foundDates: codexExpiration?.found_expiration_dates,
        inputDateISO,
        noTagline,
        ocrText: extracted?.ocr_text,
        pages: extractedText.pages,
    });

    return {
        input_date: inputDateISO,
        codex_thread_ids: threadIds,
        warnings: [
            ...(extracted?.warnings ?? []),
            ...(codexExpiration?.warnings ?? []),
            ...(spelling?.warnings ?? []),
        ],
        report,
    };
}
