import fs from "fs"
import path from "path"
import dotenv from "dotenv"
import { log } from "../../utils/logging"
import { initializeOpenAI, makeOpenAIRequest, applyRateLimit } from "../../utils/openai-utils"
import { createBackup, loadCsvData, saveCsvData, createLookupMap } from "../../utils/file-utils"

// Load environment variables
dotenv.config()

// Check for OpenAI API key
if (!process.env.OPENAI_API_KEY) {
    log("OPENAI_API_KEY environment variable is not set", "error")
    process.exit(1)
}

// Initialize OpenAI client
const openai = initializeOpenAI(process.env.OPENAI_API_KEY)

// File paths
const ROOT_DIR = process.cwd()
const DATA_DIR = path.join(ROOT_DIR, "data")
const BACKUP_DIR = path.join(ROOT_DIR, "backups")
const LICENSES_CSV_PATH = path.join(DATA_DIR, "Licenses.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// License data structure
interface License {
    license_id: string
    platform_id: string
    license_type?: string
    open_source_status?: string
    license_name?: string
    license_url?: string
    license_expiration_date?: string
    createdAt?: string
    updatedAt?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

// Platform data structure
interface Platform {
    platform_id: string
    platform_name: string
    platform_url: string
    platform_category?: string
    platform_sub_category?: string
    platform_description?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

/**
 * Validate license data against schema constraints
 */
function validateLicense(license: License): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!license.platform_id) {
        errors.push("platform_id is required")
    }

    // Check license_type constraint if present
    if (
        license.license_type &&
        !["Open-source", "Proprietary", "Creative Commons", "Other"].includes(license.license_type)
    ) {
        errors.push("license_type must be one of: Open-source, Proprietary, Creative Commons, Other")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate licenses against platforms
 */
function validateLicensesAgainstPlatforms(licenses: License[], platformsMap: Map<string, Platform>): License[] {
    log("Validating licenses against platforms...", "info")

    // If no licenses, create default ones for testing
    if (licenses.length === 0 && platformsMap.size > 0) {
        log("No licenses found in CSV, creating default licenses for testing", "warning")
        const newLicenses: License[] = []

        // Create a default license for each platform
        for (const [platformId, platform] of platformsMap.entries()) {
            const defaultLicense: License = {
                license_id: `lic_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                platform_id: platformId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            newLicenses.push(defaultLicense)
            log(`Created default license for platform: ${platform.platform_name}`, "info")
        }

        return newLicenses
    }

    const validLicenses = licenses.filter((license) => {
        const platformId = license.platform_id
        if (!platformId) {
            log(`License ${license.license_id || "unknown"} has no platform ID, skipping`, "warning")
            return false
        }

        const platformExists = platformsMap.has(platformId)
        if (!platformExists) {
            log(
                `License ${license.license_id || "unknown"} references non-existent platform ${platformId}, skipping`,
                "warning",
            )
            return false
        }

        return true
    })

    log(`Validated ${validLicenses.length}/${licenses.length} licenses`, "info")
    return validLicenses
}

/**
 * Enrich license data using OpenAI
 */
async function enrichLicenseData(license: License, platform: Platform): Promise<License> {
    try {
        log(`Enriching license data for platform: ${platform.platform_name}`, "info")

        const prompt = `
Provide accurate licensing information about the AI platform "${platform.platform_name}" in JSON format with the following fields:
- license_type: The type of license (must be one of: "Open-source", "Proprietary", "Creative Commons", "Other")
- open_source_status: Whether the platform is open source ("Yes", "No", "Partially")
- license_name: The specific name of the license (e.g., "MIT", "Apache 2.0", "GPL v3", "Commercial License")
- license_url: URL to the license text or license information page
- license_expiration_date: When the license expires, if applicable (e.g., "None", "Perpetual", "2025-12-31")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<License>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing license data, only updating null/undefined fields
        const updatedLicense: License = { ...license }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedLicense[key] === undefined || updatedLicense[key] === null || updatedLicense[key] === "") {
                updatedLicense[key] = enrichedData[key as keyof Partial<License>]
            }
        })

        updatedLicense.updatedAt = timestamp

        // Validate the enriched license data
        const validation = validateLicense(updatedLicense)
        if (!validation.valid) {
            log(
                `Validation issues with enriched license for ${platform.platform_name}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedLicense
    } catch (error: any) {
        log(`Error enriching license for ${platform.platform_name}: ${error.message}`, "error")
        return license
    }
}

/**
 * Process all licenses with rate limiting
 */
async function processLicensesWithRateLimit(
    licenses: License[],
    platformsMap: Map<string, Platform>,
): Promise<License[]> {
    const enrichedLicenses: License[] = []

    for (let i = 0; i < licenses.length; i++) {
        try {
            // Skip licenses that already have all fields filled
            const license = licenses[i]
            const hasAllFields = license.license_type && license.open_source_status && license.license_name

            if (hasAllFields) {
                log(
                    `Skipping license ${i + 1}/${licenses.length}: ${license.license_id || "unknown"} (already complete)`,
                    "info",
                )
                enrichedLicenses.push(license)
                continue
            }

            // Get associated platform
            const platform = platformsMap.get(license.platform_id) as Platform

            // Enrich license data
            const enrichedLicense = await enrichLicenseData(license, platform)
            enrichedLicenses.push(enrichedLicense)

            // Log progress
            log(`Processed license ${i + 1}/${licenses.length} for platform: ${platform.platform_name}`, "info")

            // Rate limiting delay (except for last item)
            if (i < licenses.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing license ${licenses[i].license_id || "unknown"}: ${error.message}`, "error")
            enrichedLicenses.push(licenses[i]) // Add original data if enrichment fails
        }
    }

    return enrichedLicenses
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting licenses processing...", "info")

        // Load platforms and licenses
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        let licenses = loadCsvData<License>(LICENSES_CSV_PATH)

        // Create backup of licenses file if it exists and has data
        if (fs.existsSync(LICENSES_CSV_PATH) && licenses.length > 0) {
            createBackup(LICENSES_CSV_PATH, BACKUP_DIR)
        }

        // Validate licenses against platforms
        licenses = validateLicensesAgainstPlatforms(licenses, platformsMap)

        // Enrich license data
        licenses = await processLicensesWithRateLimit(licenses, platformsMap)

        // Save to CSV
        saveCsvData(LICENSES_CSV_PATH, licenses)

        log("Licenses processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

