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
const VERSIONING_CSV_PATH = path.join(DATA_DIR, "Versioning.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Versioning data structure
interface Versioning {
    version_id: string
    platform_id: string
    release_date?: string
    last_updated?: string
    maintenance_status?: string
    deprecation_date?: string
    update_frequency?: string
    changelog_url?: string
    version_numbering_scheme?: string
    backward_compatibility_notes?: string
    known_issues?: string
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
 * Validate versioning data against schema constraints
 */
function validateVersioning(versioning: Versioning): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!versioning.platform_id) {
        errors.push("platform_id is required")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate versioning records against platforms
 */
function validateVersioningAgainstPlatforms(
    versioningRecords: Versioning[],
    platformsMap: Map<string, Platform>,
): Versioning[] {
    log("Validating versioning records against platforms...", "info")

    // If no versioning records, create default ones for testing
    if (versioningRecords.length === 0 && platformsMap.size > 0) {
        log("No versioning records found in CSV, creating default records for testing", "warning")
        const newVersioningRecords: Versioning[] = []

        // Create a default versioning record for each platform
        for (const [platformId, platform] of platformsMap.entries()) {
            const defaultVersioning: Versioning = {
                version_id: `ver_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                platform_id: platformId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            newVersioningRecords.push(defaultVersioning)
            log(`Created default versioning record for platform: ${platform.platform_name}`, "info")
        }

        return newVersioningRecords
    }

    const validVersioningRecords = versioningRecords.filter((versioning) => {
        const platformId = versioning.platform_id
        if (!platformId) {
            log(`Versioning record ${versioning.version_id || "unknown"} has no platform ID, skipping`, "warning")
            return false
        }

        const platformExists = platformsMap.has(platformId)
        if (!platformExists) {
            log(
                `Versioning record ${versioning.version_id || "unknown"} references non-existent platform ${platformId}, skipping`,
                "warning",
            )
            return false
        }

        return true
    })

    log(`Validated ${validVersioningRecords.length}/${versioningRecords.length} versioning records`, "info")
    return validVersioningRecords
}

/**
 * Enrich versioning data using OpenAI
 */
async function enrichVersioningData(versioning: Versioning, platform: Platform): Promise<Versioning> {
    try {
        log(`Enriching versioning data for platform: ${platform.platform_name}`, "info")

        const prompt = `
Provide accurate versioning information for the AI platform "${platform.platform_name}" in JSON format with the following fields:
- release_date: Initial release date (e.g., "2020-05-15", "March 2019")
- last_updated: Date of last update (e.g., "2023-11-30", "Last week")
- maintenance_status: Current maintenance status (e.g., "Active", "Maintenance mode", "Deprecated")
- deprecation_date: Deprecation date if applicable (e.g., "2024-12-31", "None", "Not announced")
- update_frequency: How often updates are released (e.g., "Monthly", "Quarterly", "As needed")
- changelog_url: URL to changelog or release notes
- version_numbering_scheme: Version numbering scheme (e.g., "Semantic versioning", "Major.Minor", "Date-based")
- backward_compatibility_notes: Notes on backward compatibility (e.g., "Full backward compatibility maintained", "Breaking changes in major versions")
- known_issues: Known issues with current version (e.g., "Memory leaks in high-load scenarios", "None reported")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<Versioning>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing versioning data, only updating null/undefined fields
        const updatedVersioning: Versioning = { ...versioning }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedVersioning[key] === undefined || updatedVersioning[key] === null || updatedVersioning[key] === "") {
                updatedVersioning[key] = enrichedData[key as keyof Partial<Versioning>]
            }
        })

        updatedVersioning.updatedAt = timestamp

        // Validate the enriched versioning data
        const validation = validateVersioning(updatedVersioning)
        if (!validation.valid) {
            log(
                `Validation issues with enriched versioning for ${platform.platform_name}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedVersioning
    } catch (error: any) {
        log(`Error enriching versioning for ${platform.platform_name}: ${error.message}`, "error")
        return versioning
    }
}

/**
 * Process all versioning records with rate limiting
 */
async function processVersioningWithRateLimit(
    versioningRecords: Versioning[],
    platformsMap: Map<string, Platform>,
): Promise<Versioning[]> {
    const enrichedVersioningRecords: Versioning[] = []

    for (let i = 0; i < versioningRecords.length; i++) {
        try {
            // Skip versioning records that already have all fields filled
            const versioning = versioningRecords[i]
            const hasAllFields =
                versioning.release_date &&
                versioning.last_updated &&
                versioning.maintenance_status &&
                versioning.update_frequency &&
                versioning.version_numbering_scheme

            if (hasAllFields) {
                log(
                    `Skipping versioning ${i + 1}/${versioningRecords.length}: ${versioning.version_id || "unknown"} (already complete)`,
                    "info",
                )
                enrichedVersioningRecords.push(versioning)
                continue
            }

            // Get associated platform
            const platform = platformsMap.get(versioning.platform_id) as Platform

            // Enrich versioning data
            const enrichedVersioning = await enrichVersioningData(versioning, platform)
            enrichedVersioningRecords.push(enrichedVersioning)

            // Log progress
            log(`Processed versioning ${i + 1}/${versioningRecords.length} for platform: ${platform.platform_name}`, "info")

            // Rate limiting delay (except for last item)
            if (i < versioningRecords.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing versioning ${versioningRecords[i].version_id || "unknown"}: ${error.message}`, "error")
            enrichedVersioningRecords.push(versioningRecords[i]) // Add original data if enrichment fails
        }
    }

    return enrichedVersioningRecords
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting versioning processing...", "info")

        // Load platforms and versioning records
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        let versioningRecords = loadCsvData<Versioning>(VERSIONING_CSV_PATH)

        // Create backup of versioning file if it exists and has data
        if (fs.existsSync(VERSIONING_CSV_PATH) && versioningRecords.length > 0) {
            createBackup(VERSIONING_CSV_PATH, BACKUP_DIR)
        }

        // Validate versioning records against platforms
        versioningRecords = validateVersioningAgainstPlatforms(versioningRecords, platformsMap)

        // Enrich versioning data
        versioningRecords = await processVersioningWithRateLimit(versioningRecords, platformsMap)

        // Save to CSV
        saveCsvData(VERSIONING_CSV_PATH, versioningRecords)

        log("Versioning processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

