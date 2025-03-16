import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { OpenAI } from "openai";
import { log } from "../../utils/logging";
import { createBackup, loadCsvData, saveCsvData, createLookupMap } from "../../utils/file-utils";
import { withErrorHandling } from "../../utils/error-handler";
import { createRateLimiter } from "../../utils/rate-limiter";

// Load environment variables
dotenv.config();

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Rate limiter for API calls - setting 10 requests per minute
const rateLimiter = createRateLimiter(10);

// File paths
const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, "data");
const BACKUP_DIR = path.join(ROOT_DIR, "backups");
const PLATFORM_LICENSES_CSV_PATH = path.join(DATA_DIR, "platform_licenses.csv");
const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv");
const LICENSES_CSV_PATH = path.join(DATA_DIR, "Licenses.csv");

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    log(`Created directory: ${DATA_DIR}`, "info");
}

if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    log(`Created directory: ${BACKUP_DIR}`, "info");
}

// Platform data structure
interface Platform {
    platform_id: string;
    platform_name: string;
    [key: string]: string | undefined; // Allow any string key for dynamic access
}

// License data structure
interface License {
    license_id: string;
    license_type?: string;
    open_source_status?: string;
    license_name?: string;
    license_url?: string;
    license_expiration_date?: string;
    platform_id?: string;
    createdAt?: string;
    updatedAt?: string;
    [key: string]: string | undefined; // Allow any string key for dynamic access
}

// Platform-License join table structure
interface PlatformLicense {
    platform_id: string;
    license_id: string;
    createdAt?: string;
    updatedAt?: string;
}

/**
 * Generate license information using OpenAI
 */
async function generateLicenseInfo(platformName: string): Promise<Partial<License>> {
    await rateLimiter.waitForNextRequest();

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: "You are a helpful assistant that provides accurate information about software licensing for AI platforms."
                },
                {
                    role: "user",
                    content: `Generate likely license information for the AI platform "${platformName}".
          Return a JSON object with the following fields:
          - license_type: One of 'Open-source', 'Proprietary', 'Creative Commons', or 'Other'
          - open_source_status: 'Yes', 'No', or 'Partial'
          - license_name: The specific name of the license (e.g., 'MIT', 'Apache 2.0', 'Commercial License')
          - license_url: A likely URL for the license information
          
          Base your response on typical licensing patterns for AI platforms. If uncertain, provide the most likely option.`
                }
            ],
            temperature: 0.7,
            max_tokens: 500
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
            throw new Error("No content returned from OpenAI");
        }

        // Extract JSON from the response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error("Could not extract JSON from OpenAI response");
        }

        const licenseInfo = JSON.parse(jsonMatch[0]);
        return licenseInfo;
    } catch (error: any) {
        log(`Error generating license info for ${platformName}: ${error.message}`, "error");
        // Return default values if API call fails
        return {
            license_type: "Proprietary",
            open_source_status: "No",
            license_name: "Commercial License",
            license_url: `https://www.example.com/${platformName.toLowerCase().replace(/\s+/g, '-')}/license`
        };
    }
}

/**
 * Process licenses data
 */
