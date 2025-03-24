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
interface Versioning {
  version_id: string
  platform_id: string
  release_date?: string
  last_updated?: string
  maintenance_status?: string
  deprecation_date?: string
  update_frequency?: string
  changelog_url?: string
  version_numbering_scheme?: string
  backward_compatibility_notes?: string
  known_issues?: string
  createdAt: string
  updatedAt: string
  [key: string]: string | undefined
}

interface Platform {
  platform_id: string
  platform_name: string
  [key: string]: string | undefined
}

// ---- File Paths ----
const DATA_DIR = path.join(process.cwd(), "data")
const VERSIONING_CSV_PATH = path.join(DATA_DIR, "Versioning.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateVersioning(version: Versioning): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!version.version_id) errors.push("version_id is required")
  if (!version.platform_id) errors.push("platform_id is required")

  // Date validations
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (version.release_date && !dateRegex.test(version.release_date)) {
    errors.push("release_date must be in YYYY-MM-DD format")
  }
  if (version.last_updated && !dateRegex.test(version.last_updated)) {
    errors.push("last_updated must be in YYYY-MM-DD format")
  }
  if (version.deprecation_date && !dateRegex.test(version.deprecation_date)) {
    errors.push("deprecation_date must be in YYYY-MM-DD format")
  }

  // Enum validations
  if (
    version.maintenance_status &&
    !["Active", "Maintenance", "Deprecated", "End of Life"].includes(version.maintenance_status)
  ) {
    errors.push("maintenance_status must be one of: Active, Maintenance, Deprecated, End of Life")
  }

  if (
    version.update_frequency &&
    !["Weekly", "Monthly", "Quarterly", "Annually", "As Needed"].includes(version.update_frequency)
  ) {
    errors.push("update_frequency must be one of: Weekly, Monthly, Quarterly, Annually, As Needed")
  }

  // URL validation
  if (version.changelog_url && !version.changelog_url.startsWith("http")) {
    errors.push("changelog_url must be a valid URL")
  }

  return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(version: Versioning): boolean {
  return (
    !!version.release_date &&
    !!version.maintenance_status &&
    !!version.update_frequency &&
    !!version.version_numbering_scheme
  )
}

// ---- Enrichment via OpenAI ----
async function enrichVersioning(version: Versioning, platforms: Platform[]): Promise<Versioning> {
  try {
    log(`Enriching versioning for: ${version.version_id}`, "info")

    const platform = platforms.find((p) => p.platform_id === version.platform_id)
    if (!platform) {
      log(`Platform not found for version_id: ${version.version_id}`, "warning")
      return version
    }

    const prompt = `
Provide enriched versioning data for the AI platform "${platform.platform_name}" in the following JSON format:
{
  "release_date": "YYYY-MM-DD format, estimate the initial release date",
  "last_updated": "YYYY-MM-DD format, estimate the last update date",
  "maintenance_status": "One of: Active, Maintenance, Deprecated, End of Life",
  "deprecation_date": "YYYY-MM-DD format if applicable, or leave empty",
  "update_frequency": "One of: Weekly, Monthly, Quarterly, Annually, As Needed",
  "changelog_url": "URL to the platform's changelog or release notes",
  "version_numbering_scheme": "Description of how versions are numbered (e.g., Semantic Versioning)",
  "backward_compatibility_notes": "Notes on backward compatibility between versions",
  "known_issues": "Any known issues with the current version"
}

Return only the JSON object with realistic, accurate information about ${platform.platform_name}'s versioning.
        `
    const enriched = await makeOpenAIRequest<Partial<Versioning>>(openai, prompt)
    const enrichedVersion: Versioning = {
      ...version,
      ...enriched,
      updatedAt: new Date().toISOString(),
    }

    const validation = validateVersioning(enrichedVersion)
    if (!validation.valid) {
      log(`Validation failed for ${version.version_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedVersion
  } catch (error: any) {
    log(`Failed to enrich versioning ${version.version_id}: ${error.message}`, "error")
    return version
  }
}

// ---- Processing ----
async function processVersioning(versions: Versioning[], platforms: Platform[]): Promise<Versioning[]> {
  const processed: Versioning[] = []

  for (let i = 0; i < versions.length; i++) {
    const version = versions[i]

    if (isComplete(version)) {
      log(`Skipping ${version.version_id} (already complete)`, "info")
      processed.push(version)
      continue
    }

    const enriched = await enrichVersioning(version, platforms)
    processed.push(enriched)

    if (i < versions.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting versioning processor...", "info")

    // Load platforms data
    if (!fs.existsSync(PLATFORMS_CSV_PATH)) {
      log("Platforms.csv not found. Please run process-platforms.ts first.", "error")
      process.exit(1)
    }
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    log(`Loaded ${platforms.length} platforms`, "info")

    // Load or initialize versioning data
    const versions = fs.existsSync(VERSIONING_CSV_PATH) ? loadCsvData<Versioning>(VERSIONING_CSV_PATH) : []

    // Create versioning entries for platforms without one
    const platformIds = new Set(versions.map((v) => v.platform_id))
    const newVersions: Versioning[] = []

    for (const platform of platforms) {
      if (!platformIds.has(platform.platform_id)) {
        const newVersion: Versioning = {
          version_id: `version_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          platform_id: platform.platform_id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        newVersions.push(newVersion)
        log(`Created new versioning entry for platform: ${platform.platform_name}`, "info")
      }
    }

    const allVersions = [...versions, ...newVersions]

    // Create backup if file exists
    if (fs.existsSync(VERSIONING_CSV_PATH) && fs.statSync(VERSIONING_CSV_PATH).size > 0) {
      createBackup(VERSIONING_CSV_PATH, BACKUP_DIR)
    }

    // Process and enrich versioning
    const enriched = await processVersioning(allVersions, platforms)
    saveCsvData(VERSIONING_CSV_PATH, enriched)

    log(`Versioning processor complete. Processed ${enriched.length} records ✅`, "info")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

