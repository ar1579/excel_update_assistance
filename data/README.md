# AI Toolkit Database Tables

This directory contains CSV files for all tables in the AI Toolkit database.

## Main Tables

## Companies
Stores information about companies that develop AI platforms

Fields:
- company_id (Primary Key)
- company_name
- hq_location
- company_size
- funding_stage
- website_url
- annual_revenue
- createdAt
- updatedAt
Constraints:
- NOT NULL: company_name
- UNIQUE: company_name

---

## Platforms
Core table storing AI platform details

Fields:
- platform_id (Primary Key)
- company_id (Foreign Key)
- platform_name
- category
- sub_category
- platform_url
- status
- integration_options
- api_availability
- createdAt
- updatedAt
Constraints:
- NOT NULL: platform_name, category
- UNIQUE: platform_name

---

## Models
Stores information about AI models associated with platforms

Fields:
- model_id (Primary Key)
- platform_id (Foreign Key)
- model_family
- model_version
- model_variants
- architecture
- parameters_count
- context_window_size
- token_limit
- training_data_size
- createdAt
- updatedAt
Constraints:
- NOT NULL: model_family, model_version
- UNIQUE: model_family, model_version

---

## Technical_Specifications
Tracks technical specifications of AI platforms and models

Fields:
- spec_id (Primary Key)
- model_id (Foreign Key)
- input_types
- output_types
- supported_languages
- hardware_requirements
- gpu_acceleration
- latency
- compatible_frameworks
- createdAt
- updatedAt
Constraints:
- NOT NULL: model_id

---

## Pricing
Contains pricing models and cost information

Fields:
- pricing_id (Primary Key)
- platform_id (Foreign Key)
- pricing_model
- starting_price
- enterprise_pricing
- billing_frequency
- custom_pricing_available
- pricing_url
- discount_options
- createdAt
- updatedAt
Constraints:
- CHECK: pricing_model IN ('Subscription', 'One-Time', 'Usage-Based')

---

## Trials
Stores free trial details

Fields:
- trial_id (Primary Key)
- platform_id (Foreign Key)
- free_trial_plan
- trial_duration
- trial_duration_unit
- usage_limits
- createdAt
- updatedAt
Constraints:
- CHECK: trial_duration_unit IN ('Day', 'Week', 'Month', 'Year')

---

## Licenses
Stores licensing information, including open-source status

Fields:
- license_id (Primary Key)
- platform_id (Foreign Key)
- license_name
- license_type
- open_source_status
- license_url
- expiration_date
- createdAt
- updatedAt
Constraints:
- CHECK: license_type IN ('Open-source', 'Proprietary', 'Creative Commons', 'Other')

---

## Performance
Captures performance metrics of AI platforms

Fields:
- performance_id (Primary Key)
- model_id (Foreign Key)
- performance_metrics
- accuracy_metrics
- precision_metrics
- recall_metrics
- f1_score
- createdAt
- updatedAt
Constraints:
- NOT NULL: model_id

---

## Benchmarks
Stores benchmark test results

Fields:
- benchmark_id (Primary Key)
- model_id (Foreign Key)
- benchmark_name
- benchmark_score
- benchmark_details
- createdAt
- updatedAt
Constraints:
- NOT NULL: model_id

---

## Training
Tracks training dataset sizes and methodology

Fields:
- training_id (Primary Key)
- model_id (Foreign Key)
- training_methodology
- fine_tuning_supported
- transfer_learning_supported
- fine_tuning_performance
- createdAt
- updatedAt
Constraints:
- NOT NULL: model_id

---

## Use_Cases
Documents use cases and application areas

Fields:
- use_case_id (Primary Key)
- model_id (Foreign Key)
- primary_use_case
- secondary_use_cases
- specialized_domains
- supported_tasks
- limitations
- createdAt
- updatedAt
Constraints:
- NOT NULL: model_id, primary_use_case

---

## Features
Stores key features of AI platforms

