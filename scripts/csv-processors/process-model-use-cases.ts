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
interface ModelUseCase {
  model_use_case_id: string
  model_id: string
  use_case_id: string
  suitability_rating?: string
  implementation_notes?: string
  success_stories?: string
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

interface UseCase {
  use_case_id: string
  primary_use_case: string
  [key: string]: string | undefined
}

// ---- File Paths ----
const DATA_DIR = path.join(process.cwd(), "data")
const MODEL_USE_CASES_CSV_PATH = path.join(DATA_DIR, "model_use_cases.csv")
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const USE_CASES_CSV_PATH = path.join(DATA_DIR, "Use_Cases.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateModelUseCase(modelUseCase: ModelUseCase): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!modelUseCase.model_use_case_id) errors.push("model_use_case_id is required")
  if (!modelUseCase.model_id) errors.push("model_id is required")
  if (!modelUseCase.use_case_id) errors.push("use_case_id is required")

  // Rating validation
  if (modelUseCase.suitability_rating && !["High", "Medium", "Low"].includes(modelUseCase.suitability_rating)) {
    errors.push("suitability_rating must be one of: High, Medium, Low")
  }

  return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(modelUseCase: ModelUseCase): boolean {
  return !!modelUseCase.suitability_rating && !!modelUseCase.implementation_notes
}

// ---- Enrichment via OpenAI ----
async function enrichModelUseCase(
  modelUseCase: ModelUseCase,
  models: Model[],
  useCases: UseCase[],
): Promise<ModelUseCase> {
  try {
    log(`Enriching model use case for: ${modelUseCase.model_use_case_id}`, "info")

    const model = models.find((m) => m.model_id === modelUseCase.model_id)
    if (!model) {
      log(`Model not found for model_use_case_id: ${modelUseCase.model_use_case_id}`, "warning")
      return modelUseCase
    }

    const useCase = useCases.find((uc) => uc.use_case_id === modelUseCase.use_case_id)
    if (!useCase) {
      log(`Use case not found for model_use_case_id: ${modelUseCase.model_use_case_id}`, "warning")
      return modelUseCase
    }

    const prompt = `
Provide enriched model use case data for the AI model "${model.model_family} ${model.model_version}" for the use case "${useCase.primary_use_case}" in the following JSON format:
{
  "suitability_rating": "One of: High, Medium, Low",
  "implementation_notes": "Notes on implementing this model for this use case",
  "success_stories": "Examples of successful implementations of this model for this use case"
}

Return only the JSON object with realistic, accurate information about how well this model fits this use case.
        `
    const enriched = await makeOpenAIRequest<Partial<ModelUseCase>>(openai, prompt)
    const enrichedModelUseCase: ModelUseCase = {
      ...modelUseCase,
      ...enriched,
      updatedAt: new Date().toISOString(),
    }

    const validation = validateModelUseCase(enrichedModelUseCase)
    if (!validation.valid) {
      log(`Validation failed for ${modelUseCase.model_use_case_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedModelUseCase
  } catch (error: any) {
    log(`Failed to enrich model use case ${modelUseCase.model_use_case_id}: ${error.message}`, "error")
    return modelUseCase
  }
}

// ---- Processing ----
async function processModelUseCases(
  modelUseCases: ModelUseCase[],
  models: Model[],
  useCases: UseCase[],
): Promise<ModelUseCase[]> {
  const processed: ModelUseCase[] = []

  for (let i = 0; i < modelUseCases.length; i++) {
    const modelUseCase = modelUseCases[i]

    if (isComplete(modelUseCase)) {
      log(`Skipping ${modelUseCase.model_use_case_id} (already complete)`, "info")
      processed.push(modelUseCase)
      continue
    }

    const enriched = await enrichModelUseCase(modelUseCase, models, useCases)
    processed.push(enriched)

    if (i < modelUseCases.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting model use cases processor...", "info")

    // Load models data
    if (!fs.existsSync(MODELS_CSV_PATH)) {
      log("Models.csv not found. Please run process-models.ts first.", "error")
      process.exit(1)
    }
    const models = loadCsvData<Model>(MODELS_CSV_PATH)
    log(`Loaded ${models.length} models`, "info")

    // Load use cases data
    if (!fs.existsSync(USE_CASES_CSV_PATH)) {
      log("Use_Cases.csv not found. Please run process-use-cases.ts first.", "error")
      process.exit(1)
    }
    const useCases = loadCsvData<UseCase>(USE_CASES_CSV_PATH)
    log(`Loaded ${useCases.length} use cases`, "info")

    // Load or initialize model use cases data
    const modelUseCases = fs.existsSync(MODEL_USE_CASES_CSV_PATH)
      ? loadCsvData<ModelUseCase>(MODEL_USE_CASES_CSV_PATH)
      : []

    // Create model use case entries for model-use case pairs that don't exist
    const existingPairs = new Set(modelUseCases.map((muc) => `${muc.model_id}-${muc.use_case_id}`))
    const newModelUseCases: ModelUseCase[] = []

    // For each model, add connections to relevant use cases
    for (const model of models) {
      // Get all use cases for this model
      const modelUseCaseIds = useCases
        .filter((uc) => uc.use_case_id.includes(model.model_id))
        .map((uc) => uc.use_case_id)

      // Add connections to these use cases if they don't exist
      for (const useCaseId of modelUseCaseIds) {
        const pairKey = `${model.model_id}-${useCaseId}`
        if (!existingPairs.has(pairKey)) {
          const newModelUseCase: ModelUseCase = {
            model_use_case_id: `model_use_case_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            model_id: model.model_id,
            use_case_id: useCaseId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          newModelUseCases.push(newModelUseCase)
          existingPairs.add(pairKey)
          log(`Created new model use case connection for model: ${model.model_family} ${model.model_version}`, "info")
          await applyRateLimit(100) // Small delay to ensure unique IDs
        }
      }
    }

    const allModelUseCases = [...modelUseCases, ...newModelUseCases]

    // Create backup if file exists
    if (fs.existsSync(MODEL_USE_CASES_CSV_PATH) && fs.statSync(MODEL_USE_CASES_CSV_PATH).size > 0) {
      createBackup(MODEL_USE_CASES_CSV_PATH, BACKUP_DIR)
    }

    // Process and enrich model use cases
    const enriched = await processModelUseCases(allModelUseCases, models, useCases)
    saveCsvData(MODEL_USE_CASES_CSV_PATH, enriched)

    log(`Model use cases processor complete. Processed ${enriched.length} records ✅`, "info")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

