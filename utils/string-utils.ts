/**
 * Extract domain from URL
 */
export function extractDomainFromUrl(url: string): string | null {
    try {
        // Add protocol if missing
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "https://" + url
        }

        const urlObj = new URL(url)
        // Remove 'www.' prefix if present
        return urlObj.hostname.replace(/^www\./, "")
    } catch (error) {
        return null
    }
}

/**
 * Normalize company name
 */
export function normalizeCompanyName(name: string): string {
    // Convert to lowercase
    let normalized = name.toLowerCase()

    // Remove common TLDs
    normalized = normalized.replace(/\.(com|org|net|io|ai)$/, "")

    // Replace hyphens and underscores with spaces
    normalized = normalized.replace(/[-_]/g, " ")

    // Capitalize first letter of each word
    normalized = normalized.replace(/\b\w/g, (c) => c.toUpperCase())

    // Handle common abbreviations and special cases
    const specialCases: Record<string, string> = {
        Api: "API",
        Ai: "AI",
        Ml: "ML",
        Nlp: "NLP",
        Aws: "AWS",
        Ibm: "IBM",
        Hp: "HP",
        Sap: "SAP",
    }

    // Apply special cases
    Object.entries(specialCases).forEach(([key, value]) => {
        const regex = new RegExp(`\\b${key}\\b`, "g")
        normalized = normalized.replace(regex, value)
    })

    // Remove common words like "Inc", "LLC", etc.
    normalized = normalized.replace(/\b(Inc|LLC|Ltd|Corp|Corporation|Company)\b/g, "").trim()

    return normalized
}

/**
 * Generate a unique ID
 */
export function generateUniqueId(prefix = ""): string {
    return `${prefix}${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
}

