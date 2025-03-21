import fs from "fs"
import path from "path"
import Papa from "papaparse"

// Define the root directory and data directory
const ROOT_DIR = process.cwd()
const DATA_DIR = path.join(ROOT_DIR, "data")

// Ensure the data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    console.log(`Created directory: ${DATA_DIR}`)
}

// Define the structure for each table
interface TableDefinition {
    name: string
    primaryKey: string
    foreignKeys: string[]
    additionalFields: string[]
    constraints: string[]
    description: string
}

// Define the structure for join tables
interface JoinTableDefinition {
    name: string
    primaryKeys: string[]
    description: string
}

// Define all 20 main tables with their fields exactly as in the master documents
const tables: TableDefinition[] = [
    {
        name: "Companies",
        description: "Stores information about companies that develop AI platforms",
        primaryKey: "company_id",
        foreignKeys: [],
        additionalFields: [
            "company_name",
            "company_hq_location",
            "company_year_founded",
            "company_size",
            "company_contact_information",
            "company_industry",
            "company_website_url",
            "company_linkedin_url",
            "company_twitter_url",
            "company_funding_stage",
            "company_annual_revenue",
            "createdAt",
            "updatedAt",
        ],
        constraints: [
            "NOT NULL: company_name",
            "UNIQUE: company_name",
            "CHECK: company_size IN ('Startup', 'Small', 'Medium', 'Large', 'Enterprise')",
        ],
    },
    {
        name: "Platforms",
        description: "Core table storing AI platform details",
        primaryKey: "platform_id",
        foreignKeys: ["company_id"],
        additionalFields: [
            "platform_name",
            "platform_url",
            "platform_category",
            "platform_sub_category",
            "platform_description",
            "platform_launch_date",
            "platform_status",
            "platform_availability",
            "api_availability",
            "integration_options",
            "createdAt",
            "updatedAt",
        ],
        constraints: [
            "NOT NULL: platform_name, platform_category",
            "UNIQUE: platform_name",
            "CHECK: platform_status IN ('Active', 'Beta', 'Discontinued')",
        ],
    },
    {
        name: "Models",
        description: "Stores information about AI models associated with platforms",
        primaryKey: "model_id",
        foreignKeys: ["platform_id"],
        additionalFields: [
            "model_family",
            "model_version",
            "model_variants",
            "model_size",
            "model_size_unit",
            "model_type",
            "model_architecture",
            "parameters_count",
            "context_window_size",
            "token_limit",
            "createdAt",
            "updatedAt",
        ],
        constraints: [
            "NOT NULL: model_family, model_version",
            "UNIQUE: model_family, model_version, platform_id",
            "CHECK: model_size_unit IN ('KB', 'MB', 'GB', 'TB')",
        ],
    },
    {
        name: "Technical_Specifications",
        description: "Tracks technical specifications of AI platforms and models",
        primaryKey: "spec_id",
        foreignKeys: ["model_id"],
        additionalFields: [
            "input_types",
            "output_types",
            "supported_languages",
            "hardware_requirements",
            "gpu_acceleration",
            "latency",
            "inference_time",
            "training_time",
            "compatible_frameworks",
            "minimum_requirements",
            "optimal_requirements",
            "dependency_information",
            "createdAt",
            "updatedAt",
        ],
        constraints: ["NOT NULL: model_id"],
    },
    {
        name: "Pricing",
        description: "Contains pricing models and cost information",
        primaryKey: "pricing_id",
        foreignKeys: ["platform_id"],
        additionalFields: [
            "pricing_model",
            "starting_price",
            "enterprise_pricing",
            "billing_frequency",
            "custom_pricing_available",
            "pricing_url",
            "discount_options",
            "createdAt",
            "updatedAt",
        ],
        constraints: ["CHECK: pricing_model IN ('Subscription', 'One-Time', 'Usage-Based', 'Free')"],
    },
    {
        name: "Trials",
        description: "Stores free trial details",
        primaryKey: "trial_id",
        foreignKeys: ["platform_id"],
        additionalFields: [
            "free_trial_plan",
            "trial_duration",
            "trial_duration_unit",
            "usage_limits",
            "createdAt",
            "updatedAt",
        ],
        constraints: ["CHECK: trial_duration_unit IN ('Day', 'Week', 'Month', 'Year')"],
    },
    {
        name: "Licenses",
        description: "Stores licensing information, including open-source status",
        primaryKey: "license_id",
        foreignKeys: ["platform_id"],
        additionalFields: [
            "license_type",
            "open_source_status",
            "license_name",
            "license_url",
            "license_expiration_date",
            "createdAt",
            "updatedAt",
        ],
        constraints: ["CHECK: license_type IN ('Open-source', 'Proprietary', 'Creative Commons', 'Other')"],
    },
    {
        name: "Performance",
        description: "Captures performance metrics of AI platforms",
        primaryKey: "performance_id",
        foreignKeys: ["model_id"],
        additionalFields: [
            "performance_metrics",
            "performance_score",
            "accuracy_metrics",
            "precision_metrics",
            "recall_metrics",
            "f1_score",
            "createdAt",
            "updatedAt",
        ],
        constraints: ["NOT NULL: model_id"],
    },
    {
        name: "Benchmarks",
        description: "Stores benchmark test results",
        primaryKey: "benchmark_id",
        foreignKeys: ["model_id"],
        additionalFields: ["benchmark_name", "benchmark_score", "benchmark_details", "createdAt", "updatedAt"],
        constraints: ["NOT NULL: model_id"],
    },
    {
        name: "Training",
        description: "Tracks training dataset sizes and methodology",
        primaryKey: "training_id",
        foreignKeys: ["model_id"],
        additionalFields: [
            "training_data_size",
            "training_data_notes",
            "training_methodology",
            "fine_tuning_supported",
            "transfer_learning_supported",
            "fine_tuning_performance",
            "createdAt",
            "updatedAt",
        ],
        constraints: ["NOT NULL: model_id"],
    },
    {
        name: "Use_Cases",
        description: "Documents use cases and application areas",
        primaryKey: "use_case_id",
        foreignKeys: ["model_id"],
        additionalFields: [
            "primary_use_case",
            "secondary_use_cases",
            "specialized_domains",
            "supported_tasks",
            "limitations",
            "typical_use_cases",
            "createdAt",
            "updatedAt",
        ],
        constraints: ["NOT NULL: model_id, primary_use_case"],
    },
    {
        name: "Features",
        description: "Stores key features of AI platforms",
        primaryKey: "feature_id",
        foreignKeys: ["platform_id"],
        additionalFields: [
            "notable_features",
            "explainability_features",
            "customization_options",
            "bias_mitigation_approaches",
            "createdAt",
            "updatedAt",
        ],
        constraints: ["NOT NULL: notable_features"],
    },
    {
        name: "Security_and_Compliance",
        description: "Records security certifications and compliance standards",
        primaryKey: "security_id",
        foreignKeys: ["platform_id"],
        additionalFields: [
            "security_certifications",
            "compliance_standards",
            "gdpr_compliance",
            "hipaa_compliance",
            "iso_certifications",
            "data_retention_policies",
            "data_processing_location",
            "privacy_features",
            "security_incidents_history",
            "audit_capabilities",
            "access_control_features",
            "createdAt",
            "updatedAt",
        ],
        constraints: ["NOT NULL: security_certifications"],
    },
    {
        name: "Support",
        description: "Captures customer support options available",
        primaryKey: "support_id",
        foreignKeys: ["platform_id"],
        additionalFields: [
            "support_options",
            "sla_available",
            "support_channels",
            "support_hours",
            "enterprise_support",
            "training_options",
            "consulting_services",
            "implementation_support",
            "response_time_guarantees",
            "createdAt",
            "updatedAt",
        ],
        constraints: [],
    },
    {
        name: "Documentation",
        description: "Tracks documentation resources and learning materials",
        primaryKey: "doc_id",
        foreignKeys: ["platform_id"],
        additionalFields: [
            "documentation_description",
            "doc_quality",
            "documentation_url",
            "faq_url",
            "forum_url",
            "example_code_available",
            "example_code_languages",
            "video_tutorials_available",
            "learning_curve_rating",
            "createdAt",
            "updatedAt",
        ],
        constraints: [],
    },
    {
        name: "Versioning",
        description: "Maintains version history and update details",
        primaryKey: "version_id",
        foreignKeys: ["platform_id"],
        additionalFields: [
            "release_date",
            "last_updated",
            "maintenance_status",
            "deprecation_date",
            "update_frequency",
            "changelog_url",
            "version_numbering_scheme",
            "backward_compatibility_notes",
            "known_issues",
            "createdAt",
            "updatedAt",
        ],
        constraints: [],
    },
    {
        name: "Community",
        description: "Tracks engagement and community support for AI platforms",
        primaryKey: "community_id",
        foreignKeys: ["platform_id"],
        additionalFields: [
            "community_size",
            "community_engagement_score",
            "user_rating",
            "github_repository",
            "stackoverflow_tags",
            "academic_papers",
            "case_studies",
            "createdAt",
            "updatedAt",
        ],
        constraints: [],
    },
    {
        name: "Ethics",
        description: "Stores ethical considerations and AI fairness metrics",
        primaryKey: "ethics_id",
        foreignKeys: ["model_id"],
        additionalFields: [
            "ethical_guidelines_url",
            "bias_evaluation",
            "fairness_metrics",
            "transparency_score",
            "environmental_impact",
            "createdAt",
            "updatedAt",
        ],
        constraints: [],
    },
    {
        name: "API",
        description: "Documents API specifications, authentication methods, and integrations",
        primaryKey: "api_id",
        foreignKeys: ["platform_id"],
        additionalFields: [
            "api_standards",
            "authentication_methods",
            "webhook_support",
            "third_party_integrations",
            "export_formats",
            "import_capabilities",
            "createdAt",
            "updatedAt",
        ],
        constraints: [],
    },
    {
        name: "Market",
        description: "Stores market-related information, including user adoption rates",
        primaryKey: "market_id",
        foreignKeys: ["platform_id"],
        additionalFields: [
            "user_count",
            "adoption_rate",
            "industry_penetration",
            "typical_customer_profile",
            "success_stories",
            "direct_competitors",
            "competitive_advantages",
            "market_share",
            "analyst_ratings",
            "industry_awards",
            "createdAt",
            "updatedAt",
        ],
        constraints: [],
    },
]

