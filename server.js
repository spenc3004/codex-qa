import express from 'express';
import dotenv from 'dotenv';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const app = express();
import { runQaReport } from './qa-service.js';

dotenv.config({ quiet: true });
const PORT = process.env.PORT || 3000;
const upload = multer({
    storage: multer.memoryStorage(),
});

app.use(express.json({ limit: '25mb' }));

app.get('/', async (_req, res) => {
    res.status(200).json({ ok: true, service: 'codex-test' });
});

app.get('/health', async (_req, res) => {
    res.status(200).json({ ok: true });
});

async function resolvePdfInput(req) {
    if (req.file?.buffer) {
        return {
            buffer: req.file.buffer,
            filename: req.file.originalname || 'upload.pdf',
            mimeType: req.file.mimetype || 'application/pdf',
            source: 'multipart',
        };
    }

    const pdfPath = typeof req.body?.pdf_path === 'string' ? req.body.pdf_path.trim() : '';
    if (pdfPath) {
        const fullPath = path.resolve(pdfPath);
        const buffer = await fs.readFile(fullPath);
        return {
            buffer,
            filename: path.basename(fullPath) || 'upload.pdf',
            mimeType: 'application/pdf',
            source: 'path',
            path: fullPath,
        };
    }

    const pdfBase64Raw = typeof req.body?.pdf_base64 === 'string' ? req.body.pdf_base64.trim() : '';
    if (pdfBase64Raw) {
        const payload = pdfBase64Raw.includes(',')
            ? pdfBase64Raw.slice(pdfBase64Raw.indexOf(',') + 1)
            : pdfBase64Raw;
        return {
            buffer: Buffer.from(payload, 'base64'),
            filename: req.body?.filename || 'upload.pdf',
            mimeType: req.body?.mime_type || 'application/pdf',
            source: 'base64',
        };
    }

    return null;
}

app.post('/qa', upload.single('pdf'), async (req, res) => {
    try {
        const inputDate = typeof req.body?.input_date === 'string' ? req.body.input_date.trim() : '';
        if (!inputDate) {
            return res.status(400).json({ error: 'Missing input_date (YYYY-MM-DD).' });
        }

        const pdfInput = await resolvePdfInput(req);
        if (!pdfInput?.buffer?.length) {
            return res.status(400).json({
                error: 'Missing PDF input. Send multipart field "pdf", or JSON field "pdf_path", or JSON field "pdf_base64".',
            });
        }

        const report = await runQaReport({
            pdfBuffer: pdfInput.buffer,
            filename: pdfInput.filename,
            mimeType: pdfInput.mimeType,
            inputDateISO: inputDate,
        });

        return res.status(200).json({
            ...report,
            request_source: pdfInput.source,
        });
    } catch (error) {
        console.error('POST /qa failed:', error);
        return res.status(500).json({
            error: 'Server error.',
            details: String(error?.message ?? error),
        });
    }
});

function startServer(port = PORT) {
    const server = app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    });

    server.on('error', (error) => {
        console.error(`Failed to start server on port ${port}:`, error?.message ?? error);
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
