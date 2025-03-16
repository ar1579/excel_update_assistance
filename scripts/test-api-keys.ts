import { OpenAI } from "openai"
import dotenv from "dotenv"
import fs from "fs"
import path from "path"

// Load environment variables
dotenv.config()

// Create logs directory if it doesn't exist
const logsDir = path.join(process.cwd(), "logs")
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true })
}

// Log file path
const LOG_FILE_PATH = path.join(logsDir, `api_test_${new Date().toISOString().replace(/:/g, "-")}.txt`)

// Helper function to log messages
function log(message: string) {
    const timestamp = new Date().toISOString()
    const logMessage = `[${timestamp}] ${message}`
    console.log(logMessage)
    fs.appendFileSync(LOG_FILE_PATH, logMessage + "\n")
}

async function testOpenAIConnection() {
    log("Testing OpenAI API connection...")

    // Check if API key exists
    if (!process.env.OPENAI_API_KEY) {
        log("❌ ERROR: OPENAI_API_KEY not found in environment variables.")
        log("Please make sure you have created a .env file with your OpenAI API key.")
        return
    }

    try {
        // Initialize OpenAI client
        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        })

        // Test API connection with a simple request
        log("Sending test request to OpenAI API...")
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "user",
                    content: "Hello, this is a test message. Please respond with 'OpenAI API is working correctly.'",
                },
            ],
            max_tokens: 20,
        })

        // Check response
        const content = response.choices[0]?.message?.content || ""
        log(`Response received: "${content}"`)

        if (content.includes("working")) {
            log("✅ SUCCESS: OpenAI API connection is working correctly!")
            log("Model: " + response.model)
            log("Completion tokens: " + response.usage?.completion_tokens)
            log("Prompt tokens: " + response.usage?.prompt_tokens)
            log("Total tokens: " + response.usage?.total_tokens)
        } else {
            log("⚠️ WARNING: Received unexpected response from OpenAI API.")
            log("The API is connected, but the response was not as expected.")
        }
    } catch (error: any) {
        log(`❌ ERROR: Failed to connect to OpenAI API: ${error.message || "Unknown error"}`)

        // Check for specific error types
        if (error.message && typeof error.message === "string") {
            if (error.message.includes("401")) {
                log("This usually indicates an invalid API key. Please check your API key and try again.")
            } else if (error.message.includes("429")) {
                log("You have exceeded your API rate limit or quota. Please check your OpenAI account.")
            } else if (error.message.includes("timeout")) {
                log("The request timed out. This could be due to network issues or high server load.")
            }
        }

        log("Full error details:")
        log(JSON.stringify(error, null, 2))
    }

    log("Test completed. Log saved to: " + LOG_FILE_PATH)
}

// Run the test
testOpenAIConnection().catch((error: any) => {
    log(`Unhandled error: ${error.message || "Unknown error"}`)
    process.exit(1)
})

