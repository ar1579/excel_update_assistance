import { log } from "./logging"

/**
 * Generic validation result interface
 */
export interface ValidationResult {
    valid: boolean
    errors: string[]
    warnings: string[]
}

/**
 * Base validation function for any record type
 * @param record The record to validate
 * @param requiredFields Array of field names that are required
 * @param conditionalFields Object mapping field names to validation functions
 * @param enumFields Object mapping field names to arrays of allowed values
 * @returns Validation result with valid flag, errors, and warnings
 */
export function validateRecord<T extends Record<string, any>>(
    record: T,
    requiredFields: string[] = [],
    conditionalFields: Record<string, (value: any) => boolean> = {},
    enumFields: Record<string, string[]> = {},
): ValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    // Check required fields
    for (const field of requiredFields) {
        if (!record[field]) {
            errors.push(`Missing required field: ${field}`)
        }
    }

    // Check conditional validations
    for (const [field, validationFn] of Object.entries(conditionalFields)) {
        if (record[field] && !validationFn(record[field])) {
            errors.push(`Invalid value for field ${field}: ${record[field]}`)
        }
    }

    // Check enum fields
    for (const [field, allowedValues] of Object.entries(enumFields)) {
        if (record[field] && !allowedValues.includes(record[field])) {
            errors.push(`Field ${field} must be one of: ${allowedValues.join(", ")}`)
        }
    }

    // Check for near-empty fields (fields with just whitespace)
    for (const [field, value] of Object.entries(record)) {
        if (typeof value === "string" && value.trim() === "" && value !== "") {
            warnings.push(`Field ${field} contains only whitespace`)
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    }
}

/**
 * Validate a URL string
 * @param url The URL to validate
 * @returns True if valid, false otherwise
 */
export function isValidUrl(url: string): boolean {
    try {
        // Add protocol if missing
        let urlToCheck = url
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            urlToCheck = "https://" + url
        }
        new URL(urlToCheck)
        return true
    } catch (error) {
        return false
    }
}

/**
 * Log validation results
 * @param entityType Type of entity being validated (e.g., "Company", "Platform")
 * @param entityId Identifier for the entity
 * @param result Validation result
 */
export function logValidationResults(entityType: string, entityId: string, result: ValidationResult): void {
    if (!result.valid) {
        log(`Validation failed for ${entityType} ${entityId}:`, "warning")
        for (const error of result.errors) {
            log(`- ${error}`, "error")
        }
    }

    if (result.warnings.length > 0) {
        log(`Validation warnings for ${entityType} ${entityId}:`, "warning")
        for (const warning of result.warnings) {
            log(`- ${warning}`, "warning")
        }
    }
}

