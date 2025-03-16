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
const COMMUNITY_CSV_PATH = path.join(DATA_DIR, "Community.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Community data structure
interface Community {
    community_id: string
    platform_id: string
    community_size?: string
    community_engagement_score?: string
    user_rating?: string
    github_repository?: string
    stackoverflow_tags?: string
    academic_papers?: string
    case_studies?: string
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
 * Validate community data against schema constraints
 */
function validateCommunity(community: Community): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!community.platform_id) {
        errors.push("platform_id is required")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate community records against platforms
 */
function validateCommunityAgainstPlatforms(
    communityRecords: Community[],
    platformsMap: Map<string, Platform>,
): Community[] {
    log("Validating community records against platforms...", "info")

    // If no community records, create default ones for testing
    if (communityRecords.length === 0 && platformsMap.size > 0) {
        log("No community records found in CSV, creating default records for testing", "warning")
        const newCommunityRecords: Community[] = []

        // Create a default community record for each platform
        for (const [platformId, platform] of platformsMap.entries()) {
            const defaultCommunity: Community = {
                community_id: `comm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                platform_id: platformId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            newCommunityRecords.push(defaultCommunity)
            log(`Created default community record for platform: ${platform.platform_name}`, "info")
        }

        return newCommunityRecords
    }

    const validCommunityRecords = communityRecords.filter((community) => {
        const platformId = community.platform_id
        if (!platformId) {
            log(`Community record ${community.community_id || "unknown"} has no platform ID, skipping`, "warning")
            return false
        }

        const platformExists = platformsMap.has(platformId)
        if (!platformExists) {
            log(
                `Community record ${community.community_id || "unknown"} references non-existent platform ${platformId}, skipping`,
                "warning",
            )
            return false
        }

        return true
    })

    log(`Validated ${validCommunityRecords.length}/${communityRecords.length} community records`, "info")
    return validCommunityRecords
}

/**
 * Enrich community data using OpenAI
 */
async function enrichCommunityData(community: Community, platform: Platform): Promise<Community> {
    try {
        log(`Enriching community data for platform: ${platform.platform_name}`, "info")

        const prompt = `
Provide accurate community information for the AI platform "${platform.platform_name}" in JSON format with the following fields:
- community_size: Estimated size of the community (e.g., "Large (100k+)", "Medium (10k-100k)", "Small (<10k)")
- community_engagement_score: Score for community engagement (e.g., "High", "Medium", "Low", or a numerical score like "8/10")
- user_rating: Average user rating (e.g., "4.5/5", "8.7/10")
- github_repository: GitHub repository URL if open source
- stackoverflow_tags: StackOverflow tags related to the platform (e.g., "openai-gpt, chatgpt, openai-api")
- academic_papers: Information about academic papers (e.g., "50+ papers citing the platform", "Key papers published in NeurIPS")
- case_studies: Information about case studies (e.g., "Multiple case studies available on website", "Limited case studies")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<Community>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing community data, only updating null/undefined fields
        const updatedCommunity: Community = { ...community }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedCommunity[key] === undefined || updatedCommunity[key] === null || updatedCommunity[key] === "") {
                updatedCommunity[key] = enrichedData[key as keyof Partial<Community>]
            }
        })

        updatedCommunity.updatedAt = timestamp

        // Validate the enriched community data
        const validation = validateCommunity(updatedCommunity)
        if (!validation.valid) {
            log(
                `Validation issues with enriched community for ${platform.platform_name}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedCommunity
    } catch (error: any) {
        log(`Error enriching community for ${platform.platform_name}: ${error.message}`, "error")
        return community
    }
}

/**
 * Process all community records with rate limiting
 */
async function processCommunityWithRateLimit(
    communityRecords: Community[],
    platformsMap: Map<string, Platform>,
): Promise<Community[]> {
    const enrichedCommunityRecords: Community[] = []

    for (let i = 0; i < communityRecords.length; i++) {
        try {
            // Skip community records that already have all fields filled
            const community = communityRecords[i]
            const hasAllFields =
                community.community_size &&
                community.community_engagement_score &&
                community.user_rating &&
                community.github_repository &&
                community.stackoverflow_tags

            if (hasAllFields) {
                log(
                    `Skipping community ${i + 1}/${communityRecords.length}: ${community.community_id || "unknown"} (already complete)`,
                    "info",
                )
                enrichedCommunityRecords.push(community)
                continue
            }

            // Get associated platform
            const platform = platformsMap.get(community.platform_id) as Platform

            // Enrich community data
            const enrichedCommunity = await enrichCommunityData(community, platform)
            enrichedCommunityRecords.push(enrichedCommunity)

            // Log progress
            log(`Processed community ${i + 1}/${communityRecords.length} for platform: ${platform.platform_name}`, "info")

            // Rate limiting delay (except for last item)
            if (i < communityRecords.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing community ${communityRecords[i].community_id || "unknown"}: ${error.message}`, "error")
            enrichedCommunityRecords.push(communityRecords[i]) // Add original data if enrichment fails
        }
    }

    return enrichedCommunityRecords
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting community processing...", "info")

        // Load platforms and community records
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        let communityRecords = loadCsvData<Community>(COMMUNITY_CSV_PATH)

        // Create backup of community file if it exists and has data
        if (fs.existsSync(COMMUNITY_CSV_PATH) && communityRecords.length > 0) {
            createBackup(COMMUNITY_CSV_PATH, BACKUP_DIR)
        }

        // Validate community records against platforms
        communityRecords = validateCommunityAgainstPlatforms(communityRecords, platformsMap)

        // Enrich community data
        communityRecords = await processCommunityWithRateLimit(communityRecords, platformsMap)

        // Save to CSV
        saveCsvData(COMMUNITY_CSV_PATH, communityRecords)

        log("Community processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

