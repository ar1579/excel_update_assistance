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
interface Ethics {
  ethics_id: string
  model_id: string
  ethical_guidelines_url?: string
  bias_evaluation?: string
  fairness_metrics?: string
  transparency_score?: string
  environmental_impact?: string
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
const ETHICS_CSV_PATH = path.join(DATA_DIR, "Ethics.csv")
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateEthics(ethics: Ethics): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!ethics.ethics_id) errors.push("ethics_id is required")
  if (!ethics.model_id) errors.push("model_id is required")

  // URL validation
  if (ethics.ethical_guidelines_url && !ethics.ethical_guidelines_url.startsWith("http")) {
    errors.push("ethical_guidelines_url must be a valid URL")
  }

  // Numeric validations
  if (ethics.transparency_score) {
    const score = Number.parseFloat(ethics.transparency_score)
    if (isNaN(score) || score < 0 || score > 100) {
      errors.push("transparency_score must be a number between 0 and 100")
    }
  }

  return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(ethics: Ethics): boolean {
  return (
    !!ethics.bias_evaluation &&
    !!ethics.fairness_metrics &&
    !!ethics.transparency_score &&
    !!ethics.environmental_impact
  )
}

// ---- Enrichment via OpenAI ----
async function enrichEthics(ethics: Ethics, models: Model[], platforms: Platform[]): Promise<Ethics> {
  try {
    log(`Enriching ethics for: ${ethics.ethics_id}`, "info")

    const model = models.find((m) => m.model_id === ethics.model_id)
    if (!model) {
      log(`Model not found for ethics_id: ${ethics.ethics_id}`, "warning")
      return ethics
    }

    const platform = platforms.find((p) => p.platform_id === model.platform_id)
    const platformName = platform ? platform.platform_name : "Unknown Platform"

    const prompt = `
Provide enriched ethics data for the AI model "${model.model_family} ${model.model_version}" from platform "${platformName}" in the following JSON format:
{
  "ethical_guidelines_url": "URL to the model's ethical guidelines (if available)",
  "bias_evaluation": "Assessment of known biases in the model",
  "fairness_metrics": "Metrics used to evaluate fairness",
  "transparency_score": "A score from 0-100 representing the model's transparency",
  "environmental_impact": "Assessment of the model's environmental impact (e.g., carbon footprint)"
}

Return only the JSON object with realistic, accurate ethics information for this AI model.
        `
    const enriched = await makeOpenAIRequest<Partial<Ethics>>(openai, prompt)
    const enrichedEthics: Ethics = {
      ...ethics,
      ...enriched,
      updatedAt: new Date().toISOString(),
    }

    const validation = validateEthics(enrichedEthics)
    if (!validation.valid) {
      log(`Validation failed for ${ethics.ethics_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedEthics
  } catch (error: any) {
    log(`Failed to enrich ethics ${ethics.ethics_id}: ${error.message}`, "error")
    return ethics
  }
}

// ---- Processing ----
async function processEthics(ethicsRecords: Ethics[], models: Model[], platforms: Platform[]): Promise<Ethics[]> {
  const processed: Ethics[] = []

  for (let i = 0; i < ethicsRecords.length; i++) {
    const ethics = ethicsRecords[i]

    if (isComplete(ethics)) {
      log(`Skipping ${ethics.ethics_id} (already complete)`, "info")
      processed.push(ethics)
      continue
    }

    const enriched = await enrichEthics(ethics, models, platforms)
    processed.push(enriched)

    if (i < ethicsRecords.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting ethics processor...", "info")

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

    // Load or initialize ethics data
    const ethicsRecords = fs.existsSync(ETHICS_CSV_PATH) ? loadCsvData<Ethics>(ETHICS_CSV_PATH) : []

    // Create ethics entries for models without one
    const modelIds = new Set(ethicsRecords.map((e) => e.model_id))
    const newEthicsRecords: Ethics[] = []

    for (const model of models) {
      if (!modelIds.has(model.model_id)) {
        const newEthics: Ethics = {
          ethics_id: `ethics_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          model_id: model.model_id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        newEthicsRecords.push(newEthics)
        log(`Created new ethics entry for model: ${model.model_family} ${model.model_version}`, "info")
      }
    }

    const allEthicsRecords = [...ethicsRecords, ...newEthicsRecords]

    // Create backup if file exists
    if (fs.existsSync(ETHICS_CSV_PATH) && fs.statSync(ETHICS_CSV_PATH).size > 0) {
      createBackup(ETHICS_CSV_PATH, BACKUP_DIR)
    }

    // Process and enrich ethics
    const enriched = await processEthics(allEthicsRecords, models, platforms)
    saveCsvData(ETHICS_CSV_PATH, enriched)

    log(`Ethics processor complete. Processed ${enriched.length} records ✅`, "info")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

