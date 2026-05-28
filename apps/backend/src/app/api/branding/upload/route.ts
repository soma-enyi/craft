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
 * Enforces path-based namespacing: uploads are stored at {user_id}/{filename}
 * RLS policies in storage bucket prevent cross-user access.
 *
 * On success returns { url } — the public URL to the uploaded asset.
 * On validation failure returns { error, code } with 422 status.
 * On storage error returns { error } with 500 status.
 */
export const POST = withAuth(async (req: NextRequest, { supabase, user }) => {
    let formData: FormData;
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

    const file = formData.get('file');
    if (!(file instanceof File)) {
        return NextResponse.json({ error: 'Missing "file" field' }, { status: 400 });
    }

    const buffer = new Uint8Array(await file.arrayBuffer());
    const result = validateBrandingFile(file.name, file.type, file.size, buffer);

    if (!result.valid) {
        return NextResponse.json({ error: result.error, code: result.code }, { status: 422 });
    }

    // Enforce path-based namespacing: user_id/filename
    const storagePath = `${user.id}/${file.name}`;

    try {
        const { data, error: uploadError } = await supabase.storage
            .from('branding_assets')
            .upload(storagePath, buffer, {
                contentType: file.type,
                upsert: true,
            });

        if (uploadError || !data) {
            return NextResponse.json(
                { error: uploadError?.message ?? 'Storage upload failed' },
                { status: 500 },
            );
        }

        // Return public URL to the uploaded asset
        const { data: publicUrlData } = supabase.storage
            .from('branding_assets')
            .getPublicUrl(storagePath);

        return NextResponse.json({ url: publicUrlData.publicUrl }, { status: 200 });
    } catch (err: unknown) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Storage upload failed' },
            { status: 500 },
        );
    }
});
