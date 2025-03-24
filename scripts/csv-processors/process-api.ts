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
interface API {
  api_id: string
  platform_id: string
  api_standards?: string
  authentication_methods?: string
  webhook_support?: string
  third_party_integrations?: string
  export_formats?: string
  import_capabilities?: string
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
const API_CSV_PATH = path.join(DATA_DIR, "API.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateAPI(api: API): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!api.api_id) errors.push("api_id is required")
  if (!api.platform_id) errors.push("platform_id is required")

  // Enum validations
  if (api.webhook_support && !["Yes", "No", "Limited"].includes(api.webhook_support)) {
    errors.push("webhook_support must be one of: Yes, No, Limited")
  }

  // API standards validation
  const validStandards = ["REST", "GraphQL", "SOAP", "gRPC", "WebSockets", "JSON-RPC"]
  if (api.api_standards) {
    const standards = api.api_standards.split(",").map((s) => s.trim())
    for (const standard of standards) {
      if (!validStandards.some((vs) => standard.includes(vs))) {
        errors.push(`api_standards contains invalid standard: ${standard}`)
      }
    }
  }

  // Authentication methods validation
  const validAuthMethods = ["API Key", "OAuth", "JWT", "Basic Auth", "Bearer Token"]
  if (api.authentication_methods) {
    const methods = api.authentication_methods.split(",").map((m) => m.trim())
    for (const method of methods) {
      if (!validAuthMethods.some((vm) => method.includes(vm))) {
        errors.push(`authentication_methods contains invalid method: ${method}`)
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(api: API): boolean {
  return !!api.api_standards && !!api.authentication_methods && !!api.webhook_support && !!api.third_party_integrations
}

// ---- Enrichment via OpenAI ----
async function enrichAPI(api: API, platforms: Platform[]): Promise<API> {
  try {
    log(`Enriching API for: ${api.api_id}`, "info")

    const platform = platforms.find((p) => p.platform_id === api.platform_id)
    if (!platform) {
      log(`Platform not found for api_id: ${api.api_id}`, "warning")
      return api
    }

    const prompt = `
Provide enriched API data for the AI platform "${platform.platform_name}" in the following JSON format:
{
  "api_standards": "Comma-separated list of API standards (e.g., REST, GraphQL, SOAP, gRPC, WebSockets, JSON-RPC)",
  "authentication_methods": "Comma-separated list of authentication methods (e.g., API Key, OAuth, JWT, Basic Auth, Bearer Token)",
  "webhook_support": "One of: Yes, No, Limited",
  "third_party_integrations": "List of supported third-party integrations",
  "export_formats": "Supported data export formats (e.g., JSON, CSV, XML)",
  "import_capabilities": "Supported data import capabilities"
}

Return only the JSON object with realistic, accurate information about ${platform.platform_name}'s API.
        `
    const enriched = await makeOpenAIRequest<Partial<API>>(openai, prompt)
    const enrichedAPI: API = {
      ...api,
      ...enriched,
      updatedAt: new Date().toISOString(),
    }

    const validation = validateAPI(enrichedAPI)
    if (!validation.valid) {
      log(`Validation failed for ${api.api_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedAPI
  } catch (error: any) {
    log(`Failed to enrich API ${api.api_id}: ${error.message}`, "error")
    return api
  }
}

// ---- Processing ----
async function processAPIs(apis: API[], platforms: Platform[]): Promise<API[]> {
  const processed: API[] = []

  for (let i = 0; i < apis.length; i++) {
    const api = apis[i]

    if (isComplete(api)) {
      log(`Skipping ${api.api_id} (already complete)`, "info")
      processed.push(api)
      continue
    }

    const enriched = await enrichAPI(api, platforms)
    processed.push(enriched)

    if (i < apis.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting API processor...", "info")

    // Load platforms data
    if (!fs.existsSync(PLATFORMS_CSV_PATH)) {
      log("Platforms.csv not found. Please run process-platforms.ts first.", "error")
      process.exit(1)
    }
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    log(`Loaded ${platforms.length} platforms`, "info")

    // Load or initialize API data
    const apis = fs.existsSync(API_CSV_PATH) ? loadCsvData<API>(API_CSV_PATH) : []

    // Create API entries for platforms without one
    const platformIds = new Set(apis.map((a) => a.platform_id))
    const newAPIs: API[] = []

    for (const platform of platforms) {
      if (!platformIds.has(platform.platform_id)) {
        const newAPI: API = {
          api_id: `api_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          platform_id: platform.platform_id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        newAPIs.push(newAPI)
        log(`Created new API entry for platform: ${platform.platform_name}`, "info")
      }
    }

    const allAPIs = [...apis, ...newAPIs]

    // Create backup if file exists
    if (fs.existsSync(API_CSV_PATH) && fs.statSync(API_CSV_PATH).size > 0) {
      createBackup(API_CSV_PATH, BACKUP_DIR)
    }

    // Process and enrich APIs
    const enriched = await processAPIs(allAPIs, platforms)
    saveCsvData(API_CSV_PATH, enriched)

    log(`API processor complete. Processed ${enriched.length} records ✅`, "info")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

