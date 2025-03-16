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
const API_CSV_PATH = path.join(DATA_DIR, "API.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const API_INTEGRATIONS_CSV_PATH = path.join(DATA_DIR, "api_integrations.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// API data structure
interface API {
    api_id: string
    platform_id: string
    api_standards?: string
    authentication_methods?: string
    webhook_support?: string
    third_party_integrations?: string
    export_formats?: string
    import_capabilities?: string
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
    api_availability?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

// API-Integration join table structure
interface APIIntegration {
    api_id: string
    integration_id: string
    createdAt?: string
    updatedAt?: string
}

/**
 * Validate API data against schema constraints
 */
function validateAPI(api: API): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!api.platform_id) {
        errors.push("platform_id is required")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate API records against platforms
 */
function validateAPIAgainstPlatforms(apiRecords: API[], platformsMap: Map<string, Platform>): API[] {
    log("Validating API records against platforms...", "info")

    // If no API records, create default ones for testing
    if (apiRecords.length === 0 && platformsMap.size > 0) {
        log("No API records found in CSV, creating default records for testing", "warning")
        const newAPIRecords: API[] = []

        // Create a default API record for each platform with API availability
        for (const [platformId, platform] of platformsMap.entries()) {
            // Only create API records for platforms with API availability
            if (
                platform.api_availability === "Yes" ||
                platform.api_availability === "Limited" ||
                !platform.api_availability
            ) {
                const defaultAPI: API = {
                    api_id: `api_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                    platform_id: platformId,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                }
                newAPIRecords.push(defaultAPI)
                log(`Created default API record for platform: ${platform.platform_name}`, "info")
            }
        }

        return newAPIRecords
    }

    const validAPIRecords = apiRecords.filter((api) => {
        const platformId = api.platform_id
        if (!platformId) {
            log(`API record ${api.api_id || "unknown"} has no platform ID, skipping`, "warning")
            return false
        }

        const platformExists = platformsMap.has(platformId)
        if (!platformExists) {
            log(`API record ${api.api_id || "unknown"} references non-existent platform ${platformId}, skipping`, "warning")
            return false
        }

        return true
    })

    log(`Validated ${validAPIRecords.length}/${apiRecords.length} API records`, "info")
    return validAPIRecords
}

/**
 * Enrich API data using OpenAI
 */
async function enrichAPIData(api: API, platform: Platform): Promise<API> {
    try {
        log(`Enriching API data for platform: ${platform.platform_name}`, "info")

        const prompt = `
Provide accurate API information for the AI platform "${platform.platform_name}" in JSON format with the following fields:
- api_standards: API standards used (e.g., "REST, GraphQL", "REST only", "SOAP, REST")
- authentication_methods: Authentication methods supported (e.g., "API key, OAuth 2.0, JWT", "API key only")
- webhook_support: Whether webhooks are supported (e.g., "Yes", "No", "Limited")
- third_party_integrations: Third-party integrations available (e.g., "Slack, Zapier, GitHub, Salesforce")
- export_formats: Supported export formats (e.g., "JSON, CSV, XML", "JSON only")
- import_capabilities: Import capabilities (e.g., "Supports file uploads, URL imports", "Limited import capabilities")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}
API availability: ${platform.api_availability || "Unknown"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<API>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing API data, only updating null/undefined fields
        const updatedAPI: API = { ...api }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedAPI[key] === undefined || updatedAPI[key] === null || updatedAPI[key] === "") {
                updatedAPI[key] = enrichedData[key as keyof Partial<API>]
            }
        })

        updatedAPI.updatedAt = timestamp

        // Validate the enriched API data
        const validation = validateAPI(updatedAPI)
        if (!validation.valid) {
            log(
                `Validation issues with enriched API for ${platform.platform_name}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedAPI
    } catch (error: any) {
        log(`Error enriching API for ${platform.platform_name}: ${error.message}`, "error")
        return api
    }
}

/**
 * Process all API records with rate limiting
 */
async function processAPIWithRateLimit(apiRecords: API[], platformsMap: Map<string, Platform>): Promise<API[]> {
    const enrichedAPIRecords: API[] = []

    for (let i = 0; i < apiRecords.length; i++) {
        try {
            // Skip API records that already have all fields filled
            const api = apiRecords[i]
            const hasAllFields =
                api.api_standards &&
                api.authentication_methods &&
                api.webhook_support &&
                api.third_party_integrations &&
                api.export_formats

            if (hasAllFields) {
                log(`Skipping API ${i + 1}/${apiRecords.length}: ${api.api_id || "unknown"} (already complete)`, "info")
                enrichedAPIRecords.push(api)
                continue
            }

            // Get associated platform
            const platform = platformsMap.get(api.platform_id) as Platform

            // Enrich API data
            const enrichedAPI = await enrichAPIData(api, platform)
            enrichedAPIRecords.push(enrichedAPI)

            // Log progress
            log(`Processed API ${i + 1}/${apiRecords.length} for platform: ${platform.platform_name}`, "info")

            // Rate limiting delay (except  for platform: ${platform.platform_name}`, "info")

            // Rate limiting delay (except for last item)
            if (i < apiRecords.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing API ${apiRecords[i].api_id || "unknown"}: ${error.message}`, "error")
            enrichedAPIRecords.push(apiRecords[i]) // Add original data if enrichment fails
        }
    }

    return enrichedAPIRecords
}

/**
 * Update the api_integrations join table
 */
function updateAPIIntegrationsJoinTable(apiRecords: API[]): void {
    try {
        log("Updating api_integrations join table...", "info")

        // Load existing join table data
        let apiIntegrations: APIIntegration[] = []
        if (fs.existsSync(API_INTEGRATIONS_CSV_PATH)) {
            apiIntegrations = loadCsvData<APIIntegration>(API_INTEGRATIONS_CSV_PATH)
        }

        // Create a map of existing relationships
        const existingRelationships = new Set<string>()
        apiIntegrations.forEach((relation) => {
            existingRelationships.add(`${relation.api_id}-${relation.integration_id}`)
        })

        // Add new relationships based on third_party_integrations field
        const timestamp = new Date().toISOString()
        let newRelationsCount = 0

        apiRecords.forEach((api) => {
            if (api.third_party_integrations) {
                // Create a simple integration ID based on the integration name
                const integrations = api.third_party_integrations.split(",").map((i) => i.trim())

                integrations.forEach((integration) => {
                    if (integration) {
                        const integrationId = `int_${integration.toLowerCase().replace(/[^a-z0-9]/g, "_")}`
                        const relationKey = `${api.api_id}-${integrationId}`

                        if (!existingRelationships.has(relationKey)) {
                            apiIntegrations.push({
                                api_id: api.api_id,
                                integration_id: integrationId,
                                createdAt: timestamp,
                                updatedAt: timestamp,
                            })
                            existingRelationships.add(relationKey)
                            newRelationsCount++
                        }
                    }
                })
            }
        })

        // Save updated join table
        saveCsvData(API_INTEGRATIONS_CSV_PATH, apiIntegrations)
        log(`Updated api_integrations join table with ${newRelationsCount} new relationships`, "info")
    } catch (error: any) {
        log(`Error updating api_integrations join table: ${error.message}`, "error")
    }
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting API processing...", "info")

        // Load platforms and API records
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        let apiRecords = loadCsvData<API>(API_CSV_PATH)

        // Create backup of API file if it exists and has data
        if (fs.existsSync(API_CSV_PATH) && apiRecords.length > 0) {
            createBackup(API_CSV_PATH, BACKUP_DIR)
        }

        // Validate API records against platforms
        apiRecords = validateAPIAgainstPlatforms(apiRecords, platformsMap)

        // Enrich API data
        apiRecords = await processAPIWithRateLimit(apiRecords, platformsMap)

        // Save to CSV
        saveCsvData(API_CSV_PATH, apiRecords)

        // Update the api_integrations join table
        updateAPIIntegrationsJoinTable(apiRecords)

        log("API processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

