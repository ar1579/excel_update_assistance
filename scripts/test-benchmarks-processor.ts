import { exec } from "child_process"
import path from "path"
import fs from "fs"
import { log } from "../utils/logging"

// Define paths
const scriptPath = path.join(process.cwd(), "scripts", "csv-processors", "process-benchmarks.ts")
const logDir = path.join(process.cwd(), "logs")

// Ensure log directory exists
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
}

log(`Testing benchmarks processor script at: ${scriptPath}`, "info")
log("Running with ts-node...", "info")

// Execute the script
exec(`npx ts-node ${scriptPath}`, (error, stdout, stderr) => {
    if (error) {
        log(`Error: ${error.message}`, "error")
        return
    }

    if (stderr) {
        log(`stderr: ${stderr}`, "error")
        return
    }

    log(`stdout: ${stdout}`, "info")
    log("Test completed successfully!", "success")
    log(`Check the logs directory for detailed execution logs: ${logDir}`, "info")
})

