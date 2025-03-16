import { OpenAI } from "openai"
import { createLogger } from "./logging"

const logger = createLogger("openai-utils")

// Primary and fallback models
const PRIMARY_MODEL = "gpt-4o"
const FALLBACK_MODEL = "gpt-3.5-turbo"

// Initialize OpenAI client
export function initializeOpenAI(apiKey: string): OpenAI {
    return new OpenAI({
        apiKey: apiKey,
    })
}

// Function to make OpenAI API calls with fallback
export async function makeOpenAIRequest<T>(
    openai: OpenAI,
    prompt: string,
    systemPrompt = "You are a helpful assistant that provides accurate information in JSON format. Only return the JSON object with no additional text.",
    temperature = 0.3,
    maxRetries = 3,
): Promise<T> {
    let retries = 0
    let currentModel = PRIMARY_MODEL

    while (retries < maxRetries) {
        try {
            logger.info(`Making OpenAI request using model: ${currentModel}`)

            const response = await openai.chat.completions.create({
                model: currentModel,
                messages: [
                    {
                        role: "system",
                        content: systemPrompt,
                    },
                    { role: "user", content: prompt },
                ],
                temperature: temperature,
            })

            const content = response.choices[0]?.message?.content || "{}"

            // Extract JSON from response
            const jsonMatch = content.match(/\{[\s\S]*\}/)
            if (!jsonMatch) {
                throw new Error("Failed to parse JSON from OpenAI response")
            }

            logger.info(`Successfully received response from model: ${currentModel}`)
            return JSON.parse(jsonMatch[0]) as T
        } catch (error: any) {
            retries++

            // Log the error
            logger.error(`Error with model ${currentModel} (attempt ${retries}/${maxRetries}): ${error.message}`)

            // Switch to fallback model if using primary model
            if (currentModel === PRIMARY_MODEL) {
                logger.warn(`Switching to fallback model: ${FALLBACK_MODEL}`)
                currentModel = FALLBACK_MODEL
            } else if (retries < maxRetries) {
                // If already using fallback model, wait before retrying
                const waitTime = 2000 * retries // Exponential backoff
                logger.info(`Waiting ${waitTime}ms before retrying...`)
                await new Promise((resolve) => setTimeout(resolve, waitTime))
            }

            // If all retries are exhausted, throw the error
            if (retries >= maxRetries) {
                throw new Error(`Failed to get response after ${maxRetries} attempts: ${error.message}`)
            }
        }
    }

    // This should never be reached due to the throw in the loop
    throw new Error("Unexpected error in makeOpenAIRequest")
}

// Rate limiting function
export async function applyRateLimit(delayMs: number): Promise<void> {
    logger.info(`Applying rate limit: waiting ${delayMs}ms before next request...`)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
}

