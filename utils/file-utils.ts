import fs from "fs"
import path from "path"
import Papa from "papaparse"
import { createLogger } from "./logging"

const logger = createLogger("file-utils")

/**
 * Create a backup of a file
 */
export function createBackup(filePath: string, backupDir: string): string {
    try {
        // Ensure backup directory exists
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true })
        }

        // Create backup filename
        const fileName = path.basename(filePath)
        const backupPath = path.join(
            backupDir,
            `${fileName.replace(".csv", "")}_backup_${new Date().toISOString().replace(/:/g, "-")}.csv`,
        )

        // Copy file to backup
        fs.copyFileSync(filePath, backupPath)
        logger.info(`Created backup at: ${backupPath}`)

        return backupPath
    } catch (error: any) {
        logger.error(`Failed to create backup: ${error.message}`)
        throw error
    }
}

/**
 * Load data from CSV file
 */
export function loadCsvData<T>(filePath: string): T[] {
    try {
        if (!fs.existsSync(filePath)) {
            logger.warn(`File does not exist: ${filePath}`)
            return []
        }

        const fileData = fs.readFileSync(filePath, "utf8")
        const { data } = Papa.parse<T>(fileData, { header: true })

        logger.info(`Loaded ${data.length} records from ${filePath}`)
        return data
    } catch (error: any) {
        logger.error(`Failed to load CSV data: ${error.message}`)
        throw error
    }
}

/**
 * Save data to CSV file
 */
export function saveCsvData<T>(filePath: string, data: T[]): void {
    try {
        // Convert to CSV
        const csv = Papa.unparse(data)

        // Save to file
        fs.writeFileSync(filePath, csv)
        logger.info(`Saved ${data.length} records to ${filePath}`)
    } catch (error: any) {
        logger.error(`Failed to save CSV data: ${error.message}`)
        throw error
    }
}

/**
 * Create a map from array for quick lookups
 */
export function createLookupMap<T>(array: T[], keyField: keyof T): Map<string, T> {
    const map = new Map<string, T>()

    array.forEach((item) => {
        const key = item[keyField]
        if (key && typeof key === "string") {
            map.set(key, item)
        }
    })

    return map
}

