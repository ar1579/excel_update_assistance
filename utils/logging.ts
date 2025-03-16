import fs from "fs"
import path from "path"

// Log levels
export type LogLevel = "debug" | "info" | "warning" | "error" | "success"

// Logger interface
export interface Logger {
    debug(message: string): void
    info(message: string): void
    warn(message: string): void
    error(message: string): void
}

// Log function
export function log(message: string, level: LogLevel = "info"): string {
    const timestamp = new Date().toISOString()
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`

    // Log to console
    switch (level) {
        case "debug":
            console.debug(logMessage)
            break
        case "info":
            console.info(logMessage)
            break
        case "warning":
            console.warn(logMessage)
            break
        case "error":
            console.error(logMessage)
            break
        case "success":
            console.log(`\x1b[32m${logMessage}\x1b[0m`) // Green color for success
            break
        default:
            console.log(logMessage)
    }

    // Log to file (optional)
    const logDir = path.join(process.cwd(), "logs")
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true })
    }
    const logFilePath = path.join(logDir, "app.log") // Single log file
    fs.appendFileSync(logFilePath, logMessage + "\n")

    return logMessage
}

// Create logger function
export function createLogger(moduleName: string): Logger {
    const logDir = path.join(process.cwd(), "logs")

    // Ensure log directory exists
    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true })
    }

    const logFilePath = path.join(logDir, `${moduleName}_${new Date().toISOString().replace(/:/g, "-")}.log`)

    // Create log file
    if (!fs.existsSync(logFilePath)) {
        fs.writeFileSync(logFilePath, "")
    }

    return {
        debug: (message: string) => log(`[${moduleName}] ${message}`, "debug"),
        info: (message: string) => log(`[${moduleName}] ${message}`, "info"),
        warn: (message: string) => log(`[${moduleName}] ${message}`, "warning"),
        error: (message: string) => log(`[${moduleName}] ${message}`, "error"),
    }
}

