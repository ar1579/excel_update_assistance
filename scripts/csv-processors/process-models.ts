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
interface Model {
  model_id: string
  platform_id: string
  model_family?: string
  model_version?: string
  model_variants?: string
  model_size?: string
  model_size_unit?: string
  model_type?: string
  model_architecture?: string
  parameters_count?: string
  context_window_size?: string
  token_limit?: string
  createdAt?: string
  updatedAt?: string
  [key: string]: string | undefined
}

interface Platform {
  platform_id: string
  platform_name: string
  platform_category?: string
  platform_sub_category?: string
  platform_description?: string
  [key: string]: string | undefined
}

// ---- File Paths ----
const DATA_DIR = path.join(process.cwd(), "data")
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateModel(model: Model): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!model.model_id) errors.push("model_id is required")
  if (!model.platform_id) errors.push("platform_id is required")

  // Check model_size_unit constraint if present
  if (model.model_size_unit && !["KB", "MB", "GB", "TB", "B"].includes(model.model_size_unit)) {
    errors.push("model_size_unit must be one of: KB, MB, GB, TB, B")
  }

  return { valid: errors.length === 0, errors }
}

// ---- Extract model info from platform ----
function extractModelInfoFromPlatform(platform: Platform): {
  modelFamily: string
  modelVersion: string
  modelType: string
} {
  // Default values
  let modelFamily = platform.platform_name
  let modelVersion = "1.0"
  let modelType = "AI Model"

  // Extract model family from platform name
  // Common patterns: "OpenAI GPT-4", "Claude (Anthropic)", "Llama 2", etc.
  const namePatterns = [
    // Extract model family and version (e.g., "GPT-4", "Claude 2", "Llama 2")
    { regex: /(GPT-\d+(?:\.\d+)?)/i, familyIndex: 1, family: "GPT" },
    { regex: /(Claude(?:\s+\d+(?:\.\d+)?)?)/i, familyIndex: 1, family: "Claude" },
    { regex: /(Llama\s+\d+(?:\.\d+)?)/i, familyIndex: 1, family: "Llama" },
    { regex: /(Gemini(?:\s+\d+(?:\.\d+)?)?)/i, familyIndex: 1, family: "Gemini" },
    { regex: /(BERT)/i, familyIndex: 1, family: "BERT" },
    { regex: /(DALL-E(?:\s+\d+)?)/i, familyIndex: 1, family: "DALL-E" },
    { regex: /(Stable\s+Diffusion)/i, familyIndex: 1, family: "Stable Diffusion" },
    { regex: /(Midjourney)/i, familyIndex: 1, family: "Midjourney" },
  ]

  // Try to extract model family and version from platform name
  for (const pattern of namePatterns) {
    const match = platform.platform_name.match(pattern.regex)
    if (match) {
      modelFamily = pattern.family

      // Try to extract version number
      const versionMatch = match[0].match(/\d+(\.\d+)?/)
      if (versionMatch) {
        modelVersion = versionMatch[0]
      }
      break
    }
  }

  // Determine model type based on platform category or name
  if (platform.platform_category) {
    const category = platform.platform_category.toLowerCase()
    if (category.includes("language") || category.includes("llm") || category.includes("text")) {
      modelType = "LLM"
    } else if (category.includes("vision") || category.includes("image")) {
      modelType = "Computer Vision"
    } else if (category.includes("speech") || category.includes("audio")) {
      modelType = "Speech Recognition"
    } else if (category.includes("multimodal")) {
      modelType = "Multimodal"
    }
  } else {
    // Try to infer from platform name
    const name = platform.platform_name.toLowerCase()
    if (name.includes("gpt") || name.includes("llama") || name.includes("claude")) {
      modelType = "LLM"
    } else if (name.includes("dall-e") || name.includes("diffusion") || name.includes("midjourney")) {
      modelType = "Image Generation"
    } else if (name.includes("whisper") || name.includes("speech")) {
      modelType = "Speech Recognition"
    }
  }

  return { modelFamily, modelVersion, modelType }
}

