# AI Toolkit Database Schema Overview

## Main Tables

| **Table Name**                | **Primary Key** | **Foreign Keys** | **Additional Fields**                                                                                                                                                                    | **Constraints**                                                                                                         | **Timestamps Required** |
| ----------------------------- | --------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| **Companies** | company_id |  | company_name, hq_location, company_size, funding_stage, website_url | NOT NULL: company_name; UNIQUE: company_name | Yes |
| **Platforms** | platform_id | company_id | platform_name, category, sub_category, platform_url, status | NOT NULL: platform_name, category; UNIQUE: platform_name | Yes |
| **Models** | model_id | platform_id | model_family, model_version, model_variants, architecture, parameters_count | NOT NULL: model_family, model_version; UNIQUE: model_family, model_version | Yes |
| **Technical_Specifications** | spec_id | model_id | input_types, output_types, supported_languages, hardware_requirements, gpu_acceleration | NOT NULL: model_id | Yes |
| **Pricing** | pricing_id | platform_id | pricing_model, starting_price, enterprise_pricing, billing_frequency, custom_pricing_available | CHECK: pricing_model IN ('Subscription', 'One-Time', 'Usage-Based') | Yes |
| **Trials** | trial_id | platform_id | free_trial_plan, trial_duration, trial_duration_unit, usage_limits | CHECK: trial_duration_unit IN ('Day', 'Week', 'Month', 'Year') | Yes |
| **Licenses** | license_id | platform_id | license_name, license_type, open_source_status, license_url, expiration_date | CHECK: license_type IN ('Open-source', 'Proprietary', 'Creative Commons', 'Other') | Yes |
| **Performance** | performance_id | model_id | performance_metrics, accuracy_metrics, precision_metrics, recall_metrics, f1_score | NOT NULL: model_id | Yes |
| **Benchmarks** | benchmark_id | model_id | benchmark_name, benchmark_score, benchmark_details | NOT NULL: model_id | Yes |
| **Training** | training_id | model_id | training_methodology, fine_tuning_supported, transfer_learning_supported, fine_tuning_performance | NOT NULL: model_id | Yes |
| **Use_Cases** | use_case_id | model_id | primary_use_case, secondary_use_cases, specialized_domains, supported_tasks, limitations | NOT NULL: model_id, primary_use_case | Yes |
| **Features** | feature_id | platform_id | notable_features, explainability_features, customization_options, bias_mitigation_approaches | NOT NULL: notable_features | Yes |
| **Security_and_Compliance** | security_id | platform_id | security_certifications, compliance_standards, gdpr_compliance, hipaa_compliance, iso_certifications | NOT NULL: security_certifications | Yes |
| **Support** | support_id | platform_id | support_options, sla_available, support_channels, support_hours, enterprise_support |  | Yes |
| **Documentation** | doc_id | platform_id | documentation_url, faq_url, forum_url, example_code_available, example_code_languages |  | Yes |
| **Versioning** | version_id | platform_id | release_date, last_updated, maintenance_status, deprecation_date, update_frequency |  | Yes |
| **Community** | community_id | platform_id | community_size, engagement_score, github_repository, stackoverflow_tags, academic_papers |  | Yes |
| **Ethics** | ethics_id | model_id | ethical_guidelines_url, bias_evaluation, fairness_metrics, transparency_score, environmental_impact |  | Yes |
| **API** | api_id | platform_id | api_standards, authentication_methods, webhook_support, third_party_integrations, export_formats |  | Yes |
| **Market** | market_id | platform_id | user_count, adoption_rate, industry_penetration, customer_profile, success_stories |  | Yes |

## Many-to-Many Join Tables

| **Join Table Name**          | **Primary Keys**                | **Description**                                                                                |
| ---------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| **platform_features** | platform_id, feature_id | Join table for the many-to-many relationship between Platforms and Features |
| **platform_licenses** | platform_id, license_id | Join table for the many-to-many relationship between Platforms and Licenses |
| **platform_certifications** | platform_id, security_id | Join table for the many-to-many relationship between Platforms and Security Certifications |
| **model_benchmarks** | model_id, benchmark_id | Join table for the many-to-many relationship between Models and Benchmarks |
| **model_use_cases** | model_id, use_case_id | Join table for the many-to-many relationship between Models and Use Cases |
| **api_integrations** | api_id, integration_id | Join table for the many-to-many relationship between API and Third-Party Integrations |
