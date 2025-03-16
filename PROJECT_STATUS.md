# CSV Updater Project Status

## Project Overview
This project provides scripts to update CSV files using the OpenAI API. It reads data from CSV files, generates content using AI, and updates the files with the generated content. Additionally, the project includes Git versioning to track changes and maintain an organized development workflow.

The project is structured with a clear separation of concerns:
- **Common scripts** for reusable functionality (to be developed).
- **CSV-specific processors** to handle different CSV structures (to be developed).
- **Planned automation processes** for streamlined development.

## Current Project Structure

```
project-root/
├── data/                  # Contains CSV files to be processed
│   ├── AI Hierarchical Categorization System.csv
│   ├── API.csv
│   ├── Benchmarks.csv
│   └── [other CSV files]
├── logs/                  # Contains log files from script executions
├── scripts/               # Contains all script files
│   ├── common/            # (Empty) Placeholder for shared script functionality
│   ├── csv-processors/    # (Empty) Placeholder for CSV-specific processors
│   ├── test-api-keys.ts   # Tests API key connections
│   ├── test-csv-read.ts   # Tests CSV file reading
│   ├── test-openai-connection.ts # Tests OpenAI API connection
│   └── update-csv.ts      # Hardcoded for AI Hierarchical Categorization System.csv
├── utils/                 # Utility functions used across scripts
│   ├── error-handler.ts   # Error handling utilities
│   ├── file-utils.ts      # File operation utilities
│   ├── index.ts           # Exports all utilities
│   ├── logging.ts         # Logging utilities
│   └── rate-limiter.ts    # Rate limiting for API calls
├── .env                   # Environment variables (API keys)
├── package.json           # Project dependencies and scripts
├── package-lock.json      # Lock file for dependencies
├── tsconfig.json          # TypeScript configuration
└── .git/                  # Git versioning setup
```

## Key Components

### Scripts
- **test-api-keys.ts**: Tests the connection to OpenAI API using the provided API key.
- **test-csv-read.ts**: Reads and parses CSV files.
- **test-openai-connection.ts**: Sends a request to OpenAI API to verify connection.
- **update-csv.ts**: Hardcoded to update the "AI Hierarchical Categorization System.csv" file.

### Utilities
- **error-handler.ts**: Provides functions for error management.
- **file-utils.ts**: Handles reading/writing CSV files and creating backups.
- **logging.ts**: Provides logging to console and log files.
- **rate-limiter.ts**: Manages API request frequency to prevent exceeding quotas.

### Dependencies
```
npm list
excel-updater@1.0.0 cd ""
├── @types/node@20.17.24
├── @types/papaparse@5.3.15
├── dotenv@16.4.7
├── openai@4.86.2
├── papaparse@5.5.2
├── ts-node@10.9.2
└── typescript@5.8.2
```

### Data Files
The project processes multiple CSV files, each requiring a unique processing script:
- AI Hierarchical Categorization System.csv
- API.csv
- Benchmarks.csv
- Community.csv
- Companies.csv
- Documentation.csv
- Ethics.csv
- Features.csv
- Licenses.csv
- Market.csv
- Models.csv
- Performance.csv
- Platforms.csv
- Pricing.csv
- Security_and_Compliance.csv
- Support.csv
- Technical_Specifications.csv
- Training.csv
- Trials.csv
- Use_Cases.csv
- Versioning.csv

## Next Steps
### **Develop Specialized Processors for Each CSV File**
The `scripts/csv-processors/` folder will contain scripts specifically tailored to process each CSV file. Each processor will:
1. Define the specific columns to update.
2. Implement custom prompt engineering for that file's domain.
3. Include validation logic specific to that data type.
4. Handle any special cases or requirements unique to that file.

**Examples of planned processor scripts:**
- **process-api.ts** - Processes API.csv with API-specific prompts.
- **process-benchmarks.ts** - Processes Benchmarks.csv with performance metrics prompts.
- **process-platforms.ts** - Processes Platforms.csv with platform-specific prompts.

### **Develop Common Utility Scripts**
The `scripts/common/` folder will contain reusable utilities used by multiple processors. Planned scripts include:
1. **api-client.ts** - A wrapper for OpenAI API calls with error handling and retries.
2. **csv-base-processor.ts** - Base class or functions for CSV processing operations.
3. **prompt-templates.ts** - Reusable prompt templates for different types of AI content generation.
4. **validation.ts** - Functions to validate generated content against expected formats.
5. **batch-processor.ts** - Functions to process files in batches with progress tracking.

### Additional Next Steps
6. Set up **automated commit processes and dependency verification**.
7. Enhance error handling and implement **progress tracking**.
8. Ensure thorough **documentation** for each script and utility.

## Recent Changes
- ✅ Set up **Git versioning** for tracking changes.
- ✅ Verified that **all dependencies are up to date**.
- ✅ Ensured **correct organization of data, scripts, and utilities**.
- ✅ Created **specialized script folders** (`common/`, `csv-processors/`)—currently empty and ready for development.

The project is now ready for **full implementation of the CSV processors** and **scalable automation**. Further steps will focus on refining individual CSV update scripts and integrating API-based enrichment seamlessly.