// ---- Generate model data for platforms without models ----
async function generateModelData(platform: Platform): Promise<Model[]> {
  try {
    log(`Generating model data for platform: ${platform.platform_name}`, "info")

    // Extract initial model info from platform name and category
    const { modelFamily, modelVersion, modelType } = extractModelInfoFromPlatform(platform)

    const prompt = `
You are a helpful AI assistant that provides structured data about AI models. I need information about models associated with the platform "${platform.platform_name}".

Please provide a JSON array of models with the following structure:
[
  {
    "model_family": "Model family name (e.g., GPT, BERT, Llama, Claude)",
    "model_version": "Specific version (e.g., 4, 3.5-turbo, 2, Opus)",
    "model_variants": "Any variants (e.g., Vision, Instruct, Base, Chat)",
    "model_architecture": "Underlying architecture (e.g., Transformer, Mixture of Experts)",
    "parameters_count": "Approximate parameters (e.g., 175B, 7B, 70B)",
    "context_window_size": "Maximum context window (e.g., 8K, 32K, 100K)",
    "model_type": "Type of model (e.g., LLM, Embedding, Image Generation)",
    "token_limit": "Maximum tokens per request (e.g., 4096, 8192)",
    "model_size": "Size of the model (e.g., 1, 7, 70, 175)",
    "model_size_unit": "Unit for model size (e.g., B for billion parameters)"
  }
]

Additional context about the platform:
Platform name: ${platform.platform_name}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

Initial analysis suggests this platform might have a model family called "${modelFamily}" with version "${modelVersion}" of type "${modelType}".

If this platform is known to have multiple models, please provide all of them (up to 5 models).
If the platform is not known to have specific models, make an educated guess based on the platform category and description.
If any information is not known with confidence, use null for that field.

Your response must be ONLY the JSON array with no additional text, explanations, or markdown formatting.
`

    // Make OpenAI request
    const enriched = await makeOpenAIRequest<Model[]>(openai, prompt)

    if (!Array.isArray(enriched) || enriched.length === 0) {
      log(`Failed to generate models for ${platform.platform_name}: Invalid response format`, "error")
      // Create a single model based on our initial analysis as fallback
      return [
        {
          model_id: `model_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          platform_id: platform.platform_id,
          model_family: modelFamily,
          model_version: modelVersion,
          model_type: modelType,
          model_architecture: modelType === "LLM" ? "Transformer" : undefined,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]
    }

    // Add required fields to each model
    return enriched.map((model) => ({
      ...model,
      model_id: `model_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      platform_id: platform.platform_id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }))
  } catch (error: any) {
    log(`Error generating models for ${platform.platform_name}: ${error.message}`, "error")

    // Extract initial model info from platform name and category
    const { modelFamily, modelVersion, modelType } = extractModelInfoFromPlatform(platform)

    // Return a single model based on our initial analysis as fallback
    return [
      {
        model_id: `model_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        platform_id: platform.platform_id,
        model_family: modelFamily,
        model_version: modelVersion,
        model_type: modelType,
        model_architecture: modelType === "LLM" ? "Transformer" : undefined,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]
  }
}

// ---- Completeness ----
function isComplete(model: Model): boolean {
  return !!(
    model.model_family &&
    model.model_version &&
    model.model_type &&
    model.model_architecture &&
    model.parameters_count &&
    model.context_window_size
  )
}

// ---- Enrichment via OpenAI ----
async function enrichModel(model: Model, platform: Platform): Promise<Model> {
  try {
    log(`Enriching model: ${model.model_family || "Unknown model"} (${platform.platform_name})`, "info")

    const prompt = `
You are a helpful AI assistant that provides structured data about AI models. I need information about the model "${model.model_family || "Unknown"}" version "${model.model_version || "Unknown"}" from the platform "${platform.platform_name}".

Please provide a JSON object with the following structure:
{
  "model_family": "Model family name (e.g., GPT, BERT, Llama, Claude)",
  "model_version": "Specific version (e.g., 4, 3.5-turbo, 2, Opus)",
  "model_variants": "Any variants (e.g., Vision, Instruct, Base, Chat)",
  "model_architecture": "Underlying architecture (e.g., Transformer, Mixture of Experts)",
  "parameters_count": "Approximate parameters (e.g., 175B, 7B, 70B)",
  "context_window_size": "Maximum context window (e.g., 8K, 32K, 100K)",
  "model_type": "Type of model (e.g., LLM, Embedding, Image Generation)",
  "token_limit": "Maximum tokens per request (e.g., 4096, 8192)",
  "model_size": "Size of the model (e.g., 1, 7, 70, 175)",
  "model_size_unit": "Unit for model size (e.g., B for billion parameters)"
}

Additional context about the platform:
Platform name: ${platform.platform_name}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

Current model information (which may be incomplete or incorrect):
${Object.entries(model)
  .filter(([key]) => !["model_id", "platform_id", "createdAt", "updatedAt"].includes(key))
  .map(([key, value]) => `- ${key}: ${value || "Not specified"}`)
  .join("\n")}

If any information is not known with confidence, use null for that field.

Your response must be ONLY the JSON object with no additional text, explanations, or markdown formatting.
        `
    const enriched = await makeOpenAIRequest<Partial<Model>>(openai, prompt)

    // Update timestamp
    const timestamp = new Date().toISOString()

    // Merge with existing model data, only updating null/undefined fields
    const enrichedModel: Model = { ...model }
    Object.keys(enriched).forEach((key) => {
      if (enrichedModel[key] === undefined || enrichedModel[key] === null || enrichedModel[key] === "") {
        enrichedModel[key] = enriched[key as keyof Partial<Model>]
      }
    })

    enrichedModel.updatedAt = timestamp

    const validation = validateModel(enrichedModel)
    if (!validation.valid) {
      log(`Validation failed for model ${model.model_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedModel
  } catch (error: any) {
    log(`Failed to enrich model ${model.model_id}: ${error.message}`, "error")
    return model
  }
}

// ---- Generate models for platforms that don't have associated models ----
async function generateModelsForPlatforms(platforms: Platform[], existingModels: Model[]): Promise<Model[]> {
  const newModels: Model[] = []

  // Create a set of platform IDs that already have models
  const platformsWithModels = new Set(existingModels.map((model) => model.platform_id))

  // Filter platforms that don't have models
  const platformsWithoutModels = platforms.filter((platform) => !platformsWithModels.has(platform.platform_id))

  log(`Found ${platformsWithoutModels.length} platforms without models. Generating models...`, "info")

  for (let i = 0; i < platformsWithoutModels.length; i++) {
    try {
      const platform = platformsWithoutModels[i]
      log(`Generating models for platform ${i + 1}/${platformsWithoutModels.length}: ${platform.platform_name}`, "info")

      // Generate models for this platform
      const generatedModels = await generateModelData(platform)
      newModels.push(...generatedModels)

      log(`Generated ${generatedModels.length} models for ${platform.platform_name}`, "info")

      // Apply rate limiting
      if (i < platformsWithoutModels.length - 1) {
        await applyRateLimit(DELAY)
      }
    } catch (error: any) {
      log(`Error generating models for platform at index ${i}: ${error.message}`, "error")
    }
  }

  return newModels
}

// ---- Processing ----
async function processModels(models: Model[], platformsMap: Map<string, Platform>): Promise<Model[]> {
  const processed: Model[] = []

  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    const platform = platformsMap.get(model.platform_id)

    if (!platform) {
      log(`Platform not found for model with platform_id: ${model.platform_id}`, "error")
      processed.push(model)
      continue
    }

    if (isComplete(model)) {
      log(
        `Skipping model ${i + 1}/${models.length}: ${model.model_family || "Unknown model"} (already complete)`,
        "info",
      )
      processed.push(model)
      continue
    }

    const enriched = await enrichModel(model, platform)
    processed.push(enriched)

    log(`Processed model ${i + 1}/${models.length}: ${enriched.model_family || "Unknown model"}`, "info")

    if (i < models.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting model processor...", "info")

    // Load platforms and models
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    const platformsMap = createLookupMap(platforms, "platform_id")

    log(`Loaded ${platforms.length} platforms from ${PLATFORMS_CSV_PATH}`, "info")

    // Create backup of models file if it exists
    if (fs.existsSync(MODELS_CSV_PATH) && fs.statSync(MODELS_CSV_PATH).size > 0) {
      createBackup(MODELS_CSV_PATH, BACKUP_DIR)
      log(`Created backup of ${MODELS_CSV_PATH}`, "info")
    }

    // Load existing models or create empty array
    let modelRecords: Model[] = []
    if (fs.existsSync(MODELS_CSV_PATH)) {
      modelRecords = loadCsvData<Model>(MODELS_CSV_PATH)
      log(`Loaded ${modelRecords.length} existing model records from ${MODELS_CSV_PATH}`, "info")
    }

    // Generate models for platforms that don't have associated models
    const newModels = await generateModelsForPlatforms(platforms, modelRecords)
    log(`Generated ${newModels.length} new model records`, "info")

    // Combine existing and new models
    const allModels = [...modelRecords, ...newModels]
    log(`Total model records: ${allModels.length}`, "info")

    // Process and enrich all models
    const processedModels = await processModels(allModels, platformsMap)

    // Save to CSV
    saveCsvData(MODELS_CSV_PATH, processedModels)
    log(`Saved ${processedModels.length} models to ${MODELS_CSV_PATH}`, "success")

    log("Model processing completed successfully ✅", "success")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

