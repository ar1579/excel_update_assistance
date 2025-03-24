import { createLogger } from "../utils/logging"
import { exec } from "child_process"
import path from "path"
import fs from "fs"

// Create a logger for this test script
const logger = createLogger("test-model-processor")

/**
 * Test the model processor script
 */
async function testModelProcessor() {
    try {
        logger.info("Starting test of model processor script...")

        // Define file paths
        const DATA_DIR = path.join(process.cwd(), "data")
        const MODELS_CSV_PATH = path.join(DATA_DIR, "Models.csv")
        const PLATFORMS_CSV_PATH = path.join(DATA_DIR, "Platforms.csv")

        // Check if required files exist
        if (!fs.existsSync(PLATFORMS_CSV_PATH)) {
            logger.error(`Platforms CSV file not found at: ${PLATFORMS_CSV_PATH}`)
            logger.info("Please run the platform processor first:")
            logger.info("npx ts-node scripts/csv-processors/process-platforms.ts")
            return
        }

        // Log the current state
        if (fs.existsSync(MODELS_CSV_PATH)) {
            const stats = fs.statSync(MODELS_CSV_PATH)
            const fileSizeInKB = stats.size / 1024
            logger.info(`Current Models.csv file size: ${fileSizeInKB.toFixed(2)} KB`)

            // Count lines in the file (approximate record count)
            const fileContent = fs.readFileSync(MODELS_CSV_PATH, "utf8")
            const lineCount = fileContent.split("\n").length - 1 // -1 for header
            logger.info(`Current Models.csv record count (approx): ${lineCount}`)
        } else {
            logger.info("Models.csv file does not exist yet. It will be created by the processor.")
        }

        // Execute the model processor script
        logger.info("Executing model processor script...")

        const command = "npx ts-node scripts/csv-processors/process-models.ts"

        const childProcess = exec(command)

        // Forward stdout and stderr
        childProcess.stdout?.on("data", (data) => {
            process.stdout.write(data)
        })

        childProcess.stderr?.on("data", (data) => {
            process.stderr.write(data)
        })

        // Wait for the process to complete
        await new Promise<void>((resolve, reject) => {
            childProcess.on("close", (code) => {
                if (code === 0) {
                    resolve()
                } else {
                    reject(new Error(`Process exited with code ${code}`))
                }
            })
        })

        // Check the results
        if (fs.existsSync(MODELS_CSV_PATH)) {
            const stats = fs.statSync(MODELS_CSV_PATH)
            const fileSizeInKB = stats.size / 1024
            logger.info(`Updated Models.csv file size: ${fileSizeInKB.toFixed(2)} KB`)

            // Count lines in the file (approximate record count)
            const fileContent = fs.readFileSync(MODELS_CSV_PATH, "utf8")
            const lineCount = fileContent.split("\n").length - 1 // -1 for header
            logger.info(`Updated Models.csv record count (approx): ${lineCount}`)

            logger.success("Model processor test completed successfully!")
        } else {
            logger.error("Models.csv file was not created by the processor.")
        }
    } catch (error: any) {
        logger.error(`Error testing model processor: ${error.message}`)
    }
}

// Run the test
testModelProcessor()

