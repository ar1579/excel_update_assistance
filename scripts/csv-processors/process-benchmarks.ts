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
interface Benchmark {
  benchmark_id: string
  model_id: string
  benchmark_name?: string
  benchmark_score?: string
  benchmark_details?: string
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
const BENCHMARKS_CSV_PATH = path.join(DATA_DIR, "Benchmarks.csv")
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateBenchmark(benchmark: Benchmark): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!benchmark.benchmark_id) errors.push("benchmark_id is required")
  if (!benchmark.model_id) errors.push("model_id is required")
  if (!benchmark.benchmark_name) errors.push("benchmark_name is required")

  // Numeric validations
  if (benchmark.benchmark_score) {
    const score = Number.parseFloat(benchmark.benchmark_score)
    if (isNaN(score)) {
      errors.push("benchmark_score must be a number")
    }
  }

  return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(benchmark: Benchmark): boolean {
  return !!benchmark.benchmark_name && !!benchmark.benchmark_score && !!benchmark.benchmark_details
}

// ---- Enrichment via OpenAI ----
async function enrichBenchmark(benchmark: Benchmark, models: Model[], platforms: Platform[]): Promise<Benchmark> {
  try {
    log(`Enriching benchmark for: ${benchmark.benchmark_id}`, "info")

    const model = models.find((m) => m.model_id === benchmark.model_id)
    if (!model) {
      log(`Model not found for benchmark_id: ${benchmark.benchmark_id}`, "warning")
      return benchmark
    }

    const platform = platforms.find((p) => p.platform_id === model.platform_id)
    const platformName = platform ? platform.platform_name : "Unknown Platform"
    const modelType = model.model_type || "LLM"

    const prompt = `
Provide enriched benchmark data for the AI model "${model.model_family} ${model.model_version}" from platform "${platformName}" in the following JSON format:
{
  "benchmark_name": "Name of a realistic benchmark test for this type of model (e.g., MMLU, HELM, SuperGLUE)",
  "benchmark_score": "A realistic score for this model on this benchmark (numeric value)",
  "benchmark_details": "Detailed description of the benchmark test and how this model performed"
}

The model is of type "${modelType}". Return only the JSON object with realistic, accurate benchmark information for this type of AI model.
        `
    const enriched = await makeOpenAIRequest<Partial<Benchmark>>(openai, prompt)
    const enrichedBenchmark: Benchmark = {
      ...benchmark,
      ...enriched,
      updatedAt: new Date().toISOString(),
    }

    const validation = validateBenchmark(enrichedBenchmark)
    if (!validation.valid) {
      log(`Validation failed for ${benchmark.benchmark_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedBenchmark
  } catch (error: any) {
    log(`Failed to enrich benchmark ${benchmark.benchmark_id}: ${error.message}`, "error")
    return benchmark
  }
}

// ---- Processing ----
async function processBenchmarks(
  benchmarks: Benchmark[],
  models: Model[],
  platforms: Platform[],
): Promise<Benchmark[]> {
  const processed: Benchmark[] = []

  for (let i = 0; i < benchmarks.length; i++) {
    const benchmark = benchmarks[i]

    if (isComplete(benchmark)) {
      log(`Skipping ${benchmark.benchmark_id} (already complete)`, "info")
      processed.push(benchmark)
      continue
    }

    const enriched = await enrichBenchmark(benchmark, models, platforms)
    processed.push(enriched)

    if (i < benchmarks.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting benchmarks processor...", "info")

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

    // Load or initialize benchmarks data
    const benchmarks = fs.existsSync(BENCHMARKS_CSV_PATH) ? loadCsvData<Benchmark>(BENCHMARKS_CSV_PATH) : []

    // Create benchmark entries for models without one
    const modelWithBenchmarks = new Map<string, number>()
    for (const benchmark of benchmarks) {
      const count = modelWithBenchmarks.get(benchmark.model_id) || 0
      modelWithBenchmarks.set(benchmark.model_id, count + 1)
    }

    const newBenchmarks: Benchmark[] = []
    for (const model of models) {
      // Create at least one benchmark per model, up to 3 for important models
      const existingCount = modelWithBenchmarks.get(model.model_id) || 0
      const targetCount =
        model.model_family.toLowerCase().includes("gpt") ||
        model.model_family.toLowerCase().includes("llama") ||
        model.model_family.toLowerCase().includes("claude")
          ? 3
          : 1

      for (let i = existingCount; i < targetCount; i++) {
        const newBenchmark: Benchmark = {
          benchmark_id: `benchmark_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          model_id: model.model_id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        newBenchmarks.push(newBenchmark)
        log(`Created new benchmark entry for model: ${model.model_family} ${model.model_version}`, "info")
        await applyRateLimit(100) // Small delay to ensure unique IDs
      }
    }

    const allBenchmarks = [...benchmarks, ...newBenchmarks]

    // Create backup if file exists
    if (fs.existsSync(BENCHMARKS_CSV_PATH) && fs.statSync(BENCHMARKS_CSV_PATH).size > 0) {
      createBackup(BENCHMARKS_CSV_PATH, BACKUP_DIR)
    }

    // Process and enrich benchmarks
    const enriched = await processBenchmarks(allBenchmarks, models, platforms)
    saveCsvData(BENCHMARKS_CSV_PATH, enriched)

    log(`Benchmarks processor complete. Processed ${enriched.length} records ✅`, "info")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