async function processLicenses(platforms: Platform[]): Promise<License[]> {
    log("Processing licenses data...", "info");

    // Load existing licenses
    let licenses: License[] = [];
    if (fs.existsSync(LICENSES_CSV_PATH)) {
        licenses = loadCsvData<License>(LICENSES_CSV_PATH);
        log(`Loaded ${licenses.length} existing licenses`, "info");
    }

    // Create a map of existing licenses by platform_id
    const licensesByPlatformId = new Map<string, License[]>();
    licenses.forEach(license => {
        if (license.platform_id) {
            if (!licensesByPlatformId.has(license.platform_id)) {
                licensesByPlatformId.set(license.platform_id, []);
            }
            licensesByPlatformId.get(license.platform_id)?.push(license);
        }
    });

    // Process each platform
    const timestamp = new Date().toISOString();
    let newLicensesCount = 0;
    let updatedLicensesCount = 0;

    for (const platform of platforms) {
        // Skip if platform already has licenses
        if (licensesByPlatformId.has(platform.platform_id) &&
            licensesByPlatformId.get(platform.platform_id)!.length > 0) {
            continue;
        }

        log(`Generating license info for platform: ${platform.platform_name}`, "info");

        // Generate license info using OpenAI
        const licenseInfo = await generateLicenseInfo(platform.platform_name);

        // Create a new license
        const newLicense: License = {
            license_id: `lic_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            platform_id: platform.platform_id,
            license_type: licenseInfo.license_type,
            open_source_status: licenseInfo.open_source_status,
            license_name: licenseInfo.license_name,
            license_url: licenseInfo.license_url,
            license_expiration_date: "", // Default to empty string
            createdAt: timestamp,
            updatedAt: timestamp
        };

        licenses.push(newLicense);
        newLicensesCount++;

        // Add to the map for future reference
        if (!licensesByPlatformId.has(platform.platform_id)) {
            licensesByPlatformId.set(platform.platform_id, []);
        }
        licensesByPlatformId.get(platform.platform_id)?.push(newLicense);
    }

    // Save updated licenses
    saveCsvData(LICENSES_CSV_PATH, licenses);
    log(`Processed licenses: ${newLicensesCount} new, ${updatedLicensesCount} updated`, "info");

    return licenses;
}

/**
 * Update the platform_licenses join table
 */
function updatePlatformLicensesJoinTable(platforms: Platform[], licenses: License[]): void {
    try {
        log("Updating platform_licenses join table...", "info");

        // Load existing join table data
        let platformLicenses: PlatformLicense[] = [];
        if (fs.existsSync(PLATFORM_LICENSES_CSV_PATH)) {
            platformLicenses = loadCsvData<PlatformLicense>(PLATFORM_LICENSES_CSV_PATH);
        }

        // Create a map of existing relationships
        const existingRelationships = new Set<string>();
        platformLicenses.forEach((relation) => {
            existingRelationships.add(`${relation.platform_id}-${relation.license_id}`);
        });

        // Add new relationships
        const timestamp = new Date().toISOString();
        let newRelationsCount = 0;

        // Create a map of platforms by ID
        const platformsMap = createLookupMap(platforms, "platform_id");

        // Process each license and create relationship with its platform
        licenses.forEach((license) => {
            if (license.platform_id && license.license_id) {
                const relationKey = `${license.platform_id}-${license.license_id}`;

                if (!existingRelationships.has(relationKey) && platformsMap.has(license.platform_id)) {
                    platformLicenses.push({
                        platform_id: license.platform_id,
                        license_id: license.license_id,
                        createdAt: timestamp,
                        updatedAt: timestamp,
                    });
                    existingRelationships.add(relationKey);
                    newRelationsCount++;
                }
            }
        });

        // Save updated join table
        saveCsvData(PLATFORM_LICENSES_CSV_PATH, platformLicenses);
        log(`Updated platform_licenses join table with ${newRelationsCount} new relationships`, "success");
    } catch (error: any) {
        log(`Error updating platform_licenses join table: ${error.message}`, "error");
        throw error; // Re-throw to be caught by the error handler
    }
}

/**
 * Validate license data
 */
function validateLicenses(licenses: License[]): boolean {
    let isValid = true;

    for (const license of licenses) {
        // Check required fields
        if (!license.license_id) {
            log(`Invalid license: missing license_id`, "error");
            isValid = false;
        }

        // Check license_type is one of the allowed values
        if (license.license_type &&
            !['Open-source', 'Proprietary', 'Creative Commons', 'Other'].includes(license.license_type)) {
            log(`Invalid license_type for license ${license.license_id}: ${license.license_type}`, "error");
            isValid = false;
        }

        // Check open_source_status is one of the allowed values
        if (license.open_source_status &&
            !['Yes', 'No', 'Partial'].includes(license.open_source_status)) {
            log(`Invalid open_source_status for license ${license.license_id}: ${license.open_source_status}`, "error");
            isValid = false;
        }
    }

    return isValid;
}

/**
 * Custom error handler
 */
function customErrorHandler(error: Error): void {
    log(`Critical error in platform-licenses processor: ${error.message}`, "error");
    // Additional error handling logic can be added here
}

/**
 * Main function
 */
const main = withErrorHandling(async () => {
    log("Starting platform_licenses processing...", "info");

    // Load platforms
    const platforms = loadCsvData<Platform>(PLATFORMS_CSV_PATH);
    log(`Loaded ${platforms.length} platforms`, "info");

    if (platforms.length === 0) {
        log("No platforms found. Exiting.", "warning");
        return;
    }

    // Create backups
    if (fs.existsSync(LICENSES_CSV_PATH)) {
        createBackup(LICENSES_CSV_PATH, BACKUP_DIR);
    }

    if (fs.existsSync(PLATFORM_LICENSES_CSV_PATH)) {
        createBackup(PLATFORM_LICENSES_CSV_PATH, BACKUP_DIR);
    }

    // Process licenses
    const licenses = await processLicenses(platforms);

    // Validate licenses
    const isValid = validateLicenses(licenses);
    if (!isValid) {
        log("License validation failed. Please check the errors above.", "warning");
    }

    // Update the platform_licenses join table
    updatePlatformLicensesJoinTable(platforms, licenses);

    log("Platform_licenses processing completed successfully", "success");
}, customErrorHandler);

// Run the main function
if (require.main === module) {
    main();
}

// Export for testing
export { processLicenses, updatePlatformLicensesJoinTable, validateLicenses };