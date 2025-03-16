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
const PRICING_CSV_PATH = path.join(DATA_DIR, "Pricing.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Pricing data structure
interface Pricing {
    pricing_id: string
    platform_id: string
    pricing_model?: string
    starting_price?: string
    enterprise_pricing?: string
    billing_frequency?: string
    custom_pricing_available?: string
    pricing_url?: string
    discount_options?: string
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
 * Validate pricing data against schema constraints
 */
function validatePricing(pricing: Pricing): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!pricing.platform_id) {
        errors.push("platform_id is required")
    }

    // Check pricing_model constraint if present
    if (pricing.pricing_model && !["Subscription", "One-Time", "Usage-Based", "Free"].includes(pricing.pricing_model)) {
        errors.push("pricing_model must be one of: Subscription, One-Time, Usage-Based, Free")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate pricing against platforms
 */
function validatePricingAgainstPlatforms(pricingRecords: Pricing[], platformsMap: Map<string, Platform>): Pricing[] {
    log("Validating pricing against platforms...", "info")

    // If no pricing records, create default ones for testing
    if (pricingRecords.length === 0 && platformsMap.size > 0) {
        log("No pricing records found in CSV, creating default pricing for testing", "warning")
        const newPricingRecords: Pricing[] = []

        // Create a default pricing record for each platform
        for (const [platformId, platform] of platformsMap.entries()) {
            const defaultPricing: Pricing = {
                pricing_id: `price_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                platform_id: platformId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            newPricingRecords.push(defaultPricing)
            log(`Created default pricing for platform: ${platform.platform_name}`, "info")
        }

        return newPricingRecords
    }

    const validPricingRecords = pricingRecords.filter((pricing) => {
        const platformId = pricing.platform_id
        if (!platformId) {
            log(`Pricing ${pricing.pricing_id || "unknown"} has no platform ID, skipping`, "warning")
            return false
        }

        const platformExists = platformsMap.has(platformId)
        if (!platformExists) {
            log(
                `Pricing ${pricing.pricing_id || "unknown"} references non-existent platform ${platformId}, skipping`,
                "warning",
            )
            return false
        }

        return true
    })

    log(`Validated ${validPricingRecords.length}/${pricingRecords.length} pricing records`, "info")
    return validPricingRecords
}

/**
 * Enrich pricing data using OpenAI
 */
async function enrichPricingData(pricing: Pricing, platform: Platform): Promise<Pricing> {
    try {
        log(`Enriching pricing data for platform: ${platform.platform_name}`, "info")

        const prompt = `
Provide accurate pricing information about the AI platform "${platform.platform_name}" in JSON format with the following fields:
- pricing_model: The pricing model used (must be one of: "Subscription", "One-Time", "Usage-Based", "Free")
- starting_price: The starting price or lowest tier price (e.g., "$10/month", "Free", "$0.0001 per token")
- enterprise_pricing: Information about enterprise pricing options (e.g., "Custom pricing available", "Starting at $10,000/year")
- billing_frequency: How often billing occurs (e.g., "Monthly", "Annual", "Pay-as-you-go")
- custom_pricing_available: Whether custom pricing is available ("Yes", "No")
- pricing_url: URL to the pricing page if available
- discount_options: Information about available discounts (e.g., "Annual commitment discount", "Academic discounts", "Startup program")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<Pricing>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing pricing data, only updating null/undefined fields
        const updatedPricing: Pricing = { ...pricing }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedPricing[key] === undefined || updatedPricing[key] === null || updatedPricing[key] === "") {
                updatedPricing[key] = enrichedData[key as keyof Partial<Pricing>]
            }
        })

        updatedPricing.updatedAt = timestamp

        // Validate the enriched pricing data
        const validation = validatePricing(updatedPricing)
        if (!validation.valid) {
            log(
                `Validation issues with enriched pricing for ${platform.platform_name}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedPricing
    } catch (error: any) {
        log(`Error enriching pricing for ${platform.platform_name}: ${error.message}`, "error")
        return pricing
    }
}

/**
 * Process all pricing records with rate limiting
 */
async function processPricingWithRateLimit(
    pricingRecords: Pricing[],
    platformsMap: Map<string, Platform>,
): Promise<Pricing[]> {
    const enrichedPricingRecords: Pricing[] = []

    for (let i = 0; i < pricingRecords.length; i++) {
        try {
            // Skip pricing records that already have all fields filled
            const pricing = pricingRecords[i]
            const hasAllFields =
                pricing.pricing_model && pricing.starting_price && pricing.billing_frequency && pricing.custom_pricing_available

            if (hasAllFields) {
                log(
                    `Skipping pricing ${i + 1}/${pricingRecords.length}: ${pricing.pricing_id || "unknown"} (already complete)`,
                    "info",
                )
                enrichedPricingRecords.push(pricing)
                continue
            }

            // Get associated platform
            const platform = platformsMap.get(pricing.platform_id) as Platform

            // Enrich pricing data
            const enrichedPricing = await enrichPricingData(pricing, platform)
            enrichedPricingRecords.push(enrichedPricing)

            // Log progress
            log(`Processed pricing ${i + 1}/${pricingRecords.length} for platform: ${platform.platform_name}`, "info")

            // Rate limiting delay (except for last item)
            if (i < pricingRecords.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing pricing ${pricingRecords[i].pricing_id || "unknown"}: ${error.message}`, "error")
            enrichedPricingRecords.push(pricingRecords[i]) // Add original data if enrichment fails
        }
    }

    return enrichedPricingRecords
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting pricing processing...", "info")

        // Load platforms and pricing
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        let pricingRecords = loadCsvData<Pricing>(PRICING_CSV_PATH)

        // Create backup of pricing file if it exists and has data
        if (fs.existsSync(PRICING_CSV_PATH) && pricingRecords.length > 0) {
            createBackup(PRICING_CSV_PATH, BACKUP_DIR)
        }

        // Validate pricing against platforms
        pricingRecords = validatePricingAgainstPlatforms(pricingRecords, platformsMap)

        // Enrich pricing data
        pricingRecords = await processPricingWithRateLimit(pricingRecords, platformsMap)

        // Save to CSV
        saveCsvData(PRICING_CSV_PATH, pricingRecords)

        log("Pricing processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

