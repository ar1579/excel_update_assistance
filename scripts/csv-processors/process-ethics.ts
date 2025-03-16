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
const ETHICS_CSV_PATH = path.join(DATA_DIR, "Ethics.csv")
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Ethics data structure
interface Ethics {
    ethics_id: string
    model_id: string
    ethical_guidelines_url?: string
    bias_evaluation?: string
    fairness_metrics?: string
    transparency_score?: string
    environmental_impact?: string
    createdAt?: string
    updatedAt?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

// Model data structure
interface Model {
    model_id: string
    platform_id: string
    model_family?: string
    model_version?: string
    model_type?: string
    model_architecture?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

// Platform data structure
interface Platform {
    platform_id: string
    platform_name: string
    platform_category?: string
    platform_sub_category?: string
    platform_description?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

/**
 * Validate ethics data against schema constraints
 */
function validateEthics(ethics: Ethics): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!ethics.model_id) {
        errors.push("model_id is required")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate ethics records against models
 */
function validateEthicsAgainstModels(ethicsRecords: Ethics[], modelsMap: Map<string, Model>): Ethics[] {
    log("Validating ethics records against models...", "info")

    // If no ethics records, create default ones for testing
    if (ethicsRecords.length === 0 && modelsMap.size > 0) {
        log("No ethics records found in CSV, creating default records for testing", "warning")
        const newEthicsRecords: Ethics[] = []

        // Create a default ethics record for each model
        for (const [modelId, model] of modelsMap.entries()) {
            const defaultEthics: Ethics = {
                ethics_id: `eth_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                model_id: modelId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            newEthicsRecords.push(defaultEthics)
            log(`Created default ethics record for model: ${model.model_family} ${model.model_version}`, "info")
        }

        return newEthicsRecords
    }

    const validEthicsRecords = ethicsRecords.filter((ethics) => {
        const modelId = ethics.model_id
        if (!modelId) {
            log(`Ethics record ${ethics.ethics_id || "unknown"} has no model ID, skipping`, "warning")
            return false
        }

        const modelExists = modelsMap.has(modelId)
        if (!modelExists) {
            log(
                `Ethics record ${ethics.ethics_id || "unknown"} references non-existent model ${modelId}, skipping`,
                "warning",
            )
            return false
        }

        return true
    })

    log(`Validated ${validEthicsRecords.length}/${ethicsRecords.length} ethics records`, "info")
    return validEthicsRecords
}

/**
 * Enrich ethics data using OpenAI
 */
async function enrichEthicsData(ethics: Ethics, model: Model, platform: Platform): Promise<Ethics> {
    try {
        log(`Enriching ethics data for model: ${model.model_family || ""} ${model.model_version || ""}`, "info")

        const prompt = `
Provide accurate ethics information for the AI model "${model.model_family || ""} ${model.model_version || ""}" from the platform "${platform.platform_name}" in JSON format with the following fields:
- ethical_guidelines_url: URL to ethical guidelines or principles
- bias_evaluation: Information about bias evaluation (e.g., "Comprehensive bias testing conducted", "Limited bias evaluation")
- fairness_metrics: Fairness metrics used (e.g., "Demographic parity, Equal opportunity, Equalized odds")
- transparency_score: Score for transparency (e.g., "High", "Medium", "Low", or a numerical score like "8/10")
- environmental_impact: Information about environmental impact (e.g., "Carbon footprint: 123 tons CO2e", "Energy-efficient training methods used")

Additional context about the model:
Model type: ${model.model_type || "Unknown"}
Model architecture: ${model.model_architecture || "Unknown"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<Ethics>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing ethics data, only updating null/undefined fields
        const updatedEthics: Ethics = { ...ethics }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedEthics[key] === undefined || updatedEthics[key] === null || updatedEthics[key] === "") {
                updatedEthics[key] = enrichedData[key as keyof Partial<Ethics>]
            }
        })

        updatedEthics.updatedAt = timestamp

        // Validate the enriched ethics data
        const validation = validateEthics(updatedEthics)
        if (!validation.valid) {
            log(
                `Validation issues with enriched ethics for ${model.model_family || ""} ${model.model_version || ""}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedEthics
    } catch (error: any) {
        log(
            `Error enriching ethics for ${model.model_family || ""} ${model.model_version || ""}: ${error.message}`,
            "error",
        )
        return ethics
    }
}

/**
 * Process all ethics records with rate limiting
 */
async function processEthicsWithRateLimit(
    ethicsRecords: Ethics[],
    modelsMap: Map<string, Model>,
    platformsMap: Map<string, Platform>,
): Promise<Ethics[]> {
    const enrichedEthicsRecords: Ethics[] = []

    for (let i = 0; i < ethicsRecords.length; i++) {
        try {
            // Skip ethics records that already have all fields filled
            const ethics = ethicsRecords[i]
            const hasAllFields =
                ethics.ethical_guidelines_url &&
                ethics.bias_evaluation &&
                ethics.fairness_metrics &&
                ethics.transparency_score &&
                ethics.environmental_impact

            if (hasAllFields) {
                log(
                    `Skipping ethics ${i + 1}/${ethicsRecords.length}: ${ethics.ethics_id || "unknown"} (already complete)`,
                    "info",
                )
                enrichedEthicsRecords.push(ethics)
                continue
            }

            // Get associated model
            const model = modelsMap.get(ethics.model_id) as Model

            // Get associated platform
            const platform = platformsMap.get(model.platform_id) as Platform

            // Enrich ethics data
            const enrichedEthics = await enrichEthicsData(ethics, model, platform)
            enrichedEthicsRecords.push(enrichedEthics)

            // Log progress
            log(
                `Processed ethics ${i + 1}/${ethicsRecords.length} for model: ${model.model_family || ""} ${model.model_version || ""}`,
                "info",
            )

            // Rate limiting delay (except for last item)
            if (i < ethicsRecords.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing ethics ${ethicsRecords[i].ethics_id || "unknown"}: ${error.message}`, "error")
            enrichedEthicsRecords.push(ethicsRecords[i]) // Add original data if enrichment fails
        }
    }

    return enrichedEthicsRecords
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting ethics processing...", "info")

        // Load models, platforms, and ethics records
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        const models = loadCsvData<Model>(MODELS_CSV_PATH)
        const modelsMap = createLookupMap(models, "model_id")

        let ethicsRecords = loadCsvData<Ethics>(ETHICS_CSV_PATH)

        // Create backup of ethics file if it exists and has data
        if (fs.existsSync(ETHICS_CSV_PATH) && ethicsRecords.length > 0) {
            createBackup(ETHICS_CSV_PATH, BACKUP_DIR)
        }

        // Validate ethics records against models
        ethicsRecords = validateEthicsAgainstModels(ethicsRecords, modelsMap)

        // Enrich ethics data
        ethicsRecords = await processEthicsWithRateLimit(ethicsRecords, modelsMap, platformsMap)

        // Save to CSV
        saveCsvData(ETHICS_CSV_PATH, ethicsRecords)

        log("Ethics processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

