import fs from "fs"
import path from "path"
import fetch from "node-fetch"
import { log } from "../../utils/logging"
import { loadCsvData } from "../../utils/file-utils"
import { withErrorHandling } from "../../utils/error-handler"

// Define paths
const ROOT_DIR = process.cwd()
const DATA_DIR = path.join(ROOT_DIR, "data")
const LOGS_DIR = path.join(ROOT_DIR, "logs")
const BACKUP_DIR = path.join(ROOT_DIR, "backups")

// File paths
const NEW_PLATFORMS_PATH = path.join(DATA_DIR, "AI_Platform_List.csv")
const EXISTING_PLATFORMS_PATH = path.join(DATA_DIR, "Platforms.csv")
const VALIDATION_REPORT_PATH = path.join(
    LOGS_DIR,
    `platform_validation_${new Date().toISOString().replace(/:/g, "-")}.json`,
)

// Ensure directories exist
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
}

// Interfaces
interface Platform {
    platform_id?: string
    platform_name: string
    platform_url: string
    company_id?: string
    platform_category?: string
    platform_sub_category?: string
    platform_description?: string
    platform_launch_date?: string
    platform_status?: string
    platform_availability?: string
    api_availability?: string
    integration_options?: string
    createdAt?: string
    updatedAt?: string
    [key: string]: string | undefined
}

interface NewPlatform {
    platformName: string
    platformUrl: string
}

interface ValidationResult {
    valid: NewPlatform[]
    invalid: Array<{ platform: NewPlatform; reason: string }>
    duplicates: Array<{ platform: NewPlatform; existingPlatform: Platform }>
}

/**
 * Parse the new platforms file with tab-separated values
 */
function parseNewPlatformsFile(filePath: string): NewPlatform[] {
    try {
        const fileData = fs.readFileSync(filePath, "utf8")
        const platforms: NewPlatform[] = []

        const lines = fileData.split("\n")
        // Skip header row
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim()
            if (!line) continue

            const [platformName, platformUrl] = line.split("\t")
            platforms.push({
                platformName: platformName?.trim() || "",
                platformUrl: platformUrl?.trim() || "",
            })
        }

        return platforms
    } catch (error: any) {
        log(`Error parsing new platforms file: ${error.message}`, "error")
        return []
    }
}

/**
 * Check if a URL is valid and accessible
 */
async function isUrlValid(url: string): Promise<{ valid: boolean; reason?: string }> {
    try {
        // Check URL format
        new URL(url)

        // Check URL connectivity with a timeout
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 5000) // 5 second timeout

        try {
            const response = await fetch(url, {
                method: "HEAD",
                signal: controller.signal,
            })

            clearTimeout(timeoutId)

            if (!response.ok) {
                return {
                    valid: false,
                    reason: `URL returned status ${response.status}`,
                }
            }

            return { valid: true }
        } catch (error: any) {
            clearTimeout(timeoutId)
            return {
                valid: false,
                reason: `Failed to connect to URL: ${error.message}`,
            }
        }
    } catch (error: any) {
        return {
            valid: false,
            reason: "Invalid URL format",
        }
    }
}

/**
 * Validate platforms against existing data and URL accessibility
 */
async function validatePlatforms(
    newPlatforms: NewPlatform[],
    existingPlatforms: Platform[],
): Promise<ValidationResult> {
    const result: ValidationResult = {
        valid: [],
        invalid: [],
        duplicates: [],
    }

    log(`Validating ${newPlatforms.length} platforms...`, "info")

    for (let i = 0; i < newPlatforms.length; i++) {
        const platform = newPlatforms[i]
        log(`Validating platform ${i + 1}/${newPlatforms.length}: ${platform.platformName}`, "info")

        // Check for empty values
        if (!platform.platformName) {
            result.invalid.push({
                platform,
                reason: "Platform name is empty",
            })
            continue
        }

        if (!platform.platformUrl) {
            result.invalid.push({
                platform,
                reason: "Platform URL is empty",
            })
            continue
        }

        // Check for duplicates in existing platforms
        const duplicate = existingPlatforms.find(
            (p) =>
                p.platform_name.toLowerCase() === platform.platformName.toLowerCase() ||
                (p.platform_url && p.platform_url.toLowerCase() === platform.platformUrl.toLowerCase()),
        )

        if (duplicate) {
            result.duplicates.push({
                platform,
                existingPlatform: duplicate,
            })
            continue
        }

        // URL validation
        const urlValidation = await isUrlValid(platform.platformUrl)
        if (!urlValidation.valid) {
            result.invalid.push({
                platform,
                reason: urlValidation.reason || "URL validation failed",
            })
            continue
        }

        // If we got here, the platform is valid
        result.valid.push(platform)
    }

    return result
}

