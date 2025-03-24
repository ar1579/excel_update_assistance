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
interface SecurityAndCompliance {
  security_id: string
  platform_id: string
  security_certifications?: string
  compliance_standards?: string
  gdpr_compliance?: string
  hipaa_compliance?: string
  iso_certifications?: string
  data_retention_policies?: string
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
const SECURITY_CSV_PATH = path.join(DATA_DIR, "Security_and_Compliance.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateSecurityAndCompliance(security: SecurityAndCompliance): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!security.security_id) errors.push("security_id is required")
  if (!security.platform_id) errors.push("platform_id is required")

  // Check boolean fields if present
  if (security.gdpr_compliance && !["true", "false"].includes(security.gdpr_compliance.toLowerCase())) {
    errors.push("gdpr_compliance must be a boolean value (true or false)")
  }

  if (security.hipaa_compliance && !["true", "false"].includes(security.hipaa_compliance.toLowerCase())) {
    errors.push("hipaa_compliance must be a boolean value (true or false)")
  }

  return { valid: errors.length === 0, errors }
}

// ---- Validate security records against platforms ----
function validateSecurityAgainstPlatforms(
  securityRecords: SecurityAndCompliance[],
  platformsMap: Map<string, Platform>,
): SecurityAndCompliance[] {
  log("Validating security and compliance records against platforms...", "info")

  // If no security records, create default ones for testing
  if (securityRecords.length === 0 && platformsMap.size > 0) {
    log("No security and compliance records found in CSV, creating default records for testing", "warning")
    const newSecurityRecords: SecurityAndCompliance[] = []

    // Create a default security record for each platform
    for (const [platformId, platform] of platformsMap.entries()) {
      const defaultSecurity: SecurityAndCompliance = {
        security_id: `sec_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        platform_id: platformId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      newSecurityRecords.push(defaultSecurity)
      log(`Created default security and compliance record for platform: ${platform.platform_name}`, "info")
    }

    return newSecurityRecords
  }

  const validSecurityRecords = securityRecords.filter((security) => {
    const platformId = security.platform_id
    if (!platformId) {
      log(`Security record ${security.security_id || "unknown"} has no platform ID, skipping`, "warning")
      return false
    }

    const platformExists = platformsMap.has(platformId)
    if (!platformExists) {
      log(
        `Security record ${security.security_id || "unknown"} references non-existent platform ${platformId}, skipping`,
        "warning",
      )
      return false
    }

    return true
  })

  log(`Validated ${validSecurityRecords.length}/${securityRecords.length} security and compliance records`, "info")
  return validSecurityRecords
}

// ---- Completeness ----
function isComplete(security: SecurityAndCompliance): boolean {
  return !!(
    security.security_certifications &&
    security.compliance_standards &&
    security.gdpr_compliance &&
    security.hipaa_compliance &&
    security.data_retention_policies
  )
}

// ---- Enrichment via OpenAI ----
async function enrichSecurityAndCompliance(
  security: SecurityAndCompliance,
  platform: Platform,
): Promise<SecurityAndCompliance> {
  try {
    log(`Enriching security and compliance for platform: ${platform.platform_name}`, "info")

    const prompt = `
Provide accurate information about the security and compliance features of the AI platform "${platform.platform_name}" in JSON format with the following fields:
- security_certifications: Security certifications held by the platform (e.g., "SOC 2, ISO 27001, PCI DSS")
- compliance_standards: Compliance standards followed (e.g., "GDPR, HIPAA, CCPA, FERPA")
- gdpr_compliance: Whether the platform is GDPR compliant (must be "true" or "false")
- hipaa_compliance: Whether the platform is HIPAA compliant (must be "true" or "false")
- iso_certifications: ISO certifications held (e.g., "ISO 27001, ISO 27017, ISO 27018")
- data_retention_policies: Data retention policies (e.g., "30 days by default, configurable up to 7 years")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
        `
    const enriched = await makeOpenAIRequest<Partial<SecurityAndCompliance>>(openai, prompt)

    // Update timestamp
    const timestamp = new Date().toISOString()

    // Merge with existing security data, only updating null/undefined fields
    const enrichedSecurity: SecurityAndCompliance = { ...security }
    Object.keys(enriched).forEach((key) => {
      if (enrichedSecurity[key] === undefined || enrichedSecurity[key] === null || enrichedSecurity[key] === "") {
        enrichedSecurity[key] = enriched[key as keyof Partial<SecurityAndCompliance>]
      }
    })

    enrichedSecurity.updatedAt = timestamp

    const validation = validateSecurityAndCompliance(enrichedSecurity)
    if (!validation.valid) {
      log(`Validation failed for security record ${security.security_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedSecurity
  } catch (error: any) {
    log(`Failed to enrich security and compliance for ${platform.platform_name}: ${error.message}`, "error")
    return security
  }
}

// ---- Processing ----
async function processSecurityAndCompliance(
  securityRecords: SecurityAndCompliance[],
  platformsMap: Map<string, Platform>,
): Promise<SecurityAndCompliance[]> {
  const processed: SecurityAndCompliance[] = []

  for (let i = 0; i < securityRecords.length; i++) {
    const security = securityRecords[i]
    const platform = platformsMap.get(security.platform_id)

    if (!platform) {
      log(`Platform not found for security record with platform_id: ${security.platform_id}`, "error")
      processed.push(security)
      continue
    }

    if (isComplete(security)) {
      log(
        `Skipping security record ${i + 1}/${securityRecords.length}: ${security.security_id} (already complete)`,
        "info",
      )
      processed.push(security)
      continue
    }

    const enriched = await enrichSecurityAndCompliance(security, platform)
    processed.push(enriched)

    log(`Processed security record ${i + 1}/${securityRecords.length} for platform: ${platform.platform_name}`, "info")

    if (i < securityRecords.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting security and compliance processor...", "info")

    // Load platforms and security records
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    const platformsMap = createLookupMap(platforms, "platform_id")

    let securityRecords = loadCsvData<SecurityAndCompliance>(SECURITY_CSV_PATH)

    // Create backup of security file if it exists and has data
    if (fs.existsSync(SECURITY_CSV_PATH) && fs.statSync(SECURITY_CSV_PATH).size > 0) {
      createBackup(SECURITY_CSV_PATH, BACKUP_DIR)
    }

    // Validate security records against platforms
    securityRecords = validateSecurityAgainstPlatforms(securityRecords, platformsMap)

    // Process and enrich security data
    securityRecords = await processSecurityAndCompliance(securityRecords, platformsMap)

    // Save to CSV
    saveCsvData(SECURITY_CSV_PATH, securityRecords)

    log("Security and compliance processing completed successfully ✅", "success")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

