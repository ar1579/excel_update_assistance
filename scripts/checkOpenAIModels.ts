import { OpenAI } from "openai";
import dotenv from "dotenv";

// Load environment variables from .env
dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

async function listAvailableModels() {
    try {
        console.log("Fetching available models...");

        // Call OpenAI API to retrieve model list
        const response = await openai.models.list();

        if (!response.data || response.data.length === 0) {
            console.log("No models found for this API key.");
            return;
        }

        console.log("\n✅ Available OpenAI Models:");
        response.data.forEach((model) => {
            console.log(`- ${model.id}`);
        });

    } catch (error: any) {
        if (error.response) {
            console.error(`❌ OpenAI API Error: ${error.response.status} - ${error.response.data}`);
        } else {
            console.error(`❌ Error: ${error.message}`);
        }
    }
}

// Run the function
listAvailableModels();
