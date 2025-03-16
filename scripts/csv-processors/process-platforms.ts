import fs from "fs"
import path from "path"
import dotenv from "dotenv"
import { log } from "../../utils/logging"
import { extractDomainFromUrl } from "../../utils/string-utils"
import { initializeOpenAI, makeOpenAIRequest, applyRateLimit } from "../../utils/openai-utils"
import { createBackup, loadCsvData, saveCsvData, createLookupMap } from "../../utils/file-utils"

// Load environment variables
dotenv.config()

// Check for OpenAI API key
if (!process.env.OPENAI_API_KEY) {
    log("OPENAI_API_KEY environment variable is not set", "error")
    process.exit(1)
}

// Initialize OpenAI client
const openai = initializeOpenAI(process.env.OPENAI_API_KEY)

// File paths
const ROOT_DIR = process.cwd()
const DATA_DIR = path.join(ROOT_DIR, "data")
const BACKUP_DIR = path.join(ROOT_DIR, "backups")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const COMPANIES_CSV_PATH = path.join(DATA_DIR, "Companies.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Platform data structure
interface Platform {
    platform_id: string
    platform_name: string
    company_id?: string
    platform_url: string
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
    [key: string]: string | undefined // Allow any string key for dynamic access
}

// Company data structure
interface Company {
    company_id: string
    company_name: string
    company_website_url: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

/**
 * Validate platform data against schema constraints
 */
function validatePlatform(platform: Platform): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!platform.platform_name) {
        errors.push("platform_name is required")
    }

    if (!platform.platform_url) {
        errors.push("platform_url is required")
    }

    if (!platform.platform_category) {
        errors.push("platform_category is required")
    }

    // Check platform_status constraint if present
    if (platform.platform_status && !["Active", "Beta", "Discontinued"].includes(platform.platform_status)) {
        errors.push("platform_status must be one of: Active, Beta, Discontinued")
    }

    // Check platform_url format
    if (platform.platform_url) {
        try {
            // Add protocol if missing
            let url = platform.platform_url
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                url = "https://" + url
            }
            new URL(url)
        } catch (error) {
            errors.push("platform_url must be a valid URL")
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Match platforms to companies
 */
function matchPlatformsToCompanies(platforms: Platform[], companiesMap: Map<string, Company>): Platform[] {
    log("Matching platforms to companies...", "info")

    const updatedPlatforms = platforms.map((platform) => {
        // Skip if already matched
        if (platform.company_id) {
            return platform
        }

        const platformUrl = platform.platform_url
        if (!platformUrl) {
            return platform
        }

        try {
            // Extract domain from URL
            const domain = extractDomainFromUrl(platformUrl)
            if (!domain) {
                return platform
            }

            // Find matching company by domain
            let matchedCompany: Company | undefined

            // First try exact domain match
            for (const [companyId, company] of companiesMap.entries()) {
                const companyDomain = extractDomainFromUrl(company.company_website_url)
                if (companyDomain === domain) {
                    matchedCompany = company
                    break
                }
            }

            // If no exact match, try partial domain match
            if (!matchedCompany) {
                for (const [companyId, company] of companiesMap.entries()) {
                    const companyDomain = extractDomainFromUrl(company.company_website_url)
                    if ((companyDomain && domain.includes(companyDomain)) || (companyDomain && companyDomain.includes(domain))) {
                        matchedCompany = company
                        break
                    }
                }
            }

            if (matchedCompany) {
                platform.company_id = matchedCompany.company_id
                log(`Matched platform ${platform.platform_name} to company ${matchedCompany.company_name}`, "info")
            }
        } catch (error: any) {
            log(`Error matching platform ${platform.platform_name}: ${error.message}`, "error")
        }

        return platform
    })

    const matchedCount = updatedPlatforms.filter((p) => p.company_id).length
    log(`Matched ${matchedCount}/${platforms.length} platforms to companies`, "info")

    return updatedPlatforms
}

/**
 * Validate and correct platform URLs
 */
function validatePlatformUrls(platforms: Platform[]): Platform[] {
    log("Validating platform URLs...", "info")

    return platforms.map((platform) => {
        if (!platform.platform_url) {
            return platform
        }

        try {
            let url = platform.platform_url

            // Add protocol if missing
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                url = "https://" + url
            }

            // Validate URL format
            new URL(url)

            // Update URL if changed
            if (url !== platform.platform_url) {
                log(`Corrected URL for ${platform.platform_name}: ${platform.platform_url} -> ${url}`, "info")
                platform.platform_url = url
            }
        } catch (error) {
            log(`Invalid URL for platform ${platform.platform_name}: ${platform.platform_url}`, "warning")
        }

        return platform
    })
}

/**
 * Enrich platform data using OpenAI  "warning")
    }

    return platform
  })
}

/**
 * Enrich platform data using OpenAI
 */
async function enrichPlatformData(platform: Platform): Promise<Platform> {
    try {
        log(`Enriching data for platform: ${platform.platform_name}`, "info")

        const prompt = `
Provide accurate information about the AI platform "${platform.platform_name}" with URL "${platform.platform_url}" in JSON format with the following fields:
- platform_category: The primary category of the platform (e.g., "Natural Language Processing", "Computer Vision", "Machine Learning", "Generative AI", "Conversational AI", "Data Analytics", etc.)
- platform_sub_category: A more specific subcategory (e.g., "Text Generation", "Image Recognition", "Predictive Analytics", "Chatbots", etc.)
- platform_description: A concise 2-3 sentence description of what the platform does and its key capabilities
- platform_status: Current status (must be one of: "Active", "Beta", "Discontinued")
- api_availability: Whether the platform offers API access ("Yes", "No", "Limited")
- integration_options: Brief description of integration options (e.g., "REST API, SDK for Python and JavaScript, Webhooks")

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<Platform>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing platform data, only updating null/undefined fields
        const updatedPlatform: Platform = { ...platform }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedPlatform[key] === undefined || updatedPlatform[key] === null || updatedPlatform[key] === "") {
                updatedPlatform[key] = enrichedData[key as keyof Partial<Platform>]
            }
        })

        updatedPlatform.updatedAt = timestamp

        // Validate the enriched platform data
        const validation = validatePlatform(updatedPlatform)
        if (!validation.valid) {
            log(
                `Validation issues with enriched platform ${platform.platform_name}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedPlatform
    } catch (error: any) {
        log(`Error enriching platform ${platform.platform_name}: ${error.message}`, "error")
        return platform
    }
}

/**
 * Process all platforms with rate limiting
 */
async function processPlatformsWithRateLimit(platforms: Platform[]): Promise<Platform[]> {
    const enrichedPlatforms: Platform[] = []

    // If no platforms, create a default one for testing
    if (platforms.length === 0) {
        log("No platforms found in CSV, creating a default platform for testing", "warning")
        const defaultPlatform: Platform = {
            platform_id: `plat_${Date.now()}`,
            platform_name: "OpenAI GPT API",
            platform_url: "https://openai.com/api",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }
        platforms.push(defaultPlatform)
    }

    for (let i = 0; i < platforms.length; i++) {
        try {
            // Skip platforms that already have all fields filled
            const platform = platforms[i]
            const hasAllFields =
                platform.platform_category &&
                platform.platform_sub_category &&
                platform.platform_description &&
                platform.platform_status &&
                platform.api_availability &&
                platform.integration_options

            if (hasAllFields) {
                log(`Skipping platform ${i + 1}/${platforms.length}: ${platform.platform_name} (already complete)`, "info")
                enrichedPlatforms.push(platform)
                continue
            }

            // Enrich platform data
            const enrichedPlatform = await enrichPlatformData(platform)
            enrichedPlatforms.push(enrichedPlatform)

            // Log progress
            log(`Processed platform ${i + 1}/${platforms.length}: ${enrichedPlatform.platform_name}`, "info")

            // Rate limiting delay (except for last item)
            if (i < platforms.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing platform ${platforms[i]?.platform_name || "unknown"}: ${error.message}`, "error")
            enrichedPlatforms.push(platforms[i]) // Add original data if enrichment fails
        }
    }

    return enrichedPlatforms
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting platform processing...", "info")

        // Load companies and platforms
        const companies = loadCsvData<Company>(COMPANIES_CSV_PATH)
        const companiesMap = createLookupMap(companies, "company_id")

        let platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)

        // Create backup of platforms file if it exists and has data
        if (fs.existsSync(PLATFORMS_CSV_PATH) && platforms.length > 0) {
            createBackup(PLATFORMS_CSV_PATH, BACKUP_DIR)
        }

        // Match platforms to companies
        platforms = matchPlatformsToCompanies(platforms, companiesMap)

        // Validate platform URLs
        platforms = validatePlatformUrls(platforms)

        // Enrich platform data
        platforms = await processPlatformsWithRateLimit(platforms)

        // Save to CSV
        saveCsvData(PLATFORMS_CSV_PATH, platforms)

        log("Platform processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

