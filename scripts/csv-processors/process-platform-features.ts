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
interface PlatformFeature {
  platform_feature_id: string
  platform_id: string
  feature_id: string
  implementation_quality?: string
  feature_availability?: string
  feature_limitations?: string
  createdAt: string
  updatedAt: string
  [key: string]: string | undefined
}

interface Platform {
  platform_id: string
  platform_name: string
  [key: string]: string | undefined
}

interface Feature {
  feature_id: string
  notable_features: string
  [key: string]: string | undefined
}

// ---- File Paths ----
const DATA_DIR = path.join(process.cwd(), "data")
const PLATFORM_FEATURES_CSV_PATH = path.join(DATA_DIR, "platform_features.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const FEATURES_CSV_PATH = path.join(DATA_DIR, "Features.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validatePlatformFeature(platformFeature: PlatformFeature): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!platformFeature.platform_feature_id) errors.push("platform_feature_id is required")
  if (!platformFeature.platform_id) errors.push("platform_id is required")
  if (!platformFeature.feature_id) errors.push("feature_id is required")

  // Quality validation
  if (
    platformFeature.implementation_quality &&
    !["Basic", "Standard", "Advanced", "Excellent"].includes(platformFeature.implementation_quality)
  ) {
    errors.push("implementation_quality must be one of: Basic, Standard, Advanced, Excellent")
  }

  // Availability validation
  if (
    platformFeature.feature_availability &&
    !["Generally Available", "Beta", "Preview", "Limited Access", "Deprecated"].includes(
      platformFeature.feature_availability,
    )
  ) {
    errors.push("feature_availability must be one of: Generally Available, Beta, Preview, Limited Access, Deprecated")
  }

  return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(platformFeature: PlatformFeature): boolean {
  return (
    !!platformFeature.implementation_quality &&
    !!platformFeature.feature_availability &&
    !!platformFeature.feature_limitations
  )
}

// ---- Enrichment via OpenAI ----
async function enrichPlatformFeature(
  platformFeature: PlatformFeature,
  platforms: Platform[],
  features: Feature[],
): Promise<PlatformFeature> {
  try {
    log(`Enriching platform feature for: ${platformFeature.platform_feature_id}`, "info")

    const platform = platforms.find((p) => p.platform_id === platformFeature.platform_id)
    if (!platform) {
      log(`Platform not found for platform_feature_id: ${platformFeature.platform_feature_id}`, "warning")
      return platformFeature
    }

    const feature = features.find((f) => f.feature_id === platformFeature.feature_id)
    if (!feature) {
      log(`Feature not found for platform_feature_id: ${platformFeature.platform_feature_id}`, "warning")
      return platformFeature
    }

    const prompt = `
Provide enriched platform feature data for the AI platform "${platform.platform_name}" regarding the feature "${feature.notable_features}" in the following JSON format:
{
  "implementation_quality": "One of: Basic, Standard, Advanced, Excellent",
  "feature_availability": "One of: Generally Available, Beta, Preview, Limited Access, Deprecated",
  "feature_limitations": "Description of any limitations or constraints of this feature on this platform"
}

Return only the JSON object with realistic, accurate information about how this feature is implemented on this platform.
        `
    const enriched = await makeOpenAIRequest<Partial<PlatformFeature>>(openai, prompt)
    const enrichedPlatformFeature: PlatformFeature = {
      ...platformFeature,
      ...enriched,
      updatedAt: new Date().toISOString(),
    }

    const validation = validatePlatformFeature(enrichedPlatformFeature)
    if (!validation.valid) {
      log(`Validation failed for ${platformFeature.platform_feature_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedPlatformFeature
  } catch (error: any) {
    log(`Failed to enrich platform feature ${platformFeature.platform_feature_id}: ${error.message}`, "error")
    return platformFeature
  }
}

// ---- Processing ----
async function processPlatformFeatures(
  platformFeatures: PlatformFeature[],
  platforms: Platform[],
  features: Feature[],
): Promise<PlatformFeature[]> {
  const processed: PlatformFeature[] = []

  for (let i = 0; i < platformFeatures.length; i++) {
    const platformFeature = platformFeatures[i]

    if (isComplete(platformFeature)) {
      log(`Skipping ${platformFeature.platform_feature_id} (already complete)`, "info")
      processed.push(platformFeature)
      continue
    }

    const enriched = await enrichPlatformFeature(platformFeature, platforms, features)
    processed.push(enriched)

    if (i < platformFeatures.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting platform features processor...", "info")

    // Load platforms data
    if (!fs.existsSync(PLATFORMS_CSV_PATH)) {
      log("Platforms.csv not found. Please run process-platforms.ts first.", "error")
      process.exit(1)
    }
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    log(`Loaded ${platforms.length} platforms`, "info")

    // Load features data
    if (!fs.existsSync(FEATURES_CSV_PATH)) {
      log("Features.csv not found. Please run process-features.ts first.", "error")
      process.exit(1)
    }
    const features = loadCsvData<Feature>(FEATURES_CSV_PATH)
    log(`Loaded ${features.length} features`, "info")

    // Load or initialize platform features data
    const platformFeatures = fs.existsSync(PLATFORM_FEATURES_CSV_PATH)
      ? loadCsvData<PlatformFeature>(PLATFORM_FEATURES_CSV_PATH)
      : []

    // Create platform feature entries for platform-feature pairs that don't exist
    const existingPairs = new Set(platformFeatures.map((pf) => `${pf.platform_id}-${pf.feature_id}`))
    const newPlatformFeatures: PlatformFeature[] = []

    // For each platform, add connections to relevant features
    for (const platform of platforms) {
      // Get all features for this platform
      const platformFeatureIds = features
        .filter((f) => f.feature_id.includes(platform.platform_id))
        .map((f) => f.feature_id)

      // Add connections to these features if they don't exist
      for (const featureId of platformFeatureIds) {
        const pairKey = `${platform.platform_id}-${featureId}`
        if (!existingPairs.has(pairKey)) {
          const newPlatformFeature: PlatformFeature = {
            platform_feature_id: `platform_feature_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            platform_id: platform.platform_id,
            feature_id: featureId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          newPlatformFeatures.push(newPlatformFeature)
          existingPairs.add(pairKey)
          log(`Created new platform feature connection for platform: ${platform.platform_name}`, "info")
          await applyRateLimit(100) // Small delay to ensure unique IDs
        }
      }
    }

    const allPlatformFeatures = [...platformFeatures, ...newPlatformFeatures]

    // Create backup if file exists
    if (fs.existsSync(PLATFORM_FEATURES_CSV_PATH) && fs.statSync(PLATFORM_FEATURES_CSV_PATH).size > 0) {
      createBackup(PLATFORM_FEATURES_CSV_PATH, BACKUP_DIR)
    }

    // Process and enrich platform features
    const enriched = await processPlatformFeatures(allPlatformFeatures, platforms, features)
    saveCsvData(PLATFORM_FEATURES_CSV_PATH, enriched)

    log(`Platform features processor complete. Processed ${enriched.length} records ✅`, "info")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

