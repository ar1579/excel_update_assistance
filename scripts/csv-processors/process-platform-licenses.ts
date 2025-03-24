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
interface PlatformLicense {
  platform_license_id: string
  platform_id: string
  license_id: string
  license_tier?: string
  license_restrictions?: string
  license_url?: string
  createdAt?: string
  updatedAt?: string
  [key: string]: string | undefined
}

interface Platform {
  platform_id: string
  platform_name: string
  [key: string]: string | undefined
}

interface License {
  license_id: string
  license_name?: string
  license_type?: string
  [key: string]: string | undefined
}

// ---- File Paths ----
const DATA_DIR = path.join(process.cwd(), "data")
const PLATFORM_LICENSES_CSV_PATH = path.join(DATA_DIR, "platform_licenses.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const LICENSES_CSV_PATH = path.join(DATA_DIR, "Licenses.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validatePlatformLicense(platformLicense: PlatformLicense): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!platformLicense.platform_license_id) errors.push("platform_license_id is required")
  if (!platformLicense.platform_id) errors.push("platform_id is required")
  if (!platformLicense.license_id) errors.push("license_id is required")

  return { valid: errors.length === 0, errors }
}

/**
 * Validate licenses against schema constraints
 */
export function validateLicenses(licenses: License[]): boolean {
  for (const license of licenses) {
    if (
      license.license_type &&
      !["Open-source", "Proprietary", "Creative Commons", "Other"].includes(license.license_type)
    ) {
      return false
    }
  }
  return true
}

