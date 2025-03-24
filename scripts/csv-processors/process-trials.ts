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
interface Trial {
  trial_id: string
  platform_id: string
  free_trial_plan?: string
  trial_duration?: string
  trial_duration_unit?: string
  usage_limits?: string
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
const TRIALS_CSV_PATH = path.join(DATA_DIR, "Trials.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateTrial(trial: Trial): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!trial.trial_id) errors.push("trial_id is required")
  if (!trial.platform_id) errors.push("platform_id is required")

  // Check trial_duration_unit constraint if present
  if (trial.trial_duration_unit && !["Day", "Week", "Month", "Year"].includes(trial.trial_duration_unit)) {
    errors.push("trial_duration_unit must be one of: Day, Week, Month, Year")
  }

  return { valid: errors.length === 0, errors }
}

// ---- Validate trials against platforms ----
function validateTrialsAgainstPlatforms(trialRecords: Trial[], platformsMap: Map<string, Platform>): Trial[] {
  log("Validating trials against platforms...", "info")

  // If no trial records, create default ones for testing
  if (trialRecords.length === 0 && platformsMap.size > 0) {
    log("No trial records found in CSV, creating default trials for testing", "warning")
    const newTrialRecords: Trial[] = []

    // Create a default trial record for each platform
    for (const [platformId, platform] of platformsMap.entries()) {
      const defaultTrial: Trial = {
        trial_id: `trial_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        platform_id: platformId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      newTrialRecords.push(defaultTrial)
      log(`Created default trial for platform: ${platform.platform_name}`, "info")
    }

    return newTrialRecords
  }

  const validTrialRecords = trialRecords.filter((trial) => {
    const platformId = trial.platform_id
    if (!platformId) {
      log(`Trial ${trial.trial_id || "unknown"} has no platform ID, skipping`, "warning")
      return false
    }

    const platformExists = platformsMap.has(platformId)
    if (!platformExists) {
      log(`Trial ${trial.trial_id || "unknown"} references non-existent platform ${platformId}, skipping`, "warning")
      return false
    }

    return true
  })

  log(`Validated ${validTrialRecords.length}/${trialRecords.length} trial records`, "info")
  return validTrialRecords
}

// ---- Completeness ----
function isComplete(trial: Trial): boolean {
  return !!(trial.free_trial_plan && trial.trial_duration && trial.trial_duration_unit && trial.usage_limits)
}

// ---- Enrichment via OpenAI ----
async function enrichTrial(trial: Trial, platform: Platform): Promise<Trial> {
  try {
    log(`Enriching trial for platform: ${platform.platform_name}`, "info")

    const prompt = `
Provide accurate free trial information about the AI platform "${platform.platform_name}" in JSON format with the following fields:
- free_trial_plan: Description of the free trial offering (e.g., "14-day free trial", "Free tier with limited features", "No free trial")
- trial_duration: The duration of the trial as a number (e.g., "14", "30", "7")
- trial_duration_unit: The unit of time for the trial duration (must be one of: "Day", "Week", "Month", "Year")
- usage_limits: Limitations during the trial period (e.g., "5,000 API calls", "Limited to 3 users", "1GB storage")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
If the platform does not offer a free trial, set free_trial_plan to "No free trial" and other fields to null.
Return ONLY the JSON object with no additional text.
        `
    const enriched = await makeOpenAIRequest<Partial<Trial>>(openai, prompt)

    // Update timestamp
    const timestamp = new Date().toISOString()

    // Merge with existing trial data, only updating null/undefined fields
    const enrichedTrial: Trial = { ...trial }
    Object.keys(enriched).forEach((key) => {
      if (enrichedTrial[key] === undefined || enrichedTrial[key] === null || enrichedTrial[key] === "") {
        enrichedTrial[key] = enriched[key as keyof Partial<Trial>]
      }
    })

    enrichedTrial.updatedAt = timestamp

    const validation = validateTrial(enrichedTrial)
    if (!validation.valid) {
      log(`Validation failed for trial ${trial.trial_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedTrial
  } catch (error: any) {
    log(`Failed to enrich trial for ${platform.platform_name}: ${error.message}`, "error")
    return trial
  }
}

// ---- Processing ----
async function processTrials(trialRecords: Trial[], platformsMap: Map<string, Platform>): Promise<Trial[]> {
  const processed: Trial[] = []

  for (let i = 0; i < trialRecords.length; i++) {
    const trial = trialRecords[i]
    const platform = platformsMap.get(trial.platform_id)

    if (!platform) {
      log(`Platform not found for trial with platform_id: ${trial.platform_id}`, "error")
      processed.push(trial)
      continue
    }

    if (isComplete(trial)) {
      log(`Skipping trial ${i + 1}/${trialRecords.length}: ${trial.trial_id} (already complete)`, "info")
      processed.push(trial)
      continue
    }

    const enriched = await enrichTrial(trial, platform)
    processed.push(enriched)

    log(`Processed trial ${i + 1}/${trialRecords.length} for platform: ${platform.platform_name}`, "info")

    if (i < trialRecords.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting trials processor...", "info")

    // Load platforms and trials
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    const platformsMap = createLookupMap(platforms, "platform_id")

    let trialRecords = loadCsvData<Trial>(TRIALS_CSV_PATH)

    // Create backup of trials file if it exists and has data
    if (fs.existsSync(TRIALS_CSV_PATH) && fs.statSync(TRIALS_CSV_PATH).size > 0) {
      createBackup(TRIALS_CSV_PATH, BACKUP_DIR)
    }

    // Validate trials against platforms
    trialRecords = validateTrialsAgainstPlatforms(trialRecords, platformsMap)

    // Process and enrich trial data
    trialRecords = await processTrials(trialRecords, platformsMap)

    // Save to CSV
    saveCsvData(TRIALS_CSV_PATH, trialRecords)

    log("Trials processing completed successfully ✅", "success")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

