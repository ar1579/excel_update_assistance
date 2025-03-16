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
const DOCUMENTATION_CSV_PATH = path.join(DATA_DIR, "Documentation.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Documentation data structure
interface Documentation {
    doc_id: string
    platform_id: string
    documentation_description?: string
    doc_quality?: string
    documentation_url?: string
    faq_url?: string
    forum_url?: string
    example_code_available?: string
    example_code_languages?: string
    video_tutorials_available?: string
    learning_curve_rating?: string
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
 * Validate documentation data against schema constraints
 */
function validateDocumentation(documentation: Documentation): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!documentation.platform_id) {
        errors.push("platform_id is required")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate documentation records against platforms
 */
function validateDocumentationAgainstPlatforms(
    documentationRecords: Documentation[],
    platformsMap: Map<string, Platform>,
): Documentation[] {
    log("Validating documentation records against platforms...", "info")

    // If no documentation records, create default ones for testing
    if (documentationRecords.length === 0 && platformsMap.size > 0) {
        log("No documentation records found in CSV, creating default records for testing", "warning")
        const newDocumentationRecords: Documentation[] = []

        // Create a default documentation record for each platform
        for (const [platformId, platform] of platformsMap.entries()) {
            const defaultDocumentation: Documentation = {
                doc_id: `doc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                platform_id: platformId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            newDocumentationRecords.push(defaultDocumentation)
            log(`Created default documentation record for platform: ${platform.platform_name}`, "info")
        }

        return newDocumentationRecords
    }

    const validDocumentationRecords = documentationRecords.filter((documentation) => {
        const platformId = documentation.platform_id
        if (!platformId) {
            log(`Documentation record ${documentation.doc_id || "unknown"} has no platform ID, skipping`, "warning")
            return false
        }

        const platformExists = platformsMap.has(platformId)
        if (!platformExists) {
            log(
                `Documentation record ${documentation.doc_id || "unknown"} references non-existent platform ${platformId}, skipping`,
                "warning",
            )
            return false
        }

        return true
    })

    log(`Validated ${validDocumentationRecords.length}/${documentationRecords.length} documentation records`, "info")
    return validDocumentationRecords
}

/**
 * Enrich documentation data using OpenAI
 */
async function enrichDocumentationData(documentation: Documentation, platform: Platform): Promise<Documentation> {
    try {
        log(`Enriching documentation data for platform: ${platform.platform_name}`, "info")

        const prompt = `
Provide accurate documentation information for the AI platform "${platform.platform_name}" in JSON format with the following fields:
- documentation_description: Description of available documentation (e.g., "Comprehensive API reference, tutorials, and guides")
- doc_quality: Quality assessment of documentation (e.g., "Excellent", "Good", "Average", "Poor")
- documentation_url: URL to main documentation
- faq_url: URL to FAQ page
- forum_url: URL to community forum or discussion board
- example_code_available: Whether example code is available ("Yes", "No", "Limited")
- example_code_languages: Programming languages of example code (e.g., "Python, JavaScript, Java, Ruby")
- video_tutorials_available: Whether video tutorials are available ("Yes", "No", "Limited")
- learning_curve_rating: Rating of learning curve (e.g., "Gentle", "Moderate", "Steep")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<Documentation>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing documentation data, only updating null/undefined fields
        const updatedDocumentation: Documentation = { ...documentation }
        Object.keys(enrichedData).forEach((key) => {
            if (
                updatedDocumentation[key] === undefined ||
                updatedDocumentation[key] === null ||
                updatedDocumentation[key] === ""
            ) {
                updatedDocumentation[key] = enrichedData[key as keyof Partial<Documentation>]
            }
        })

        updatedDocumentation.updatedAt = timestamp

        // Validate the enriched documentation data
        const validation = validateDocumentation(updatedDocumentation)
        if (!validation.valid) {
            log(
                `Validation issues with enriched documentation for ${platform.platform_name}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedDocumentation
    } catch (error: any) {
        log(`Error enriching documentation for ${platform.platform_name}: ${error.message}`, "error")
        return documentation
    }
}

/**
 * Process all documentation records with rate limiting
 */
async function processDocumentationWithRateLimit(
    documentationRecords: Documentation[],
    platformsMap: Map<string, Platform>,
): Promise<Documentation[]> {
    const enrichedDocumentationRecords: Documentation[] = []

    for (let i = 0; i < documentationRecords.length; i++) {
        try {
            // Skip documentation records that already have all fields filled
            const documentation = documentationRecords[i]
            const hasAllFields =
                documentation.documentation_description &&
                documentation.doc_quality &&
                documentation.documentation_url &&
                documentation.example_code_available &&
                documentation.learning_curve_rating

            if (hasAllFields) {
                log(
                    `Skipping documentation ${i + 1}/${documentationRecords.length}: ${documentation.doc_id || "unknown"} (already complete)`,
                    "info",
                )
                enrichedDocumentationRecords.push(documentation)
                continue
            }

            // Get associated platform
            const platform = platformsMap.get(documentation.platform_id) as Platform

            // Enrich documentation data
            const enrichedDocumentation = await enrichDocumentationData(documentation, platform)
            enrichedDocumentationRecords.push(enrichedDocumentation)

            // Log progress
            log(
                `Processed documentation ${i + 1}/${documentationRecords.length} for platform: ${platform.platform_name}`,
                "info",
            )

            // Rate limiting delay (except for last item)
            if (i < documentationRecords.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing documentation ${documentationRecords[i].doc_id || "unknown"}: ${error.message}`, "error")
            enrichedDocumentationRecords.push(documentationRecords[i]) // Add original data if enrichment fails
        }
    }

    return enrichedDocumentationRecords
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting documentation processing...", "info")

        // Load platforms and documentation records
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        let documentationRecords = loadCsvData<Documentation>(DOCUMENTATION_CSV_PATH)

        // Create backup of documentation file if it exists and has data
        if (fs.existsSync(DOCUMENTATION_CSV_PATH) && documentationRecords.length > 0) {
            createBackup(DOCUMENTATION_CSV_PATH, BACKUP_DIR)
        }

        // Validate documentation records against platforms
        documentationRecords = validateDocumentationAgainstPlatforms(documentationRecords, platformsMap)

        // Enrich documentation data
        documentationRecords = await processDocumentationWithRateLimit(documentationRecords, platformsMap)

        // Save to CSV
        saveCsvData(DOCUMENTATION_CSV_PATH, documentationRecords)

        log("Documentation processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

