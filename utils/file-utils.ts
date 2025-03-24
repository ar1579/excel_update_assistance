import fs from 'fs'
import path from 'path'
import Papa from 'papaparse'
import { createLogger } from './logging'

// Create a logger for this module
const logger = createLogger('file-utils')

/**
 * Load CSV data from a file
 */
export function loadCsvData<T>(filePath: string): T[] {
    try {
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            logger.warning(`File not found: ${filePath}`)
            return []
        }

        // Read file content
        const fileContent = fs.readFileSync(filePath, 'utf8')

        // Parse CSV
        const result = Papa.parse<T>(fileContent, {
            header: true,
            skipEmptyLines: true,
        })

        logger.info(`Loaded ${result.data.length} records from ${filePath}`)
        return result.data
    } catch (error: any) {
        logger.error(`Error loading CSV data from ${filePath}: ${error.message}`)
        return []
    }
}

/**
 * Save data to a CSV file
 */
export function saveCsvData<T>(filePath: string, data: T[]): boolean {
    try {
        // Create directory if it doesn't exist
        const dir = path.dirname(filePath)
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true })
        }

        // Convert data to CSV
        const csv = Papa.unparse(data)

        // Write to file
        fs.writeFileSync(filePath, csv, 'utf8')

        logger.info(`Saved ${data.length} records to ${filePath}`)
        return true
    } catch (error: any) {
        logger.error(`Error saving CSV data to ${filePath}: ${error.message}`)
        return false
    }
}

/**
 * Create a backup of a file
 */
export function createBackup(filePath: string, backupDir: string): string | null {
    try {
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            logger.warning(`Cannot create backup: File not found: ${filePath}`)
            return null
        }

        // Create backup directory if it doesn't exist
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true })
        }

        // Generate backup file name with timestamp
        const fileName = path.basename(filePath)
        const timestamp = new Date().toISOString().replace(/:/g, '-')
        const backupFileName = `${fileName.replace('.csv', '')}_backup_${timestamp}.csv`
        const backupFilePath = path.join(backupDir, backupFileName)

        // Copy file to backup location
        fs.copyFileSync(filePath, backupFilePath)

        logger.info(`Created backup: ${backupFilePath}`)
        return backupFilePath
    } catch (error: any) {
        logger.error(`Error creating backup of ${filePath}: ${error.message}`)
        return null
    }
}

/**
 * Create a lookup map from an array of objects
 */
export function createLookupMap<T>(data: T[], keyField: keyof T): Map<string, T> {
    const map = new Map<string, T>()

    for (const item of data) {
        const key = String(item[keyField])
        map.set(key, item)
    }

    return map
}