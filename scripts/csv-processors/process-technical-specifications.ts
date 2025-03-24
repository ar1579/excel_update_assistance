import fs from "fs"
import path from "path"
import dotenv from "dotenv"
import { log } from "../../utils/logging"
import { createBackup, loadCsvData, saveCsvData, createLookupMap } from "../../utils/file-utils"
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
interface TechnicalSpecification {
  spec_id: string
  model_id: string
  input_types?: string
  output_types?: string
  supported_languages?: string
  hardware_requirements?: string
  gpu_acceleration?: string
  latency?: string
  inference_time?: string
  training_time?: string
  compatible_frameworks?: string
  minimum_requirements?: string
  optimal_requirements?: string
  dependency_information?: string
  createdAt?: string
  updatedAt?: string
  [key: string]: string | undefined
}

interface Model {
  model_id: string
  platform_id: string
  model_family?: string
  model_version?: string
  model_type?: string
  model_architecture?: string
  parameters_count?: string
  [key: string]: string | undefined
}

interface Platform {
  platform_id: string
  platform_name: string
  platform_category?: string
  platform_sub_category?: string
  [key: string]: string | undefined
}

// ---- File Paths ----
const DATA_DIR = path.join(process.cwd(), "data")
const TECHNICAL_SPECS_CSV_PATH = path.join(DATA_DIR, "Technical_Specifications.csv")
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateTechnicalSpecification(spec: TechnicalSpecification): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!spec.spec_id) errors.push("spec_id is required")
  if (!spec.model_id) errors.push("model_id is required")

  return { valid: errors.length === 0, errors }
}

