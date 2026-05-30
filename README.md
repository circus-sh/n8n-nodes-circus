# n8n-nodes-circus

This is an n8n community node. It lets you use the [Circus AI Workflow Orchestration Platform](https://circus.sh) in your n8n workflows.

Circus is an AI workflow orchestration platform that enables operators to configure models, prompts, agents, and external services through a central UI. These nodes let n8n workflow developers integrate with the Circus platform — executing AI agent calls, making external service API calls, logging execution steps, tracking costs, and managing the execution lifecycle.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/sustainable-use-license/) workflow automation platform.

[Installation](#installation)
[Operations](#operations)
[Credentials](#credentials)
[Compatibility](#compatibility)
[Usage](#usage)
[Resources](#resources)
[Version history](#version-history)

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

## Operations

This package provides five nodes:

- **Circus Agent** — Execute AI agent calls using operator-configured models and prompts. The agent configuration (model, prompt, parameters) is read from the workflow snapshot at runtime, allowing operators to change AI providers and prompts without editing the n8n workflow. Supports OpenAI, Anthropic, Google, and xAI providers.
- **Circus Service** — Execute external service API calls using snapshot-configured URL, headers, and method. Service configuration is managed in the Circus UI and resolved at runtime from the webhook payload.
- **Circus Log** — Create log entries on the Circus platform for workflow steps. Tracks execution data, checks cost and time thresholds, and can trigger workflow termination if thresholds are exceeded.
- **Circus Complete** — Mark a workflow execution as successfully completed and transmit result artifacts back to the Circus platform.
- **Circus Terminate** — Terminate a workflow execution on the Circus platform due to an error. Intended for use in error branches.

## Credentials

### Circus API

All nodes require the **Circus API** credential, which authenticates with the Circus platform:

- **API Key** — Circus Platform API Key (JWT token)
- **API URL** — Base URL of your Circus platform instance (e.g. `https://your-instance.circus.sh`)

### AI Provider API Keys

The Agent node requires AI provider API keys configured as n8n credentials. These follow the naming convention `circus_{provider}_api_key` (e.g. `circus_openai_api_key`, `circus_anthropic_api_key`). The Agent node looks up the correct credential at runtime based on the model provider specified in the snapshot.

### Service API Keys

The Service node resolves header variables (e.g. `{{ELEVENLABS_API_KEY}}`) from n8n environment variables. Set these as environment variables on your n8n instance (e.g. in the `.env` file or Docker environment).

## Compatibility

Tested with n8n version 1.x. Requires `n8n-workflow` version 2.16.0 or later.

## Usage

These nodes are designed to work with the Circus platform's webhook-triggered workflow pattern:

1. A webhook trigger node receives the execution payload from the Circus platform, containing workflow and service configuration snapshots.
2. Agent and Service nodes read their configuration from these snapshots — no hardcoded API URLs, models, or prompts in the n8n workflow.
3. Log nodes record execution steps and check cost/time thresholds.
4. The Complete node marks the execution as finished, or the Terminate node handles error cases.

All nodes automatically include the n8n execution ID (`external_execution_id`) in every platform API call, enabling the Circus platform to remotely manage the n8n execution if needed.

### Error Handling

These nodes follow a consistent error handling pattern based on n8n's built-in "On Error" setting:

- **Stop Workflow + Retry On Fail**: The node throws an error to let n8n retry. It does not call the platform's terminate endpoint, allowing retries to succeed.
- **Stop Workflow + No Retry**: The node calls the platform's terminate endpoint and throws an error.
- **Continue (any variant)**: The node calls the platform's terminate endpoint to trigger remote termination, then throws an error. The platform will stop the n8n execution remotely.

It is recommended to set "On Error" to "Stop Workflow" for all Circus nodes.

## Resources

* [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)
* [Circus platform documentation](https://circus.sh/docs)

## Version history

### 0.1.0

Initial release with five nodes: Agent, Service, Log, Complete, and Terminate.
