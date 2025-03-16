import fs from "fs"
import path from "path"
import Papa from "papaparse"
import { OpenAI } from "openai"
import dotenv from "dotenv"

// Load environment variables
dotenv.config()

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

// File paths
const CSV_FILE_PATH = path.join(process.cwd(), "data", "AI Hierarchical Categorization System.csv")
const BACKUP_FILE_PATH = path.join(
    process.cwd(),
    "data",
    `AI Hierarchical Categorization System_backup_${new Date().toISOString().replace(/:/g, "-")}.csv`,
)
const LOG_FILE_PATH = path.join(process.cwd(), "logs", `update_log_${new Date().toISOString().replace(/:/g, "-")}.txt`)

// Column indices (0-based)
const START_COLUMN_INDEX = 2 // Column C (0-indexed)
const END_COLUMN_INDEX = 9 // Column J (0-indexed)

// Rate limiting settings
const REQUESTS_PER_MINUTE = 60 // Adjust based on your OpenAI tier
const DELAY_BETWEEN_REQUESTS = (60 * 1000) / REQUESTS_PER_MINUTE // in milliseconds

// Define a type for our CSV records
interface CsvRecord {
    [key: string]: string
}

// Create logs directory if it doesn't exist
if (!fs.existsSync(path.dirname(LOG_FILE_PATH))) {
    fs.mkdirSync(path.dirname(LOG_FILE_PATH), { recursive: true })
}

// Helper function to log messages to console and file
function log(message: string) {
    const timestamp = new Date().toISOString()
    const logMessage = `[${timestamp}] ${message}`
    console.log(logMessage)
    fs.appendFileSync(LOG_FILE_PATH, logMessage + "\n")
}

// Helper function to delay execution (for rate limiting)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Main function to update the CSV file
async function updateCsvFile() {
    try {
        log("Starting CSV update process...")

        // Check if file exists
        if (!fs.existsSync(CSV_FILE_PATH)) {
            throw new Error(`CSV file not found at: ${CSV_FILE_PATH}`)
        }

        // Create backup of original file
        log("Creating backup of original file...")
        fs.copyFileSync(CSV_FILE_PATH, BACKUP_FILE_PATH)
        log(`Backup created at: ${BACKUP_FILE_PATH}`)

        // Read the CSV file
        log("Reading CSV file...")
        const fileContent = fs.readFileSync(CSV_FILE_PATH, "utf8")

        // Parse CSV with Papa Parse
        const parseResult = Papa.parse<CsvRecord>(fileContent, {
            header: true,
            skipEmptyLines: true,
        })

        const records = parseResult.data
        const headers = parseResult.meta.fields || []

        log(`Found ${records.length} rows in the CSV file.`)
        log(`CSV Headers: ${headers.join(", ")}`)

        // Process each row
        const updatedRecords = [...records] // Create a copy of the records array
        let processedCount = 0

        for (let i = 0; i < updatedRecords.length; i++) {
            const record = updatedRecords[i]

            // Get the first two columns (Level 1 and Level 2)
            const level1 = record[headers[0]] || ""
            const level2 = record[headers[1]] || ""

            // Skip if both Level 1 and Level 2 are empty
            if (!level1 && !level2) {
                log(`Skipping row ${i + 1}: Empty Level 1 and Level 2`)
                continue
            }

            log(`Processing row ${i + 1}/${updatedRecords.length}: ${level1} - ${level2}`)

            try {
                // Generate content for columns C through J using OpenAI
                const generatedContent = await generateHierarchicalContent(level1, level2)

                // Update the record with generated content
                for (let colIndex = START_COLUMN_INDEX; colIndex <= END_COLUMN_INDEX; colIndex++) {
                    const header = headers[colIndex]
                    if (header && generatedContent[colIndex - START_COLUMN_INDEX]) {
                        record[header] = generatedContent[colIndex - START_COLUMN_INDEX]
                    }
                }

                processedCount++
                log(`Successfully processed row ${i + 1}`)
            } catch (error: any) {
                log(`Error processing row ${i + 1}: ${error.message || "Unknown error"}`)
                // Continue with next row on error
            }

            // Save progress every 10 rows
            if (i % 10 === 9 || i === updatedRecords.length - 1) {
                saveProgress(updatedRecords, headers)
                log(`Progress saved: ${i + 1}/${updatedRecords.length} rows processed.`)
            }

            // Apply rate limiting
            if (i < updatedRecords.length - 1) {
                log(`Waiting ${DELAY_BETWEEN_REQUESTS}ms before next request (rate limiting)...`)
                await sleep(DELAY_BETWEEN_REQUESTS)
            }
        }

        log(`CSV file has been successfully updated! Processed ${processedCount} rows.`)
    } catch (error: any) {
        log(`CRITICAL ERROR: ${error.message || "Unknown error"}`)
        log("Process terminated due to critical error.")
    }
}

// Function to save progress
function saveProgress(records: CsvRecord[], headers: string[]) {
    const csv = Papa.unparse(records, {
        header: true,
        columns: headers,
    })
    fs.writeFileSync(CSV_FILE_PATH, csv)
}

// Function to generate hierarchical content using OpenAI
async function generateHierarchicalContent(level1: string, level2: string): Promise<string[]> {
    try {
        const prompt = `
    I need to create a hierarchical categorization for an AI technology or application.
    
    Level 1 (Main Category): ${level1}
    Level 2 (Sub-Category): ${level2}
    
    Please generate appropriate values for Levels 3-10 in this hierarchical structure:
    
    Level 3: Domain Focus - The specific domain or industry where this AI is applied
    Level 4: Functional Area - The functional area or department within that domain
    Level 5: Technology Specialization - The specific AI technology or approach used
    Level 6: Specific Application - A concrete application or use case
    Level 7: Condition Focus - A particular condition or scenario this AI addresses
    Level 8: Specific Condition - A specific instance of that condition
    Level 9: Methodology Approach - The methodological approach used
    Level 10: Technical Implementation - The technical implementation details
    
    Return ONLY the values for levels 3-10 as a JSON array with no explanations.
    Example format: ["Healthcare", "Diagnostics", "Medical Imaging", "Brain MRI Analysis", "Neurological Disorders", "Alzheimer's Detection", "Biomarker-based Detection", "Deep Learning-based Biomarker Detection"]
    `

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content:
                        "You are a helpful assistant that specializes in AI technology categorization. You respond only with the requested data in the exact format specified, with no additional text.",
                },
                { role: "user", content: prompt },
            ],
            temperature: 0.7,
            max_tokens: 500,
        })

        const content = response.choices[0]?.message?.content || "[]"

        // Extract the JSON array from the response
        const jsonMatch = content.match(/\[.*\]/s)
        if (!jsonMatch) {
            throw new Error("Failed to parse JSON array from OpenAI response")
        }

        // Parse the JSON array
        const hierarchyLevels = JSON.parse(jsonMatch[0])

        // Validate the response
        if (!Array.isArray(hierarchyLevels) || hierarchyLevels.length !== 8) {
            throw new Error(`Invalid response format. Expected array of 8 items, got: ${JSON.stringify(hierarchyLevels)}`)
        }

        return hierarchyLevels
    } catch (error: any) {
        log(`Error generating content with OpenAI: ${error.message || "Unknown error"}`)
        // Rethrow to handle in the main function
        throw error
    }
}

// Run the update function
updateCsvFile()
    .then(() => {
        log("Script execution completed.")
    })
    .catch((error: any) => {
        log(`Unhandled error: ${error.message || "Unknown error"}`)
        process.exit(1)
    })

