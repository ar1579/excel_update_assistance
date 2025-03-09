import fs from "fs"
import path from "path"

// Create logs directory if it doesn't exist
const logsDir = path.join(process.cwd(), "logs")
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
}

/**
 * Creates a logger that writes to both console and a log file
 * @param logFileName Name of the log file (without extension)
 * @returns A logging function
 */
export function createLogger(logFileName: string) {
    const timestamp = new Date().toISOString().replace(/:/g, "-")
    const logFilePath = path.join(logsDir, `${logFileName}_${timestamp}.txt`)

    // Create the log file
    fs.writeFileSync(logFilePath, `=== Log started at ${new Date().toISOString()} ===\n\n`)

    // Return the logging function
    return function log(message: string, level: "info" | "success" | "warning" | "error" = "info") {
        const timestamp = new Date().toISOString()

        // Add prefix based on log level
        let prefix = ""
        switch (level) {
            case "success":
                prefix = "✅ SUCCESS: "
                break
            case "warning":
                prefix = "⚠️ WARNING: "
                break
            case "error":
                prefix = "❌ ERROR: "
                break
            default:
                prefix = ""
        }

        const logMessage = `[${timestamp}] ${prefix}${message}`
        console.log(logMessage)
        fs.appendFileSync(logFilePath, logMessage + "\n")

        return logFilePath // Return the log file path for reference
    }
}

