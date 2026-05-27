import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api/with-auth';
import { validateBrandingFile } from '@/lib/customization/validate-branding-file';
import {
    validateContentLength,
    DEFAULT_MAX_BRANDING_FILE_SIZE,
    formatBytes,
} from '@/lib/api/validate-request-size';
import {
    validateUploadMetadata,
    formatValidationErrors,
} from '@/lib/validation/schema-validator';

/**
 * POST /api/branding/upload
 *
 * Upload and validate branding files with strict size and schema validation.
 * Validates file size, type, format, and optional metadata before processing.
 *
 * Request body: multipart/form-data
 *   file     (required)  The file to upload
 *   metadata (optional)  JSON metadata with optional fields:
 *     - filename: string (max 255 chars)
 *     - description: string (max 1000 chars)
 *     - tags: string[] (max 20 tags, each 1-50 chars)
 *     - category: one of "branding", "content", "config", "other"
 *
 * Responses:
 *   200 — File validated successfully
 *   400 — Missing required fields or invalid format
 *   401 — Not authenticated
 *   413 — Request body exceeds size limit
 *   422 — File validation failed (invalid type, size, or safety)
 *   500 — Unexpected server error
 *
 * Issue: #607
 * Branch: feat/issue-071-upload-size-schema-validation
 */
export const POST = withAuth(async (req: NextRequest) => {
    try {
        // Validate request size before buffering entire body
        const contentLength = req.headers.get('content-length');
        const sizeValidation = validateContentLength(
            contentLength,
            DEFAULT_MAX_BRANDING_FILE_SIZE,
        );

        if (!sizeValidation.valid) {
            return NextResponse.json(
                { error: sizeValidation.message },
                { status: 413 },
            );
        }

        let formData: FormData;
        try {
            formData = await req.formData();
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : 'Failed to parse form data';
            console.error('[branding-upload] form parsing error:', err);
            return NextResponse.json(
                { error: 'Expected multipart/form-data' },
                { status: 400 },
            );
        }

        // Validate file field
        const file = formData.get('file');
        if (!(file instanceof File)) {
            return NextResponse.json(
                { error: 'Missing or invalid "file" field' },
                { status: 400 },
            );
        }

        // Additional file size check (safety measure)
        if (file.size > DEFAULT_MAX_BRANDING_FILE_SIZE) {
            return NextResponse.json(
                {
                    error: `File exceeds maximum size of ${formatBytes(DEFAULT_MAX_BRANDING_FILE_SIZE)}. Received: ${formatBytes(file.size)}.`,
                },
                { status: 413 },
            );
        }

        // Validate optional metadata
        let metadata;
        const metadataField = formData.get('metadata');
        if (metadataField) {
            if (typeof metadataField !== 'string') {
                return NextResponse.json(
                    { error: 'Metadata field must be a JSON string' },
                    { status: 400 },
                );
            }

            try {
                metadata = JSON.parse(metadataField);
            } catch (err: unknown) {
                return NextResponse.json(
                    { error: 'Invalid metadata: must be valid JSON' },
                    { status: 400 },
                );
            }

            const metadataValidation = validateUploadMetadata(metadata);
            if (!metadataValidation.valid) {
                return NextResponse.json(
                    { error: formatValidationErrors(metadataValidation.errors) },
                    { status: 400 },
                );
            }
        }

        // Validate file (type, extension, content safety)
        const buffer = new Uint8Array(await file.arrayBuffer());
        const fileValidation = validateBrandingFile(file.name, file.type, file.size, buffer);

        if (!fileValidation.valid) {
            return NextResponse.json(
                { error: fileValidation.error, code: fileValidation.code },
                { status: 422 },
            );
        }

        // TODO: upload buffer to Supabase Storage / S3 and return the real URL
        return NextResponse.json(
            {
                url: null,
                message: 'File validated successfully. Storage not yet wired.',
            },
            { status: 200 },
        );
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        console.error('[branding-upload] unexpected error:', err);
        return NextResponse.json({ error: msg }, { status: 500 });
    }
});