// Define the 6 many-to-many join tables
const joinTables: JoinTableDefinition[] = [
    {
        name: "platform_features",
        description: "Join table for the many-to-many relationship between Platforms and Features",
        primaryKeys: ["platform_id", "feature_id"],
    },
    {
        name: "platform_licenses",
        description: "Join table for the many-to-many relationship between Platforms and Licenses",
        primaryKeys: ["platform_id", "license_id"],
    },
    {
        name: "platform_certifications",
        description: "Join table for the many-to-many relationship between Platforms and Security Certifications",
        primaryKeys: ["platform_id", "security_id"],
    },
    {
        name: "model_benchmarks",
        description: "Join table for the many-to-many relationship between Models and Benchmarks",
        primaryKeys: ["model_id", "benchmark_id"],
    },
    {
        name: "model_use_cases",
        description: "Join table for the many-to-many relationship between Models and Use Cases",
        primaryKeys: ["model_id", "use_case_id"],
    },
    {
        name: "api_integrations",
        description: "Join table for the many-to-many relationship between API and Third-Party Integrations",
        primaryKeys: ["api_id", "integration_id"],
    },
]

// Function to create a CSV file for a main table
function createMainTableCsvFile(table: TableDefinition): void {
    // Combine all fields in the correct order: primary key, foreign keys, additional fields
    const allFields = [table.primaryKey, ...table.foreignKeys, ...table.additionalFields]

    // Create an empty row with just the headers
    const csvData = Papa.unparse({
        fields: allFields,
        data: [],
    })

    const filePath = path.join(DATA_DIR, `${table.name}.csv`)
    fs.writeFileSync(filePath, csvData)
    console.log(`Created CSV file: ${filePath}`)
}

