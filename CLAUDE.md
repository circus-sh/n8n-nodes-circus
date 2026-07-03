@AGENTS.md

## Project Context

This repository contains custom n8n nodes for the Circus AI Workflow Orchestration Platform (https://circus.sh). These nodes enable n8n workflow developers to integrate with the Circus platform's workflow execution engine — logging execution steps, tracking costs, managing execution lifecycle, and executing AI agent calls using operator-configured models and prompts.

Read `docs/n8n_nodes_spec.md` for the detailed specification of all Circus nodes, including exact API endpoints, field mappings, request/response structures, and runtime behavior.

## Circus Platform API

All nodes authenticate with the Circus platform via API key (JWT signed with `workflow_jwt_secret`) using the `Authorization: Bearer {apiKey}` header. All machine-facing endpoints are under `/api/machine/`.

Credential test endpoint: `POST /api/machine/health`

## Nodes in this package

| Node | Purpose | Complexity |
|------|---------|------------|
| CircusInit | Initialize execution context, validate JWT, register execution start | Low |
| CircusAgent | Operator-controlled AI execution — reads model, prompt, and parameters from snapshot | High |
| CircusLog | Log workflow steps, check cost/time thresholds | Low |
| CircusTerminate | Terminate a workflow execution on error | Low |
| CircusComplete | Mark execution as complete with result payload | Low |

## AI Provider Credentials

The Agent node requires AI provider API keys stored as n8n credentials following the naming convention `circus_{model_provider}_api_key` (e.g. `circus_openai_api_key`, `circus_anthropic_api_key`). These are separate from the CircusApi credential and are looked up at runtime based on the `model_provider` value in the snapshot.

## Key Design Decisions

- The Circus Init node validates the JWT (if present), stores execution context in n8n's execution custom data, and registers execution start via `/logs`. All downstream nodes read context via the shared `getCircusContext()` and `getSnapshot()` helpers in `nodes/shared/circusContext.ts`
- All nodes extract `workflow_execution_id` from execution custom data (stored by the Init node)
- JWT validation failures in the Init node do NOT call `/terminate` — the workflow_execution_id may be forged or mismatched, so it cannot be trusted to identify a valid execution on the platform
- The Agent node reads its configuration from snapshots in the webhook payload — it does not hardcode API URLs, models, or prompts
- The Agent node builds provider-specific HTTP requests (OpenAI, Anthropic, Google, xAI). Unknown providers fall back to OpenAI request structure.
- The Log node only supports `worker_type` of `service` or `internal` — not `agent` (Agent nodes self-log)
- Idempotency keys are auto-generated via `crypto.randomUUID()` per log entry, never exposed to the user
- Duration measurement starts when the node is triggered, not when the external API call begins
- Cost/time threshold checking happens after every /log call — if `abort` is true, the node terminates the execution

## Rules

- No runtime dependencies — the `dependencies` field in package.json must be empty. Everything goes in `devDependencies`. This is a hard requirement for n8n verified community node verification.
- Use n8n's built-in `this.helpers.httpRequest` for all HTTP calls — do not import axios, fetch, or any HTTP library
- Use `crypto.randomUUID()` for idempotency keys — do not add the uuid package
- All UI text, descriptions, error messages, and README content must be in English
- Use `NodeApiError` for API failures and `NodeOperationError` for configuration/validation errors
- Support `continueOnFail()` in the execute method where appropriate
- Always include `pairedItem` when building return data
- Run `npm run lint` and `npm run build` before committing to verify there are no errors
- Update `package.json` `n8n.nodes` and `n8n.credentials` arrays when adding new nodes or credentials
- Register every new node's codex JSON file alongside the node TypeScript file