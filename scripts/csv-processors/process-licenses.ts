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
interface License {
  license_id: string
  platform_id: string
  license_type?: string
  open_source_status?: string
  license_name?: string
  license_url?: string
  license_expiration_date?: string
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
const LICENSES_CSV_PATH = path.join(DATA_DIR, "Licenses.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateLicense(license: License): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!license.license_id) errors.push("license_id is required")
  if (!license.platform_id) errors.push("platform_id is required")

  // Check license_type constraint if present
  if (
    license.license_type &&
    !["Open-source", "Proprietary", "Creative Commons", "Other"].includes(license.license_type)
  ) {
    errors.push("license_type must be one of: Open-source, Proprietary, Creative Commons, Other")
  }

  return { valid: errors.length === 0, errors }
}

// ---- Validate licenses against platforms ----
function validateLicensesAgainstPlatforms(licenseRecords: License[], platformsMap: Map<string, Platform>): License[] {
  log("Validating licenses against platforms...", "info")

  // If no license records, create default ones for testing
  if (licenseRecords.length === 0 && platformsMap.size > 0) {
    log("No license records found in CSV, creating default licenses for testing", "warning")
    const newLicenseRecords: License[] = []

    // Create a default license record for each platform
    for (const [platformId, platform] of platformsMap.entries()) {
      const defaultLicense: License = {
        license_id: `lic_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        platform_id: platformId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      newLicenseRecords.push(defaultLicense)
      log(`Created default license for platform: ${platform.platform_name}`, "info")
    }

    return newLicenseRecords
  }

  const validLicenseRecords = licenseRecords.filter((license) => {
    const platformId = license.platform_id
    if (!platformId) {
      log(`License ${license.license_id || "unknown"} has no platform ID, skipping`, "warning")
      return false
    }

    const platformExists = platformsMap.has(platformId)
    if (!platformExists) {
      log(
        `License ${license.license_id || "unknown"} references non-existent platform ${platformId}, skipping`,
        "warning",
      )
      return false
    }

    return true
  })

  log(`Validated ${validLicenseRecords.length}/${licenseRecords.length} license records`, "info")
  return validLicenseRecords
}

// ---- Completeness ----
function isComplete(license: License): boolean {
  return !!(license.license_type && license.open_source_status && license.license_name)
}

// ---- Enrichment via OpenAI ----
async function enrichLicense(license: License, platform: Platform): Promise<License> {
  try {
    log(`Enriching license for platform: ${platform.platform_name}`, "info")

    const prompt = `
Provide accurate licensing information about the AI platform "${platform.platform_name}" in JSON format with the following fields:
- license_type: The type of license (must be one of: "Open-source", "Proprietary", "Creative Commons", "Other")
- open_source_status: Whether the platform is open source ("Yes", "No", "Partially")
- license_name: The specific name of the license (e.g., "MIT", "Apache 2.0", "GPL v3", "Commercial License")
- license_url: URL to the license text or license information page
- license_expiration_date: When the license expires, if applicable (e.g., "None", "Perpetual", "2025-12-31")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
        `
    const enriched = await makeOpenAIRequest<Partial<License>>(openai, prompt)

    // Update timestamp
    const timestamp = new Date().toISOString()

    // Merge with existing license data, only updating null/undefined fields
    const enrichedLicense: License = { ...license }
    Object.keys(enriched).forEach((key) => {
      if (enrichedLicense[key] === undefined || enrichedLicense[key] === null || enrichedLicense[key] === "") {
        enrichedLicense[key] = enriched[key as keyof Partial<License>]
      }
    })

    enrichedLicense.updatedAt = timestamp

    const validation = validateLicense(enrichedLicense)
    if (!validation.valid) {
      log(`Validation failed for license ${license.license_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedLicense
  } catch (error: any) {
    log(`Failed to enrich license for ${platform.platform_name}: ${error.message}`, "error")
    return license
  }
}

// ---- Processing ----
async function processLicenses(licenseRecords: License[], platformsMap: Map<string, Platform>): Promise<License[]> {
  const processed: License[] = []

  for (let i = 0; i < licenseRecords.length; i++) {
    const license = licenseRecords[i]
    const platform = platformsMap.get(license.platform_id)

    if (!platform) {
      log(`Platform not found for license with platform_id: ${license.platform_id}`, "error")
      processed.push(license)
      continue
    }

    if (isComplete(license)) {
      log(`Skipping license ${i + 1}/${licenseRecords.length}: ${license.license_id} (already complete)`, "info")
      processed.push(license)
      continue
    }

    const enriched = await enrichLicense(license, platform)
    processed.push(enriched)

    log(`Processed license ${i + 1}/${licenseRecords.length} for platform: ${platform.platform_name}`, "info")

    if (i < licenseRecords.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting licenses processor...", "info")

    // Load platforms and licenses
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    const platformsMap = createLookupMap(platforms, "platform_id")

    let licenseRecords = loadCsvData<License>(LICENSES_CSV_PATH)

    // Create backup of licenses file if it exists and has data
    if (fs.existsSync(LICENSES_CSV_PATH) && fs.statSync(LICENSES_CSV_PATH).size > 0) {
      createBackup(LICENSES_CSV_PATH, BACKUP_DIR)
    }

    // Validate licenses against platforms
    licenseRecords = validateLicensesAgainstPlatforms(licenseRecords, platformsMap)

    // Process and enrich license data
    licenseRecords = await processLicenses(licenseRecords, platformsMap)

    // Save to CSV
    saveCsvData(LICENSES_CSV_PATH, licenseRecords)

    log("Licenses processing completed successfully ✅", "success")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