// Function to create a CSV file for a join table
function createJoinTableCsvFile(table: JoinTableDefinition): void {
    // Join tables have composite primary keys and timestamps
    const allFields = [...table.primaryKeys, "createdAt", "updatedAt"]

    // Create an empty row with just the headers
    const csvData = Papa.unparse({
        fields: allFields,
        data: [],
    })

    const filePath = path.join(DATA_DIR, `${table.name}.csv`)

    // Log the file path to verify it's correct
    console.log(`Creating join table CSV file: ${filePath}`)

    // Force write the file
    fs.writeFileSync(filePath, csvData)
    console.log(`Created CSV file: ${filePath}`)
}

// Create CSV files for all main tables
console.log("Starting CSV generation for main tables...")
tables.forEach((table) => {
    createMainTableCsvFile(table)
})
console.log("Main tables CSV generation completed!")

// Create CSV files for all join tables
console.log("Starting CSV generation for join tables...")
joinTables.forEach((table) => {
    console.log(`Processing join table: ${table.name}`)
    createJoinTableCsvFile(table)
})
console.log("Join tables CSV generation completed!")

// Create a README file with table descriptions
const mainTablesReadmeContent = tables
    .map((table) => {
        const allFields = [
            `- ${table.primaryKey} (Primary Key)`,
            ...table.foreignKeys.map((fk) => `- ${fk} (Foreign Key)`),
            ...table.additionalFields.map((field) => `- ${field}`),
        ]

        const constraintsSection =
            table.constraints.length > 0 ? `\nConstraints:\n${table.constraints.map((c) => `- ${c}`).join("\n")}` : ""

        return `## ${table.name}
${table.description}

Fields:
${allFields.join("\n")}${constraintsSection}
`
    })
    .join("\n---\n\n")

