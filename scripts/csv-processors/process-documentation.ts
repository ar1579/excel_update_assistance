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
interface Documentation {
  doc_id: string
  platform_id: string
  documentation_description?: string
  doc_quality?: string
  documentation_url?: string
  faq_url?: string
  forum_url?: string
  example_code_available?: string
  example_code_languages?: string
  video_tutorials_available?: string
  learning_curve_rating?: string
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
const DOCUMENTATION_CSV_PATH = path.join(DATA_DIR, "Documentation.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateDocumentation(doc: Documentation): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!doc.doc_id) errors.push("doc_id is required")
  if (!doc.platform_id) errors.push("platform_id is required")

  // URL validations
  if (doc.documentation_url && !doc.documentation_url.startsWith("http")) {
    errors.push("documentation_url must be a valid URL")
  }
  if (doc.faq_url && !doc.faq_url.startsWith("http")) {
    errors.push("faq_url must be a valid URL")
  }
  if (doc.forum_url && !doc.forum_url.startsWith("http")) {
    errors.push("forum_url must be a valid URL")
  }

  // Boolean validations
  if (doc.example_code_available && !["Yes", "No"].includes(doc.example_code_available)) {
    errors.push("example_code_available must be 'Yes' or 'No'")
  }
  if (doc.video_tutorials_available && !["Yes", "No"].includes(doc.video_tutorials_available)) {
    errors.push("video_tutorials_available must be 'Yes' or 'No'")
  }

  // Rating validation
  if (
    doc.learning_curve_rating &&
    !["Easy", "Moderate", "Difficult", "Very Difficult"].includes(doc.learning_curve_rating)
  ) {
    errors.push("learning_curve_rating must be one of: Easy, Moderate, Difficult, Very Difficult")
  }

  return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(doc: Documentation): boolean {
  return (
    !!doc.documentation_description &&
    !!doc.doc_quality &&
    !!doc.documentation_url &&
    !!doc.example_code_available &&
    !!doc.learning_curve_rating
  )
}

// ---- Enrichment via OpenAI ----
async function enrichDocumentation(doc: Documentation, platforms: Platform[]): Promise<Documentation> {
  try {
    log(`Enriching documentation for: ${doc.doc_id}`, "info")

    const platform = platforms.find((p) => p.platform_id === doc.platform_id)
    if (!platform) {
      log(`Platform not found for doc_id: ${doc.doc_id}`, "warning")
      return doc
    }

    const prompt = `
Provide enriched documentation data for the AI platform "${platform.platform_name}" in the following JSON format:
{
  "documentation_description": "A comprehensive description of the documentation available",
  "doc_quality": "Excellent, Good, Average, Poor, or Minimal",
  "documentation_url": "The main URL for the platform's documentation (if not provided)",
  "faq_url": "URL to the platform's FAQ section (if available)",
  "forum_url": "URL to the platform's community forum (if available)",
  "example_code_available": "Yes or No",
  "example_code_languages": "List of programming languages for which example code is available (e.g., Python, JavaScript, Java)",
  "video_tutorials_available": "Yes or No",
  "learning_curve_rating": "Easy, Moderate, Difficult, or Very Difficult"
}

Return only the JSON object with realistic, accurate information about ${platform.platform_name}'s documentation.
        `
    const enriched = await makeOpenAIRequest<Partial<Documentation>>(openai, prompt)
    const enrichedDoc: Documentation = {
      ...doc,
      ...enriched,
      updatedAt: new Date().toISOString(),
    }

    const validation = validateDocumentation(enrichedDoc)
    if (!validation.valid) {
      log(`Validation failed for ${doc.doc_id}: ${validation.errors.join(", ")}`, "warning")
    }

    return enrichedDoc
  } catch (error: any) {
    log(`Failed to enrich documentation ${doc.doc_id}: ${error.message}`, "error")
    return doc
  }
}

// ---- Processing ----
async function processDocumentation(docs: Documentation[], platforms: Platform[]): Promise<Documentation[]> {
  const processed: Documentation[] = []

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]

    if (isComplete(doc)) {
      log(`Skipping ${doc.doc_id} (already complete)`, "info")
      processed.push(doc)
      continue
    }

    const enriched = await enrichDocumentation(doc, platforms)
    processed.push(enriched)

    if (i < docs.length - 1) {
      await applyRateLimit(DELAY)
    }
  }

  return processed
}

// ---- Main ----
async function main() {
  try {
    log("Starting documentation processor...", "info")

    // Load platforms data
    if (!fs.existsSync(PLATFORMS_CSV_PATH)) {
      log("Platforms.csv not found. Please run process-platforms.ts first.", "error")
      process.exit(1)
    }
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
    log(`Loaded ${platforms.length} platforms`, "info")

    // Load or initialize documentation data
    const docs = fs.existsSync(DOCUMENTATION_CSV_PATH) ? loadCsvData<Documentation>(DOCUMENTATION_CSV_PATH) : []

    // Create documentation entries for platforms without one
    const platformIds = new Set(docs.map((doc) => doc.platform_id))
    const newDocs: Documentation[] = []

    for (const platform of platforms) {
      if (!platformIds.has(platform.platform_id)) {
        const newDoc: Documentation = {
          doc_id: `doc_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          platform_id: platform.platform_id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        newDocs.push(newDoc)
        log(`Created new documentation entry for platform: ${platform.platform_name}`, "info")
      }
    }

    const allDocs = [...docs, ...newDocs]

    // Create backup if file exists
    if (fs.existsSync(DOCUMENTATION_CSV_PATH) && fs.statSync(DOCUMENTATION_CSV_PATH).size > 0) {
      createBackup(DOCUMENTATION_CSV_PATH, BACKUP_DIR)
    }

    // Process and enrich documentation
    const enriched = await processDocumentation(allDocs, platforms)
    saveCsvData(DOCUMENTATION_CSV_PATH, enriched)

    log(`Documentation processor complete. Processed ${enriched.length} records ✅`, "info")
  } catch (error: any) {
    log(`Unhandled error: ${error.message}`, "error")
    process.exit(1)
  }
}

main()

