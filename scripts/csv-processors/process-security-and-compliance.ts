import fs from "fs"
import path from "path"
import dotenv from "dotenv"
import { log } from "../../utils/logging"
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
const SECURITY_CSV_PATH = path.join(DATA_DIR, "Security_and_Compliance.csv")
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")
const PLATFORM_CERTIFICATIONS_CSV_PATH = path.join(DATA_DIR, "platform_certifications.csv")

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    log(`Created directory: ${DATA_DIR}`, "info")
}

// Rate limiting settings
const DELAY_BETWEEN_REQUESTS = 1000 // 1 second

// Security and Compliance data structure
interface SecurityCompliance {
    security_id: string
    platform_id: string
    security_certifications: string
    compliance_standards?: string
    gdpr_compliance?: string
    hipaa_compliance?: string
    iso_certifications?: string
    data_retention_policies?: string
    data_processing_location?: string
    privacy_features?: string
    security_incidents_history?: string
    audit_capabilities?: string
    access_control_features?: string
    createdAt?: string
    updatedAt?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

// Platform data structure
interface Platform {
    platform_id: string
    platform_name: string
    platform_url: string
    platform_category?: string
    platform_sub_category?: string
    platform_description?: string
    [key: string]: string | undefined // Allow any string key for dynamic access
}

// Platform-Certification join table structure
interface PlatformCertification {
    platform_id: string
    security_id: string
    createdAt?: string
    updatedAt?: string
}

/**
 * Validate security and compliance data against schema constraints
 */
function validateSecurityCompliance(security: SecurityCompliance): { valid: boolean; errors: string[] } {
    const errors: string[] = []

    // Check required fields
    if (!security.platform_id) {
        errors.push("platform_id is required")
    }

    if (!security.security_certifications) {
        errors.push("security_certifications is required")
    }

    return {
        valid: errors.length === 0,
        errors,
    }
}

/**
 * Validate security records against platforms
 */
function validateSecurityAgainstPlatforms(
    securityRecords: SecurityCompliance[],
    platformsMap: Map<string, Platform>,
): SecurityCompliance[] {
    log("Validating security records against platforms...", "info")

    // If no security records, create default ones for testing
    if (securityRecords.length === 0 && platformsMap.size > 0) {
        log("No security records found in CSV, creating default records for testing", "warning")
        const newSecurityRecords: SecurityCompliance[] = []

        // Create a default security record for each platform
        for (const [platformId, platform] of platformsMap.entries()) {
            const defaultSecurity: SecurityCompliance = {
                security_id: `sec_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                platform_id: platformId,
                security_certifications: "Standard security practices",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            }
            newSecurityRecords.push(defaultSecurity)
            log(`Created default security record for platform: ${platform.platform_name}`, "info")
        }

        return newSecurityRecords
    }

    const validSecurityRecords = securityRecords.filter((security) => {
        const platformId = security.platform_id
        if (!platformId) {
            log(`Security record ${security.security_id || "unknown"} has no platform ID, skipping`, "warning")
            return false
        }

        const platformExists = platformsMap.has(platformId)
        if (!platformExists) {
            log(
                `Security record ${security.security_id || "unknown"} references non-existent platform ${platformId}, skipping`,
                "warning",
            )
            return false
        }

        return true
    })

    log(`Validated ${validSecurityRecords.length}/${securityRecords.length} security records`, "info")
    return validSecurityRecords
}

/**
 * Enrich security and compliance data using OpenAI
 */
async function enrichSecurityComplianceData(
    security: SecurityCompliance,
    platform: Platform,
): Promise<SecurityCompliance> {
    try {
        log(`Enriching security and compliance data for platform: ${platform.platform_name}`, "info")

        const prompt = `
Provide accurate security and compliance information for the AI platform "${platform.platform_name}" in JSON format with the following fields:
- security_certifications: Security certifications held (e.g., "SOC 2, ISO 27001, NIST")
- compliance_standards: Compliance standards met (e.g., "GDPR, HIPAA, CCPA, PCI DSS")
- gdpr_compliance: GDPR compliance status (e.g., "Fully compliant", "Partially compliant", "Not applicable")
- hipaa_compliance: HIPAA compliance status (e.g., "Compliant", "Not compliant", "Not applicable")
- iso_certifications: ISO certifications held (e.g., "ISO 27001, ISO 27017, ISO 27018")
- data_retention_policies: Data retention policies (e.g., "30-day default retention, customizable up to 7 years")
- data_processing_location: Where data is processed (e.g., "US, EU, Global with regional options")
- privacy_features: Privacy features offered (e.g., "Data encryption, Anonymization, Access controls")
- security_incidents_history: History of security incidents (e.g., "No major incidents reported", "Minor incident in 2022, resolved")
- audit_capabilities: Audit capabilities (e.g., "Comprehensive audit logs, User activity tracking")
- access_control_features: Access control features (e.g., "Role-based access, Multi-factor authentication, SSO")

Additional context about the platform:
Platform URL: ${platform.platform_url || "Not available"}
Platform category: ${platform.platform_category || "Unknown"}
Platform sub-category: ${platform.platform_sub_category || "Unknown"}
Platform description: ${platform.platform_description || "No description available"}

If any information is not known with confidence, use null for that field.
Return ONLY the JSON object with no additional text.
`

        // Make OpenAI request with fallback mechanism
        const enrichedData = await makeOpenAIRequest<Partial<SecurityCompliance>>(openai, prompt)

        // Update timestamp
        const timestamp = new Date().toISOString()

        // Merge with existing security data, only updating null/undefined fields
        const updatedSecurity: SecurityCompliance = { ...security }
        Object.keys(enrichedData).forEach((key) => {
            if (updatedSecurity[key] === undefined || updatedSecurity[key] === null || updatedSecurity[key] === "") {
                updatedSecurity[key] = enrichedData[key as keyof Partial<SecurityCompliance>]
            }
        })

        updatedSecurity.updatedAt = timestamp

        // Validate the enriched security data
        const validation = validateSecurityCompliance(updatedSecurity)
        if (!validation.valid) {
            log(
                `Validation issues with enriched security for ${platform.platform_name}: ${validation.errors.join(", ")}`,
                "warning",
            )
        }

        return updatedSecurity
    } catch (error: any) {
        log(`Error enriching security for ${platform.platform_name}: ${error.message}`, "error")
        return security
    }
}

/**
 * Process all security records with rate limiting
 */
async function processSecurityWithRateLimit(
    securityRecords: SecurityCompliance[],
    platformsMap: Map<string, Platform>,
): Promise<SecurityCompliance[]> {
    const enrichedSecurityRecords: SecurityCompliance[] = []

    for (let i = 0; i < securityRecords.length; i++) {
        try {
            // Skip security records that already have all fields filled
            const security = securityRecords[i]
            const hasAllFields =
                security.security_certifications &&
                security.compliance_standards &&
                security.gdpr_compliance &&
                security.hipaa_compliance &&
                security.data_retention_policies &&
                security.privacy_features

            if (hasAllFields) {
                log(
                    `Skipping security ${i + 1}/${securityRecords.length}: ${security.security_id || "unknown"} (already complete)`,
                    "info",
                )
                enrichedSecurityRecords.push(security)
                continue
            }

            // Get associated platform
            const platform = platformsMap.get(security.platform_id) as Platform

            // Enrich security data
            const enrichedSecurity = await enrichSecurityComplianceData(security, platform)
            enrichedSecurityRecords.push(enrichedSecurity)

            // Log progress
            log(`Processed security ${i + 1}/${securityRecords.length} for platform: ${platform.platform_name}`, "info")

            // Rate limiting delay (except for last item)
            if (i < securityRecords.length - 1) {
                await applyRateLimit(DELAY_BETWEEN_REQUESTS)
            }
        } catch (error: any) {
            log(`Error processing security ${securityRecords[i].security_id || "unknown"}: ${error.message}`, "error")
            enrichedSecurityRecords.push(securityRecords[i]) // Add original data if enrichment fails
        }
    }

    return enrichedSecurityRecords
}

/**
 * Update the platform_certifications join table
 */
function updatePlatformCertificationsJoinTable(securityRecords: SecurityCompliance[]): void {
    try {
        log("Updating platform_certifications join table...", "info")

        // Load existing join table data
        let platformCertifications: PlatformCertification[] = []
        if (fs.existsSync(PLATFORM_CERTIFICATIONS_CSV_PATH)) {
            platformCertifications = loadCsvData<PlatformCertification>(PLATFORM_CERTIFICATIONS_CSV_PATH)
        }

        // Create a map of existing relationships
        const existingRelationships = new Set<string>()
        platformCertifications.forEach((relation) => {
            existingRelationships.add(`${relation.platform_id}-${relation.security_id}`)
        })

        // Add new relationships
        const timestamp = new Date().toISOString()
        let newRelationsCount = 0

        securityRecords.forEach((security) => {
            const relationKey = `${security.platform_id}-${security.security_id}`
            if (!existingRelationships.has(relationKey)) {
                platformCertifications.push({
                    platform_id: security.platform_id,
                    security_id: security.security_id,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                })
                existingRelationships.add(relationKey)
                newRelationsCount++
            }
        })

        // Save updated join table
        saveCsvData(PLATFORM_CERTIFICATIONS_CSV_PATH, platformCertifications)
        log(`Updated platform_certifications join table with ${newRelationsCount} new relationships`, "info")
    } catch (error: any) {
        log(`Error updating platform_certifications join table: ${error.message}`, "error")
    }
}

/**
 * Main function
 */
async function main() {
    try {
        log("Starting security and compliance processing...", "info")

        // Load platforms and security records
        const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH)
        const platformsMap = createLookupMap(platforms, "platform_id")

        let securityRecords = loadCsvData<SecurityCompliance>(SECURITY_CSV_PATH)

        // Create backup of security file if it exists and has data
        if (fs.existsSync(SECURITY_CSV_PATH) && securityRecords.length > 0) {
            createBackup(SECURITY_CSV_PATH, BACKUP_DIR)
        }

        // Validate security records against platforms
        securityRecords = validateSecurityAgainstPlatforms(securityRecords, platformsMap)

        // Enrich security data
        securityRecords = await processSecurityWithRateLimit(securityRecords, platformsMap)

        // Save to CSV
        saveCsvData(SECURITY_CSV_PATH, securityRecords)

        // Update the platform_certifications join table
        updatePlatformCertificationsJoinTable(securityRecords)

        log("Security and compliance processing completed successfully", "info")
    } catch (error: any) {
        log(`Error in main process: ${error.message}`, "error")
        process.exit(1)
    }
}

// Run the main function
main()

