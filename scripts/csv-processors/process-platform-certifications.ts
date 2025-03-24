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
interface PlatformCertification {
  platform_certification_id: string
  platform_id: string
  certification_id: string
  certification_date?: string
  expiration_date?: string
  certification_scope?: string
  verification_url?: string
  createdAt: string
  updatedAt: string
  [key: string]: string | undefined
}

interface Platform {
  platform_id: string
  platform_name: string
  [key: string]: string | undefined
}

interface SecurityCompliance {
  security_id: string
  platform_id: string
  security_certifications?: string
  [key: string]: string | undefined
}

// ---- File Paths ----
const DATA_DIR = path.join(process.cwd(), "data")
const PLATFORM_CERTIFICATIONS_CSV_PATH = path.join(DATA_DIR, "platform_certifications.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const SECURITY_COMPLIANCE_CSV_PATH = path.join(DATA_DIR, "Security_and_Compliance.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validatePlatformCertification(platformCertification: PlatformCertification): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []

  if (!platformCertification.platform_certification_id) errors.push("platform_certification_id is required")
  if (!platformCertification.platform_id) errors.push("platform_id is required")
  if (!platformCertification.certification_id) errors.push("certification_id is required")

  // Date validations
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (platformCertification.certification_date && !dateRegex.test(platformCertification.certification_date)) {
    errors.push("certification_date must be in YYYY-MM-DD format")
  }
  if (platformCertification.expiration_date && !dateRegex.test(platformCertification.expiration_date)) {
    errors.push("expiration_date must be in YYYY-MM-DD format")
  }

  // URL validation
  if (platformCertification.verification_url && !platformCertification.verification_url.startsWith("http")) {
    errors.push("verification_url must be a valid URL")
  }

  return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(platformCertification: PlatformCertification): boolean {
  return !!platformCertification.certification_date && !!platformCertification.certification_scope
}

// ---- Enrichment via OpenAI ----
async function enrichPlatformCertification(
  platformCertification: PlatformCertification,
  platforms: Platform[],
  securityCompliances: SecurityCompliance[],
): Promise<PlatformCertification> {
  try {
    log(`Enriching platform certification for: ${platformCertification.platform_certification_id}`, "info")

    const platform = platforms.find((p) => p.platform_id === platformCertification.platform_id)
    if (!platform) {
      log(
        `Platform not found for platform_certification_id: ${platformCertification.platform_certification_id}`,
        "warning",
      )
      return platformCertification
    }

    const securityCompliance = securityCompliances.find(
      (sc) => sc.security_id === platformCertification.certification_id,
    )
    if (!securityCompliance) {
      log(
        `Security compliance not found for platform_certification_id: ${platformCertification.platform_certification_id}`,
        "warning",
      )
      return platformCertification
    }

    const certifications = securityCompliance.security_certifications || "ISO 27001, SOC 2"

    const prompt = `
Provide enriched platform certification data for the AI platform "${platform.platform_name}" regarding the certification "${certifications}" in the following JSON format:
{
  "certification_date": "Date when the certification was obtained (YYYY-MM-DD format)",
  "expiration_date": "Date when the certification expires (YYYY-MM-DD format)",
  "certification_scope": "Scope of what the certification covers",
  "verification_url": "URL to verify the certification (if available)"
}

Return only the JSON object with realistic, accurate information about this certification for this platform.
        `
    const enriched = await makeOpenAIRequest<Partial<PlatformCertification>>(openai, prompt)
    const enrichedPlatformCertification: PlatformCertification = {
      ...platformCertification,
      ...enriched,
      updatedAt: new Date().toISOString(),
    }

    const validation = validatePlatformCertification(enrichedPlatformCertification)
    if (!validation.valid) {
      log(
        `Validation failed for ${platformCertification.platform_certification_id}: ${validation.errors.join(", ")}`,
        "warning",
      )
    }

    return enrichedPlatformCertification
  } catch (error: any) {
    log(
      `Failed to enrich platform certification ${platformCertification.platform_certification_id}: ${error.message}`,
      "error",
    )
    return platformCertification
  }
}

// ---- Processing ----
async function processPlatformCertifications(
  platformCertifications: PlatformCertification[],
  platforms: Platform[],
  securityCompliances: SecurityCompliance[],
): Promise<PlatformCertification[]> {
  const processed: PlatformCertification[] = []

  for (let i = 0; i < platformCertifications.length; i++) {
    const platformCertification = platformCertifications[i]

    if (isComplete(platformCertification)) {
      log(`Skipping ${platformCertification.platform_certification_id} (already complete)`, "info")
      processed.push(platformCertification)
      continue
    }

    const enriched = await enrichPlatformCertification(platformCertification, platforms, securityCompliances)
    processed.push(enriched)

    if (i < platformCertifications.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting platform certifications processor...", "info")

    // Load platforms data
    if (!fs.existsSync(PLATFORMS_CSV_PATH)) {
      log("Platforms.csv not found. Please run process-platforms.ts first.", "error")
      process.exit(1)
    }
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    log(`Loaded ${platforms.length} platforms`, "info")

    // Load security compliance data
    if (!fs.existsSync(SECURITY_COMPLIANCE_CSV_PATH)) {
      log("Security_and_Compliance.csv not found. Please run process-security-and-compliance.ts first.", "error")
      process.exit(1)
    }
    const securityCompliances = loadCsvData<SecurityCompliance>(SECURITY_COMPLIANCE_CSV_PATH)
    log(`Loaded ${securityCompliances.length} security compliances`, "info")

    // Load or initialize platform certifications data
    const platformCertifications = fs.existsSync(PLATFORM_CERTIFICATIONS_CSV_PATH)
      ? loadCsvData<PlatformCertification>(PLATFORM_CERTIFICATIONS_CSV_PATH)
      : []

    // Create platform certification entries for platform-certification pairs that don't exist
    const existingPairs = new Set(platformCertifications.map((pc) => `${pc.platform_id}-${pc.certification_id}`))
    const newPlatformCertifications: PlatformCertification[] = []

    // For each platform, add connections to relevant certifications
    for (const platform of platforms) {
      // Get all security compliances for this platform
      const securityCompliancesForPlatform = securityCompliances.filter((sc) => sc.platform_id === platform.platform_id)

      for (const securityCompliance of securityCompliancesForPlatform) {
        const pairKey = `${platform.platform_id}-${securityCompliance.security_id}`
        if (!existingPairs.has(pairKey)) {
          const newPlatformCertification: PlatformCertification = {
            platform_certification_id: `platform_certification_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            platform_id: platform.platform_id,
            certification_id: securityCompliance.security_id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
          newPlatformCertifications.push(newPlatformCertification)
          existingPairs.add(pairKey)
          log(`Created new platform certification connection for platform: ${platform.platform_name}`, "info")
          await applyRateLimit(100) // Small delay to ensure unique IDs
        }
      }
    }

    const allPlatformCertifications = [...platformCertifications, ...newPlatformCertifications]

    // Create backup if file exists
    if (fs.existsSync(PLATFORM_CERTIFICATIONS_CSV_PATH) && fs.statSync(PLATFORM_CERTIFICATIONS_CSV_PATH).size > 0) {
      createBackup(PLATFORM_CERTIFICATIONS_CSV_PATH, BACKUP_DIR)
    }

    // Process and enrich platform certifications
    const enriched = await processPlatformCertifications(allPlatformCertifications, platforms, securityCompliances)
    saveCsvData(PLATFORM_CERTIFICATIONS_CSV_PATH, enriched)

    log(`Platform certifications processor complete. Processed ${enriched.length} records ✅`, "info")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

