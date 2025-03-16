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
const PERFORMANCE_CSV_PATH = path.join(DATA_DIR, "Performance.csv")
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Performance data structure
interface Performance {
    performance_id: string
    model_id: string
    performance_metrics?: string
    performance_score?: string
    accuracy_metrics?: string
    precision_metrics?: string
    recall_metrics?: string
    f1_score?: string
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
 * Validate performance data against schema constraints
 */
function validatePerformance(performance: Performance): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!performance.model_id) {
        errors.push("model_id is required")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate performance records against models
 */
function validatePerformanceAgainstModels(
    performanceRecords: Performance[],
    modelsMap: Map<string, Model>,
): Performance[] {
    log("Validating performance records against models...", "info")

    // If no performance records, create default ones for testing
    if (performanceRecords.length === 0 && modelsMap.size > 0) {
        log("No performance records found in CSV, creating default records for testing", "warning")
        const newPerformanceRecords: Performance[] = []

        // Create a default performance record for each model
        for (const [modelId, model] of modelsMap.entries()) {
            const defaultPerformance: Performance = {
                performance_id: `perf_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                model_id: modelId,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            newPerformanceRecords.push(defaultPerformance)
            log(`Created default performance record for model: ${model.model_family} ${model.model_version}`, "info")
        }

        return newPerformanceRecords
    }

    const validPerformanceRecords = performanceRecords.filter((performance) => {
        const modelId = performance.model_id
        if (!modelId) {
            log(`Performance ${performance.performance_id || "unknown"} has no model ID, skipping`, "warning")
            return false
        }

        const modelExists = modelsMap.has(modelId)
        if (!modelExists) {
            log(
                `Performance ${performance.performance_id || "unknown"} references non-existent model ${modelId}, skipping`,
                "warning",
            )
            return false
        }

        return true
    })

    log(`Validated ${validPerformanceRecords.length}/${performanceRecords.length} performance records`, "info")
    return validPerformanceRecords
}

/**
 * Enrich performance data using OpenAI
 */
async function enrichPerformanceData(performance: Performance, model: Model, platform: Platform): Promise<Performance> {
    try {
        log(`Enriching performance data for model: ${model.model_family || ""} ${model.model_version || ""}`, "info")

        const prompt = `
Provide accurate performance metrics for the AI model "${model.model_family || ""} ${model.model_version || ""}" from the platform "${platform.platform_name}" in JSON format with the following fields:
- performance_metrics: General performance metrics (e.g., "MMLU: 86.4%, GSM8k: 92.0%")
- performance_score: Overall performance score if available (e.g., "8.7/10", "92%")
- accuracy_metrics: Accuracy measurements (e.g., "95% on classification tasks")
- precision_metrics: Precision measurements (e.g., "0.92")
- recall_metrics: Recall measurements (e.g., "0.89")
- f1_score: F1 score if available (e.g., "0.905")

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
        const enrichedData = await makeOpenAIRequest<Partial<Performance>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing performance data, only updating null/undefined fields
        const updatedPerformance: Performance = { ...performance }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedPerformance[key] === undefined || updatedPerformance[key] === null || updatedPerformance[key] === "") {
                updatedPerformance[key] = enrichedData[key as keyof Partial<Performance>]
            }
        })

        updatedPerformance.updatedAt = timestamp

        // Validate the enriched performance data
        const validation = validatePerformance(updatedPerformance)
        if (!validation.valid) {
            log(
                `Validation issues with enriched performance for ${model.model_family || ""} ${model.model_version || ""}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedPerformance
    } catch (error: any) {
        log(
            `Error enriching performance for ${model.model_family || ""} ${model.model_version || ""}: ${error.message}`,
            "error",
        )
        return performance
    }
}

/**
 * Process all performance records with rate limiting
 */
async function processPerformanceWithRateLimit(
    performanceRecords: Performance[],
    modelsMap: Map<string, Model>,
    platformsMap: Map<string, Platform>,
): Promise<Performance[]> {
    const enrichedPerformanceRecords: Performance[] = []

    for (let i = 0; i < performanceRecords.length; i++) {
        try {
            // Skip performance records that already have all fields filled
            const performance = performanceRecords[i]
            const hasAllFields =
                performance.performance_metrics &&
                performance.accuracy_metrics &&
                performance.precision_metrics &&
                performance.recall_metrics &&
                performance.f1_score

            if (hasAllFields) {
                log(
                    `Skipping performance ${i + 1}/${performanceRecords.length}: ${performance.performance_id || "unknown"} (already complete)`,
                    "info",
                )
                enrichedPerformanceRecords.push(performance)
                continue
            }

            // Get associated model
            const model = modelsMap.get(performance.model_id) as Model

            // Get associated platform
            const platform = platformsMap.get(model.platform_id) as Platform

            // Enrich performance data
            const enrichedPerformance = await enrichPerformanceData(performance, model, platform)
            enrichedPerformanceRecords.push(enrichedPerformance)

            // Log progress
            log(
                `Processed performance ${i + 1}/${performanceRecords.length} for model: ${model.model_family || ""} ${model.model_version || ""}`,
                "info",
            )

            // Rate limiting delay (except for last item)
            if (i < performanceRecords.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(
                `Error processing performance ${performanceRecords[i].performance_id || "unknown"}: ${error.message}`,
                "error",
            )
            enrichedPerformanceRecords.push(performanceRecords[i]) // Add original data if enrichment fails
        }
    }

    return enrichedPerformanceRecords
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting performance processing...", "info")

        // Load models, platforms, and performance records
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        const models = loadCsvData<Model>(MODELS_CSV_PATH)
        const modelsMap = createLookupMap(models, "model_id")

        let performanceRecords = loadCsvData<Performance>(PERFORMANCE_CSV_PATH)

        // Create backup of performance file if it exists and has data
        if (fs.existsSync(PERFORMANCE_CSV_PATH) && performanceRecords.length > 0) {
            createBackup(PERFORMANCE_CSV_PATH, BACKUP_DIR)
        }

        // Validate performance records against models
        performanceRecords = validatePerformanceAgainstModels(performanceRecords, modelsMap)

        // Enrich performance data
        performanceRecords = await processPerformanceWithRateLimit(performanceRecords, modelsMap, platformsMap)

        // Save to CSV
        saveCsvData(PERFORMANCE_CSV_PATH, performanceRecords)

        log("Performance processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

