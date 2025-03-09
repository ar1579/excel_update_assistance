import fs from "fs"
import path from "path"
import Papa from "papaparse"

/**
 * Creates a backup of a file
 * @param filePath Path to the file to backup
 * @returns Path to the backup file
 */
export function createBackup(filePath: string): string {
    const timestamp = new Date().toISOString().replace(/:/g, "-")
    const fileExt = path.extname(filePath)
    const fileName = path.basename(filePath, fileExt)
    const dirName = path.dirname(filePath)

    const backupPath = path.join(dirName, `${fileName}_backup_${timestamp}${fileExt}`)

    fs.copyFileSync(filePath, backupPath)
    return backupPath
}

/**
 * Interface for CSV records
 */
export interface CsvRecord {
    [key: string]: string
}

/**
 * Reads a CSV file and returns the parsed data
 * @param filePath Path to the CSV file
 * @returns Parsed CSV data and headers
 */
export function readCsvFile(filePath: string) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`)
    }

    const fileContent = fs.readFileSync(filePath, "utf8")
    const parseResult = Papa.parse<CsvRecord>(fileContent, {
        header: true,
        skipEmptyLines: true,
    })

    return {
        records: parseResult.data,
        headers: parseResult.meta.fields || [],
    }
}

/**
 * Writes data to a CSV file
 * @param filePath Path to the CSV file
 * @param records Array of records to write
 * @param headers Array of column headers
 */
export function writeCsvFile(filePath: string, records: CsvRecord[], headers: string[]) {
    const csv = Papa.unparse(records, {
        header: true,
        columns: headers,
    })

    fs.writeFileSync(filePath, csv)
    return filePath
}

/**
 * Ensures a directory exists, creating it if necessary
 * @param dirPath Path to the directory
 */
export function ensureDirectoryExists(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true })
    }
    return dirPath
}

