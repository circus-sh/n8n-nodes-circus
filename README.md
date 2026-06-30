# n8n-nodes-circus

This is an n8n community node. It lets you use the [Circus AI Workflow Orchestration Platform](https://circus.sh) in your n8n workflows.

Circus is an AI workflow orchestration platform that enables operators to configure models, prompts, and agents through a central UI. These nodes let n8n workflow developers integrate with the Circus platform — executing AI agent calls, logging execution steps, tracking costs, and managing the execution lifecycle.

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

- **Circus Init** — Initialize the Circus execution context. Place directly after the Webhook trigger node. Stores the webhook payload in n8n's execution data so all downstream Circus nodes can access configuration snapshots and execution IDs regardless of their position in the workflow.
- **Circus Agent** — Execute AI agent calls using operator-configured models and prompts. The agent configuration (model, prompt, parameters) is read from the workflow snapshot at runtime, allowing operators to change AI providers and prompts without editing the n8n workflow. Supports OpenAI, Anthropic, Google, and xAI providers.
- **Circus Log** — Create log entries on the Circus platform for workflow steps. Tracks execution data, checks cost and time thresholds, and can trigger workflow termination if thresholds are exceeded.
- **Circus Complete** — Mark a workflow execution as successfully completed and transmit result artifacts back to the Circus platform.
- **Circus Terminate** — Terminate a workflow execution on the Circus platform due to an error. Intended for use in error branches.

## Credentials

### Circus API

All nodes (except Circus Init) require the **Circus API** credential, which authenticates with the Circus platform:

- **API Key** — Circus Platform API Key (JWT token)
- **API URL** — Base URL of your Circus platform instance (e.g. `https://your-instance.circus.sh`)

### AI Provider API Keys

The Agent node requires AI provider API keys configured as n8n credentials. The Agent node looks up the correct credential at runtime based on the model provider specified in the snapshot. Supported providers:

- **Circus OpenAI API** — for OpenAI models
- **Circus Anthropic API** — for Anthropic models
- **Circus Google AI API** — for Google AI models
- **Circus xAI API** — for xAI models

## Compatibility

Tested with n8n version 2.25+. Requires `n8n-workflow` version 2.16.0 or later.

## Usage

These nodes are designed to work with the Circus platform's webhook-triggered workflow pattern:

1. A **Webhook** trigger node receives the execution payload from the Circus platform.
2. A **Circus Init** node (placed directly after the Webhook) stores the payload in execution data.
3. **Agent** nodes read their configuration from the stored snapshots — no hardcoded API URLs, models, or prompts in the n8n workflow.
4. **Log** nodes record execution steps and check cost/time thresholds.
5. The **Complete** node marks the execution as finished, or the **Terminate** node handles error cases.

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

Initial release with five nodes: Init, Agent, Log, Complete, and Terminate.
