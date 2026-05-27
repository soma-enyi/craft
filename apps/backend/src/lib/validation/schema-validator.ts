/**
 * Schema validation utilities for request metadata.
 * Validates that structured data conforms to expected types and constraints.
 */

export interface ValidationError {
    field: string;
    message: string;
}

export interface ValidationResult {
    valid: true;
} | {
    valid: false;
    errors: ValidationError[];
};

/**
 * Validate upload metadata schema
 */
export interface UploadMetadata {
    filename?: string;
    description?: string;
    tags?: string[];
    category?: string;
}

export function validateUploadMetadata(metadata: unknown): ValidationResult {
    const errors: ValidationError[] = [];

    if (typeof metadata !== 'object' || metadata === null) {
        return {
            valid: false,
            errors: [{ field: 'metadata', message: 'Metadata must be an object' }],
        };
    }

    const obj = metadata as Record<string, unknown>;

    // Validate filename if present
    if ('filename' in obj) {
        if (typeof obj.filename !== 'string') {
            errors.push({ field: 'filename', message: 'Filename must be a string' });
        } else if (obj.filename.trim().length === 0) {
            errors.push({ field: 'filename', message: 'Filename cannot be empty' });
        } else if (obj.filename.length > 255) {
            errors.push({ field: 'filename', message: 'Filename exceeds 255 characters' });
        }
    }

    // Validate description if present
    if ('description' in obj) {
        if (typeof obj.description !== 'string') {
            errors.push({ field: 'description', message: 'Description must be a string' });
        } else if (obj.description.length > 1000) {
            errors.push({ field: 'description', message: 'Description exceeds 1000 characters' });
        }
    }

    // Validate tags if present
    if ('tags' in obj) {
        if (!Array.isArray(obj.tags)) {
            errors.push({ field: 'tags', message: 'Tags must be an array' });
        } else {
            if (obj.tags.length > 20) {
                errors.push({ field: 'tags', message: 'Cannot have more than 20 tags' });
            }
            for (let i = 0; i < obj.tags.length; i++) {
                const tag = obj.tags[i];
                if (typeof tag !== 'string') {
                    errors.push({
                        field: `tags[${i}]`,
                        message: 'Each tag must be a string',
                    });
                } else if (tag.length === 0 || tag.length > 50) {
                    errors.push({
                        field: `tags[${i}]`,
                        message: 'Each tag must be 1-50 characters',
                    });
                }
            }
        }
    }

    // Validate category if present
    if ('category' in obj) {
        if (typeof obj.category !== 'string') {
            errors.push({ field: 'category', message: 'Category must be a string' });
        } else {
            const validCategories = ['branding', 'content', 'config', 'other'];
            if (!validCategories.includes(obj.category)) {
                errors.push({
                    field: 'category',
                    message: `Category must be one of: ${validCategories.join(', ')}`,
                });
            }
        }
    }

    if (errors.length > 0) {
        return { valid: false, errors };
    }

    return { valid: true };
}

/**
 * Format validation errors into a user-friendly message
 */
export function formatValidationErrors(errors: ValidationError[]): string {
    if (errors.length === 1) {
        return `${errors[0].field}: ${errors[0].message}`;
    }

    const lines = errors.map((e) => `  • ${e.field}: ${e.message}`);
    return 'Validation errors:\n' + lines.join('\n');
}
