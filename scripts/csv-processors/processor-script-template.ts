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
interface Entity {
    entity_id: string
    // Add relevant fields here
    [key: string]: string | undefined
}

// ---- File Paths ----
const DATA_DIR = path.join(process.cwd(), "data")
const ENTITY_CSV_PATH = path.join(DATA_DIR, "YourEntity.csv")
const BACKUP_DIR = path.join(process.cwd(), "backups")

// ---- Validation ----
function validateEntity(entity: Entity): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    if (!entity.entity_id) errors.push("entity_id is required")
    // Add field-specific checks here
    return { valid: errors.length === 0, errors }
}

// ---- Completeness ----
function isComplete(entity: Entity): boolean {
    // Customize based on required fields
    return !!entity["some_required_field"] && !!entity["another_field"]
}

// ---- Enrichment via OpenAI ----
async function enrichEntity(entity: Entity): Promise<Entity> {
    try {
        log(`Enriching: ${entity.entity_id}`, "info")

        const prompt = `
Provide enriched data for the entity with ID "${entity.entity_id}" in the following JSON format:
- field_one
- field_two
Return only the JSON object.
        `
        const enriched = await makeOpenAIRequest<Partial<Entity>>(openai, prompt)
        const enrichedEntity: Entity = {
            ...entity,
            ...enriched,
            updatedAt: new Date().toISOString()
        }

        const validation = validateEntity(enrichedEntity)
        if (!validation.valid) {
            log(`Validation failed for ${entity.entity_id}: ${validation.errors.join(", ")}`, "warning")
        }

        return enrichedEntity
    } catch (error: any) {
        log(`Failed to enrich ${entity.entity_id}: ${error.message}`, "error")
        return entity
    }
}

// ---- Processing ----
async function processEntities(entities: Entity[]): Promise<Entity[]> {
    const processed: Entity[] = []

    for (let i = 0; i < entities.length; i++) {
        const entity = entities[i]

        if (isComplete(entity)) {
            log(`Skipping ${entity.entity_id} (already complete)`, "info")
            processed.push(entity)
            continue
        }

        const enriched = await enrichEntity(entity)
        processed.push(enriched)

        if (i < entities.length - 1) {
            await applyRateLimit(DELAY)
        }
    }

    return processed
}

// ---- Main ----
async function main() {
    try {
        log("Starting entity processor...", "info")

        const data = fs.existsSync(ENTITY_CSV_PATH)
            ? loadCsvData<Entity>(ENTITY_CSV_PATH)
            : []

        if (fs.existsSync(ENTITY_CSV_PATH) && fs.statSync(ENTITY_CSV_PATH).size > 0) {
            createBackup(ENTITY_CSV_PATH, BACKUP_DIR)
        }

        const enriched = await processEntities(data)
        saveCsvData(ENTITY_CSV_PATH, enriched)

        log("Processor complete ✅", "info")
    } catch (error: any) {
        log(`Unhandled error: ${error.message}`, "error")
        process.exit(1)
    }
}

main()
