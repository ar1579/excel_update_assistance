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
interface Feature {
  feature_id: string
  platform_id: string
  notable_features?: string
  explainability_features?: string
  customization_options?: string
  bias_mitigation_approaches?: string
  createdAt?: string
  updatedAt?: string
  [key: string]: string | undefined
}

interface Platform {
  platform_id: string
  platform_name: string
  platform_url: string
  platform_category?: string
  platform_sub_category?: string
  platform_description?: string
  [key: string]: string | undefined
}

// ---- File Paths ----
const DATA_DIR = path.join(process.cwd(), "data")
const FEATURES_CSV_PATH = path.join(DATA_DIR, "Features.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateFeature(feature: Feature): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!feature.feature_id) errors.push("feature_id is required")
  if (!feature.platform_id) errors.push("platform_id is required")

  return { valid: errors.length === 0, errors }
}

// ---- Validate features against platforms ----
function validateFeaturesAgainstPlatforms(featureRecords: Feature[], platformsMap: Map<string, Platform>): Feature[] {
  log("Validating features against platforms...", "info")

  // If no feature records, create default ones for testing
  if (featureRecords.length === 0 && platformsMap.size > 0) {
    log("No feature records found in CSV, creating default features for testing", "warning")
    const newFeatureRecords: Feature[] = []

    // Create a default feature record for each platform
    for (const [platformId, platform] of platformsMap.entries()) {
      const defaultFeature: Feature = {
        feature_id: `feat_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        platform_id: platformId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      newFeatureRecords.push(defaultFeature)
      log(`Created default feature for platform: ${platform.platform_name}`, "info")
    }

    return newFeatureRecords
  }

  const validFeatureRecords = featureRecords.filter((feature) => {
    const platformId = feature.platform_id
    if (!platformId) {
      log(`Feature ${feature.feature_id || "unknown"} has no platform ID, skipping`, "warning")
      return false
    }

    const platformExists = platformsMap.has(platformId)
    if (!platformExists) {
      log(
        `Feature ${feature.feature_id || "unknown"} references non-existent platform ${platformId}, skipping`,
        "warning",
      )
      return false
    }

    return true
  })

  log(`Validated ${validFeatureRecords.length}/${featureRecords.length} feature records`, "info")
  return validFeatureRecords
}

// ---- Completeness ----
function isComplete(feature: Feature): boolean {
  return !!(
    feature.notable_features &&
    feature.explainability_features &&
    feature.customization_options &&
    feature.bias_mitigation_approaches
  )
}

// ---- Enrichment via OpenAI ----
async function enrichFeature(feature: Feature, platform: Platform): Promise<Feature> {
  try {
    log(`Enriching features for platform: ${platform.platform_name}`, "info")

    const prompt = `
Provide accurate information about the features of the AI platform "${platform.platform_name}" in JSON format with the following fields:
- notable_features: A list of the most notable features of the platform (e.g., "Real-time translation, Voice recognition, Sentiment analysis")
- explainability_features: Features related to AI explainability and transparency (e.g., "Attention visualization, Feature importance, Decision trees")
- customization_options: Available options for customizing the platform (e.g., "Fine-tuning, Custom models, API customization")
- bias_mitigation_approaches: Approaches used to mitigate bias in AI models (e.g., "Fairness metrics, Bias detection tools, Diverse training data")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
        `
    const enriched = await makeOpenAIRequest<Partial<Feature>>(openai, prompt)

    // Update timestamp
    const timestamp = new Date().toISOString()

    // Merge with existing feature data, only updating null/undefined fields
    const enrichedFeature: Feature = { ...feature }
    Object.keys(enriched).forEach((key) => {
      if (enrichedFeature[key] === undefined || enrichedFeature[key] === null || enrichedFeature[key] === "") {
        enrichedFeature[key] = enriched[key as keyof Partial<Feature>]
      }
    })

    enrichedFeature.updatedAt = timestamp

    const validation = validateFeature(enrichedFeature)
    if (!validation.valid) {
      log(`Validation failed for feature ${feature.feature_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedFeature
  } catch (error: any) {
    log(`Failed to enrich features for ${platform.platform_name}: ${error.message}`, "error")
    return feature
  }
}

// ---- Processing ----
async function processFeatures(featureRecords: Feature[], platformsMap: Map<string, Platform>): Promise<Feature[]> {
  const processed: Feature[] = []

  for (let i = 0; i < featureRecords.length; i++) {
    const feature = featureRecords[i]
    const platform = platformsMap.get(feature.platform_id)

    if (!platform) {
      log(`Platform not found for feature with platform_id: ${feature.platform_id}`, "error")
      processed.push(feature)
      continue
    }

    if (isComplete(feature)) {
      log(`Skipping feature ${i + 1}/${featureRecords.length}: ${feature.feature_id} (already complete)`, "info")
      processed.push(feature)
      continue
    }

    const enriched = await enrichFeature(feature, platform)
    processed.push(enriched)

    log(`Processed feature ${i + 1}/${featureRecords.length} for platform: ${platform.platform_name}`, "info")

    if (i < featureRecords.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting features processor...", "info")

    // Load platforms and features
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    const platformsMap = createLookupMap(platforms, "platform_id")

    let featureRecords = loadCsvData<Feature>(FEATURES_CSV_PATH)

    // Create backup of features file if it exists and has data
    if (fs.existsSync(FEATURES_CSV_PATH) && fs.statSync(FEATURES_CSV_PATH).size > 0) {
      createBackup(FEATURES_CSV_PATH, BACKUP_DIR)
    }

    // Validate features against platforms
    featureRecords = validateFeaturesAgainstPlatforms(featureRecords, platformsMap)

    // Process and enrich feature data
    featureRecords = await processFeatures(featureRecords, platformsMap)

    // Save to CSV
    saveCsvData(FEATURES_CSV_PATH, featureRecords)

    log("Features processing completed successfully ✅", "success")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

