import express from 'express';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pLimit from 'p-limit';
import { format, isValid, parse } from 'date-fns';
import { runQaReport } from './qa-service.js';

dotenv.config({ quiet: true });

function readPositiveInt(rawValue, fallbackValue) {
    const parsed = Number.parseInt(String(rawValue ?? ''), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue;
}

const app = express();
const PORT = readPositiveInt(process.env.PORT, 3000);
const HOST = process.env.HOST ?? '127.0.0.1';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const SERVICE_API_KEY = process.env.SERVICE_API_KEY ?? '';
const ALLOW_PDF_PATH = process.env.ALLOW_PDF_PATH === 'true';
const PDF_INPUT_ROOT = path.resolve(process.env.PDF_INPUT_ROOT ?? process.cwd());
const MAX_PDF_BYTES = readPositiveInt(process.env.MAX_PDF_BYTES, 10 * 1024 * 1024);
const MAX_QA_CONCURRENCY = readPositiveInt(process.env.MAX_QA_CONCURRENCY, 2);
const RATE_LIMIT_PER_MINUTE = readPositiveInt(process.env.RATE_LIMIT_PER_MINUTE, 10);
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT ?? '15mb';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const qaLimit = pLimit(MAX_QA_CONCURRENCY);

class HttpError extends Error {
    constructor(status, message, { code = 'BAD_REQUEST', expose = true } = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.expose = expose;
    }
}

const qaRateLimit = rateLimit({
    windowMs: 60_000,
    max: RATE_LIMIT_PER_MINUTE,
    standardHeaders: true,
    legacyHeaders: false,
});

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: MAX_PDF_BYTES,
        files: 1,
    },
    fileFilter: (_req, file, cb) => {
        const isPdf = file.mimetype === 'application/pdf'
            || file.originalname.toLowerCase().endsWith('.pdf');

        if (!isPdf) {
            return cb(new HttpError(400, 'Only PDF uploads are allowed.', {
                code: 'INVALID_FILE_TYPE',
            }));
        }

        cb(null, true);
    },
});

app.disable('x-powered-by');

if (TRUST_PROXY) {
    app.set('trust proxy', 1);
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: JSON_BODY_LIMIT }));


app.use(express.json({ limit: '25mb' }));

app.get('/', async (_req, res) => {
    res.status(200).json({ ok: true, service: 'codex-test' });
});

async function resolvePdfInput(req) {
    if (req.file?.buffer) {
        assertPdfBuffer(req.file.buffer);

        return {
            buffer: req.file.buffer,
            filename: req.file.originalname || 'upload.pdf',
            source: 'multipart',
        };
    }

    const pdfPath = typeof req.body?.pdf_path === 'string' ? req.body.pdf_path.trim() : '';
    if (pdfPath) {
        if (!ALLOW_PDF_PATH) {
            throw new HttpError(400, 'pdf_path mode is disabled on this server.', {
                code: 'PDF_PATH_DISABLED',
            });
        }

        const fullPath = resolveAllowedPdfPath(pdfPath);

        let buffer;
        try {
            const stat = await fs.stat(fullPath);
            if (!stat.isFile()) {
                throw new HttpError(400, 'pdf_path must point to a file.', {
                    code: 'INVALID_PDF_PATH',
                });
            }

            buffer = await fs.readFile(fullPath);
        } catch (error) {
            if (error instanceof HttpError) {
                throw error;
            }

            if (error?.code === 'ENOENT') {
                throw new HttpError(400, 'pdf_path does not exist.', {
                    code: 'INVALID_PDF_PATH',
                });
            }

            throw error;
        }

        assertPdfBuffer(buffer);

        return {
            buffer,
            filename: path.basename(fullPath) || 'upload.pdf',
            source: 'path',
            path: fullPath,
        };
    }

    const pdfBase64Raw = typeof req.body?.pdf_base64 === 'string'
        ? req.body.pdf_base64.trim()
        : '';

    if (pdfBase64Raw) {
        return {
            buffer: decodeBase64PdfOrThrow(pdfBase64Raw),
            filename: typeof req.body?.filename === 'string'
                ? req.body.filename
                : 'upload.pdf',
            source: 'base64',
        };
    }

    return null;
}


function requireServiceApiKey(req, _res, next) {
    if (!SERVICE_API_KEY) {
        return next();
    }

    if (req.get('x-api-key') !== SERVICE_API_KEY) {
        return next(new HttpError(401, 'Unauthorized.', {
            code: 'UNAUTHORIZED',
        }));
    }

    next();
}

function assertPdfBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new HttpError(400, 'PDF content is missing.', {
            code: 'MISSING_PDF',
        });
    }

    if (buffer.length > MAX_PDF_BYTES) {
        throw new HttpError(413, `PDF exceeds the ${MAX_PDF_BYTES}-byte limit.`, {
            code: 'PAYLOAD_TOO_LARGE',
        });
    }

    if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw new HttpError(400, 'Input is not a valid PDF.', {
            code: 'INVALID_PDF',
        });
    }
}

function parseInputDateOrThrow(rawValue) {
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';

    if (!ISO_DATE_RE.test(value)) {
        throw new HttpError(400, 'input_date must be YYYY-MM-DD.', {
            code: 'INVALID_INPUT_DATE',
        });
    }

    const parsed = parse(value, 'yyyy-MM-dd', new Date());
    if (!isValid(parsed) || format(parsed, 'yyyy-MM-dd') !== value) {
        throw new HttpError(400, 'input_date must be a real calendar date.', {
            code: 'INVALID_INPUT_DATE',
        });
    }

    return value;
}

function parseNoTaglineOrThrow(rawValue) {
    if (rawValue === true || rawValue === false) {
        return rawValue;
    }

    if (typeof rawValue === 'string') {
        const value = rawValue.trim().toLowerCase();

        if (value === 'true') {
            return true;
        }

        if (value === 'false') {
            return false;
        }
    }

    throw new HttpError(400, 'noTagline must be true or false.', {
        code: 'INVALID_NO_TAGLINE',
    });
}

function resolveAllowedPdfPath(pdfPath) {
    const fullPath = path.resolve(PDF_INPUT_ROOT, pdfPath);
    const relativePath = path.relative(PDF_INPUT_ROOT, fullPath);

    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new HttpError(400, 'pdf_path is outside the allowed directory.', {
            code: 'INVALID_PDF_PATH',
        });
    }

    return fullPath;
}

function decodeBase64PdfOrThrow(rawValue) {
    const payload = rawValue.replace(/^data:application\/pdf;base64,/i, '');

    if (!/^[A-Za-z0-9+/=\s]+$/.test(payload)) {
        throw new HttpError(400, 'pdf_base64 is not valid base64.', {
            code: 'INVALID_PDF_BASE64',
        });
    }

    const buffer = Buffer.from(payload, 'base64');
    assertPdfBuffer(buffer);
    return buffer;
}


async function handleQaRequest(req) {
    const inputDate = parseInputDateOrThrow(req.body?.input_date);
    const noTagline = parseNoTaglineOrThrow(req.body?.noTagline);
    const pdfInput = await resolvePdfInput(req);

    if (!pdfInput?.buffer?.length) {
        throw new HttpError(
            400,
            'Missing PDF input. Send multipart field "pdf", or JSON field "pdf_path", or JSON field "pdf_base64".',
            { code: 'MISSING_PDF' },
        );
    }

    const report = await runQaReport({
        pdfBuffer: pdfInput.buffer,
        filename: pdfInput.filename,
        inputDateISO: inputDate,
        noTagline,
    });

    return {
        ...report,
        noTagline,
        request_source: pdfInput.source,
    };
}

app.post(
    '/qa',
    qaRateLimit,
    requireServiceApiKey,
    upload.single('pdf'),
    async (req, res) => {
        const responseBody = await qaLimit(() => handleQaRequest(req));
        return res.status(200).json(responseBody);
    },
);


app.use((error, _req, res, _next) => {
    console.error('Request failed:', error);

    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                error: `PDF exceeds the ${MAX_PDF_BYTES}-byte limit.`,
                code: 'PAYLOAD_TOO_LARGE',
            });
        }

        return res.status(400).json({
            error: error.message,
            code: 'UPLOAD_ERROR',
        });
    }

    const status = error instanceof HttpError ? error.status : 500;
    const expose = error instanceof HttpError ? error.expose : false;

    return res.status(status).json({
        error: expose ? error.message : 'Server error.',
        code: error?.code ?? 'INTERNAL_ERROR',
    });
});


function startServer(port = PORT, host = HOST) {
    const server = app.listen(port, host, () => {
        console.log(`Server is running on http://${host}:${port}`);
    });

    server.on('error', (error) => {
        console.error(`Failed to start server on ${host}:${port}:`, error?.message ?? error);
        process.exit(1);
    });

    return server;
}


const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryPoint && entryPoint === fileURLToPath(import.meta.url)) {
    startServer();
}

export {
    app,
    startServer,
};