// ---- Validate specs against models ----
function validateSpecsAgainstModels(
  specs: TechnicalSpecification[],
  modelsMap: Map<string, Model>,
): TechnicalSpecification[] {
  log("Validating technical specifications against models...", "info")

  // If no specs, create default ones for testing
  if (specs.length === 0 && modelsMap.size > 0) {
    log("No technical specifications found in CSV, creating default specs for testing", "warning")
    const newSpecs: TechnicalSpecification[] = []

    // Create a default spec for each model
    for (const [modelId, model] of modelsMap.entries()) {
      const defaultSpec: TechnicalSpecification = {
        spec_id: `spec_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        model_id: modelId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      newSpecs.push(defaultSpec)
      log(`Created default technical specification for model: ${model.model_family} ${model.model_version}`, "info")
    }

    return newSpecs
  }

  const validSpecs = specs.filter((spec) => {
    const modelId = spec.model_id
    if (!modelId) {
      log(`Technical specification ${spec.spec_id || "unknown"} has no model ID, skipping`, "warning")
      return false
    }

    const modelExists = modelsMap.has(modelId)
    if (!modelExists) {
      log(
        `Technical specification ${spec.spec_id || "unknown"} references non-existent model ${modelId}, skipping`,
        "warning",
      )
      return false
    }

    return true
  })

  log(`Validated ${validSpecs.length}/${specs.length} technical specifications`, "info")
  return validSpecs
}

// ---- Completeness ----
function isComplete(spec: TechnicalSpecification): boolean {
  return !!(
    spec.input_types &&
    spec.output_types &&
    spec.supported_languages &&
    spec.hardware_requirements &&
    spec.gpu_acceleration &&
    spec.compatible_frameworks
  )
}

// ---- Enrichment via OpenAI ----
async function enrichTechnicalSpecification(
  spec: TechnicalSpecification,
  model: Model,
  platform: Platform,
): Promise<TechnicalSpecification> {
  try {
    log(`Enriching technical specification for model: ${model.model_family || ""} ${model.model_version || ""}`, "info")

    const prompt = `
Provide accurate technical specifications for the AI model "${model.model_family || ""} ${model.model_version || ""}" from the platform "${platform.platform_name}" in JSON format with the following fields:
- input_types: Supported input formats (e.g., "Text, Images, Audio")
- output_types: Possible output types (e.g., "Text, Structured data, Image")
- supported_languages: Languages the model understands (e.g., "English, Spanish, French, 100+ languages")
- hardware_requirements: Minimum system requirements (e.g., "8GB RAM, 4-core CPU")
- gpu_acceleration: Whether GPU acceleration is supported (e.g., "Yes", "No", "Optional")
- latency: Average processing time per request (e.g., "200ms", "1-2 seconds")
- inference_time: Time taken for generating responses (e.g., "100ms per token", "2s for 1000 tokens")
- training_time: Model training duration (e.g., "2 weeks on 8 A100 GPUs")
- compatible_frameworks: Supported ML/DL frameworks (e.g., "TensorFlow, PyTorch, JAX")
- minimum_requirements: Minimum hardware/software needed (e.g., "4GB RAM, 2-core CPU")
- optimal_requirements: Recommended hardware/software (e.g., "16GB RAM, 8-core CPU, NVIDIA GPU")
- dependency_information: Required dependencies (e.g., "Python 3.8+, CUDA 11.7+")

Additional context about the model:
Model type: ${model.model_type || "Unknown"}
Model architecture: ${model.model_architecture || "Unknown"}
Parameters count: ${model.parameters_count || "Unknown"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
        `
    const enriched = await makeOpenAIRequest<Partial<TechnicalSpecification>>(openai, prompt)

    // Update timestamp
    const timestamp = new Date().toISOString()

    // Merge with existing spec data, only updating null/undefined fields
    const enrichedSpec: TechnicalSpecification = { ...spec }
    Object.keys(enriched).forEach((key) => {
      if (enrichedSpec[key] === undefined || enrichedSpec[key] === null || enrichedSpec[key] === "") {
        enrichedSpec[key] = enriched[key as keyof Partial<TechnicalSpecification>]
      }
    })

    enrichedSpec.updatedAt = timestamp

    const validation = validateTechnicalSpecification(enrichedSpec)
    if (!validation.valid) {
      log(`Validation failed for technical specification ${spec.spec_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedSpec
  } catch (error: any) {
    log(`Failed to enrich technical specification ${spec.spec_id}: ${error.message}`, "error")
    return spec
  }
}

// ---- Processing ----
async function processTechnicalSpecifications(
  specs: TechnicalSpecification[],
  modelsMap: Map<string, Model>,
  platformsMap: Map<string, Platform>,
): Promise<TechnicalSpecification[]> {
  const processed: TechnicalSpecification[] = []

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]
    const model = modelsMap.get(spec.model_id)

    if (!model) {
      log(`Model not found for technical specification with model_id: ${spec.model_id}`, "error")
      processed.push(spec)
      continue
    }

    const platform = platformsMap.get(model.platform_id)
    if (!platform) {
      log(`Platform not found for model with platform_id: ${model.platform_id}`, "error")
      processed.push(spec)
      continue
    }

    if (isComplete(spec)) {
      log(`Skipping technical specification ${i + 1}/${specs.length}: ${spec.spec_id} (already complete)`, "info")
      processed.push(spec)
      continue
    }

    const enriched = await enrichTechnicalSpecification(spec, model, platform)
    processed.push(enriched)

    log(
      `Processed technical specification ${i + 1}/${specs.length} for model: ${model.model_family || ""} ${model.model_version || ""}`,
      "info",
    )

    if (i < specs.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting technical specifications processor...", "info")

    // Load models, platforms, and technical specifications
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    const platformsMap = createLookupMap(platforms, "platform_id")

    const models = loadCsvData<Model>(MODELS_CSV_PATH)
    const modelsMap = createLookupMap(models, "model_id")

    let specs = loadCsvData<TechnicalSpecification>(TECHNICAL_SPECS_CSV_PATH)

    // Create backup of technical specifications file if it exists and has data
    if (fs.existsSync(TECHNICAL_SPECS_CSV_PATH) && fs.statSync(TECHNICAL_SPECS_CSV_PATH).size > 0) {
      createBackup(TECHNICAL_SPECS_CSV_PATH, BACKUP_DIR)
    }

    // Validate technical specifications against models
    specs = validateSpecsAgainstModels(specs, modelsMap)

    // Process and enrich technical specifications
    specs = await processTechnicalSpecifications(specs, modelsMap, platformsMap)

    // Save to CSV
    saveCsvData(TECHNICAL_SPECS_CSV_PATH, specs)

    log("Technical specifications processing completed successfully ✅", "success")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

