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
const USE_CASES_CSV_PATH = path.join(DATA_DIR, "Use_Cases.csv")
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const MODEL_USE_CASES_CSV_PATH = path.join(DATA_DIR, "model_use_cases.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Use Case data structure
interface UseCase {
    use_case_id: string
    model_id: string
    primary_use_case: string
    secondary_use_cases?: string
    specialized_domains?: string
    supported_tasks?: string
    limitations?: string
    typical_use_cases?: string
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

// Model-UseCase join table structure
interface ModelUseCase {
    model_id: string
    use_case_id: string
    createdAt?: string
    updatedAt?: string
}

/**
 * Validate use case data against schema constraints
 */
function validateUseCase(useCase: UseCase): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!useCase.model_id) {
        errors.push("model_id is required")
    }

    if (!useCase.primary_use_case) {
        errors.push("primary_use_case is required")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate use cases against models
 */
function validateUseCasesAgainstModels(useCases: UseCase[], modelsMap: Map<string, Model>): UseCase[] {
    log("Validating use cases against models...", "info")

    // If no use cases, create default ones for testing
    if (useCases.length === 0 && modelsMap.size > 0) {
        log("No use cases found in CSV, creating default use cases for testing", "warning")
        const newUseCases: UseCase[] = []

        // Create a default use case for each model
        for (const [modelId, model] of modelsMap.entries()) {
            const defaultUseCase: UseCase = {
                use_case_id: `uc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                model_id: modelId,
                primary_use_case: "General purpose AI",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            newUseCases.push(defaultUseCase)
            log(`Created default use case for model: ${model.model_family} ${model.model_version}`, "info")
        }

        return newUseCases
    }

    const validUseCases = useCases.filter((useCase) => {
        const modelId = useCase.model_id
        if (!modelId) {
            log(`Use case ${useCase.use_case_id || "unknown"} has no model ID, skipping`, "warning")
            return false
        }

        const modelExists = modelsMap.has(modelId)
        if (!modelExists) {
            log(`Use case ${useCase.use_case_id || "unknown"} references non-existent model ${modelId}, skipping`, "warning")
            return false
        }

        return true
    })

    log(`Validated ${validUseCases.length}/${useCases.length} use cases`, "info")
    return validUseCases
}

/**
 * Enrich use case data using OpenAI
 */
async function enrichUseCaseData(useCase: UseCase, model: Model, platform: Platform): Promise<UseCase> {
    try {
        log(`Enriching use case data for model: ${model.model_family || ""} ${model.model_version || ""}`, "info")

        const prompt = `
Provide accurate use case information for the AI model "${model.model_family || ""} ${model.model_version || ""}" from the platform "${platform.platform_name}" in JSON format with the following fields:
- primary_use_case: The main use case for this model (e.g., "Text generation", "Image recognition", "Code completion")
- secondary_use_cases: Other important use cases, comma-separated (e.g., "Translation, Summarization, Question answering")
- specialized_domains: Domains where this model excels, comma-separated (e.g., "Healthcare, Finance, Legal")
- supported_tasks: Specific tasks the model can perform (e.g., "Text classification, Named entity recognition, Sentiment analysis")
- limitations: Known limitations of the model (e.g., "Limited context window, Struggles with complex reasoning, Hallucinations")
- typical_use_cases: Examples of typical applications (e.g., "Customer support chatbots, Content generation for marketing, Code assistance for developers")

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
        const enrichedData = await makeOpenAIRequest<Partial<UseCase>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing use case data, only updating null/undefined fields
        const updatedUseCase: UseCase = { ...useCase }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedUseCase[key] === undefined || updatedUseCase[key] === null || updatedUseCase[key] === "") {
                updatedUseCase[key] = enrichedData[key as keyof Partial<UseCase>]
            }
        })

        updatedUseCase.updatedAt = timestamp

        // Validate the enriched use case data
        const validation = validateUseCase(updatedUseCase)
        if (!validation.valid) {
            log(
                `Validation issues with enriched use case for ${model.model_family || ""} ${model.model_version || ""}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedUseCase
    } catch (error: any) {
        log(
            `Error enriching use case for ${model.model_family || ""} ${model.model_version || ""}: ${error.message}`,
            "error",
        )
        return useCase
    }
}

/**
 * Process all use cases with rate limiting
 */
async function processUseCasesWithRateLimit(
    useCases: UseCase[],
    modelsMap: Map<string, Model>,
    platformsMap: Map<string, Platform>,
): Promise<UseCase[]> {
    const enrichedUseCases: UseCase[] = []

    for (let i = 0; i < useCases.length; i++) {
        try {
            // Skip use cases that already have all fields filled
            const useCase = useCases[i]
            const hasAllFields =
                useCase.primary_use_case &&
                useCase.secondary_use_cases &&
                useCase.specialized_domains &&
                useCase.supported_tasks &&
                useCase.limitations &&
                useCase.typical_use_cases

            if (hasAllFields) {
                log(
                    `Skipping use case ${i + 1}/${useCases.length}: ${useCase.use_case_id || "unknown"} (already complete)`,
                    "info",
                )
                enrichedUseCases.push(useCase)
                continue
            }

            // Get associated model
            const model = modelsMap.get(useCase.model_id) as Model

            // Get associated platform
            const platform = platformsMap.get(model.platform_id) as Platform

            // Enrich use case data
            const enrichedUseCase = await enrichUseCaseData(useCase, model, platform)
            enrichedUseCases.push(enrichedUseCase)

            // Log progress
            log(
                `Processed use case ${i + 1}/${useCases.length} for model: ${model.model_family || ""} ${model.model_version || ""}`,
                "info",
            )

            // Rate limiting delay (except for last item)
            if (i < useCases.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing use case ${useCases[i].use_case_id || "unknown"}: ${error.message}`, "error")
            enrichedUseCases.push(useCases[i]) // Add original data if enrichment fails
        }
    }

    return enrichedUseCases
}

/**
 * Update the model_use_cases join table
 */
function updateModelUseCasesJoinTable(useCases: UseCase[]): void {
    try {
        log("Updating model_use_cases join table...", "info")

        // Load existing join table data
        let modelUseCases: ModelUseCase[] = []
        if (fs.existsSync(MODEL_USE_CASES_CSV_PATH)) {
            modelUseCases = loadCsvData<ModelUseCase>(MODEL_USE_CASES_CSV_PATH)
        }

        // Create a map of existing relationships
        const existingRelationships = new Set<string>()
        modelUseCases.forEach((relation) => {
            existingRelationships.add(`${relation.model_id}-${relation.use_case_id}`)
        })

        // Add new relationships
        const timestamp = new Date().toISOString()
        let newRelationsCount = 0

        useCases.forEach((useCase) => {
            const relationKey = `${useCase.model_id}-${useCase.use_case_id}`
            if (!existingRelationships.has(relationKey)) {
                modelUseCases.push({
                    model_id: useCase.model_id,
                    use_case_id: useCase.use_case_id,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                })
                existingRelationships.add(relationKey)
                newRelationsCount++
            }
        })

        // Save updated join table
        saveCsvData(MODEL_USE_CASES_CSV_PATH, modelUseCases)
        log(`Updated model_use_cases join table with ${newRelationsCount} new relationships`, "info")
    } catch (error: any) {
        log(`Error updating model_use_cases join table: ${error.message}`, "error")
    }
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting use cases processing...", "info")

        // Load models, platforms, and use cases
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        const models = loadCsvData<Model>(MODELS_CSV_PATH)
        const modelsMap = createLookupMap(models, "model_id")

        let useCases = loadCsvData<UseCase>(USE_CASES_CSV_PATH)

        // Create backup of use cases file if it exists and has data
        if (fs.existsSync(USE_CASES_CSV_PATH) && useCases.length > 0) {
            createBackup(USE_CASES_CSV_PATH, BACKUP_DIR)
        }

        // Validate use cases against models
        useCases = validateUseCasesAgainstModels(useCases, modelsMap)

        // Enrich use case data
        useCases = await processUseCasesWithRateLimit(useCases, modelsMap, platformsMap)

        // Save to CSV
        saveCsvData(USE_CASES_CSV_PATH, useCases)

        // Update the model_use_cases join table
        updateModelUseCasesJoinTable(useCases)

        log("Use cases processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

