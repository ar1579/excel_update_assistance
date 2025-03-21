import fs from "fs"
import path from "path"
import { log } from "../../utils/logging"
import { createBackup, loadCsvData, saveCsvData } from "../../utils/file-utils"
import { withErrorHandling } from "../../utils/error-handler"

// Define paths
const ROOT_DIR = process.cwd()
const DATA_DIR = path.join(ROOT_DIR, "data")
const LOGS_DIR = path.join(ROOT_DIR, "logs")
const BACKUP_DIR = path.join(ROOT_DIR, "backups")

// File paths
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const COMPANIES_CSV_PATH = path.join(DATA_DIR, "Companies.csv")

// Interfaces
interface Platform {
    platform_id: string
    platform_name: string
    platform_url: string
    company_id: string
    platform_category?: string
    platform_sub_category?: string
    platform_description?: string
    platform_launch_date?: string
    platform_status?: string
    platform_availability?: string
    api_availability?: string
    integration_options?: string
    createdAt: string
    updatedAt: string
    [key: string]: string | undefined
}

interface Company {
    company_id: string
    company_name: string
    company_hq_location?: string
    company_year_founded?: string
    company_size?: string
    company_contact_information?: string
    company_industry?: string
    company_website_url?: string
    company_linkedin_url?: string
    company_twitter_url?: string
    company_funding_stage?: string
    company_annual_revenue?: string
    createdAt: string
    updatedAt: string
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
 * Extract company name from URL
 */
function extractCompanyFromUrl(url: string): string {
    try {
        const urlObj = new URL(url)
        const hostname = urlObj.hostname

        // Remove www. if present
        const domain = hostname.replace(/^www\./, "")

        // Get the main domain name (before the TLD)
        const domainParts = domain.split(".")
        if (domainParts.length >= 2) {
            return domainParts[domainParts.length - 2]
        }

        return domain
    } catch (error) {
        return ""
    }
}

/**
 * Generate a unique ID
 */
function generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}`
}

/**
 * Find or create a company based on platform URL
 */
function findOrCreateCompany(
    platformUrl: string,
    platformName: string,
    companies: Company[],
): { company: Company; isNew: boolean } {
    const companyName = extractCompanyFromUrl(platformUrl)

    // Capitalize first letter
    const formattedCompanyName = companyName.charAt(0).toUpperCase() + companyName.slice(1)

    // Check if company already exists
    const existingCompany = companies.find((c) => c.company_name.toLowerCase() === formattedCompanyName.toLowerCase())

    if (existingCompany) {
        return { company: existingCompany, isNew: false }
    }

    // Create new company
    const newCompany: Company = {
        company_id: generateId("company"),
        company_name: formattedCompanyName,
        company_website_url: platformUrl,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }

    return { company: newCompany, isNew: true }
}

/**
 * Import validated platforms
 */
async function importValidatedPlatforms(validationReportPath: string): Promise<void> {
    log(`Importing platforms from validation report: ${validationReportPath}`, "info")

    // Check if validation report exists
    if (!fs.existsSync(validationReportPath)) {
        log(`Validation report not found at: ${validationReportPath}`, "error")
        return
    }

    // Read validation report
    const reportData = fs.readFileSync(validationReportPath, "utf8")
    const validationResult: ValidationResult = JSON.parse(reportData)

    const validPlatforms = validationResult.valid

    if (validPlatforms.length === 0) {
        log("No valid platforms to import", "warning")
        return
    }

    log(`Found ${validPlatforms.length} valid platforms to import`, "info")

    // Load existing companies
    let companies: Company[] = []
    if (fs.existsSync(COMPANIES_CSV_PATH)) {
        companies = loadCsvData<Company>(COMPANIES_CSV_PATH)
        log(`Loaded ${companies.length} existing companies`, "info")
    } else {
        log("No existing companies file found. Will create new file.", "warning")
    }

    // Load existing platforms
    let platforms: Platform[] = []
    if (fs.existsSync(PLATFORMS_CSV_PATH)) {
        platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        log(`Loaded ${platforms.length} existing platforms`, "info")
    } else {
        log("No existing platforms file found. Will create new file.", "warning")
    }

    // Create backups
    if (fs.existsSync(COMPANIES_CSV_PATH)) {
        await createBackup(COMPANIES_CSV_PATH, BACKUP_DIR)
    }

    if (fs.existsSync(PLATFORMS_CSV_PATH)) {
        await createBackup(PLATFORMS_CSV_PATH, BACKUP_DIR)
    }

    // Process each valid platform
    const newCompanies: Company[] = []
    const newPlatforms: Platform[] = []

    for (const platform of validPlatforms) {
        // Find or create company
        const { company, isNew } = findOrCreateCompany(platform.platformUrl, platform.platformName, [
            ...companies,
            ...newCompanies,
        ])

        if (isNew) {
            newCompanies.push(company)
            log(`Created new company: ${company.company_name}`, "info")
        }

        // Create platform
        const newPlatform: Platform = {
            platform_id: generateId("platform"),
            platform_name: platform.platformName,
            platform_url: platform.platformUrl,
            company_id: company.company_id,
            platform_status: "Active", // Default status
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }

        newPlatforms.push(newPlatform)
        log(`Created new platform: ${newPlatform.platform_name}`, "info")
    }

    // Update companies file
    const updatedCompanies = [...companies, ...newCompanies]
    saveCsvData(COMPANIES_CSV_PATH, updatedCompanies)
    log(`Saved ${updatedCompanies.length} companies (${newCompanies.length} new)`, "success")

    // Update platforms file
    const updatedPlatforms = [...platforms, ...newPlatforms]
    saveCsvData(PLATFORMS_CSV_PATH, updatedPlatforms)
    log(`Saved ${updatedPlatforms.length} platforms (${newPlatforms.length} new)`, "success")

    log("Platform import completed successfully", "success")
    log("Next steps:", "info")
    log("1. Run the company processor to enrich company data:", "info")
    log("   npx ts-node scripts/csv-processors/process-companies.ts", "info")
    log("2. Run the platform processor to enrich platform data:", "info")
    log("   npx ts-node scripts/csv-processors/process-platforms.ts", "info")
}

// Main function
const main = withErrorHandling(
    async () => {
        // Get validation report path from command line argument or use default
        const reportFileName = process.argv[2]
        let validationReportPath: string

        if (reportFileName) {
            validationReportPath = path.join(LOGS_DIR, reportFileName)
        } else {
            // Find the most recent validation report
            const logFiles = fs
                .readdirSync(LOGS_DIR)
                .filter((file) => file.startsWith("platform_validation_"))
                .sort()
                .reverse()

            if (logFiles.length === 0) {
                log("No validation reports found. Please run validate-platform-list.ts first.", "error")
                return
            }

            validationReportPath = path.join(LOGS_DIR, logFiles[0])
        }

        await importValidatedPlatforms(validationReportPath)
    },
    (error: Error) => {
        log(`Critical error in import-validated-platforms: ${error.message}`, "error")
        process.exit(1)
    },
)

// Execute if this script is run directly
if (require.main === module) {
    main()
}

// Export for testing
export { findOrCreateCompany, extractCompanyFromUrl }
