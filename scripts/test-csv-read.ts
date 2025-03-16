import fs from "fs"
import path from "path"
import Papa from "papaparse"
import dotenv from "dotenv"

// Load environment variables
dotenv.config()

// File paths
const CSV_FILE_PATH = path.join(process.cwd(), "data", "AI Hierarchical Categorization System.csv")
const LOG_FILE_PATH = path.join(process.cwd(), "logs", `csv_test_${new Date().toISOString().replace(/:/g, "-")}.txt`)

// Define a type for our CSV records
interface CsvRecord {
    [key: string]: string
}

// Create logs directory if it doesn't exist
if (!fs.existsSync(path.dirname(LOG_FILE_PATH))) {
    fs.mkdirSync(path.dirname(LOG_FILE_PATH), { recursive: true })
}

// Helper function to log messages
function log(message: string) {
    const timestamp = new Date().toISOString()
    const logMessage = `[${timestamp}] ${message}`
    console.log(logMessage)
    fs.appendFileSync(LOG_FILE_PATH, logMessage + "\n")
}

async function testCsvRead() {
    log("Testing CSV file read...")

    try {
        // Check if file exists
        if (!fs.existsSync(CSV_FILE_PATH)) {
            log(`❌ ERROR: CSV file not found at: ${CSV_FILE_PATH}`)
            log(`Current working directory: ${process.cwd()}`)
            log("Please make sure the file exists at the specified location.")
            return
        }

        // Get file stats
        const stats = fs.statSync(CSV_FILE_PATH)
        log(`File size: ${(stats.size / 1024).toFixed(2)} KB`)
        log(`Last modified: ${stats.mtime}`)

        // Read the CSV file
        log("Reading CSV file...")
        const fileContent = fs.readFileSync(CSV_FILE_PATH, "utf8")

        // Parse CSV with Papa Parse
        const parseResult = Papa.parse<CsvRecord>(fileContent, {
            header: true,
            skipEmptyLines: true,
        })

        const records = parseResult.data

        log(`✅ SUCCESS: CSV file read successfully!`)
        log(`Found ${records.length} rows in the CSV file.`)

        // Get column headers
        const headers = parseResult.meta.fields || []
        log(`CSV Headers (${headers.length}): ${headers.join(", ")}`)

        // Check if we have at least 10 columns (A-J)
        if (headers.length >= 10) {
            log("✅ File has at least 10 columns (A-J) as required.")
        } else {
            log(`⚠️ WARNING: File has only ${headers.length} columns, but we need at least 10 columns (A-J).`)
        }

        // Display first row as sample
        if (records.length > 0) {
            log("Sample data (first row):")
            log(JSON.stringify(records[0], null, 2))
        }

        // Check columns C-J (indices 2-9)
        const targetColumns = headers.slice(START_COLUMN_INDEX, END_COLUMN_INDEX + 1)
        log(`Target columns to update (${targetColumns.length}): ${targetColumns.join(", ")}`)

        // Count rows with empty values in columns C-J
        let emptyCount = 0
        for (const record of records) {
            let hasEmpty = false
            for (const col of targetColumns) {
                if (!record[col] || record[col].trim() === "") {
                    hasEmpty = true
                    break
                }
            }
            if (hasEmpty) emptyCount++
        }

        log(
            `Rows with empty values in target columns: ${emptyCount}/${records.length} (${((emptyCount / records.length) * 100).toFixed(2)}%)`,
        )
    } catch (error: any) {
        log(`❌ ERROR: Failed to read or parse CSV file: ${error.message || "Unknown error"}`)
        log("Full error details:")
        log(JSON.stringify(error, null, 2))
    }

    log("Test completed. Log saved to: " + LOG_FILE_PATH)
}

// Constants
const START_COLUMN_INDEX = 2 // Column C (0-indexed)
const END_COLUMN_INDEX = 9 // Column J (0-indexed)

// Run the test
testCsvRead().catch((error: any) => {
    log(`Unhandled error: ${error.message || "Unknown error"}`)
    process.exit(1)
})