# What Each Script that is currently in this project is used for; Each answer accurately describes the purpose and functionality of the respective files in this project

    - **Is the current version of the 'update_csv.ts' file specifically for updating the 'Hierarchical Categorization System.csv' file?**
    	- Yes, the current version is hardcoded to update the "AI Hierarchical Categorization System.csv" file, generating content for columns C through J based on values in columns A and B.
    - **What specifically does the 'test-api-keys.ts' file do?**
	    - It tests the OpenAI API key by making a simple API call and verifying the response, providing detailed feedback on whether the key is valid and working correctly.
    - **What specifically does the 'test-csv-read.ts' file do?**
	    - The test-csv-read.ts file is hardcoded to read only one specific CSV file: "AI Hierarchical Categorization System.csv". It's not designed to read all CSV files in the data directory. It has a constant `CSV_FILE_PATH` that points specifically to this file..
    - **What specifically does the 'test-openai-connection.ts' file do?**
    	- It tests the OpenAI API connection by sending a simple request and verifying the response, with detailed logging of success or failure.
    - **What specifically does the 'error-handler.ts' file do?**
	    - It provides utility functions for handling errors, including a wrapper for async functions with error handling and functions to extract meaningful error messages.
    - **What specifically does the 'file-utils.ts' file do?**
	    - It provides utilities for file operations, including creating backups, reading/writing CSV files, and ensuring directories exist.
    - **What specifically does the 'index.ts' file do?**
	    - It exports all utility functions from the other utility files, providing a single import point for accessing all utilities.
    - **What specifically does the 'logging.ts' file do?**
	    - It provides a logging system that writes messages to both the console and log files, with support for different log levels (info, success, warning, error).
    - **What specifically does the 'rate-limiter.ts' file do?**
	    - The rate-limiter.ts file provides utilities to control API request frequency and prevent exceeding rate limits. It exports two key functions: `createRateLimiter()` which tracks request timestamps and enforces waiting periods when necessary, and `sleep()` which adds configurable delays between operations. Its objective is to manage API call pacing to avoid throttling or quota exhaustion when making multiple requests to external services.
    - **What specifically is the 'AI Hierarchical Categorization System.csv'?**
	    - It's a CSV file containing a 10-level hierarchical categorization of AI technologies. Each row represents a categorization path from broad (Level 1: Main Categories like "Robotics & Automation") to specific (Level 10: Technical Implementation like "Real-time Image Processing with Neural Networks"). The update-csv.ts script was designed and used to generate content for levels 3-10 based on the values in levels 1-2.

# Brief Description of CSV Files

## API.csv
**Purpose:** This file stores API-related information for AI platforms, including standards, authentication methods, and integration capabilities.
**Current Contents:** The file contains platform names (e.g., "Zyro AI") as foreign keys with empty fields for API standards, authentication methods, webhook support, third-party integrations, export formats, and import capabilities.

## Benchmarks.csv
**Purpose:** This file stores performance benchmark data for AI platforms to enable comparative analysis.
**Current Contents:** The file has an empty schema and likely contains minimal data. It is structured to track benchmark results for different AI platforms.

## Community.csv
**Purpose:** Stores community engagement and resources around AI platforms.
**Current Content:** Contains platform names with empty fields for community size, engagement scores, user ratings, GitHub repositories, Stack Overflow tags, academic papers, and case studies. The structure is designed to assess the ecosystem and support around each platform. 

## Companies.csv
**Purpose:** Stores information about companies that develop AI platforms.
**Current Content:** The schema is empty, suggesting this is a placeholder file that hasn't been fully defined yet. It would typically contain company names, locations, founding dates, and other company-specific information.

## Documentation.csv
**Purpose:** Stores documentation resources and learning materials for AI platforms.
**Current Content:** Contains platform names with empty fields for documentation quality, URLs (documentation, FAQ, forum), code example availability, supported programming languages, video tutorial availability, and learning curve ratings. The structure is ready for comprehensive documentation tracking.

## Ethics.csv
**Purpose:** Stores ethical considerations and frameworks for AI platforms.
**Current Content:** The schema is empty, suggesting this is a placeholder file that hasn't been fully defined yet. It may be intended to track ethical guidelines, compliance information, or responsible AI practices.

## Features.csv
**Purpose:** Stores information about AI platform features and capabilities.
**Current Content:** Contains platform names (e.g., "Zyro AI") with empty fields for notable features, explainability features, customization options, and bias mitigation approaches. The file has a structure ready for documenting platform-specific features but currently lacks populated data in most columns.

## Licenses.csv
**Purpose:** This file stores licensing information for AI platforms, including license types and open-source status.
**Current Contents:** The file contains platform names as foreign keys with empty fields for license type, open-source status, license name, license URL, and expiration date.

## Market.csv
**Purpose:** This file stores market-related information for AI platforms, including adoption metrics and competitive positioning.
**Current Contents:** The file contains platform names as foreign keys with empty fields for user count, adoption rate, industry penetration, customer profiles, success stories, competitors, advantages, market share, analyst ratings, and industry awards.

## Models.csv
**Purpose:** This file stores detailed information about AI models associated with each platform.
**Current Contents:** The file contains platform names as foreign keys with empty fields for model family, version, variants, size, type, architecture, parameter count, context window size, and token limits.

## Performance.csv
**Purpose:** This file stores performance metrics and capabilities of AI platforms.
**Current Contents:** The file has an empty schema and likely contains minimal data. It is structured to track performance metrics for different AI platforms.

## Platforms.csv
**Purpose:** This file stores core information about AI platforms and serves as the central reference for platform details.
**Current Contents:** The file contains platform names as primary keys, some platform URLs, and empty fields for company name, platform category, sub-category, description, launch date, status, availability, API availability, and integration options.


    