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
interface Performance {
  performance_id: string
  model_id: string
  performance_metrics?: string
  performance_score?: string
  accuracy_metrics?: string
  precision_metrics?: string
  recall_metrics?: string
  f1_score?: string
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

interface Platform {
  platform_id: string
  platform_name: string
  [key: string]: string | undefined
}

// ---- File Paths ----
const DATA_DIR = path.join(process.cwd(), "data")
const PERFORMANCE_CSV_PATH = path.join(DATA_DIR, "Performance.csv")
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validatePerformance(performance: Performance): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!performance.performance_id) errors.push("performance_id is required")
  if (!performance.model_id) errors.push("model_id is required")

  // Numeric validations
  if (performance.performance_score) {
    const score = Number.parseFloat(performance.performance_score)
    if (isNaN(score) || score < 0 || score > 100) {
      errors.push("performance_score must be a number between 0 and 100")
    }
  }

  if (performance.accuracy_metrics) {
    const accuracy = Number.parseFloat(performance.accuracy_metrics)
    if (isNaN(accuracy) || accuracy < 0 || accuracy > 1) {
      errors.push("accuracy_metrics must be a number between 0 and 1")
    }
  }

  if (performance.precision_metrics) {
    const precision = Number.parseFloat(performance.precision_metrics)
    if (isNaN(precision) || precision < 0 || precision > 1) {
      errors.push("precision_metrics must be a number between 0 and 1")
    }
  }

  if (performance.recall_metrics) {
    const recall = Number.parseFloat(performance.recall_metrics)
    if (isNaN(recall) || recall < 0 || recall > 1) {
      errors.push("recall_metrics must be a number between 0 and 1")
    }
  }

  if (performance.f1_score) {
    const f1 = Number.parseFloat(performance.f1_score)
    if (isNaN(f1) || f1 < 0 || f1 > 1) {
      errors.push("f1_score must be a number between 0 and 1")
    }
  }

  return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(performance: Performance): boolean {
  return (
    !!performance.performance_metrics &&
    !!performance.performance_score &&
    !!performance.accuracy_metrics &&
    !!performance.precision_metrics &&
    !!performance.recall_metrics &&
    !!performance.f1_score
  )
}

// ---- Enrichment via OpenAI ----
async function enrichPerformance(
  performance: Performance,
  models: Model[],
  platforms: Platform[],
): Promise<Performance> {
  try {
    log(`Enriching performance for: ${performance.performance_id}`, "info")

    const model = models.find((m) => m.model_id === performance.model_id)
    if (!model) {
      log(`Model not found for performance_id: ${performance.performance_id}`, "warning")
      return performance
    }

    const platform = platforms.find((p) => p.platform_id === model.platform_id)
    const platformName = platform ? platform.platform_name : "Unknown Platform"

    const prompt = `
Provide enriched performance data for the AI model "${model.model_family} ${model.model_version}" from platform "${platformName}" in the following JSON format:
{
  "performance_metrics": "Description of key performance metrics for this model",
  "performance_score": "Overall performance score between 0-100",
  "accuracy_metrics": "Accuracy score between 0-1",
  "precision_metrics": "Precision score between 0-1",
  "recall_metrics": "Recall score between 0-1",
  "f1_score": "F1 score between 0-1"
}

Return only the JSON object with realistic, accurate performance metrics for this type of AI model.
        `
    const enriched = await makeOpenAIRequest<Partial<Performance>>(openai, prompt)
    const enrichedPerformance: Performance = {
      ...performance,
      ...enriched,
      updatedAt: new Date().toISOString(),
    }

    const validation = validatePerformance(enrichedPerformance)
    if (!validation.valid) {
      log(`Validation failed for ${performance.performance_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedPerformance
  } catch (error: any) {
    log(`Failed to enrich performance ${performance.performance_id}: ${error.message}`, "error")
    return performance
  }
}

// ---- Processing ----
async function processPerformances(
  performances: Performance[],
  models: Model[],
  platforms: Platform[],
): Promise<Performance[]> {
  const processed: Performance[] = []

  for (let i = 0; i < performances.length; i++) {
    const performance = performances[i]

    if (isComplete(performance)) {
      log(`Skipping ${performance.performance_id} (already complete)`, "info")
      processed.push(performance)
      continue
    }

    const enriched = await enrichPerformance(performance, models, platforms)
    processed.push(enriched)

    if (i < performances.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting performance processor...", "info")

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

    // Load or initialize performance data
    const performances = fs.existsSync(PERFORMANCE_CSV_PATH) ? loadCsvData<Performance>(PERFORMANCE_CSV_PATH) : []

    // Create performance entries for models without one
    const modelIds = new Set(performances.map((p) => p.model_id))
    const newPerformances: Performance[] = []

    for (const model of models) {
      if (!modelIds.has(model.model_id)) {
        const newPerformance: Performance = {
          performance_id: `performance_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          model_id: model.model_id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        newPerformances.push(newPerformance)
        log(`Created new performance entry for model: ${model.model_family} ${model.model_version}`, "info")
      }
    }

    const allPerformances = [...performances, ...newPerformances]

    // Create backup if file exists
    if (fs.existsSync(PERFORMANCE_CSV_PATH) && fs.statSync(PERFORMANCE_CSV_PATH).size > 0) {
      createBackup(PERFORMANCE_CSV_PATH, BACKUP_DIR)
    }

    // Process and enrich performances
    const enriched = await processPerformances(allPerformances, models, platforms)
    saveCsvData(PERFORMANCE_CSV_PATH, enriched)

    log(`Performance processor complete. Processed ${enriched.length} records ✅`, "info")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

