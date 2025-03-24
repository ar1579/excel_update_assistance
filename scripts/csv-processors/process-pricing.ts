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
interface Pricing {
  pricing_id: string
  platform_id: string
  pricing_model?: string
  starting_price?: string
  enterprise_pricing?: string
  billing_frequency?: string
  custom_pricing_available?: string
  pricing_url?: string
  discount_options?: string
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
const PRICING_CSV_PATH = path.join(DATA_DIR, "Pricing.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validatePricing(pricing: Pricing): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!pricing.pricing_id) errors.push("pricing_id is required")
  if (!pricing.platform_id) errors.push("platform_id is required")

  // Check pricing_model constraint if present
  if (pricing.pricing_model && !["Subscription", "One-Time", "Usage-Based", "Free"].includes(pricing.pricing_model)) {
    errors.push("pricing_model must be one of: Subscription, One-Time, Usage-Based, Free")
  }

  return { valid: errors.length === 0, errors }
}

// ---- Validate pricing against platforms ----
function validatePricingAgainstPlatforms(pricingRecords: Pricing[], platformsMap: Map<string, Platform>): Pricing[] {
  log("Validating pricing against platforms...", "info")

  // If no pricing records, create default ones for testing
  if (pricingRecords.length === 0 && platformsMap.size > 0) {
    log("No pricing records found in CSV, creating default pricing for testing", "warning")
    const newPricingRecords: Pricing[] = []

    // Create a default pricing record for each platform
    for (const [platformId, platform] of platformsMap.entries()) {
      const defaultPricing: Pricing = {
        pricing_id: `price_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        platform_id: platformId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      newPricingRecords.push(defaultPricing)
      log(`Created default pricing for platform: ${platform.platform_name}`, "info")
    }

    return newPricingRecords
  }

  const validPricingRecords = pricingRecords.filter((pricing) => {
    const platformId = pricing.platform_id
    if (!platformId) {
      log(`Pricing ${pricing.pricing_id || "unknown"} has no platform ID, skipping`, "warning")
      return false
    }

    const platformExists = platformsMap.has(platformId)
    if (!platformExists) {
      log(
        `Pricing ${pricing.pricing_id || "unknown"} references non-existent platform ${platformId}, skipping`,
        "warning",
      )
      return false
    }

    return true
  })

  log(`Validated ${validPricingRecords.length}/${pricingRecords.length} pricing records`, "info")
  return validPricingRecords
}

// ---- Completeness ----
function isComplete(pricing: Pricing): boolean {
  return !!(
    pricing.pricing_model &&
    pricing.starting_price &&
    pricing.billing_frequency &&
    pricing.custom_pricing_available
  )
}

// ---- Enrichment via OpenAI ----
async function enrichPricing(pricing: Pricing, platform: Platform): Promise<Pricing> {
  try {
    log(`Enriching pricing for platform: ${platform.platform_name}`, "info")

    const prompt = `
Provide accurate pricing information about the AI platform "${platform.platform_name}" in JSON format with the following fields:
- pricing_model: The pricing model used (must be one of: "Subscription", "One-Time", "Usage-Based", "Free")
- starting_price: The starting price or lowest tier price (e.g., "$10/month", "Free", "$0.0001 per token")
- enterprise_pricing: Information about enterprise pricing options (e.g., "Custom pricing available", "Starting at $10,000/year")
- billing_frequency: How often billing occurs (e.g., "Monthly", "Annual", "Pay-as-you-go")
- custom_pricing_available: Whether custom pricing is available ("Yes", "No")
- pricing_url: URL to the pricing page if available
- discount_options: Information about available discounts (e.g., "Annual commitment discount", "Academic discounts", "Startup program")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
        `
    const enriched = await makeOpenAIRequest<Partial<Pricing>>(openai, prompt)

    // Update timestamp
    const timestamp = new Date().toISOString()

    // Merge with existing pricing data, only updating null/undefined fields
    const enrichedPricing: Pricing = { ...pricing }
    Object.keys(enriched).forEach((key) => {
      if (enrichedPricing[key] === undefined || enrichedPricing[key] === null || enrichedPricing[key] === "") {
        enrichedPricing[key] = enriched[key as keyof Partial<Pricing>]
      }
    })

    enrichedPricing.updatedAt = timestamp

    const validation = validatePricing(enrichedPricing)
    if (!validation.valid) {
      log(`Validation failed for pricing ${pricing.pricing_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedPricing
  } catch (error: any) {
    log(`Failed to enrich pricing for ${platform.platform_name}: ${error.message}`, "error")
    return pricing
  }
}

// ---- Processing ----
async function processPricing(pricingRecords: Pricing[], platformsMap: Map<string, Platform>): Promise<Pricing[]> {
  const processed: Pricing[] = []

  for (let i = 0; i < pricingRecords.length; i++) {
    const pricing = pricingRecords[i]
    const platform = platformsMap.get(pricing.platform_id)

    if (!platform) {
      log(`Platform not found for pricing with platform_id: ${pricing.platform_id}`, "error")
      processed.push(pricing)
      continue
    }

    if (isComplete(pricing)) {
      log(`Skipping pricing ${i + 1}/${pricingRecords.length}: ${pricing.pricing_id} (already complete)`, "info")
      processed.push(pricing)
      continue
    }

    const enriched = await enrichPricing(pricing, platform)
    processed.push(enriched)

    log(`Processed pricing ${i + 1}/${pricingRecords.length} for platform: ${platform.platform_name}`, "info")

    if (i < pricingRecords.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting pricing processor...", "info")

    // Load platforms and pricing
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    const platformsMap = createLookupMap(platforms, "platform_id")

    let pricingRecords = loadCsvData<Pricing>(PRICING_CSV_PATH)

    // Create backup of pricing file if it exists and has data
    if (fs.existsSync(PRICING_CSV_PATH) && fs.statSync(PRICING_CSV_PATH).size > 0) {
      createBackup(PRICING_CSV_PATH, BACKUP_DIR)
    }

    // Validate pricing against platforms
    pricingRecords = validatePricingAgainstPlatforms(pricingRecords, platformsMap)

    // Process and enrich pricing data
    pricingRecords = await processPricing(pricingRecords, platformsMap)

    // Save to CSV
    saveCsvData(PRICING_CSV_PATH, pricingRecords)

    log("Pricing processing completed successfully ✅", "success")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

