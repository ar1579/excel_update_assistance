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
const BENCHMARKS_CSV_PATH = path.join(DATA_DIR, "Benchmarks.csv")
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const MODEL_BENCHMARKS_CSV_PATH = path.join(DATA_DIR, "model_benchmarks.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Benchmark data structure
interface Benchmark {
    benchmark_id: string
    model_id: string
    benchmark_name?: string
    benchmark_score?: string
    benchmark_details?: string
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
    [key: string]: string | undefined // Allow any string key for dynamic access
}

// Model-Benchmark join table structure
interface ModelBenchmark {
    model_id: string
    benchmark_id: string
    createdAt?: string
    updatedAt?: string
}

/**
 * Validate benchmark data against schema constraints
 */
function validateBenchmark(benchmark: Benchmark): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!benchmark.model_id) {
        errors.push("model_id is required")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate benchmarks against models
 */
function validateBenchmarksAgainstModels(benchmarks: Benchmark[], modelsMap: Map<string, Model>): Benchmark[] {
    log("Validating benchmarks against models...", "info")

    // If no benchmarks, create default ones for testing
    if (benchmarks.length === 0 && modelsMap.size > 0) {
        log("No benchmarks found in CSV, creating default benchmarks for testing", "warning")
        const newBenchmarks: Benchmark[] = []

        // Create default benchmarks for each model
        for (const [modelId, model] of modelsMap.entries()) {
            // Create common benchmarks based on model type
            const benchmarkTypes = ["MMLU", "HellaSwag", "TruthfulQA"]

            for (const benchmarkType of benchmarkTypes) {
                const defaultBenchmark: Benchmark = {
                    benchmark_id: `bench_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                    model_id: modelId,
                    benchmark_name: benchmarkType,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                }
                newBenchmarks.push(defaultBenchmark)
            }

            log(`Created default benchmarks for model: ${model.model_family} ${model.model_version}`, "info")
        }

        return newBenchmarks
    }

    const validBenchmarks = benchmarks.filter((benchmark) => {
        const modelId = benchmark.model_id
        if (!modelId) {
            log(`Benchmark ${benchmark.benchmark_id || "unknown"} has no model ID, skipping`, "warning")
            return false
        }

        const modelExists = modelsMap.has(modelId)
        if (!modelExists) {
            log(
                `Benchmark ${benchmark.benchmark_id || "unknown"} references non-existent model ${modelId}, skipping`,
                "warning",
            )
            return false
        }

        return true
    })

    log(`Validated ${validBenchmarks.length}/${benchmarks.length} benchmarks`, "info")
    return validBenchmarks
}

/**
 * Enrich benchmark data using OpenAI
 */
async function enrichBenchmarkData(benchmark: Benchmark, model: Model, platform: Platform): Promise<Benchmark> {
    try {
        log(
            `Enriching benchmark data for ${benchmark.benchmark_name || "benchmark"} on model: ${model.model_family || ""} ${model.model_version || ""}`,
            "info",
        )

        const prompt = `
Provide accurate benchmark information for the AI model "${model.model_family || ""} ${model.model_version || ""}" from the platform "${platform.platform_name}" for the benchmark "${benchmark.benchmark_name || "unknown benchmark"}" in JSON format with the following fields:
- benchmark_name: The name of the benchmark (e.g., "MMLU", "HellaSwag", "TruthfulQA", "GSM8k", "HumanEval")
- benchmark_score: The score achieved on this benchmark (e.g., "85.2%", "0.92", "72.4")
- benchmark_details: Additional details about the benchmark performance (e.g., "Performed well on reasoning tasks but struggled with world knowledge questions")

Additional context about the model:
Model type: ${model.model_type || "Unknown"}
Model architecture: ${model.model_architecture || "Unknown"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<Benchmark>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing benchmark data, only updating null/undefined fields
        const updatedBenchmark: Benchmark = { ...benchmark }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedBenchmark[key] === undefined || updatedBenchmark[key] === null || updatedBenchmark[key] === "") {
                updatedBenchmark[key] = enrichedData[key as keyof Partial<Benchmark>]
            }
        })

        updatedBenchmark.updatedAt = timestamp

        // Validate the enriched benchmark data
        const validation = validateBenchmark(updatedBenchmark)
        if (!validation.valid) {
            log(
                `Validation issues with enriched benchmark for ${model.model_family || ""} ${model.model_version || ""}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedBenchmark
    } catch (error: any) {
        log(
            `Error enriching benchmark for ${model.model_family || ""} ${model.model_version || ""}: ${error.message}`,
            "error",
        )
        return benchmark
    }
}

/**
 * Process all benchmarks with rate limiting
 */
async function processBenchmarksWithRateLimit(
    benchmarks: Benchmark[],
    modelsMap: Map<string, Model>,
    platformsMap: Map<string, Platform>,
): Promise<Benchmark[]> {
    const enrichedBenchmarks: Benchmark[] = []

    for (let i = 0; i < benchmarks.length; i++) {
        try {
            // Skip benchmarks that already have all fields filled
            const benchmark = benchmarks[i]
            const hasAllFields = benchmark.benchmark_name && benchmark.benchmark_score && benchmark.benchmark_details

            if (hasAllFields) {
                log(
                    `Skipping benchmark ${i + 1}/${benchmarks.length}: ${benchmark.benchmark_id || "unknown"} (already complete)`,
                    "info",
                )
                enrichedBenchmarks.push(benchmark)
                continue
            }

            // Get associated model
            const model = modelsMap.get(benchmark.model_id) as Model

            // Get associated platform
            const platform = platformsMap.get(model.platform_id) as Platform

            // Enrich benchmark data
            const enrichedBenchmark = await enrichBenchmarkData(benchmark, model, platform)
            enrichedBenchmarks.push(enrichedBenchmark)

            // Log progress
            log(
                `Processed benchmark ${i + 1}/${benchmarks.length} for model: ${model.model_family || ""} ${model.model_version || ""}`,
                "info",
            )

            // Rate limiting delay (except for last item)
            if (i < benchmarks.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing benchmark ${benchmarks[i].benchmark_id || "unknown"}: ${error.message}`, "error")
            enrichedBenchmarks.push(benchmarks[i]) // Add original data if enrichment fails
        }
    }

    return enrichedBenchmarks
}

/**
 * Update the model_benchmarks join table
 */
function updateModelBenchmarksJoinTable(benchmarks: Benchmark[]): void {
    try {
        log("Updating model_benchmarks join table...", "info")

        // Load existing join table data
        let modelBenchmarks: ModelBenchmark[] = []
        if (fs.existsSync(MODEL_BENCHMARKS_CSV_PATH)) {
            modelBenchmarks = loadCsvData<ModelBenchmark>(MODEL_BENCHMARKS_CSV_PATH)
        }

        // Create a map of existing relationships
        const existingRelationships = new Set<string>()
        modelBenchmarks.forEach((relation) => {
            existingRelationships.add(`${relation.model_id}-${relation.benchmark_id}`)
        })

        // Add new relationships
        const timestamp = new Date().toISOString()
        let newRelationsCount = 0

        benchmarks.forEach((benchmark) => {
            const relationKey = `${benchmark.model_id}-${benchmark.benchmark_id}`
            if (!existingRelationships.has(relationKey)) {
                modelBenchmarks.push({
                    model_id: benchmark.model_id,
                    benchmark_id: benchmark.benchmark_id,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                })
                existingRelationships.add(relationKey)
                newRelationsCount++
            }
        })

        // Save updated join table
        saveCsvData(MODEL_BENCHMARKS_CSV_PATH, modelBenchmarks)
        log(`Updated model_benchmarks join table with ${newRelationsCount} new relationships`, "info")
    } catch (error: any) {
        log(`Error updating model_benchmarks join table: ${error.message}`, "error")
    }
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting benchmarks processing...", "info")

        // Load models, platforms, and benchmarks
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        const models = loadCsvData<Model>(MODELS_CSV_PATH)
        const modelsMap = createLookupMap(models, "model_id")

        let benchmarks = loadCsvData<Benchmark>(BENCHMARKS_CSV_PATH)

        // Create backup of benchmarks file if it exists and has data
        if (fs.existsSync(BENCHMARKS_CSV_PATH) && benchmarks.length > 0) {
            createBackup(BENCHMARKS_CSV_PATH, BACKUP_DIR)
        }

        // Validate benchmarks against models
        benchmarks = validateBenchmarksAgainstModels(benchmarks, modelsMap)

        // Enrich benchmark data
        benchmarks = await processBenchmarksWithRateLimit(benchmarks, modelsMap, platformsMap)

        // Save to CSV
        saveCsvData(BENCHMARKS_CSV_PATH, benchmarks)

        // Update the model_benchmarks join table
        updateModelBenchmarksJoinTable(benchmarks)

        log("Benchmarks processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

