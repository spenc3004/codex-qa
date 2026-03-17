import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI, { toFile } from 'openai';
import { Codex } from '@openai/codex-sdk';
import {
    differenceInDays,
    isValid,
    parseISO,
    startOfDay,
} from 'date-fns';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extractionPrompt = fs
    .readFileSync(path.join(__dirname, 'prompts', 'extraction_prompt.txt'), 'utf8')
    .trim();

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

const EXTRACTION_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['found_expiration_dates', 'extracted_text', 'warnings'],
    properties: {
        found_expiration_dates: {
            type: 'array',
            items: {
                anyOf: EXPIRATION_ITEM_SCHEMA_ANYOF,
            },
        },
        extracted_text: {
            type: 'object',
            additionalProperties: false,
            required: ['pages'],
            properties: {
                pages: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['page', 'lines'],
                        properties: {
                            page: { type: 'integer', minimum: 1 },
                            lines: { type: 'array', items: { type: 'string' } },
                        },
                    },
                },
            },
        },
        warnings: {
            type: 'array',
            items: { type: 'string' },
        },
    },
};

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

function ensureOpenAiKey() {
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('Missing OPENAI_API_KEY.');
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

function extractResponsesOutputText(response) {
    if (typeof response?.output_text === 'string' && response.output_text.trim()) {
        return response.output_text;
    }

    const outputItems = Array.isArray(response?.output) ? response.output : [];
    for (const item of outputItems) {
        const contentItems = Array.isArray(item?.content) ? item.content : [];
        for (const content of contentItems) {
            if ((content?.type === 'output_text' || content?.type === 'text') && typeof content?.text === 'string') {
                return content.text;
            }
        }
    }

    return '';
}

async function uploadPDFToOpenAI(openai, fileBuffer, originalName, mimeType) {
    const file = await toFile(fileBuffer, originalName, {
        type: mimeType || 'application/pdf',
    });

    const uploaded = await openai.files.create({
        file,
        purpose: 'user_data',
    });

    return uploaded.id;
}

async function runExtraction(openai, fileId) {
    const extractionModel = process.env.EXTRACTION_MODEL || 'gpt-5.2';
    const response = await openai.responses.create({
        model: extractionModel,
        input: [
            {
                role: 'user',
                content: [
                    { type: 'input_text', text: extractionPrompt },
                    { type: 'input_file', file_id: fileId },
                ],
            },
        ],
        text: {
            format: {
                type: 'json_schema',
                name: 'artwork_qa_report',
                strict: true,
                schema: EXTRACTION_SCHEMA,
            },
        },
    });

    const raw = extractResponsesOutputText(response);
    return parseJSONOrThrow(raw, 'Extraction stage');
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
    mimeType = 'application/pdf',
    inputDateISO,
}) {
    ensureOpenAiKey();

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    let fileId = null;

    try {
        fileId = await uploadPDFToOpenAI(openai, pdfBuffer, filename, mimeType);
        const extracted = await runExtraction(openai, fileId);
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
            extraction_model: process.env.EXTRACTION_MODEL || 'gpt-5.2',
            codex_model: process.env.CODEX_MODEL || null,
            codex_thread_id: threadId,
            extracted,
            codex_expiration: codexExpiration,
            spelling,
            deterministic,
        };
    } finally {
        if (fileId) {
            try {
                await openai.files.delete(fileId);
            } catch (error) {
                console.warn(`Failed to delete temporary file ${fileId}:`, error?.message ?? error);
            }
        }
    }
}
