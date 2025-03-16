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
const TRIALS_CSV_PATH = path.join(DATA_DIR, "Trials.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const PRICING_CSV_PATH = path.join(DATA_DIR, "Pricing.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Trial data structure
interface Trial {
    trial_id: string
    platform_id: string
    free_trial_plan?: string
    trial_duration?: string
    trial_duration_unit?: string
    usage_limits?: string
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

// Pricing data structure
interface Pricing {
    pricing_id: string
    platform_id: string
    pricing_model?: string
    starting_price?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

/**
 * Validate trial data against schema constraints
 */
function validateTrial(trial: Trial): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!trial.platform_id) {
        errors.push("platform_id is required")
    }

    // Check trial_duration_unit constraint if present
    if (trial.trial_duration_unit && !["Day", "Week", "Month", "Year"].includes(trial.trial_duration_unit)) {
        errors.push("trial_duration_unit must be one of: Day, Week, Month, Year")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate trials against platforms
 */
function validateTrialsAgainstPlatforms(trials: Trial[], platformsMap: Map<string, Platform>): Trial[] {
    log("Validating trials against platforms...", "info")

    // If no trials, create default ones for testing
    if (trials.length === 0 && platformsMap.size > 0) {
        log("No trials found in CSV, creating default trials for testing", "warning")
        const newTrials: Trial[] = []

        // Create a default trial for each platform
        for (const [platformId, platform] of platformsMap.entries()) {
            const defaultTrial: Trial = {
                trial_id: `trial_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                platform_id: platformId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            newTrials.push(defaultTrial)
            log(`Created default trial for platform: ${platform.platform_name}`, "info")
        }

        return newTrials
    }

    const validTrials = trials.filter((trial) => {
        const platformId = trial.platform_id
        if (!platformId) {
            log(`Trial ${trial.trial_id || "unknown"} has no platform ID, skipping`, "warning")
            return false
        }

        const platformExists = platformsMap.has(platformId)
        if (!platformExists) {
            log(`Trial ${trial.trial_id || "unknown"} references non-existent platform ${platformId}, skipping`, "warning")
            return false
        }

        return true
    })

    log(`Validated ${validTrials.length}/${trials.length} trials`, "info")
    return validTrials
}

/**
 * Enrich trial data using OpenAI
 */
async function enrichTrialData(trial: Trial, platform: Platform, pricingMap: Map<string, Pricing>): Promise<Trial> {
    try {
        log(`Enriching trial data for platform: ${platform.platform_name}`, "info")

        // Get pricing information if available
        const pricing = Array.from(pricingMap.values()).find((p) => p.platform_id === platform.platform_id)
        const pricingInfo = pricing
            ? `Pricing model: ${pricing.pricing_model || "Unknown"}, Starting price: ${pricing.starting_price || "Unknown"}`
            : "No pricing information available"

        const prompt = `
Provide accurate free trial information about the AI platform "${platform.platform_name}" in JSON format with the following fields:
- free_trial_plan: Description of the free trial plan (e.g., "Basic features with limited usage", "Full access with time limit")
- trial_duration: The duration of the free trial as a number (e.g., "14", "30", "7")
- trial_duration_unit: The unit of the trial duration (must be one of: "Day", "Week", "Month", "Year")
- usage_limits: Any usage limits during the trial period (e.g., "1000 API calls", "5 users", "Limited to 100MB data")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}
${pricingInfo}

If any information is not known with confidence, use null for that field.
If the platform does not offer a free trial, set free_trial_plan to "None" and leave other fields as null.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<Trial>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing trial data, only updating null/undefined fields
        const updatedTrial: Trial = { ...trial }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedTrial[key] === undefined || updatedTrial[key] === null || updatedTrial[key] === "") {
                updatedTrial[key] = enrichedData[key as keyof Partial<Trial>]
            }
        })

        updatedTrial.updatedAt = timestamp

        // Validate the enriched trial data
        const validation = validateTrial(updatedTrial)
        if (!validation.valid) {
            log(
                `Validation issues with enriched trial for ${platform.platform_name}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedTrial
    } catch (error: any) {
        log(`Error enriching trial for ${platform.platform_name}: ${error.message}`, "error")
        return trial
    }
}

/**
 * Process all trials with rate limiting
 */
async function processTrialsWithRateLimit(
    trials: Trial[],
    platformsMap: Map<string, Platform>,
    pricingMap: Map<string, Pricing>,
): Promise<Trial[]> {
    const enrichedTrials: Trial[] = []

    for (let i = 0; i < trials.length; i++) {
        try {
            // Skip trials that already have all fields filled
            const trial = trials[i]
            const hasAllFields =
                trial.free_trial_plan && trial.trial_duration && trial.trial_duration_unit && trial.usage_limits

            if (hasAllFields) {
                log(`Skipping trial ${i + 1}/${trials.length}: ${trial.trial_id || "unknown"} (already complete)`, "info")
                enrichedTrials.push(trial)
                continue
            }

            // Get associated platform
            const platform = platformsMap.get(trial.platform_id) as Platform

            // Enrich trial data
            const enrichedTrial = await enrichTrialData(trial, platform, pricingMap)
            enrichedTrials.push(enrichedTrial)

            // Log progress
            log(`Processed trial ${i + 1}/${trials.length} for platform: ${platform.platform_name}`, "info")

            // Rate limiting delay (except for last item)
            if (i < trials.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing trial ${trials[i].trial_id || "unknown"}: ${error.message}`, "error")
            enrichedTrials.push(trials[i]) // Add original data if enrichment fails
        }
    }

    return enrichedTrials
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting trials processing...", "info")

        // Load platforms, pricing, and trials
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        const pricing = loadCsvData<Pricing>(PRICING_CSV_PATH)
        const pricingMap = createLookupMap(pricing, "pricing_id")

        let trials = loadCsvData<Trial>(TRIALS_CSV_PATH)

        // Create backup of trials file if it exists and has data
        if (fs.existsSync(TRIALS_CSV_PATH) && trials.length > 0) {
            createBackup(TRIALS_CSV_PATH, BACKUP_DIR)
        }

        // Validate trials against platforms
        trials = validateTrialsAgainstPlatforms(trials, platformsMap)

        // Enrich trial data
        trials = await processTrialsWithRateLimit(trials, platformsMap, pricingMap)

        // Save to CSV
        saveCsvData(TRIALS_CSV_PATH, trials)

        log("Trials processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

