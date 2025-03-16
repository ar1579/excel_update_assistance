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
const FEATURES_CSV_PATH = path.join(DATA_DIR, "Features.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const PLATFORM_FEATURES_CSV_PATH = path.join(DATA_DIR, "platform_features.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Feature data structure
interface Feature {
    feature_id: string
    platform_id: string
    notable_features: string
    explainability_features?: string
    customization_options?: string
    bias_mitigation_approaches?: string
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

// Platform-Feature join table structure
interface PlatformFeature {
    platform_id: string
    feature_id: string
    createdAt?: string
    updatedAt?: string
}

/**
 * Validate feature data against schema constraints
 */
function validateFeature(feature: Feature): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!feature.platform_id) {
        errors.push("platform_id is required")
    }

    if (!feature.notable_features) {
        errors.push("notable_features is required")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate features against platforms
 */
function validateFeaturesAgainstPlatforms(features: Feature[], platformsMap: Map<string, Platform>): Feature[] {
    log("Validating features against platforms...", "info")

    // If no features, create default ones for testing
    if (features.length === 0 && platformsMap.size > 0) {
        log("No features found in CSV, creating default features for testing", "warning")
        const newFeatures: Feature[] = []

        // Create a default feature for each platform
        for (const [platformId, platform] of platformsMap.entries()) {
            const defaultFeature: Feature = {
                feature_id: `feat_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                platform_id: platformId,
                notable_features: "Basic AI capabilities",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            newFeatures.push(defaultFeature)
            log(`Created default feature for platform: ${platform.platform_name}`, "info")
        }

        return newFeatures
    }

    const validFeatures = features.filter((feature) => {
        const platformId = feature.platform_id
        if (!platformId) {
            log(`Feature ${feature.feature_id || "unknown"} has no platform ID, skipping`, "warning")
            return false
        }

        const platformExists = platformsMap.has(platformId)
        if (!platformExists) {
            log(
                `Feature ${feature.feature_id || "unknown"} references non-existent platform ${platformId}, skipping`,
                "warning",
            )
            return false
        }

        return true
    })

    log(`Validated ${validFeatures.length}/${features.length} features`, "info")
    return validFeatures
}

/**
 * Enrich feature data using OpenAI
 */
async function enrichFeatureData(feature: Feature, platform: Platform): Promise<Feature> {
    try {
        log(`Enriching feature data for platform: ${platform.platform_name}`, "info")

        const prompt = `
Provide accurate feature information for the AI platform "${platform.platform_name}" in JSON format with the following fields:
- notable_features: Key features of the platform (e.g., "Real-time translation, Voice recognition, Sentiment analysis")
- explainability_features: Features related to AI explainability (e.g., "Attention visualization, Feature importance, Decision explanations")
- customization_options: Available customization options (e.g., "Fine-tuning, Custom models, Parameter adjustments")
- bias_mitigation_approaches: Approaches to mitigate bias (e.g., "Diverse training data, Bias detection tools, Fairness metrics")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<Feature>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing feature data, only updating null/undefined fields
        const updatedFeature: Feature = { ...feature }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedFeature[key] === undefined || updatedFeature[key] === null || updatedFeature[key] === "") {
                updatedFeature[key] = enrichedData[key as keyof Partial<Feature>]
            }
        })

        updatedFeature.updatedAt = timestamp

        // Validate the enriched feature data
        const validation = validateFeature(updatedFeature)
        if (!validation.valid) {
            log(
                `Validation issues with enriched feature for ${platform.platform_name}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedFeature
    } catch (error: any) {
        log(`Error enriching feature for ${platform.platform_name}: ${error.message}`, "error")
        return feature
    }
}

/**
 * Process all features with rate limiting
 */
async function processFeaturesWithRateLimit(
    features: Feature[],
    platformsMap: Map<string, Platform>,
): Promise<Feature[]> {
    const enrichedFeatures: Feature[] = []

    for (let i = 0; i < features.length; i++) {
        try {
            // Skip features that already have all fields filled
            const feature = features[i]
            const hasAllFields =
                feature.notable_features &&
                feature.explainability_features &&
                feature.customization_options &&
                feature.bias_mitigation_approaches

            if (hasAllFields) {
                log(
                    `Skipping feature ${i + 1}/${features.length}: ${feature.feature_id || "unknown"} (already complete)`,
                    "info",
                )
                enrichedFeatures.push(feature)
                continue
            }

            // Get associated platform
            const platform = platformsMap.get(feature.platform_id) as Platform

            // Enrich feature data
            const enrichedFeature = await enrichFeatureData(feature, platform)
            enrichedFeatures.push(enrichedFeature)

            // Log progress
            log(`Processed feature ${i + 1}/${features.length} for platform: ${platform.platform_name}`, "info")

            // Rate limiting delay (except for last item)
            if (i < features.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing feature ${features[i].feature_id || "unknown"}: ${error.message}`, "error")
            enrichedFeatures.push(features[i]) // Add original data if enrichment fails
        }
    }

    return enrichedFeatures
}

/**
 * Update the platform_features join table
 */
function updatePlatformFeaturesJoinTable(features: Feature[]): void {
    try {
        log("Updating platform_features join table...", "info")

        // Load existing join table data
        let platformFeatures: PlatformFeature[] = []
        if (fs.existsSync(PLATFORM_FEATURES_CSV_PATH)) {
            platformFeatures = loadCsvData<PlatformFeature>(PLATFORM_FEATURES_CSV_PATH)
        }

        // Create a map of existing relationships
        const existingRelationships = new Set<string>()
        platformFeatures.forEach((relation) => {
            existingRelationships.add(`${relation.platform_id}-${relation.feature_id}`)
        })

        // Add new relationships
        const timestamp = new Date().toISOString()
        let newRelationsCount = 0

        features.forEach((feature) => {
            const relationKey = `${feature.platform_id}-${feature.feature_id}`
            if (!existingRelationships.has(relationKey)) {
                platformFeatures.push({
                    platform_id: feature.platform_id,
                    feature_id: feature.feature_id,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                })
                existingRelationships.add(relationKey)
                newRelationsCount++
            }
        })

        // Save updated join table
        saveCsvData(PLATFORM_FEATURES_CSV_PATH, platformFeatures)
        log(`Updated platform_features join table with ${newRelationsCount} new relationships`, "info")
    } catch (error: any) {
        log(`Error updating platform_features join table: ${error.message}`, "error")
    }
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting features processing...", "info")

        // Load platforms and features
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        let features = loadCsvData<Feature>(FEATURES_CSV_PATH)

        // Create backup of features file if it exists and has data
        if (fs.existsSync(FEATURES_CSV_PATH) && features.length > 0) {
            createBackup(FEATURES_CSV_PATH, BACKUP_DIR)
        }

        // Validate features against platforms
        features = validateFeaturesAgainstPlatforms(features, platformsMap)

        // Enrich feature data
        features = await processFeaturesWithRateLimit(features, platformsMap)

        // Save to CSV
        saveCsvData(FEATURES_CSV_PATH, features)

        // Update the platform_features join table
        updatePlatformFeaturesJoinTable(features)

        log("Features processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

