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
const SUPPORT_CSV_PATH = path.join(DATA_DIR, "Support.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Support data structure
interface Support {
    support_id: string
    platform_id: string
    support_options?: string
    sla_available?: string
    support_channels?: string
    support_hours?: string
    enterprise_support?: string
    training_options?: string
    consulting_services?: string
    implementation_support?: string
    response_time_guarantees?: string
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
 * Validate support data against schema constraints
 */
function validateSupport(support: Support): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!support.platform_id) {
        errors.push("platform_id is required")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate support records against platforms
 */
function validateSupportAgainstPlatforms(supportRecords: Support[], platformsMap: Map<string, Platform>): Support[] {
    log("Validating support records against platforms...", "info")

    // If no support records, create default ones for testing
    if (supportRecords.length === 0 && platformsMap.size > 0) {
        log("No support records found in CSV, creating default records for testing", "warning")
        const newSupportRecords: Support[] = []

        // Create a default support record for each platform
        for (const [platformId, platform] of platformsMap.entries()) {
            const defaultSupport: Support = {
                support_id: `supp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                platform_id: platformId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            newSupportRecords.push(defaultSupport)
            log(`Created default support record for platform: ${platform.platform_name}`, "info")
        }

        return newSupportRecords
    }

    const validSupportRecords = supportRecords.filter((support) => {
        const platformId = support.platform_id
        if (!platformId) {
            log(`Support record ${support.support_id || "unknown"} has no platform ID, skipping`, "warning")
            return false
        }

        const platformExists = platformsMap.has(platformId)
        if (!platformExists) {
            log(
                `Support record ${support.support_id || "unknown"} references non-existent platform ${platformId}, skipping`,
                "warning",
            )
            return false
        }

        return true
    })

    log(`Validated ${validSupportRecords.length}/${supportRecords.length} support records`, "info")
    return validSupportRecords
}

/**
 * Enrich support data using OpenAI
 */
async function enrichSupportData(support: Support, platform: Platform): Promise<Support> {
    try {
        log(`Enriching support data for platform: ${platform.platform_name}`, "info")

        const prompt = `
Provide accurate support information for the AI platform "${platform.platform_name}" in JSON format with the following fields:
- support_options: Available support options (e.g., "Community, Basic, Premium, Enterprise")
- sla_available: Whether SLAs are available ("Yes", "No", "Enterprise only")
- support_channels: Available support channels (e.g., "Email, Chat, Phone, Forum")
- support_hours: Support hours (e.g., "24/7", "Business hours", "9am-5pm EST")
- enterprise_support: Enterprise support options (e.g., "Dedicated account manager, Priority support")
- training_options: Available training options (e.g., "Documentation, Webinars, In-person training")
- consulting_services: Consulting services offered (e.g., "Implementation consulting, Custom solution design")
- implementation_support: Implementation support (e.g., "Self-service, Guided implementation, Full-service")
- response_time_guarantees: Response time guarantees (e.g., "1 hour for critical issues, 24 hours for standard")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<Support>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing support data, only updating null/undefined fields
        const updatedSupport: Support = { ...support }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedSupport[key] === undefined || updatedSupport[key] === null || updatedSupport[key] === "") {
                updatedSupport[key] = enrichedData[key as keyof Partial<Support>]
            }
        })

        updatedSupport.updatedAt = timestamp

        // Validate the enriched support data
        const validation = validateSupport(updatedSupport)
        if (!validation.valid) {
            log(
                `Validation issues with enriched support for ${platform.platform_name}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedSupport
    } catch (error: any) {
        log(`Error enriching support for ${platform.platform_name}: ${error.message}`, "error")
        return support
    }
}

/**
 * Process all support records with rate limiting
 */
async function processSupportWithRateLimit(
    supportRecords: Support[],
    platformsMap: Map<string, Platform>,
): Promise<Support[]> {
    const enrichedSupportRecords: Support[] = []

    for (let i = 0; i < supportRecords.length; i++) {
        try {
            // Skip support records that already have all fields filled
            const support = supportRecords[i]
            const hasAllFields =
                support.support_options &&
                support.sla_available &&
                support.support_channels &&
                support.support_hours &&
                support.enterprise_support

            if (hasAllFields) {
                log(
                    `Skipping support ${i + 1}/${supportRecords.length}: ${support.support_id || "unknown"} (already complete)`,
                    "info",
                )
                enrichedSupportRecords.push(support)
                continue
            }

            // Get associated platform
            const platform = platformsMap.get(support.platform_id) as Platform

            // Enrich support data
            const enrichedSupport = await enrichSupportData(support, platform)
            enrichedSupportRecords.push(enrichedSupport)

            // Log progress
            log(`Processed support ${i + 1}/${supportRecords.length} for platform: ${platform.platform_name}`, "info")

            // Rate limiting delay (except for last item)
            if (i < supportRecords.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing support ${supportRecords[i].support_id || "unknown"}: ${error.message}`, "error")
            enrichedSupportRecords.push(supportRecords[i]) // Add original data if enrichment fails
        }
    }

    return enrichedSupportRecords
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting support processing...", "info")

        // Load platforms and support records
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        let supportRecords = loadCsvData<Support>(SUPPORT_CSV_PATH)

        // Create backup of support file if it exists and has data
        if (fs.existsSync(SUPPORT_CSV_PATH) && supportRecords.length > 0) {
            createBackup(SUPPORT_CSV_PATH, BACKUP_DIR)
        }

        // Validate support records against platforms
        supportRecords = validateSupportAgainstPlatforms(supportRecords, platformsMap)

        // Enrich support data
        supportRecords = await processSupportWithRateLimit(supportRecords, platformsMap)

        // Save to CSV
        saveCsvData(SUPPORT_CSV_PATH, supportRecords)

        log("Support processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

