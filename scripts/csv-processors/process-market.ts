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
const MARKET_CSV_PATH = path.join(DATA_DIR, "Market.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Market data structure
interface Market {
    market_id: string
    platform_id: string
    user_count?: string
    adoption_rate?: string
    industry_penetration?: string
    typical_customer_profile?: string
    success_stories?: string
    direct_competitors?: string
    competitive_advantages?: string
    market_share?: string
    analyst_ratings?: string
    industry_awards?: string
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
 * Validate market data against schema constraints
 */
function validateMarket(market: Market): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!market.platform_id) {
        errors.push("platform_id is required")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate market records against platforms
 */
function validateMarketAgainstPlatforms(marketRecords: Market[], platformsMap: Map<string, Platform>): Market[] {
    log("Validating market records against platforms...", "info")

    // If no market records, create default ones for testing
    if (marketRecords.length === 0 && platformsMap.size > 0) {
        log("No market records found in CSV, creating default records for testing", "warning")
        const newMarketRecords: Market[] = []

        // Create a default market record for each platform
        for (const [platformId, platform] of platformsMap.entries()) {
            const defaultMarket: Market = {
                market_id: `mkt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                platform_id: platformId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            newMarketRecords.push(defaultMarket)
            log(`Created default market record for platform: ${platform.platform_name}`, "info")
        }

        return newMarketRecords
    }

    const validMarketRecords = marketRecords.filter((market) => {
        const platformId = market.platform_id
        if (!platformId) {
            log(`Market record ${market.market_id || "unknown"} has no platform ID, skipping`, "warning")
            return false
        }

        const platformExists = platformsMap.has(platformId)
        if (!platformExists) {
            log(
                `Market record ${market.market_id || "unknown"} references non-existent platform ${platformId}, skipping`,
                "warning",
            )
            return false
        }

        return true
    })

    log(`Validated ${validMarketRecords.length}/${marketRecords.length} market records`, "info")
    return validMarketRecords
}

/**
 * Enrich market data using OpenAI
 */
async function enrichMarketData(market: Market, platform: Platform): Promise<Market> {
    try {
        log(`Enriching market data for platform: ${platform.platform_name}`, "info")

        const prompt = `
Provide accurate market information for the AI platform "${platform.platform_name}" in JSON format with the following fields:
- user_count: Estimated number of users (e.g., "1M+", "500k-1M", "10k-50k")
- adoption_rate: Rate of adoption (e.g., "Rapid", "Moderate", "Slow", "Growing at 20% annually")
- industry_penetration: Industries where the platform has significant penetration (e.g., "Strong in healthcare, finance, and retail")
- typical_customer_profile: Profile of typical customers (e.g., "Enterprise companies with 1000+ employees", "Tech startups", "Research institutions")
- success_stories: Information about success stories (e.g., "Multiple Fortune 500 companies have reported ROI improvements", "Case studies available on website")
- direct_competitors: Direct competitors (e.g., "OpenAI, Anthropic, Cohere", "Google Cloud Vision, Amazon Rekognition")
- competitive_advantages: Competitive advantages (e.g., "Superior accuracy, Lower cost, Better documentation")
- market_share: Estimated market share (e.g., "15-20%", "Market leader with 30%", "Emerging player with <5%")
- analyst_ratings: Analyst ratings or mentions (e.g., "Gartner Leader Quadrant", "Forrester Wave Strong Performer")
- industry_awards: Industry awards received (e.g., "AI Breakthrough Award 2023", "Multiple industry recognitions")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<Market>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing market data, only updating null/undefined fields
        const updatedMarket: Market = { ...market }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedMarket[key] === undefined || updatedMarket[key] === null || updatedMarket[key] === "") {
                updatedMarket[key] = enrichedData[key as keyof Partial<Market>]
            }
        })

        updatedMarket.updatedAt = timestamp

        // Validate the enriched market data
        const validation = validateMarket(updatedMarket)
        if (!validation.valid) {
            log(
                `Validation issues with enriched market for ${platform.platform_name}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedMarket
    } catch (error: any) {
        log(`Error enriching market for ${platform.platform_name}: ${error.message}`, "error")
        return market
    }
}

/**
 * Process all market records with rate limiting
 */
async function processMarketWithRateLimit(
    marketRecords: Market[],
    platformsMap: Map<string, Platform>,
): Promise<Market[]> {
    const enrichedMarketRecords: Market[] = []

    for (let i = 0; i < marketRecords.length; i++) {
        try {
            // Skip market records that already have all fields filled
            const market = marketRecords[i]
            const hasAllFields =
                market.user_count &&
                market.adoption_rate &&
                market.industry_penetration &&
                market.typical_customer_profile &&
                market.direct_competitors &&
                market.competitive_advantages

            if (hasAllFields) {
                log(
                    `Skipping market ${i + 1}/${marketRecords.length}: ${market.market_id || "unknown"} (already complete)`,
                    "info",
                )
                enrichedMarketRecords.push(market)
                continue
            }

            // Get associated platform
            const platform = platformsMap.get(market.platform_id) as Platform

            // Enrich market data
            const enrichedMarket = await enrichMarketData(market, platform)
            enrichedMarketRecords.push(enrichedMarket)

            // Log progress
            log(`Processed market ${i + 1}/${marketRecords.length} for platform: ${platform.platform_name}`, "info")

            // Rate limiting delay (except for last item)
            if (i < marketRecords.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing market ${marketRecords[i].market_id || "unknown"}: ${error.message}`, "error")
            enrichedMarketRecords.push(marketRecords[i]) // Add original data if enrichment fails
        }
    }

    return enrichedMarketRecords
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting market processing...", "info")

        // Load platforms and market records
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        let marketRecords = loadCsvData<Market>(MARKET_CSV_PATH)

        // Create backup of market file if it exists and has data
        if (fs.existsSync(MARKET_CSV_PATH) && marketRecords.length > 0) {
            createBackup(MARKET_CSV_PATH, BACKUP_DIR)
        }

        // Validate market records against platforms
        marketRecords = validateMarketAgainstPlatforms(marketRecords, platformsMap)

        // Enrich market data
        marketRecords = await processMarketWithRateLimit(marketRecords, platformsMap)

        // Save to CSV
        saveCsvData(MARKET_CSV_PATH, marketRecords)

        log("Market processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

