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
interface ApiIntegration {
  integration_id: string
  api_id: string
  integration_type?: string
  integration_details?: string
  integration_url?: string
  createdAt: string
  updatedAt: string
  [key: string]: string | undefined
}

interface API {
  api_id: string
  platform_id: string
  api_standards?: string
  [key: string]: string | undefined
}

interface Platform {
  platform_id: string
  platform_name: string
  [key: string]: string | undefined
}

// ---- File Paths ----
const DATA_DIR = path.join(process.cwd(), "data")
const API_INTEGRATIONS_CSV_PATH = path.join(DATA_DIR, "api_integrations.csv")
const API_CSV_PATH = path.join(DATA_DIR, "API.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateApiIntegration(integration: ApiIntegration): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!integration.integration_id) errors.push("integration_id is required")
  if (!integration.api_id) errors.push("api_id is required")
  if (!integration.integration_type) errors.push("integration_type is required")

  // URL validation
  if (integration.integration_url && !integration.integration_url.startsWith("http")) {
    errors.push("integration_url must be a valid URL")
  }

  // Type validation
  const validTypes = ["REST", "GraphQL", "SOAP", "SDK", "Webhook", "OAuth", "Custom"]
  if (integration.integration_type && !validTypes.some((t) => integration.integration_type!.includes(t))) {
    errors.push(`integration_type must include one of: ${validTypes.join(", ")}`)
  }

  return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(integration: ApiIntegration): boolean {
  return !!integration.integration_type && !!integration.integration_details
}

// ---- Enrichment via OpenAI ----
async function enrichApiIntegration(
  integration: ApiIntegration,
  apis: API[],
  platforms: Platform[],
): Promise<ApiIntegration> {
  try {
    log(`Enriching API integration for: ${integration.integration_id}`, "info")

    const api = apis.find((a) => a.api_id === integration.api_id)
    if (!api) {
      log(`API not found for integration_id: ${integration.integration_id}`, "warning")
      return integration
    }

    const platform = platforms.find((p) => p.platform_id === api.platform_id)
    const platformName = platform ? platform.platform_name : "Unknown Platform"
    const apiStandards = api.api_standards || "REST"

    const prompt = `
Provide enriched API integration data for the platform "${platformName}" with API standards "${apiStandards}" in the following JSON format:
{
  "integration_type": "One of: REST, GraphQL, SOAP, SDK, Webhook, OAuth, Custom",
  "integration_details": "Detailed description of this integration",
  "integration_url": "URL to documentation for this integration (if available)"
}

Return only the JSON object with realistic, accurate integration information for this platform's API.
        `
    const enriched = await makeOpenAIRequest<Partial<ApiIntegration>>(openai, prompt)
    const enrichedIntegration: ApiIntegration = {
      ...integration,
      ...enriched,
      updatedAt: new Date().toISOString(),
    }

    const validation = validateApiIntegration(enrichedIntegration)
    if (!validation.valid) {
      log(`Validation failed for ${integration.integration_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedIntegration
  } catch (error: any) {
    log(`Failed to enrich API integration ${integration.integration_id}: ${error.message}`, "error")
    return integration
  }
}

// ---- Processing ----
async function processApiIntegrations(
  integrations: ApiIntegration[],
  apis: API[],
  platforms: Platform[],
): Promise<ApiIntegration[]> {
  const processed: ApiIntegration[] = []

  for (let i = 0; i < integrations.length; i++) {
    const integration = integrations[i]

    if (isComplete(integration)) {
      log(`Skipping ${integration.integration_id} (already complete)`, "info")
      processed.push(integration)
      continue
    }

    const enriched = await enrichApiIntegration(integration, apis, platforms)
    processed.push(enriched)

    if (i < integrations.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting API integrations processor...", "info")

    // Load APIs data
    if (!fs.existsSync(API_CSV_PATH)) {
      log("API.csv not found. Please run process-api.ts first.", "error")
      process.exit(1)
    }
    const apis = loadCsvData<API>(API_CSV_PATH)
    log(`Loaded ${apis.length} APIs`, "info")

    // Load platforms data
    if (!fs.existsSync(PLATFORMS_CSV_PATH)) {
      log("Platforms.csv not found. Please run process-platforms.ts first.", "error")
      process.exit(1)
    }
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    log(`Loaded ${platforms.length} platforms`, "info")

    // Load or initialize API integrations data
    const integrations = fs.existsSync(API_INTEGRATIONS_CSV_PATH)
      ? loadCsvData<ApiIntegration>(API_INTEGRATIONS_CSV_PATH)
      : []

    // Create API integration entries for APIs without them
    const apiWithIntegrations = new Map<string, number>()
    for (const integration of integrations) {
      const count = apiWithIntegrations.get(integration.api_id) || 0
      apiWithIntegrations.set(integration.api_id, count + 1)
    }

    const newIntegrations: ApiIntegration[] = []
    for (const api of apis) {
      // Create 2-4 integrations per API
      const existingCount = apiWithIntegrations.get(api.api_id) || 0
      const targetCount = Math.floor(Math.random() * 3) + 2 // 2-4 integrations

      for (let i = existingCount; i < targetCount; i++) {
        const newIntegration: ApiIntegration = {
          integration_id: `integration_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          api_id: api.api_id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        newIntegrations.push(newIntegration)
        log(`Created new API integration for API ID: ${api.api_id}`, "info")
        await applyRateLimit(100) // Small delay to ensure unique IDs
      }
    }

    const allIntegrations = [...integrations, ...newIntegrations]

    // Create backup if file exists
    if (fs.existsSync(API_INTEGRATIONS_CSV_PATH) && fs.statSync(API_INTEGRATIONS_CSV_PATH).size > 0) {
      createBackup(API_INTEGRATIONS_CSV_PATH, BACKUP_DIR)
    }

    // Process and enrich API integrations
    const enriched = await processApiIntegrations(allIntegrations, apis, platforms)
    saveCsvData(API_INTEGRATIONS_CSV_PATH, enriched)

    log(`API integrations processor complete. Processed ${enriched.length} records ✅`, "info")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

