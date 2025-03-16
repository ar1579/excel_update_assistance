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
const TRAINING_CSV_PATH = path.join(DATA_DIR, "Training.csv")
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Training data structure
interface Training {
    training_id: string
    model_id: string
    training_data_size?: string
    training_data_notes?: string
    training_methodology?: string
    fine_tuning_supported?: string
    transfer_learning_supported?: string
    fine_tuning_performance?: string
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
    parameters_count?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

// Platform data structure
interface Platform {
    platform_id: string
    platform_name: string
    platform_category?: string
    platform_sub_category?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

/**
 * Validate training data against schema constraints
 */
function validateTraining(training: Training): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!training.model_id) {
        errors.push("model_id is required")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate training records against models
 */
function validateTrainingAgainstModels(trainingRecords: Training[], modelsMap: Map<string, Model>): Training[] {
    log("Validating training records against models...", "info")

    // If no training records, create default ones for testing
    if (trainingRecords.length === 0 && modelsMap.size > 0) {
        log("No training records found in CSV, creating default records for testing", "warning")
        const newTrainingRecords: Training[] = []

        // Create a default training record for each model
        for (const [modelId, model] of modelsMap.entries()) {
            const defaultTraining: Training = {
                training_id: `train_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                model_id: modelId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            newTrainingRecords.push(defaultTraining)
            log(`Created default training record for model: ${model.model_family} ${model.model_version}`, "info")
        }

        return newTrainingRecords
    }

    const validTrainingRecords = trainingRecords.filter((training) => {
        const modelId = training.model_id
        if (!modelId) {
            log(`Training ${training.training_id || "unknown"} has no model ID, skipping`, "warning")
            return false
        }

        const modelExists = modelsMap.has(modelId)
        if (!modelExists) {
            log(`Training ${training.training_id || "unknown"} references non-existent model ${modelId}, skipping`, "warning")
            return false
        }

        return true
    })

    log(`Validated ${validTrainingRecords.length}/${trainingRecords.length} training records`, "info")
    return validTrainingRecords
}

/**
 * Enrich training data using OpenAI
 */
async function enrichTrainingData(training: Training, model: Model, platform: Platform): Promise<Training> {
    try {
        log(`Enriching training data for model: ${model.model_family || ""} ${model.model_version || ""}`, "info")

        const prompt = `
Provide accurate training information for the AI model "${model.model_family || ""} ${model.model_version || ""}" from the platform "${platform.platform_name}" in JSON format with the following fields:
- training_data_size: Size of the training dataset (e.g., "1.4T tokens", "570GB of text", "45B examples")
- training_data_notes: Notes about the training data (e.g., "Trained on web data, books, and code", "Includes filtered web content and academic papers")
- training_methodology: Methodology used for training (e.g., "Supervised fine-tuning followed by RLHF", "Self-supervised learning on diverse corpus")
- fine_tuning_supported: Whether fine-tuning is supported ("Yes", "No", "Limited")
- transfer_learning_supported: Whether transfer learning is supported ("Yes", "No", "Limited")
- fine_tuning_performance: Information about fine-tuning performance (e.g., "Achieves 95% of base performance with 1000 examples", "Significant improvements on domain-specific tasks")

Additional context about the model:
Model type: ${model.model_type || "Unknown"}
Model architecture: ${model.model_architecture || "Unknown"}
Parameters count: ${model.parameters_count || "Unknown"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<Training>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing training data, only updating null/undefined fields
        const updatedTraining: Training = { ...training }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedTraining[key] === undefined || updatedTraining[key] === null || updatedTraining[key] === "") {
                updatedTraining[key] = enrichedData[key as keyof Partial<Training>]
            }
        })

        updatedTraining.updatedAt = timestamp

        // Validate the enriched training data
        const validation = validateTraining(updatedTraining)
        if (!validation.valid) {
            log(
                `Validation issues with enriched training for ${model.model_family || ""} ${model.model_version || ""}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedTraining
    } catch (error: any) {
        log(
            `Error enriching training for ${model.model_family || ""} ${model.model_version || ""}: ${error.message}`,
            "error",
        )
        return training
    }
}

/**
 * Process all training records with rate limiting
 */
async function processTrainingWithRateLimit(
    trainingRecords: Training[],
    modelsMap: Map<string, Model>,
    platformsMap: Map<string, Platform>,
): Promise<Training[]> {
    const enrichedTrainingRecords: Training[] = []

    for (let i = 0; i < trainingRecords.length; i++) {
        try {
            // Skip training records that already have all fields filled
            const training = trainingRecords[i]
            const hasAllFields =
                training.training_data_size &&
                training.training_methodology &&
                training.fine_tuning_supported &&
                training.transfer_learning_supported

            if (hasAllFields) {
                log(
                    `Skipping training ${i + 1}/${trainingRecords.length}: ${training.training_id || "unknown"} (already complete)`,
                    "info",
                )
                enrichedTrainingRecords.push(training)
                continue
            }

            // Get associated model
            const model = modelsMap.get(training.model_id) as Model

            // Get associated platform
            const platform = platformsMap.get(model.platform_id) as Platform

            // Enrich training data
            const enrichedTraining = await enrichTrainingData(training, model, platform)
            enrichedTrainingRecords.push(enrichedTraining)

            // Log progress
            log(
                `Processed training ${i + 1}/${trainingRecords.length} for model: ${model.model_family || ""} ${model.model_version || ""}`,
                "info",
            )

            // Rate limiting delay (except for last item)
            if (i < trainingRecords.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing training ${trainingRecords[i].training_id || "unknown"}: ${error.message}`, "error")
            enrichedTrainingRecords.push(trainingRecords[i]) // Add original data if enrichment fails
        }
    }

    return enrichedTrainingRecords
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting training processing...", "info")

        // Load models, platforms, and training records
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        const models = loadCsvData<Model>(MODELS_CSV_PATH)
        const modelsMap = createLookupMap(models, "model_id")

        let trainingRecords = loadCsvData<Training>(TRAINING_CSV_PATH)

        // Create backup of training file if it exists and has data
        if (fs.existsSync(TRAINING_CSV_PATH) && trainingRecords.length > 0) {
            createBackup(TRAINING_CSV_PATH, BACKUP_DIR)
        }

        // Validate training records against models
        trainingRecords = validateTrainingAgainstModels(trainingRecords, modelsMap)

        // Enrich training data
        trainingRecords = await processTrainingWithRateLimit(trainingRecords, modelsMap, platformsMap)

        // Save to CSV
        saveCsvData(TRAINING_CSV_PATH, trainingRecords)

        log("Training processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