Fields:
- feature_id (Primary Key)
- platform_id (Foreign Key)
- notable_features
- explainability_features
- customization_options
- bias_mitigation_approaches
- createdAt
- updatedAt
Constraints:
- NOT NULL: notable_features

---

## Security_and_Compliance
Records security certifications and compliance standards

Fields:
- security_id (Primary Key)
- platform_id (Foreign Key)
- security_certifications
- compliance_standards
- gdpr_compliance
- hipaa_compliance
- iso_certifications
- data_retention_policies
- privacy_features
- createdAt
- updatedAt
Constraints:
- NOT NULL: security_certifications

---

## Support
Captures customer support options available

Fields:
- support_id (Primary Key)
- platform_id (Foreign Key)
- support_options
- sla_available
- support_channels
- support_hours
- enterprise_support
- training_options
- consulting_services
- response_time_guarantees
- createdAt
- updatedAt

---

## Documentation
Tracks documentation resources and learning materials

Fields:
- doc_id (Primary Key)
- platform_id (Foreign Key)
- documentation_url
- faq_url
- forum_url
- example_code_available
- example_code_languages
- video_tutorials_available
- createdAt
- updatedAt

---

## Versioning
Maintains version history and update details

Fields:
- version_id (Primary Key)
- platform_id (Foreign Key)
- release_date
- last_updated
- maintenance_status
- deprecation_date
- update_frequency
- changelog_url
- version_numbering_scheme
- backward_compatibility_notes
- createdAt
- updatedAt

---

## Community
Tracks engagement and community support for AI platforms

Fields:
- community_id (Primary Key)
- platform_id (Foreign Key)
- community_size
- engagement_score
- github_repository
- stackoverflow_tags
- academic_papers
- case_studies
- createdAt
- updatedAt

---

## Ethics
Stores ethical considerations and AI fairness metrics

Fields:
- ethics_id (Primary Key)
- model_id (Foreign Key)
- ethical_guidelines_url
- bias_evaluation
- fairness_metrics
- transparency_score
- environmental_impact
- createdAt
- updatedAt

---

## API
Documents API specifications, authentication methods, and integrations

Fields:
- api_id (Primary Key)
- platform_id (Foreign Key)
- api_standards
- authentication_methods
- webhook_support
- third_party_integrations
- export_formats
- import_capabilities
- createdAt
- updatedAt

---

## Market
Stores market-related information, including user adoption rates

Fields:
- market_id (Primary Key)
- platform_id (Foreign Key)
- user_count
- adoption_rate
- industry_penetration
- customer_profile
- success_stories
- direct_competitors
- competitive_advantages
- market_share
- analyst_ratings
- industry_awards
- createdAt
- updatedAt


## Join Tables (Many-to-Many Relationships)

## platform_features
Join table for the many-to-many relationship between Platforms and Features

Fields:
- platform_id (Primary Key)
- feature_id (Primary Key)
- createdAt
- updatedAt

---

## platform_licenses
Join table for the many-to-many relationship between Platforms and Licenses

Fields:
- platform_id (Primary Key)
- license_id (Primary Key)
- createdAt
- updatedAt

---

## platform_certifications
Join table for the many-to-many relationship between Platforms and Security Certifications

Fields:
- platform_id (Primary Key)
- security_id (Primary Key)
- createdAt
- updatedAt

---

## model_benchmarks
Join table for the many-to-many relationship between Models and Benchmarks

Fields:
- model_id (Primary Key)
- benchmark_id (Primary Key)
- createdAt
- updatedAt

---

## model_use_cases
Join table for the many-to-many relationship between Models and Use Cases

Fields:
- model_id (Primary Key)
- use_case_id (Primary Key)
- createdAt
- updatedAt

---

## api_integrations
Join table for the many-to-many relationship between API and Third-Party Integrations

Fields:
- api_id (Primary Key)
- integration_id (Primary Key)
- createdAt
- updatedAt
