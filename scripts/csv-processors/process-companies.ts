import fs from "fs"
import path from "path"
import dotenv from "dotenv"
import { log } from "../../utils/logging"
import { extractDomainFromUrl, normalizeCompanyName } from "../../utils/string-utils"
import { initializeOpenAI, makeOpenAIRequest, applyRateLimit } from "../../utils/openai-utils"
import { createBackup, loadCsvData, saveCsvData } from "../../utils/file-utils"

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

// Company data structure
interface Company {
    company_id: string
    company_name: string
    hq_location?: string
    company_size?: string
    funding_stage?: string
    website_url: string
    annual_revenue?: string
    createdAt?: string
    updatedAt?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

// Platform data structure
interface Platform {
    platform_id: string
    platform_name: string
    company_id?: string
    platform_url: string
    category?: string
    sub_category?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

/**
 * Validate company data against schema constraints
 */
function validateCompany(company: Company): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!company.company_name) {
        errors.push("company_name is required")
    }

    // Check company_size constraint if present
    if (company.company_size && !["Startup", "Small", "Medium", "Large", "Enterprise"].includes(company.company_size)) {
        errors.push("company_size must be one of: Startup, Small, Medium, Large, Enterprise")
    }

    // Check website_url format
    if (company.website_url) {
        try {
            // Add protocol if missing
            let url = company.website_url
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                url = "https://" + url
            }
            new URL(url)
        } catch (error) {
            errors.push("website_url must be a valid URL")
        }
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Extract company information from platform data
 */
async function extractCompaniesFromPlatforms(): Promise<Company[]> {
    log("Extracting companies from platforms data...", "info")

    // Read platforms CSV
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)

    // Map to store unique companies
    const companiesMap = new Map<string, Company>()

    // Current timestamp for created/updated fields
    const timestamp = new Date().toISOString()

    // Process each platform to extract company information
    for (const platform of platforms) {
        const platformUrl = platform.platform_url
        if (!platformUrl) continue

        try {
            // Extract domain from URL
            const domain = extractDomainFromUrl(platformUrl)
            if (!domain) continue

            // Generate company name from domain
            let companyName = domain.split(".")[0]
            companyName = normalizeCompanyName(companyName)

            // Skip if already processed
            if (companiesMap.has(companyName)) continue

            // Create company entry
            companiesMap.set(companyName, {
                company_id: `comp_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
                company_name: companyName,
                website_url: `https://${domain}`,
                createdAt: timestamp,
                updatedAt: timestamp,
            })

            log(`Extracted company: ${companyName} from ${platformUrl}`, "info")
        } catch (error: any) {
            log(`Error processing platform URL ${platformUrl}: ${error.message}`, "error")
        }
    }

    return Array.from(companiesMap.values())
}

/**
 * Enrich company data using OpenAI
 */
async function enrichCompanyData(company: Company): Promise<Company> {
    try {
        log(`Enriching data for company: ${company.company_name}`, "info")

        const prompt = `
Provide accurate information about the company "${company.company_name}" with URL "${company.website_url}" in JSON format with the following fields:
- hq_location: Location of company headquarters (city, country)
- company_size: Company size category (must be one of: Startup, Small, Medium, Large, Enterprise)
- funding_stage: Funding stage (e.g., "Bootstrapped", "Seed", "Series A", "Series B", "Public", "Acquired")
- annual_revenue: Estimated annual revenue range (e.g., "<$1M", "$1M-$10M", "$10M-$50M", "$50M-$100M", "$100M-$1B", ">$1B")

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<Company>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing company data
        const updatedCompany: Company = {
            ...company,
            ...enrichedData,
            updatedAt: timestamp,
        }

        // Validate the enriched company data
        const validation = validateCompany(updatedCompany)
        if (!validation.valid) {
            log(`Validation issues with enriched company ${company.company_name}: ${validation.errors.join(", ")}`, "warning")
        }

        return updatedCompany
    } catch (error: any) {
        log(`Error enriching company ${company.company_name}: ${error.message}`, "error")
        return company
    }
}

/**
 * Process all companies with rate limiting
 */
async function processCompaniesWithRateLimit(companies: Company[]): Promise<Company[]> {
    const enrichedCompanies: Company[] = []

    // Load existing companies if file exists
    const existingCompanies = fs.existsSync(COMPANIES_CSV_PATH) ? loadCsvData<Company>(COMPANIES_CSV_PATH) : []

    // Create map of existing companies for quick lookup
    const existingCompaniesMap = new Map<string, Company>()
    existingCompanies.forEach((company) => {
        if (company.company_name) {
            existingCompaniesMap.set(company.company_name, company)
        }
    })

    for (let i = 0; i < companies.length; i++) {
        try {
            const company = companies[i]

            // Check if company already exists
            const existingCompany = existingCompaniesMap.get(company.company_name)
            if (existingCompany) {
                log(`Company ${company.company_name} already exists, updating...`, "info")

                // Preserve existing ID and created timestamp
                company.company_id = existingCompany.company_id
                company.createdAt = existingCompany.createdAt

                // Preserve existing data if not in new data
                Object.keys(existingCompany).forEach((key) => {
                    if (company[key] === undefined && existingCompany[key] !== undefined) {
                        company[key] = existingCompany[key]
                    }
                })
            }

            // Skip companies that already have all fields filled
            const hasAllFields =
                company.hq_location && company.company_size && company.funding_stage && company.annual_revenue

            if (hasAllFields) {
                log(`Skipping company ${i + 1}/${companies.length}: ${company.company_name} (already complete)`, "info")
                enrichedCompanies.push(company)
                continue
            }

            // Enrich company data
            const enrichedCompany = await enrichCompanyData(company)
            enrichedCompanies.push(enrichedCompany)

            // Log progress
            log(`Processed company ${i + 1}/${companies.length}: ${enrichedCompany.company_name}`, "info")

            // Rate limiting delay (except for last item)
            if (i < companies.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing company ${companies[i].company_name}: ${error.message}`, "error")
            enrichedCompanies.push(companies[i]) // Add original data if enrichment fails
        }
    }

    return enrichedCompanies
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting company processing...", "info")

        // Extract companies from platforms
        const companies = await extractCompaniesFromPlatforms()
        log(`Extracted ${companies.length} unique companies`, "info")

        // Create backup if file exists
        if (fs.existsSync(COMPANIES_CSV_PATH)) {
            createBackup(COMPANIES_CSV_PATH, BACKUP_DIR)
        }

        // Enrich company data
        const enrichedCompanies = await processCompaniesWithRateLimit(companies)

        // Save to CSV
        saveCsvData(COMPANIES_CSV_PATH, enrichedCompanies)

        log("Company processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

