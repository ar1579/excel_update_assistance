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
const TECH_SPECS_CSV_PATH = path.join(DATA_DIR, "Technical_Specifications.csv")
const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Technical Specification data structure
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
    [key: string]: string | undefined // Allow any string key for dynamic access
}

// Model data structure
interface Model {
    model_id: string
    platform_id: string
    model_family?: string
    model_version?: string
    model_variants?: string
    model_architecture?: string
    parameters_count?: string
    context_window_size?: string
    token_limit?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

// Platform data structure
interface Platform {
    platform_id: string
    platform_name: string
    platform_category?: string
    platform_sub_category?: string
    platform_description?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

/**
 * Validate technical specification data against schema constraints
 */
function validateTechnicalSpecification(techSpec: TechnicalSpecification): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!techSpec.model_id) {
        errors.push("model_id is required")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate technical specifications against models
 */
function validateTechnicalSpecificationsAgainstModels(
    techSpecs: TechnicalSpecification[],
    modelsMap: Map<string, Model>,
): TechnicalSpecification[] {
    log("Validating technical specifications against models...", "info")

    // If no tech specs, create a default one for testing
    if (techSpecs.length === 0 && modelsMap.size > 0) {
        log("No technical specifications found in CSV, creating a default spec for testing", "warning")
        const modelId = Array.from(modelsMap.keys())[0]
        const model = modelsMap.get(modelId)

        if (model) {
            const defaultTechSpec: TechnicalSpecification = {
                spec_id: `spec_${Date.now()}`,
                model_id: modelId,
                input_types: "Text",
                output_types: "Text",
                supported_languages: "English",
                hardware_requirements: "GPU recommended",
                gpu_acceleration: "Yes",
                compatible_frameworks: "API",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            techSpecs.push(defaultTechSpec)
            log(`Created default technical specification for model: ${model.model_family} ${model.model_version}`, "info")
            return techSpecs
        }
    }

    const validTechSpecs = techSpecs.filter((spec) => {
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

    log(`Validated ${validTechSpecs.length}/${techSpecs.length} technical specifications`, "info")
    return validTechSpecs
}

/**
 * Enrich technical specification data using OpenAI
 */
async function enrichTechnicalSpecificationData(
    techSpec: TechnicalSpecification,
    model: Model,
    platform: Platform,
): Promise<TechnicalSpecification> {
    try {
        log(
            `Enriching data for technical specification: ${techSpec.spec_id || "new"} (Model: ${model.model_id || model.model_family})`,
            "info",
        )

        const prompt = `
Provide accurate technical specifications for the AI model "${model.model_family} ${model.model_version}" from the platform "${platform.platform_name}" in JSON format with the following fields:
- input_types: Types of inputs the model accepts (e.g., "Text, Images, Audio", "Text only", etc.)
- output_types: Types of outputs the model produces (e.g., "Text, Images", "Text only", etc.)
- supported_languages: Languages supported by the model (e.g., "English, Spanish, French", "English only", etc.)
- hardware_requirements: Hardware needed to run the model (e.g., "GPU required", "CPU compatible", etc.)
- gpu_acceleration: Whether GPU acceleration is supported (e.g., "Yes", "No", "Optional")
- latency: Typical latency for inference (e.g., "50-100ms", "1-2s", etc.)
- inference_time: Time taken for generating responses (e.g., "100ms per token", "2s for 1000 tokens")
- training_time: Model training duration (e.g., "2 weeks on 8 A100 GPUs", "1 month on TPU v4")
- compatible_frameworks: Frameworks compatible with the model (e.g., "TensorFlow, PyTorch", "Custom framework", etc.)
- minimum_requirements: Minimum system requirements (e.g., "8GB RAM, 4 CPU cores", "16GB RAM, NVIDIA GPU", etc.)
- optimal_requirements: Optimal system requirements (e.g., "32GB RAM, NVIDIA A100", "64GB RAM, 16 CPU cores", etc.)
- dependency_information: Dependencies required (e.g., "CUDA 11.7+, Python 3.8+", "Docker", etc.)

Additional context about the model:
- Model family: ${model.model_family || "Unknown"}
- Model architecture: ${model.model_architecture || "Unknown"}
- Parameters count: ${model.parameters_count || "Unknown"}
- Context window size: ${model.context_window_size || "Unknown"}

Additional context about the platform:
- Platform description: ${platform.platform_description || "No description available"}
- Platform category: ${platform.platform_category || "Unknown"}
- Platform sub-category: ${platform.platform_sub_category || "Unknown"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<TechnicalSpecification>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing technical specification data, only updating null/undefined fields
        const updatedTechSpec: TechnicalSpecification = { ...techSpec }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedTechSpec[key] === undefined || updatedTechSpec[key] === null || updatedTechSpec[key] === "") {
                updatedTechSpec[key] = enrichedData[key as keyof Partial<TechnicalSpecification>]
            }
        })

        updatedTechSpec.updatedAt = timestamp

        // Validate the enriched technical specification data
        const validation = validateTechnicalSpecification(updatedTechSpec)
        if (!validation.valid) {
            log(
                `Validation issues with enriched technical specification ${techSpec.spec_id || "new"}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedTechSpec
    } catch (error: any) {
        log(`Error enriching technical specification ${techSpec.spec_id || "new"}: ${error.message}`, "error")
        return techSpec
    }
}

/**
 * Process all technical specifications with rate limiting
 */
async function processTechnicalSpecificationsWithRateLimit(
    techSpecs: TechnicalSpecification[],
    modelsMap: Map<string, Model>,
    platformsMap: Map<string, Platform>,
): Promise<TechnicalSpecification[]> {
    const enrichedTechSpecs: TechnicalSpecification[] = []

    for (let i = 0; i < techSpecs.length; i++) {
        try {
            // Skip technical specifications that already have all fields filled
            const techSpec = techSpecs[i]
            const hasAllFields =
                techSpec.input_types &&
                techSpec.output_types &&
                techSpec.supported_languages &&
                techSpec.hardware_requirements &&
                techSpec.gpu_acceleration &&
                techSpec.latency &&
                techSpec.compatible_frameworks

            if (hasAllFields) {
                log(
                    `Skipping technical specification ${i + 1}/${techSpecs.length}: ${techSpec.spec_id || "unknown"} (already complete)`,
                    "info",
                )
                enrichedTechSpecs.push(techSpec)
                continue
            }

            // Get associated model
            const model = modelsMap.get(techSpec.model_id) as Model

            // Get associated platform
            const platform = platformsMap.get(model.platform_id) as Platform

            // Enrich technical specification data
            const enrichedTechSpec = await enrichTechnicalSpecificationData(techSpec, model, platform)
            enrichedTechSpecs.push(enrichedTechSpec)

            // Log progress
            log(
                `Processed technical specification ${i + 1}/${techSpecs.length}: ${enrichedTechSpec.spec_id || "new"}`,
                "info",
            )

            // Rate limiting delay (except for last item)
            if (i < techSpecs.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing technical specification ${techSpecs[i].spec_id || "unknown"}: ${error.message}`, "error")
            enrichedTechSpecs.push(techSpecs[i]) // Add original data if enrichment fails
        }
    }

    return enrichedTechSpecs
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting technical specification processing...", "info")

        // Load models, platforms, and technical specifications
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        const models = loadCsvData<Model>(MODELS_CSV_PATH)
        const modelsMap = createLookupMap(models, "model_id")

        let techSpecs = loadCsvData<TechnicalSpecification>(TECH_SPECS_CSV_PATH)

        // Create backup of technical specifications file if it exists and has data
        if (fs.existsSync(TECH_SPECS_CSV_PATH) && techSpecs.length > 0) {
            createBackup(TECH_SPECS_CSV_PATH, BACKUP_DIR)
        }

        // Validate technical specifications against models
        techSpecs = validateTechnicalSpecificationsAgainstModels(techSpecs, modelsMap)

        // Enrich technical specification data
        techSpecs = await processTechnicalSpecificationsWithRateLimit(techSpecs, modelsMap, platformsMap)

        // Save to CSV
        saveCsvData(TECH_SPECS_CSV_PATH, techSpecs)

        log("Technical specification processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

