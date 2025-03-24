import fs from 'fs'
import path from 'path'

// Define log levels
type LogLevel = 'debug' | 'info' | 'warning' | 'error' | 'success'

// Create logs directory if it doesn't exist
const LOGS_DIR = path.join(process.cwd(), 'logs')
if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
}

// Main app log file
const APP_LOG_FILE = path.join(LOGS_DIR, 'app.log')

/**
* Create a logger for a specific module
*/
export function createLogger(moduleName: string) {
    const timestamp = new Date().toISOString().replace(/:/g, '-')
    const logFileName = `${moduleName}_${timestamp}.log`
    const logFilePath = path.join(LOGS_DIR, logFileName)

    // Create the log file - use writeFileSync to ensure it's created before returning
    try {
        fs.writeFileSync(logFilePath, `=== ${moduleName} Log Started at ${new Date().toISOString()} ===\n`)
    } catch (error) {
        console.error(`Failed to create log file for ${moduleName}: ${error}`)
        // Continue anyway - we'll try to log to console at least
    }

    // Return a simple object with logging methods
    return {
        debug: (message: string) => log(message, 'debug', logFilePath),
        info: (message: string) => log(message, 'info', logFilePath),
        warning: (message: string) => log(message, 'warning', logFilePath),
        warn: (message: string) => log(message, 'warning', logFilePath), // Alias for warning
        error: (message: string) => log(message, 'error', logFilePath),
        success: (message: string) => log(message, 'success', logFilePath),
    }
}

/**
* Log a message with a specific level
*/
export function log(message: string, level: LogLevel = 'info', logFilePath: string = APP_LOG_FILE) {
    const timestamp = new Date().toISOString()
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`

    // Log to console with color - use try/catch to prevent crashes
    try {
        switch (level) {
            case 'debug':
                console.debug(`\x1b[90m${logMessage}\x1b[0m`) // Gray
                break
            case 'info':
                console.info(`\x1b[36m${logMessage}\x1b[0m`) // Cyan
                break
            case 'warning':
                console.warn(`\x1b[33m${logMessage}\x1b[0m`) // Yellow
                break
            case 'error':
                console.error(`\x1b[31m${logMessage}\x1b[0m`) // Red
                break
            case 'success':
                console.log(`\x1b[32m${logMessage}\x1b[0m`) // Green
                break
        }
    } catch (error) {
        // If console logging fails, at least try to write to a file
        console.error(`Failed to log to console: ${error}`)
    }

    // Log to the specified file - use try/catch to prevent crashes
    try {
        fs.appendFileSync(logFilePath, `${logMessage}\n`)
    } catch (fileError) {
        console.error(`Failed to write to log file ${logFilePath}: ${fileError}`)
    }

    // Also log to the main app log file if it's not already the target
    if (logFilePath !== APP_LOG_FILE) {
        try {
            fs.appendFileSync(APP_LOG_FILE, `${logMessage}\n`)
        } catch (appLogError) {
            console.error(`Failed to write to app log file: ${appLogError}`)
        }
    }
}