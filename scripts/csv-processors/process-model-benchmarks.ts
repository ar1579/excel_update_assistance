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
interface ModelBenchmark {
  model_benchmark_id: string
  model_id: string
  benchmark_id: string
  score?: string
  score_date?: string
  methodology?: string
  source_url?: string
  createdAt: string
  updatedAt: string
  [key: string]: string | undefined
}

interface Model {
  model_id: string
  model_family: string
  model_version: string
  platform_id: string
  [key: string]: string | undefined
}

interface Benchmark {
  benchmark_id: string
  benchmark_name: string
  [key: string]: string | undefined
}

// ---- File Paths ----
const DATA_DIR = path.join(process.cwd(), "data")
const MODEL_BENCHMARKS_CSV_PATH = path.join(DATA_DIR, "model_benchmarks.csv")
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const BENCHMARKS_CSV_PATH = path.join(DATA_DIR, "Benchmarks.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateModelBenchmark(modelBenchmark: ModelBenchmark): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!modelBenchmark.model_benchmark_id) errors.push("model_benchmark_id is required")
  if (!modelBenchmark.model_id) errors.push("model_id is required")
  if (!modelBenchmark.benchmark_id) errors.push("benchmark_id is required")

  // Date validation
  if (modelBenchmark.score_date) {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/
    if (!dateRegex.test(modelBenchmark.score_date)) {
      errors.push("score_date must be in YYYY-MM-DD format")
    }
  }

  // URL validation
  if (modelBenchmark.source_url && !modelBenchmark.source_url.startsWith("http")) {
    errors.push("source_url must be a valid URL")
  }

  return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(modelBenchmark: ModelBenchmark): boolean {
  return !!modelBenchmark.score && !!modelBenchmark.score_date && !!modelBenchmark.methodology
}

// ---- Enrichment via OpenAI ----
async function enrichModelBenchmark(
  modelBenchmark: ModelBenchmark,
  models: Model[],
  benchmarks: Benchmark[],
): Promise<ModelBenchmark> {
  try {
    log(`Enriching model benchmark for: ${modelBenchmark.model_benchmark_id}`, "info")

    const model = models.find((m) => m.model_id === modelBenchmark.model_id)
    if (!model) {
      log(`Model not found for model_benchmark_id: ${modelBenchmark.model_benchmark_id}`, "warning")
      return modelBenchmark
    }

    const benchmark = benchmarks.find((b) => b.benchmark_id === modelBenchmark.benchmark_id)
    if (!benchmark) {
      log(`Benchmark not found for model_benchmark_id: ${modelBenchmark.model_benchmark_id}`, "warning")
      return modelBenchmark
    }

    const prompt = `
Provide enriched model benchmark data for the AI model "${model.model_family} ${model.model_version}" on the benchmark "${benchmark.benchmark_name}" in the following JSON format:
{
  "score": "A realistic score for this model on this benchmark",
  "score_date": "Date when the benchmark was performed (YYYY-MM-DD format)",
  "methodology": "Description of the testing methodology used",
  "source_url": "URL to the source of the benchmark results (if available)"
}

Return only the JSON object with realistic, accurate benchmark information for this model.
        `
    const enriched = await makeOpenAIRequest<Partial<ModelBenchmark>>(openai, prompt)
    const enrichedModelBenchmark: ModelBenchmark = {
      ...modelBenchmark,
      ...enriched,
      updatedAt: new Date().toISOString(),
    }

    const validation = validateModelBenchmark(enrichedModelBenchmark)
    if (!validation.valid) {
      log(`Validation failed for ${modelBenchmark.model_benchmark_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedModelBenchmark
  } catch (error: any) {
    log(`Failed to enrich model benchmark ${modelBenchmark.model_benchmark_id}: ${error.message}`, "error")
    return modelBenchmark
  }
}

// ---- Processing ----
async function processModelBenchmarks(
  modelBenchmarks: ModelBenchmark[],
  models: Model[],
  benchmarks: Benchmark[],
): Promise<ModelBenchmark[]> {
  const processed: ModelBenchmark[] = []

  for (let i = 0; i < modelBenchmarks.length; i++) {
    const modelBenchmark = modelBenchmarks[i]

    if (isComplete(modelBenchmark)) {
      log(`Skipping ${modelBenchmark.model_benchmark_id} (already complete)`, "info")
      processed.push(modelBenchmark)
      continue
    }

    const enriched = await enrichModelBenchmark(modelBenchmark, models, benchmarks)
    processed.push(enriched)

    if (i < modelBenchmarks.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting model benchmarks processor...", "info")

    // Load models data
    if (!fs.existsSync(MODELS_CSV_PATH)) {
      log("Models.csv not found. Please run process-models.ts first.", "error")
      process.exit(1)
    }
    const models = loadCsvData<Model>(MODELS_CSV_PATH)
    log(`Loaded ${models.length} models`, "info")

    // Load benchmarks data
    if (!fs.existsSync(BENCHMARKS_CSV_PATH)) {
      log("Benchmarks.csv not found. Please run process-benchmarks.ts first.", "error")
      process.exit(1)
    }
    const benchmarks = loadCsvData<Benchmark>(BENCHMARKS_CSV_PATH)
    log(`Loaded ${benchmarks.length} benchmarks`, "info")

    // Load or initialize model benchmarks data
    const modelBenchmarks = fs.existsSync(MODEL_BENCHMARKS_CSV_PATH)
      ? loadCsvData<ModelBenchmark>(MODEL_BENCHMARKS_CSV_PATH)
      : []

    // Create model benchmark entries for model-benchmark pairs that don't exist
    const existingPairs = new Set(modelBenchmarks.map((mb) => `${mb.model_id}-${mb.benchmark_id}`))
    const newModelBenchmarks: ModelBenchmark[] = []

    // For each model, add connections to relevant benchmarks
    for (const model of models) {
      // Get all benchmarks for this model
      const modelBenchmarkIds = benchmarks
        .filter((b) => b.benchmark_id.includes(model.model_id))
        .map((b) => b.benchmark_id)

      // Add connections to these benchmarks if they don't exist
      for (const benchmarkId of modelBenchmarkIds) {
        const pairKey = `${model.model_id}-${benchmarkId}`
        if (!existingPairs.has(pairKey)) {
          const newModelBenchmark: ModelBenchmark = {
            model_benchmark_id: `model_benchmark_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            model_id: model.model_id,
            benchmark_id: benchmarkId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          newModelBenchmarks.push(newModelBenchmark)
          existingPairs.add(pairKey)
          log(`Created new model benchmark connection for model: ${model.model_family} ${model.model_version}`, "info")
          await applyRateLimit(100) // Small delay to ensure unique IDs
        }
      }
    }

    const allModelBenchmarks = [...modelBenchmarks, ...newModelBenchmarks]

    // Create backup if file exists
    if (fs.existsSync(MODEL_BENCHMARKS_CSV_PATH) && fs.statSync(MODEL_BENCHMARKS_CSV_PATH).size > 0) {
      createBackup(MODEL_BENCHMARKS_CSV_PATH, BACKUP_DIR)
    }

    // Process and enrich model benchmarks
    const enriched = await processModelBenchmarks(allModelBenchmarks, models, benchmarks)
    saveCsvData(MODEL_BENCHMARKS_CSV_PATH, enriched)

    log(`Model benchmarks processor complete. Processed ${enriched.length} records ✅`, "info")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

