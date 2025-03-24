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
interface Community {
  community_id: string
  platform_id: string
  community_size?: string
  community_engagement_score?: string
  user_rating?: string
  github_repository?: string
  stackoverflow_tags?: string
  academic_papers?: string
  case_studies?: string
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
const COMMUNITY_CSV_PATH = path.join(DATA_DIR, "Community.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateCommunity(community: Community): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!community.community_id) errors.push("community_id is required")
  if (!community.platform_id) errors.push("platform_id is required")

  // Numeric validations
  if (community.community_engagement_score) {
    const score = Number.parseFloat(community.community_engagement_score)
    if (isNaN(score) || score < 0 || score > 100) {
      errors.push("community_engagement_score must be a number between 0 and 100")
    }
  }

  if (community.user_rating) {
    const rating = Number.parseFloat(community.user_rating)
    if (isNaN(rating) || rating < 0 || rating > 5) {
      errors.push("user_rating must be a number between 0 and 5")
    }
  }

  // URL validations
  if (community.github_repository && !community.github_repository.includes("github.com")) {
    errors.push("github_repository must be a valid GitHub URL")
  }

  return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(community: Community): boolean {
  return !!community.community_size && !!community.community_engagement_score && !!community.user_rating
}

// ---- Enrichment via OpenAI ----
async function enrichCommunity(community: Community, platforms: Platform[]): Promise<Community> {
  try {
    log(`Enriching community for: ${community.community_id}`, "info")

    const platform = platforms.find((p) => p.platform_id === community.platform_id)
    if (!platform) {
      log(`Platform not found for community_id: ${community.community_id}`, "warning")
      return community
    }

    const prompt = `
Provide enriched community data for the AI platform "${platform.platform_name}" in the following JSON format:
{
  "community_size": "Estimated number of users/developers (e.g., 5000, 10000+, etc.)",
  "community_engagement_score": "A score from 0-100 representing community activity level",
  "user_rating": "Average user rating from 0-5",
  "github_repository": "URL to the platform's GitHub repository if open source",
  "stackoverflow_tags": "Common Stack Overflow tags related to this platform",
  "academic_papers": "Number or list of academic papers referencing this platform",
  "case_studies": "Brief description of notable case studies using this platform"
}

Return only the JSON object with realistic, accurate information about ${platform.platform_name}'s community.
        `
    const enriched = await makeOpenAIRequest<Partial<Community>>(openai, prompt)
    const enrichedCommunity: Community = {
      ...community,
      ...enriched,
      updatedAt: new Date().toISOString(),
    }

    const validation = validateCommunity(enrichedCommunity)
    if (!validation.valid) {
      log(`Validation failed for ${community.community_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedCommunity
  } catch (error: any) {
    log(`Failed to enrich community ${community.community_id}: ${error.message}`, "error")
    return community
  }
}

// ---- Processing ----
async function processCommunities(communities: Community[], platforms: Platform[]): Promise<Community[]> {
  const processed: Community[] = []

  for (let i = 0; i < communities.length; i++) {
    const community = communities[i]

    if (isComplete(community)) {
      log(`Skipping ${community.community_id} (already complete)`, "info")
      processed.push(community)
      continue
    }

    const enriched = await enrichCommunity(community, platforms)
    processed.push(enriched)

    if (i < communities.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting community processor...", "info")

    // Load platforms data
    if (!fs.existsSync(PLATFORMS_CSV_PATH)) {
      log("Platforms.csv not found. Please run process-platforms.ts first.", "error")
      process.exit(1)
    }
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    log(`Loaded ${platforms.length} platforms`, "info")

    // Load or initialize community data
    const communities = fs.existsSync(COMMUNITY_CSV_PATH) ? loadCsvData<Community>(COMMUNITY_CSV_PATH) : []

    // Create community entries for platforms without one
    const platformIds = new Set(communities.map((c) => c.platform_id))
    const newCommunities: Community[] = []

    for (const platform of platforms) {
      if (!platformIds.has(platform.platform_id)) {
        const newCommunity: Community = {
          community_id: `community_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          platform_id: platform.platform_id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        newCommunities.push(newCommunity)
        log(`Created new community entry for platform: ${platform.platform_name}`, "info")
      }
    }

    const allCommunities = [...communities, ...newCommunities]

    // Create backup if file exists
    if (fs.existsSync(COMMUNITY_CSV_PATH) && fs.statSync(COMMUNITY_CSV_PATH).size > 0) {
      createBackup(COMMUNITY_CSV_PATH, BACKUP_DIR)
    }

    // Process and enrich communities
    const enriched = await processCommunities(allCommunities, platforms)
    saveCsvData(COMMUNITY_CSV_PATH, enriched)

    log(`Community processor complete. Processed ${enriched.length} records ✅`, "info")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