const joinTablesReadmeContent = joinTables
    .map((table) => {
        const allFields = [...table.primaryKeys.map((pk) => `- ${pk} (Primary Key)`), `- createdAt`, `- updatedAt`]

        return `## ${table.name}
${table.description}

Fields:
${allFields.join("\n")}
`
    })
    .join("\n---\n\n")

const readmePath = path.join(DATA_DIR, "README.md")
fs.writeFileSync(
    readmePath,
    `# AI Toolkit Database Tables

This directory contains CSV files for all tables in the AI Toolkit database.

## Main Tables

${mainTablesReadmeContent}

## Join Tables (Many-to-Many Relationships)

${joinTablesReadmeContent}`,
)
console.log(`Created README file: ${readmePath}`)

// Create a schema overview file that matches the provided format
const schemaOverviewContent = `# AI Toolkit Database Schema Overview

## Main Tables

| **Table Name**                | **Primary Key** | **Foreign Keys** | **Additional Fields**                                                                                                                                                                    | **Constraints**                                                                                                         | **Timestamps Required** |
| ----------------------------- | --------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
${tables
        .map((table) => {
            // Show first 5 additional fields or fewer if there aren't that many
            const additionalFieldsShown = table.additionalFields
                .filter((field) => !field.includes("createdAt") && !field.includes("updatedAt"))
                .slice(0, 5)
                .join(", ")

            const constraintsShown = table.constraints.join("; ")

            return `| **${table.name}** | ${table.primaryKey} | ${table.foreignKeys.join(", ")} | ${additionalFieldsShown} | ${constraintsShown} | Yes |`
        })
        .join("\n")}

## Many-to-Many Join Tables

| **Join Table Name**          | **Primary Keys**                | **Description**                                                                                |
| ---------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
${joinTables
        .map((table) => {
            return `| **${table.name}** | ${table.primaryKeys.join(", ")} | ${table.description} |`
        })
        .join("\n")}
`

const schemaOverviewPath = path.join(DATA_DIR, "schema-overview.md")
fs.writeFileSync(schemaOverviewPath, schemaOverviewContent)
console.log(`Created schema overview file: ${schemaOverviewPath}`)

// Add sample data to CSV files to help with testing
function addSampleDataToCSV() {
    // Add a sample company
    const companyData = {
        company_id: "comp_1",
        company_name: "OpenAI",
        company_hq_location: "San Francisco, USA",
        company_size: "Large",
        company_website_url: "https://openai.com",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }

    const companiesFilePath = path.join(DATA_DIR, "Companies.csv")
    const companiesCSV = Papa.unparse({
        fields: Object.keys(companyData),
        data: [Object.values(companyData)],
    })
    fs.writeFileSync(companiesFilePath, companiesCSV)

    // Add a sample platform
    const platformData = {
        platform_id: "plat_1",
        company_id: "comp_1",
        platform_name: "GPT API",
        platform_url: "https://openai.com/api",
        platform_category: "Natural Language Processing",
        platform_sub_category: "Text Generation",
        platform_status: "Active",
        api_availability: "Yes",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }

    const platformsFilePath = path.join(DATA_DIR, "Platforms.csv")
    const platformsCSV = Papa.unparse({
        fields: Object.keys(platformData),
        data: [Object.values(platformData)],
    })
    fs.writeFileSync(platformsFilePath, platformsCSV)

    // Add a sample model
    const modelData = {
        model_id: "model_1",
        platform_id: "plat_1",
        model_family: "GPT",
        model_version: "4",
        model_variants: "Base, Vision",
        model_architecture: "Transformer",
        parameters_count: "1.76T",
        context_window_size: "8192",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }

    const modelsFilePath = path.join(DATA_DIR, "Models.csv")
    const modelsCSV = Papa.unparse({
        fields: Object.keys(modelData),
        data: [Object.values(modelData)],
    })
    fs.writeFileSync(modelsFilePath, modelsCSV)

    // Add a sample technical specification
    const techSpecData = {
        spec_id: "spec_1",
        model_id: "model_1",
        input_types: "Text, Images",
        output_types: "Text",
        supported_languages: "English, Spanish, French, German, and many others",
        hardware_requirements: "GPU recommended for inference",
        gpu_acceleration: "Yes",
        compatible_frameworks: "OpenAI API",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    }

    const techSpecsFilePath = path.join(DATA_DIR, "Technical_Specifications.csv")
    const techSpecsCSV = Papa.unparse({
        fields: Object.keys(techSpecData),
        data: [Object.values(techSpecData)],
    })
    fs.writeFileSync(techSpecsFilePath, techSpecsCSV)

    console.log("Added sample data to CSV files for testing")
}

// Add sample data to help with testing
addSampleDataToCSV()

