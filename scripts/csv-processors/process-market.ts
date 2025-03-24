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
interface Market {
  market_id: string
  platform_id: string
  user_count?: string
  adoption_rate?: string
  industry_penetration?: string
  typical_customer_profile?: string
  success_stories?: string
  direct_competitors?: string
  competitive_advantages?: string
  market_share?: string
  analyst_ratings?: string
  industry_awards?: string
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
const MARKET_CSV_PATH = path.join(DATA_DIR, "Market.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateMarket(market: Market): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!market.market_id) errors.push("market_id is required")
  if (!market.platform_id) errors.push("platform_id is required")

  // Numeric validations
  if (market.user_count) {
    const count = Number.parseInt(market.user_count.replace(/,/g, ""))
    if (isNaN(count) || count < 0) {
      errors.push("user_count must be a positive number")
    }
  }

  if (market.adoption_rate) {
    const rate = Number.parseFloat(market.adoption_rate.replace("%", ""))
    if (isNaN(rate) || rate < 0 || rate > 100) {
      errors.push("adoption_rate must be a percentage between 0 and 100")
    }
  }

  if (market.market_share) {
    const share = Number.parseFloat(market.market_share.replace("%", ""))
    if (isNaN(share) || share < 0 || share > 100) {
      errors.push("market_share must be a percentage between 0 and 100")
    }
  }

  return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(market: Market): boolean {
  return (
    !!market.user_count &&
    !!market.adoption_rate &&
    !!market.industry_penetration &&
    !!market.direct_competitors &&
    !!market.competitive_advantages
  )
}

// ---- Enrichment via OpenAI ----
async function enrichMarket(market: Market, platforms: Platform[]): Promise<Market> {
  try {
    log(`Enriching market data for: ${market.market_id}`, "info")

    const platform = platforms.find((p) => p.platform_id === market.platform_id)
    if (!platform) {
      log(`Platform not found for market_id: ${market.market_id}`, "warning")
      return market
    }

    const prompt = `
Provide enriched market data for the AI platform "${platform.platform_name}" in the following JSON format:
{
  "user_count": "Estimated number of users (e.g., 50000, 1000000+)",
  "adoption_rate": "Growth rate as a percentage (e.g., 15%)",
  "industry_penetration": "Description of industries where this platform is widely adopted",
  "typical_customer_profile": "Description of the typical customer or user",
  "success_stories": "Brief description of notable success stories",
  "direct_competitors": "List of main competing platforms",
  "competitive_advantages": "Key advantages over competitors",
  "market_share": "Estimated market share as a percentage (e.g., 8%)",
  "analyst_ratings": "Ratings from industry analysts (e.g., Gartner, Forrester)",
  "industry_awards": "Notable awards received"
}

Return only the JSON object with realistic, accurate information about ${platform.platform_name}'s market position.
        `
    const enriched = await makeOpenAIRequest<Partial<Market>>(openai, prompt)
    const enrichedMarket: Market = {
      ...market,
      ...enriched,
      updatedAt: new Date().toISOString(),
    }

    const validation = validateMarket(enrichedMarket)
    if (!validation.valid) {
      log(`Validation failed for ${market.market_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedMarket
  } catch (error: any) {
    log(`Failed to enrich market ${market.market_id}: ${error.message}`, "error")
    return market
  }
}

// ---- Processing ----
async function processMarkets(markets: Market[], platforms: Platform[]): Promise<Market[]> {
  const processed: Market[] = []

  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]

    if (isComplete(market)) {
      log(`Skipping ${market.market_id} (already complete)`, "info")
      processed.push(market)
      continue
    }

    const enriched = await enrichMarket(market, platforms)
    processed.push(enriched)

    if (i < markets.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting market processor...", "info")

    // Load platforms data
    if (!fs.existsSync(PLATFORMS_CSV_PATH)) {
      log("Platforms.csv not found. Please run process-platforms.ts first.", "error")
      process.exit(1)
    }
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    log(`Loaded ${platforms.length} platforms`, "info")

    // Load or initialize market data
    const markets = fs.existsSync(MARKET_CSV_PATH) ? loadCsvData<Market>(MARKET_CSV_PATH) : []

    // Create market entries for platforms without one
    const platformIds = new Set(markets.map((m) => m.platform_id))
    const newMarkets: Market[] = []

    for (const platform of platforms) {
      if (!platformIds.has(platform.platform_id)) {
        const newMarket: Market = {
          market_id: `market_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          platform_id: platform.platform_id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        newMarkets.push(newMarket)
        log(`Created new market entry for platform: ${platform.platform_name}`, "info")
      }
    }

    const allMarkets = [...markets, ...newMarkets]

    // Create backup if file exists
    if (fs.existsSync(MARKET_CSV_PATH) && fs.statSync(MARKET_CSV_PATH).size > 0) {
      createBackup(MARKET_CSV_PATH, BACKUP_DIR)
    }

    // Process and enrich markets
    const enriched = await processMarkets(allMarkets, platforms)
    saveCsvData(MARKET_CSV_PATH, enriched)

    log(`Market processor complete. Processed ${enriched.length} records ✅`, "info")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

