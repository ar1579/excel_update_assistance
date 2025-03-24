import fs from "fs"
import path from "path"
import dotenv from "dotenv"
import { log } from "../../utils/logging"
import { createBackup, loadCsvData, saveCsvData } from "../../utils/file-utils"
import { initializeOpenAI, makeOpenAIRequest, applyRateLimit } from "../../utils/openai-utils"

// Load env
dotenv.config()

if (!process.env.OPENAI_API_KEY) {
    log("Missing OpenAI API Key", "error")
    process.exit(1)
}

const openai = initializeOpenAI(process.env.OPENAI_API_KEY!)
const DELAY = 1000

// ---- Define Types ----
interface Training {
    training_id: string
    model_id: string
    training_data_size?: string
    training_data_notes?: string
    training_methodology?: string
    fine_tuning_supported?: string
    transfer_learning_supported?: string
    fine_tuning_performance?: string
    createdAt: string
    updatedAt: string
    [key: string]: string | undefined
}

interface Model {
    model_id: string
    model_family: string
    model_version: string
    platform_id: string
    model_type?: string
    [key: string]: string | undefined
}

interface Platform {
    platform_id: string
    platform_name: string
    [key: string]: string | undefined
}

// ---- File Paths ----
const DATA_DIR = path.join(process.cwd(), "data")
const TRAINING_CSV_PATH = path.join(DATA_DIR, "Training.csv")
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateTraining(training: Training): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    if (!training.training_id) errors.push("training_id is required")
    if (!training.model_id) errors.push("model_id is required")

    // Boolean validations
    if (training.fine_tuning_supported && !["Yes", "No", "Limited"].includes(training.fine_tuning_supported)) {
        errors.push("fine_tuning_supported must be one of: Yes, No, Limited")
    }

    if (
        training.transfer_learning_supported &&
        !["Yes", "No", "Limited"].includes(training.transfer_learning_supported)
    ) {
        errors.push("transfer_learning_supported must be one of: Yes, No, Limited")
    }

    return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(training: Training): boolean {
    return (
        !!training.training_data_size &&
        !!training.training_methodology &&
        !!training.fine_tuning_supported &&
        !!training.transfer_learning_supported
    )
}

// ---- Enrichment via OpenAI ----
async function enrichTraining(training: Training, models: Model[], platforms: Platform[]): Promise<Training> {
    try {
        log(`Enriching training data for: ${training.training_id}`, "info")

        const model = models.find((m) => m.model_id === training.model_id)
        if (!model) {
            log(`Model not found for training_id: ${training.training_id}`, "warning")
            return training
        }

        const platform = platforms.find((p) => p.platform_id === model.platform_id)
        const platformName = platform ? platform.platform_name : "Unknown Platform"
        const modelType = model.model_type || "LLM"

        const prompt = `
Provide enriched training data for the AI model "${model.model_family} ${model.model_version}" from platform "${platformName}" in the following JSON format:
{
  "training_data_size": "Size of the training dataset (e.g., 1.5TB, 300B tokens)",
  "training_data_notes": "Notes about the training data sources and composition",
  "training_methodology": "Description of the training methodology used",
  "fine_tuning_supported": "One of: Yes, No, Limited",
  "transfer_learning_supported": "One of: Yes, No, Limited",
  "fine_tuning_performance": "Description of fine-tuning performance and capabilities"
}

The model is of type "${modelType}". Return only the JSON object with realistic, accurate training information for this type of AI model.
        `
        const enriched = await makeOpenAIRequest<Partial<Training>>(openai, prompt)
        const enrichedTraining: Training = {
            ...training,
            ...enriched,
            updatedAt: new Date().toISOString(),
        }

        const validation = validateTraining(enrichedTraining)
        if (!validation.valid) {
            log(`Validation failed for ${training.training_id}: ${validation.errors.join(", ")}`, "warning")
        }

        return enrichedTraining
    } catch (error: any) {
        log(`Failed to enrich training ${training.training_id}: ${error.message}`, "error")
        return training
    }
}

// ---- Processing ----
async function processTrainings(trainings: Training[], models: Model[], platforms: Platform[]): Promise<Training[]> {
    const processed: Training[] = []

    for (let i = 0; i < trainings.length; i++) {
        const training = trainings[i]

        if (isComplete(training)) {
            log(`Skipping ${training.training_id} (already complete)`, "info")
            processed.push(training)
            continue
        }

        const enriched = await enrichTraining(training, models, platforms)
        processed.push(enriched)

        if (i < trainings.length - 1) {
            await applyRateLimit(DELAY)
        }
    }

    return processed
}

// ---- Main ----
async function main() {
    try {
        log("Starting training processor...", "info")

        // Load models data
        if (!fs.existsSync(MODELS_CSV_PATH)) {
            log("Models.csv not found. Please run process-models.ts first.", "error")
            process.exit(1)
        }
        const models = loadCsvData<Model>(MODELS_CSV_PATH)
        log(`Loaded ${models.length} models`, "info")

        // Load platforms data
        if (!fs.existsSync(PLATFORMS_CSV_PATH)) {
            log("Platforms.csv not found. Please run process-platforms.ts first.", "error")
            process.exit(1)
        }
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        log(`Loaded ${platforms.length} platforms`, "info")

        // Load or initialize training data
        const trainings = fs.existsSync(TRAINING_CSV_PATH) ? loadCsvData<Training>(TRAINING_CSV_PATH) : []

        // Create training entries for models without one
        const modelIds = new Set(trainings.map((t) => t.model_id))
        const newTrainings: Training[] = []

        for (const model of models) {
            if (!modelIds.has(model.model_id)) {
                const newTraining: Training = {
                    training_id: `training_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                    model_id: model.model_id,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                }
                newTrainings.push(newTraining)
                log(`Created new training entry for model: ${model.model_family} ${model.model_version}`, "info")
            }
        }

        const allTrainings = [...trainings, ...newTrainings]

        // Create backup if file exists
        if (fs.existsSync(TRAINING_CSV_PATH) && fs.statSync(TRAINING_CSV_PATH).size > 0) {
            createBackup(TRAINING_CSV_PATH, BACKUP_DIR)
        }

        // Process and enrich trainings
        const enriched = await processTrainings(allTrainings, models, platforms)
        saveCsvData(TRAINING_CSV_PATH, enriched)

        log(`Training processor complete. Processed ${enriched.length} records ✅`, "info")
    } catch (error: any) {
        log(`Unhandled error: ${error.message}`, "error")
        process.exit(1)
    }
}

main()