// ---- Validate platform licenses against platforms and licenses ----
function validatePlatformLicensesAgainstReferences(
  platformLicenseRecords: PlatformLicense[],
  platformsMap: Map<string, Platform>,
  licensesMap: Map<string, License>,
): PlatformLicense[] {
  log("Validating platform licenses against platforms and licenses...", "info")

  // If no platform license records, create default ones for testing
  if (platformLicenseRecords.length === 0 && platformsMap.size > 0 && licensesMap.size > 0) {
    log("No platform license records found in CSV, creating default platform licenses for testing", "warning")
    const newPlatformLicenseRecords: PlatformLicense[] = []

    // Create a default platform license record for each platform with the first license
    const licenseIds = Array.from(licensesMap.keys())
    if (licenseIds.length > 0) {
      for (const [platformId, platform] of platformsMap.entries()) {
        const defaultPlatformLicense: PlatformLicense = {
          platform_license_id: `plat_lic_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          platform_id: platformId,
          license_id: licenseIds[0],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        newPlatformLicenseRecords.push(defaultPlatformLicense)
        log(`Created default platform license for platform: ${platform.platform_name}`, "info")
      }
    }

    return newPlatformLicenseRecords
  }

  const validPlatformLicenseRecords = platformLicenseRecords.filter((platformLicense) => {
    const platformId = platformLicense.platform_id
    const licenseId = platformLicense.license_id

    if (!platformId) {
      log(
        `Platform license ${platformLicense.platform_license_id || "unknown"} has no platform ID, skipping`,
        "warning",
      )
      return false
    }

    if (!licenseId) {
      log(`Platform license ${platformLicense.platform_license_id || "unknown"} has no license ID, skipping`, "warning")
      return false
    }

    const platformExists = platformsMap.has(platformId)
    if (!platformExists) {
      log(
        `Platform license ${platformLicense.platform_license_id || "unknown"} references non-existent platform ${platformId}, skipping`,
        "warning",
      )
      return false
    }

    const licenseExists = licensesMap.has(licenseId)
    if (!licenseExists) {
      log(
        `Platform license ${platformLicense.platform_license_id || "unknown"} references non-existent license ${licenseId}, skipping`,
        "warning",
      )
      return false
    }

    return true
  })

  log(
    `Validated ${validPlatformLicenseRecords.length}/${platformLicenseRecords.length} platform license records`,
    "info",
  )
  return validPlatformLicenseRecords
}

// ---- Completeness ----
function isComplete(platformLicense: PlatformLicense): boolean {
  return !!(platformLicense.license_tier && platformLicense.license_restrictions)
}

// ---- Enrichment via OpenAI ----
async function enrichPlatformLicense(
  platformLicense: PlatformLicense,
  platform: Platform,
  license: License,
): Promise<PlatformLicense> {
  try {
    log(
      `Enriching platform license for platform: ${platform.platform_name} and license: ${license.license_name || license.license_id}`,
      "info",
    )

    const prompt = `
Provide accurate information about the license tier and restrictions for the platform "${platform.platform_name}" with license "${license.license_name || license.license_type || "Unknown"}" in JSON format with the following fields:
- license_tier: The tier level of the license (e.g., "Basic", "Professional", "Enterprise", "Community", "Developer")
- license_restrictions: Any restrictions or limitations of the license (e.g., "Non-commercial use only", "Limited to 5 users", "No redistribution")
- license_url: URL to the license details or terms page

Additional context:
License type: ${license.license_type || "Unknown"}
License name: ${license.license_name || "Unknown"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
        `
    const enriched = await makeOpenAIRequest<Partial<PlatformLicense>>(openai, prompt)

    // Update timestamp
    const timestamp = new Date().toISOString()

    // Merge with existing platform license data, only updating null/undefined fields
    const enrichedPlatformLicense: PlatformLicense = { ...platformLicense }
    Object.keys(enriched).forEach((key) => {
      if (
        enrichedPlatformLicense[key] === undefined ||
        enrichedPlatformLicense[key] === null ||
        enrichedPlatformLicense[key] === ""
      ) {
        enrichedPlatformLicense[key] = enriched[key as keyof Partial<PlatformLicense>]
      }
    })

    enrichedPlatformLicense.updatedAt = timestamp

    const validation = validatePlatformLicense(enrichedPlatformLicense)
    if (!validation.valid) {
      log(
        `Validation failed for platform license ${platformLicense.platform_license_id}: ${validation.errors.join(", ")}`,
        "warning",
      )
    }

    return enrichedPlatformLicense
  } catch (error: any) {
    log(`Failed to enrich platform license for ${platform.platform_name}: ${error.message}`, "error")
    return platformLicense
  }
}

// ---- Processing ----
export async function processLicenses(
  platformLicenseRecords: PlatformLicense[],
  platformsMap: Map<string, Platform>,
  licensesMap: Map<string, License>,
): Promise<PlatformLicense[]> {
  const processed: PlatformLicense[] = []

  for (let i = 0; i < platformLicenseRecords.length; i++) {
    const platformLicense = platformLicenseRecords[i]
    const platform = platformsMap.get(platformLicense.platform_id)
    const license = licensesMap.get(platformLicense.license_id)

    if (!platform) {
      log(`Platform not found for platform license with platform_id: ${platformLicense.platform_id}`, "error")
      processed.push(platformLicense)
      continue
    }

    if (!license) {
      log(`License not found for platform license with license_id: ${platformLicense.license_id}`, "error")
      processed.push(platformLicense)
      continue
    }

    if (isComplete(platformLicense)) {
      log(
        `Skipping platform license ${i + 1}/${platformLicenseRecords.length}: ${platformLicense.platform_license_id} (already complete)`,
        "info",
      )
      processed.push(platformLicense)
      continue
    }

    const enriched = await enrichPlatformLicense(platformLicense, platform, license)
    processed.push(enriched)

    log(
      `Processed platform license ${i + 1}/${platformLicenseRecords.length} for platform: ${platform.platform_name}`,
      "info",
    )

    if (i < platformLicenseRecords.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

/**
 * Update the platform_licenses join table
 */
export function updatePlatformLicensesJoinTable(platforms: Platform[], licenses: License[]): void {
  try {
    log("Updating platform_licenses join table...", "info")

    // Load existing join table data
    let platformLicenses: PlatformLicense[] = []
    if (fs.existsSync(PLATFORM_LICENSES_CSV_PATH)) {
      platformLicenses = loadCsvData<PlatformLicense>(PLATFORM_LICENSES_CSV_PATH)
    }

    // Create a map of existing relationships
    const existingRelationships = new Set<string>()
    platformLicenses.forEach((relation) => {
      existingRelationships.add(`${relation.platform_id}-${relation.license_id}`)
    })

    // Add new relationships
    const timestamp = new Date().toISOString()
    let newRelationsCount = 0

    platforms.forEach((platform) => {
      licenses.forEach((license) => {
        const relationKey = `${platform.platform_id}-${license.license_id}`
        if (!existingRelationships.has(relationKey)) {
          const platformLicenseId = `plat_lic_${Date.now()}_${Math.floor(Math.random() * 1000)}`
          platformLicenses.push({
            platform_license_id: platformLicenseId,
            platform_id: platform.platform_id,
            license_id: license.license_id,
            createdAt: timestamp,
            updatedAt: timestamp,
          })
          existingRelationships.add(relationKey)
          newRelationsCount++
        }
      })
    })

    // Save updated join table
    saveCsvData(PLATFORM_LICENSES_CSV_PATH, platformLicenses)
    log(`Updated platform_licenses join table with ${newRelationsCount} new relationships`, "info")
  } catch (error: any) {
    log(`Error updating platform_licenses join table: ${error.message}`, "error")
  }
}

// ---- Main ----
async function main() {
  try {
    log("Starting platform licenses processor...", "info")

    // Load platforms, licenses, and platform licenses
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    const platformsMap = createLookupMap(platforms, "platform_id")

    const licenses = loadCsvData<License>(LICENSES_CSV_PATH)
    const licensesMap = createLookupMap(licenses, "license_id")

    let platformLicenseRecords = loadCsvData<PlatformLicense>(PLATFORM_LICENSES_CSV_PATH)

    // Create backup of platform licenses file if it exists and has data
    if (fs.existsSync(PLATFORM_LICENSES_CSV_PATH) && fs.statSync(PLATFORM_LICENSES_CSV_PATH).size > 0) {
      createBackup(PLATFORM_LICENSES_CSV_PATH, BACKUP_DIR)
    }

    // Validate platform licenses against platforms and licenses
    platformLicenseRecords = validatePlatformLicensesAgainstReferences(
      platformLicenseRecords,
      platformsMap,
      licensesMap,
    )

    // Process and enrich platform license data
    platformLicenseRecords = await processLicenses(platformLicenseRecords, platformsMap, licensesMap)

    // Save to CSV
    saveCsvData(PLATFORM_LICENSES_CSV_PATH, platformLicenseRecords)

    log("Platform licenses processing completed successfully ✅", "success")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

// Run the main function
// main()

