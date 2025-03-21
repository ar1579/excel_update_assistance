# AI Toolkit Database Schema Overview

## Main Tables

| **Table Name**                | **Primary Key** | **Foreign Keys** | **Additional Fields**                                                                                                                                                                    | **Constraints**                                                                                                         | **Timestamps Required** |
| ----------------------------- | --------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| **Companies** | company_id |  | company_name, company_hq_location, company_year_founded, company_size, company_contact_information | NOT NULL: company_name; UNIQUE: company_name; CHECK: company_size IN ('Startup', 'Small', 'Medium', 'Large', 'Enterprise') | Yes |
| **Platforms** | platform_id | company_id | platform_name, platform_url, platform_category, platform_sub_category, platform_description | NOT NULL: platform_name, platform_category; UNIQUE: platform_name; CHECK: platform_status IN ('Active', 'Beta', 'Discontinued') | Yes |
| **Models** | model_id | platform_id | model_family, model_version, model_variants, model_size, model_size_unit | NOT NULL: model_family, model_version; UNIQUE: model_family, model_version, platform_id; CHECK: model_size_unit IN ('KB', 'MB', 'GB', 'TB') | Yes |
| **Technical_Specifications** | spec_id | model_id | input_types, output_types, supported_languages, hardware_requirements, gpu_acceleration | NOT NULL: model_id | Yes |
| **Pricing** | pricing_id | platform_id | pricing_model, starting_price, enterprise_pricing, billing_frequency, custom_pricing_available | CHECK: pricing_model IN ('Subscription', 'One-Time', 'Usage-Based', 'Free') | Yes |
| **Trials** | trial_id | platform_id | free_trial_plan, trial_duration, trial_duration_unit, usage_limits | CHECK: trial_duration_unit IN ('Day', 'Week', 'Month', 'Year') | Yes |
| **Licenses** | license_id | platform_id | license_type, open_source_status, license_name, license_url, license_expiration_date | CHECK: license_type IN ('Open-source', 'Proprietary', 'Creative Commons', 'Other') | Yes |
| **Performance** | performance_id | model_id | performance_metrics, performance_score, accuracy_metrics, precision_metrics, recall_metrics | NOT NULL: model_id | Yes |
| **Benchmarks** | benchmark_id | model_id | benchmark_name, benchmark_score, benchmark_details | NOT NULL: model_id | Yes |
| **Training** | training_id | model_id | training_data_size, training_data_notes, training_methodology, fine_tuning_supported, transfer_learning_supported | NOT NULL: model_id | Yes |
| **Use_Cases** | use_case_id | model_id | primary_use_case, secondary_use_cases, specialized_domains, supported_tasks, limitations | NOT NULL: model_id, primary_use_case | Yes |
| **Features** | feature_id | platform_id | notable_features, explainability_features, customization_options, bias_mitigation_approaches | NOT NULL: notable_features | Yes |
| **Security_and_Compliance** | security_id | platform_id | security_certifications, compliance_standards, gdpr_compliance, hipaa_compliance, iso_certifications | NOT NULL: security_certifications | Yes |
| **Support** | support_id | platform_id | support_options, sla_available, support_channels, support_hours, enterprise_support |  | Yes |
| **Documentation** | doc_id | platform_id | documentation_description, doc_quality, documentation_url, faq_url, forum_url |  | Yes |
| **Versioning** | version_id | platform_id | release_date, last_updated, maintenance_status, deprecation_date, update_frequency |  | Yes |
| **Community** | community_id | platform_id | community_size, community_engagement_score, user_rating, github_repository, stackoverflow_tags |  | Yes |
| **Ethics** | ethics_id | model_id | ethical_guidelines_url, bias_evaluation, fairness_metrics, transparency_score, environmental_impact |  | Yes |
| **API** | api_id | platform_id | api_standards, authentication_methods, webhook_support, third_party_integrations, export_formats |  | Yes |
| **Market** | market_id | platform_id | user_count, adoption_rate, industry_penetration, typical_customer_profile, success_stories |  | Yes |

## Many-to-Many Join Tables

| **Join Table Name**          | **Primary Keys**                | **Description**                                                                                |
| ---------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| **platform_features** | platform_id, feature_id | Join table for the many-to-many relationship between Platforms and Features |
| **platform_licenses** | platform_id, license_id | Join table for the many-to-many relationship between Platforms and Licenses |
| **platform_certifications** | platform_id, security_id | Join table for the many-to-many relationship between Platforms and Security Certifications |
| **model_benchmarks** | model_id, benchmark_id | Join table for the many-to-many relationship between Models and Benchmarks |
| **model_use_cases** | model_id, use_case_id | Join table for the many-to-many relationship between Models and Use Cases |
| **api_integrations** | api_id, integration_id | Join table for the many-to-many relationship between API and Third-Party Integrations |
