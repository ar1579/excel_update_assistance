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
interface Support {
  support_id: string
  platform_id: string
  support_options?: string
  sla_available?: string
  support_channels?: string
  support_hours?: string
  enterprise_support?: string
  training_options?: string
  consulting_services?: string
  implementation_support?: string
  response_time_guarantees?: string
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
const SUPPORT_CSV_PATH = path.join(DATA_DIR, "Support.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateSupport(support: Support): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!support.support_id) errors.push("support_id is required")
  if (!support.platform_id) errors.push("platform_id is required")

  // Check boolean fields if present
  if (support.sla_available && !["true", "false", "Yes", "No"].includes(support.sla_available)) {
    errors.push("sla_available must be a boolean value (true/false or Yes/No)")
  }

  return { valid: errors.length === 0, errors }
}

// ---- Validate support records against platforms ----
function validateSupportAgainstPlatforms(supportRecords: Support[], platformsMap: Map<string, Platform>): Support[] {
  log("Validating support records against platforms...", "info")

  // If no support records, create default ones for testing
  if (supportRecords.length === 0 && platformsMap.size > 0) {
    log("No support records found in CSV, creating default records for testing", "warning")
    const newSupportRecords: Support[] = []

    // Create a default support record for each platform
    for (const [platformId, platform] of platformsMap.entries()) {
      const defaultSupport: Support = {
        support_id: `sup_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        platform_id: platformId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      newSupportRecords.push(defaultSupport)
      log(`Created default support record for platform: ${platform.platform_name}`, "info")
    }

    return newSupportRecords
  }

  const validSupportRecords = supportRecords.filter((support) => {
    const platformId = support.platform_id
    if (!platformId) {
      log(`Support record ${support.support_id || "unknown"} has no platform ID, skipping`, "warning")
      return false
    }

    const platformExists = platformsMap.has(platformId)
    if (!platformExists) {
      log(
        `Support record ${support.support_id || "unknown"} references non-existent platform ${platformId}, skipping`,
        "warning",
      )
      return false
    }

    return true
  })

  log(`Validated ${validSupportRecords.length}/${supportRecords.length} support records`, "info")
  return validSupportRecords
}

// ---- Completeness ----
function isComplete(support: Support): boolean {
  return !!(
    support.support_options &&
    support.sla_available &&
    support.support_channels &&
    support.support_hours &&
    support.enterprise_support
  )
}

// ---- Enrichment via OpenAI ----
async function enrichSupport(support: Support, platform: Platform): Promise<Support> {
  try {
    log(`Enriching support for platform: ${platform.platform_name}`, "info")

    const prompt = `
Provide accurate information about the support services offered by the AI platform "${platform.platform_name}" in JSON format with the following fields:
- support_options: Available support options (e.g., "Community, Standard, Premium, Enterprise")
- sla_available: Whether Service Level Agreements are available (must be "true" or "false")
- support_channels: Available support channels (e.g., "Email, Chat, Phone, Community forum")
- support_hours: Hours of support availability (e.g., "24/7", "Business hours (9 AM - 5 PM EST)", "Varies by plan")
- enterprise_support: Enterprise-specific support options (e.g., "Dedicated account manager, Priority support")
- training_options: Available training options (e.g., "Documentation, Webinars, On-site training")
- consulting_services: Available consulting services (e.g., "Implementation consulting, Custom development")
- implementation_support: Support for implementation (e.g., "Guided setup, Migration assistance")
- response_time_guarantees: Guaranteed response times (e.g., "1 hour for critical issues, 24 hours for standard issues")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
        `
    const enriched = await makeOpenAIRequest<Partial<Support>>(openai, prompt)

    // Update timestamp
    const timestamp = new Date().toISOString()

    // Merge with existing support data, only updating null/undefined fields
    const enrichedSupport: Support = { ...support }
    Object.keys(enriched).forEach((key) => {
      if (enrichedSupport[key] === undefined || enrichedSupport[key] === null || enrichedSupport[key] === "") {
        enrichedSupport[key] = enriched[key as keyof Partial<Support>]
      }
    })

    enrichedSupport.updatedAt = timestamp

    const validation = validateSupport(enrichedSupport)
    if (!validation.valid) {
      log(`Validation failed for support record ${support.support_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedSupport
  } catch (error: any) {
    log(`Failed to enrich support for ${platform.platform_name}: ${error.message}`, "error")
    return support
  }
}

// ---- Processing ----
async function processSupport(supportRecords: Support[], platformsMap: Map<string, Platform>): Promise<Support[]> {
  const processed: Support[] = []

  for (let i = 0; i < supportRecords.length; i++) {
    const support = supportRecords[i]
    const platform = platformsMap.get(support.platform_id)

    if (!platform) {
      log(`Platform not found for support record with platform_id: ${support.platform_id}`, "error")
      processed.push(support)
      continue
    }

    if (isComplete(support)) {
      log(`Skipping support record ${i + 1}/${supportRecords.length}: ${support.support_id} (already complete)`, "info")
      processed.push(support)
      continue
    }

    const enriched = await enrichSupport(support, platform)
    processed.push(enriched)

    log(`Processed support record ${i + 1}/${supportRecords.length} for platform: ${platform.platform_name}`, "info")

    if (i < supportRecords.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting support processor...", "info")

    // Load platforms and support records
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    const platformsMap = createLookupMap(platforms, "platform_id")

    let supportRecords = loadCsvData<Support>(SUPPORT_CSV_PATH)

    // Create backup of support file if it exists and has data
    if (fs.existsSync(SUPPORT_CSV_PATH) && fs.statSync(SUPPORT_CSV_PATH).size > 0) {
      createBackup(SUPPORT_CSV_PATH, BACKUP_DIR)
    }

    // Validate support records against platforms
    supportRecords = validateSupportAgainstPlatforms(supportRecords, platformsMap)

    // Process and enrich support data
    supportRecords = await processSupport(supportRecords, platformsMap)

    // Save to CSV
    saveCsvData(SUPPORT_CSV_PATH, supportRecords)

    log("Support processing completed successfully ✅", "success")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