/**
 * Save validation results to a JSON file
 */
function saveValidationReport(result: ValidationResult, filePath: string): void {
    try {
        const reportDir = path.dirname(filePath)
        if (!fs.existsSync(reportDir)) {
            fs.mkdirSync(reportDir, { recursive: true })
        }

        fs.writeFileSync(filePath, JSON.stringify(result, null, 2))
        log(`Validation report saved to: ${filePath}`, "info")
    } catch (error: any) {
        log(`Error saving validation report: ${error.message}`, "error")
    }
}

/**
 * Main validation function
 */
async function validatePlatformList(): Promise<void> {
    log("Starting platform list validation...", "info")

    // Check if new platforms file exists
    if (!fs.existsSync(NEW_PLATFORMS_PATH)) {
        log(`New platforms file not found at: ${NEW_PLATFORMS_PATH}`, "error")
        return
    }

    // Parse new platforms
    const newPlatforms = parseNewPlatformsFile(NEW_PLATFORMS_PATH)
    log(`Found ${newPlatforms.length} platforms in new file`, "info")

    if (newPlatforms.length === 0) {
        log("No platforms found in the new file. Validation aborted.", "warning")
        return
    }

    // Load existing platforms
    let existingPlatforms: Platform[] = []
    if (fs.existsSync(EXISTING_PLATFORMS_PATH)) {
        existingPlatforms = loadCsvData<Platform>(EXISTING_PLATFORMS_PATH)
        log(`Loaded ${existingPlatforms.length} existing platforms for comparison`, "info")
    } else {
        log("No existing platforms file found. Will validate against empty set.", "warning")
    }

    // Validate platforms
    const validationResult = await validatePlatforms(newPlatforms, existingPlatforms)

    // Save validation report
    saveValidationReport(validationResult, VALIDATION_REPORT_PATH)

    // Log summary
    log("Validation complete:", "info")
    log(`- Valid platforms: ${validationResult.valid.length}`, "success")
    log(`- Invalid platforms: ${validationResult.invalid.length}`, "warning")
    log(`- Potential duplicates: ${validationResult.duplicates.length}`, "warning")

    // Output examples of issues found
    if (validationResult.invalid.length > 0) {
        log("Sample invalid platforms:", "warning")
        validationResult.invalid.slice(0, 5).forEach((item) => {
            log(`- ${item.platform.platformName}: ${item.reason}`, "warning")
        })
    }

    if (validationResult.duplicates.length > 0) {
        log("Sample potential duplicates:", "warning")
        validationResult.duplicates.slice(0, 5).forEach((item) => {
            log(`- ${item.platform.platformName} may be a duplicate of ${item.existingPlatform.platform_name}`, "warning")
        })
    }

    log(
        `To import validated platforms, run: npx ts-node scripts/csv-processors/import-validated-platforms.ts ${path.basename(VALIDATION_REPORT_PATH)}`,
        "info",
    )
}

// Run with error handling
const main = withErrorHandling(
    async () => {
        await validatePlatformList()
    },
    (error: Error) => {
        log(`Critical error in validate-platform-list: ${error.message}`, "error")
        process.exit(1)
    },
)

// Execute if this script is run directly
if (require.main === module) {
    main()
}

// Export for testing
export { validatePlatforms, parseNewPlatformsFile, isUrlValid }

