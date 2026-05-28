import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/api/with-auth';
import { validateBrandingFile } from '@/lib/customization/validate-branding-file';

/**
 * POST /api/branding/upload
 * Accepts a multipart/form-data upload with a single "file" field.
 * Validates type, extension, size, and content safety before accepting.
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
        formData = await req.formData();
    } catch {
        return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
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
