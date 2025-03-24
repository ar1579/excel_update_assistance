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
interface UseCase {
  use_case_id: string
  model_id: string
  primary_use_case?: string
  secondary_use_case?: string
  specialized_domains?: string
  supported_tasks?: string
  limitations?: string
  typical_use_case?: string
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
const USE_CASES_CSV_PATH = path.join(DATA_DIR, "Use_Cases.csv")
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateUseCase(useCase: UseCase): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!useCase.use_case_id) errors.push("use_case_id is required")
  if (!useCase.model_id) errors.push("model_id is required")
  if (!useCase.primary_use_case) errors.push("primary_use_case is required")

  return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(useCase: UseCase): boolean {
  return (
    !!useCase.primary_use_case &&
    !!useCase.secondary_use_case &&
    !!useCase.specialized_domains &&
    !!useCase.supported_tasks &&
    !!useCase.limitations
  )
}

// ---- Enrichment via OpenAI ----
async function enrichUseCase(useCase: UseCase, models: Model[], platforms: Platform[]): Promise<UseCase> {
  try {
    log(`Enriching use case for: ${useCase.use_case_id}`, "info")

    const model = models.find((m) => m.model_id === useCase.model_id)
    if (!model) {
      log(`Model not found for use_case_id: ${useCase.use_case_id}`, "warning")
      return useCase
    }

    const platform = platforms.find((p) => p.platform_id === model.platform_id)
    const platformName = platform ? platform.platform_name : "Unknown Platform"
    const modelType = model.model_type || "LLM"

    const prompt = `
Provide enriched use case data for the AI model "${model.model_family} ${model.model_version}" from platform "${platformName}" in the following JSON format:
{
  "primary_use_case": "The main use case for this model",
  "secondary_use_case": "Secondary or additional use cases",
  "specialized_domains": "Specific domains where this model excels (e.g., healthcare, finance, legal)",
  "supported_tasks": "Specific tasks this model can perform",
  "limitations": "Known limitations or weaknesses of this model",
  "typical_use_case": "A detailed example of a typical use case scenario"
}

The model is of type "${modelType}". Return only the JSON object with realistic, accurate use case information for this type of AI model.
        `
    const enriched = await makeOpenAIRequest<Partial<UseCase>>(openai, prompt)
    const enrichedUseCase: UseCase = {
      ...useCase,
      ...enriched,
      updatedAt: new Date().toISOString(),
    }

    const validation = validateUseCase(enrichedUseCase)
    if (!validation.valid) {
      log(`Validation failed for ${useCase.use_case_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedUseCase
  } catch (error: any) {
    log(`Failed to enrich use case ${useCase.use_case_id}: ${error.message}`, "error")
    return useCase
  }
}

// ---- Processing ----
async function processUseCases(useCases: UseCase[], models: Model[], platforms: Platform[]): Promise<UseCase[]> {
  const processed: UseCase[] = []

  for (let i = 0; i < useCases.length; i++) {
    const useCase = useCases[i]

    if (isComplete(useCase)) {
      log(`Skipping ${useCase.use_case_id} (already complete)`, "info")
      processed.push(useCase)
      continue
    }

    const enriched = await enrichUseCase(useCase, models, platforms)
    processed.push(enriched)

    if (i < useCases.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting use cases processor...", "info")

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

    // Load or initialize use cases data
    const useCases = fs.existsSync(USE_CASES_CSV_PATH) ? loadCsvData<UseCase>(USE_CASES_CSV_PATH) : []

    // Create use case entries for models without one
    const modelWithUseCases = new Map<string, number>()
    for (const useCase of useCases) {
      const count = modelWithUseCases.get(useCase.model_id) || 0
      modelWithUseCases.set(useCase.model_id, count + 1)
    }

    const newUseCases: UseCase[] = []
    for (const model of models) {
      // Create at least one use case per model, up to 3 for important models
      const existingCount = modelWithUseCases.get(model.model_id) || 0
      const targetCount =
        model.model_family.toLowerCase().includes("gpt") ||
        model.model_family.toLowerCase().includes("llama") ||
        model.model_family.toLowerCase().includes("claude")
          ? 3
          : 1

      for (let i = existingCount; i < targetCount; i++) {
        const newUseCase: UseCase = {
          use_case_id: `use_case_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          model_id: model.model_id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        newUseCases.push(newUseCase)
        log(`Created new use case entry for model: ${model.model_family} ${model.model_version}`, "info")
        await applyRateLimit(100) // Small delay to ensure unique IDs
      }
    }

    const allUseCases = [...useCases, ...newUseCases]

    // Create backup if file exists
    if (fs.existsSync(USE_CASES_CSV_PATH) && fs.statSync(USE_CASES_CSV_PATH).size > 0) {
      createBackup(USE_CASES_CSV_PATH, BACKUP_DIR)
    }

    // Process and enrich use cases
    const enriched = await processUseCases(allUseCases, models, platforms)
    saveCsvData(USE_CASES_CSV_PATH, enriched)

    log(`Use cases processor complete. Processed ${enriched.length} records ✅`, "info")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

