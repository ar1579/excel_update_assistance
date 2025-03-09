/**
 * Wraps an async function with error handling
 * @param fn The async function to wrap
 * @param errorHandler Function to handle errors
 * @returns The wrapped function
 */
export function withErrorHandling<T, Args extends any[]>(
    fn: (...args: Args) => Promise<T>,
    errorHandler: (error: any) => void,
) {
    return async (...args: Args): Promise<T | undefined> => {
        try {
            return await fn(...args)
        } catch (error: any) {
            errorHandler(error)
            return undefined
        }
    }
}

/**
 * Extracts a meaningful error message from various error types
 * @param error The error object
 * @returns A string error message
 */
export function getErrorMessage(error: any): string {
    if (!error) {
        return "Unknown error occurred"
    }

    if (typeof error === "string") {
        return error
    }

    if (error.message && typeof error.message === "string") {
        return error.message
    }

    if (error.error && typeof error.error === "string") {
        return error.error
    }

    return JSON.stringify(error)
}

/**
 * Checks if an error is of a specific type based on its message
 * @param error The error object
 * @param errorType String that should be included in the error message
 * @returns Boolean indicating if the error is of the specified type
 */
export function isErrorType(error: any, errorType: string): boolean {
    const message = getErrorMessage(error)
    return message.toLowerCase().includes(errorType.toLowerCase())
}

