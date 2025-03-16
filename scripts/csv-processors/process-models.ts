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
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Model data structure
interface Model {
    model_id: string
    platform_id: string
    model_family: string
    model_version: string
    model_variants?: string
    model_size?: string
    model_size_unit?: string
    model_type?: string
    model_architecture?: string
    parameters_count?: string
    context_window_size?: string
    token_limit?: string
    createdAt?: string
    updatedAt?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

// Platform data structure
interface Platform {
    platform_id: string
    platform_name: string
    company_id?: string
    platform_category?: string
    platform_sub_category?: string
    platform_description?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

/**
 * Validate model data against schema constraints
 */
function validateModel(model: Model): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!model.model_family) {
        errors.push("model_family is required")
    }

    if (!model.model_version) {
        errors.push("model_version is required")
    }

    if (!model.platform_id) {
        errors.push("platform_id is required")
    }

    // Check model_size_unit constraint if present
    if (model.model_size_unit && !["KB", "MB", "GB", "TB"].includes(model.model_size_unit)) {
        errors.push("model_size_unit must be one of: KB, MB, GB, TB")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate models against platforms
 */
function validateModelsAgainstPlatforms(models: Model[], platformsMap: Map<string, Platform>): Model[] {
    log("Validating models against platforms...", "info")

    // If no models, create a default one for testing
    if (models.length === 0 && platformsMap.size > 0) {
        log("No models found in CSV, creating a default model for testing", "warning")
        const platformId = Array.from(platformsMap.keys())[0]
        const platform = platformsMap.get(platformId)

        if (platform) {
            const defaultModel: Model = {
                model_id: `model_${Date.now()}`,
                platform_id: platformId,
                model_family: "GPT",
                model_version: "4",
                model_variants: "Base",
                model_architecture: "Transformer",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            models.push(defaultModel)
            log(`Created default model for platform: ${platform.platform_name}`, "info")
            return models
        }
    }

    const validModels = models.filter((model) => {
        const platformId = model.platform_id
        if (!platformId) {
            log(`Model ${model.model_id || "unknown"} has no platform ID, skipping`, "warning")
            return false
        }

        const platformExists = platformsMap.has(platformId)
        if (!platformExists) {
            log(`Model ${model.model_id || "unknown"} references non-existent platform ${platformId}, skipping`, "warning")
            return false
        }

        return true
    })

    log(`Validated ${validModels.length}/${models.length} models`, "info")
    return validModels
}

/**
 * Enrich model data using OpenAI
 */
async function enrichModelData(model: Model, platform: Platform): Promise<Model> {
    try {
        log(
            `Enriching data for model: ${model.model_id || model.model_family} (Platform: ${platform.platform_name})`,
            "info",
        )

        const prompt = `
Provide accurate information about the AI model "${model.model_family} ${model.model_version}" from the platform "${platform.platform_name}" in JSON format with the following fields:
- model_family: The family or group this model belongs to (e.g., "GPT", "BERT", "DALL-E", etc.)
- model_version: Version number or identifier (e.g., "1.0", "2", "3.5", etc.)
- model_variants: Any variants of this model, comma-separated (e.g., "Base, Fine-tuned, Quantized")
- model_type: Type of AI model (e.g., "LLM", "Transformer", "CV Model")
- model_architecture: Underlying architecture (e.g., "Transformer", "Diffusion", "CNN", etc.)
- parameters_count: Number of parameters (e.g., "7B", "175B", "1.5B", etc.)
- context_window_size: Maximum context window size in tokens (e.g., "2048", "4096", "8192", etc.)
- token_limit: Maximum token limit for input/output (e.g., "4096", "8192", "16384", etc.)
- model_size: Size of the model (e.g., "7B", "13B", "70B")
- model_size_unit: Unit of model size (must be one of: "KB", "MB", "GB", "TB")

Additional context about the platform: ${platform.platform_description || "No description available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<Model>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing model data, only updating null/undefined fields
        const updatedModel: Model = { ...model }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedModel[key] === undefined || updatedModel[key] === null || updatedModel[key] === "") {
                updatedModel[key] = enrichedData[key as keyof Partial<Model>]
            }
        })

        updatedModel.updatedAt = timestamp

        // Validate the enriched model data
        const validation = validateModel(updatedModel)
        if (!validation.valid) {
            log(
                `Validation issues with enriched model ${model.model_id || model.model_family}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedModel
    } catch (error: any) {
        log(`Error enriching model ${model.model_id || model.model_family}: ${error.message}`, "error")
        return model
    }
}

/**
 * Process all models with rate limiting
 */
async function processModelsWithRateLimit(models: Model[], platformsMap: Map<string, Platform>): Promise<Model[]> {
    const enrichedModels: Model[] = []

    for (let i = 0; i < models.length; i++) {
        try {
            // Skip models that already have all fields filled
            const model = models[i]
            const hasAllFields =
                model.model_family &&
                model.model_version &&
                model.model_type &&
                model.model_architecture &&
                model.parameters_count &&
                model.context_window_size &&
                model.token_limit &&
                model.model_size &&
                model.model_size_unit

            if (hasAllFields) {
                log(
                    `Skipping model ${i + 1}/${models.length}: ${model.model_id || model.model_family} (already complete)`,
                    "info",
                )
                enrichedModels.push(model)
                continue
            }

            // Get associated platform
            const platform = platformsMap.get(model.platform_id) as Platform

            // Enrich model data
            const enrichedModel = await enrichModelData(model, platform)
            enrichedModels.push(enrichedModel)

            // Log progress
            log(`Processed model ${i + 1}/${models.length}: ${enrichedModel.model_id || enrichedModel.model_family}`, "info")

            // Rate limiting delay (except for last item)
            if (i < models.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(
                `Error processing model ${models[i].model_id || models[i].model_family || "unknown"}: ${error.message}`,
                "error",
            )
            enrichedModels.push(models[i]) // Add original data if enrichment fails
        }
    }

    return enrichedModels
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting model processing...", "info")

        // Load platforms and models
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        let models = loadCsvData<Model>(MODELS_CSV_PATH)

        // Create backup of models file if it exists and has data
        if (fs.existsSync(MODELS_CSV_PATH) && models.length > 0) {
            createBackup(MODELS_CSV_PATH, BACKUP_DIR)
        }

        // Validate models against platforms
        models = validateModelsAgainstPlatforms(models, platformsMap)

        // Enrich model data
        models = await processModelsWithRateLimit(models, platformsMap)

        // Save to CSV
        saveCsvData(MODELS_CSV_PATH, models)

        log("Model processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

