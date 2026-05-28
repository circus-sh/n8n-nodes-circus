# Circus n8n Nodes — Detailed Specification

This document defines six custom n8n nodes for the Circus AI Workflow Orchestration Platform. It includes exact API endpoints, field names, types, and request/response structures from the core API contract.

---

## Shared: Circus API Credential Type

All Circus nodes share a single credential type for authenticating with the Circus platform. Defined once, reused by every node.

**Credential fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `apiKey` | string (password) | Yes | Circus Platform API Key (JWT signed with `workflow_jwt_secret`) |
| `apiUrl` | string | Yes | Circus Platform API base URL (e.g. `https://staging.circus.sh`) |

**Authentication method:** `Authorization: Bearer {apiKey}` header on all requests to `/api/machine/*` endpoints.

**Credential test:** On save, call `POST {apiUrl}/api/machine/health`. If 200 with `{ "data": { "status": "ok" } }`, credentials are valid.

---

## Shared: AI Provider Credentials

The Agent node requires AI provider API keys. These are stored as n8n credentials following the naming convention:

```
circus_{model_provider}_api_key
```

Examples:
- `circus_openai_api_key`
- `circus_anthropic_api_key`
- `circus_xai_api_key`
- `circus_google_api_key`

The Agent node reads `model_provider` from the snapshot at runtime, constructs the credential name, and looks it up. One credential per provider, shared across all Agent nodes that use that provider.

The user configures these once in n8n's credential manager — not per node.

---

## Shared: Workflow Execution ID

All nodes extract `workflow_execution_id` from the webhook payload received by the n8n workflow. This value is passed through n8n's expression system from the webhook trigger node.

The webhook payload structure (sent by the Circus platform when starting an execution):

```json
{
  "workflow_execution_id": "5",
  "workspace_id": "1",
  "workflow_id": "1",
  "run_reason": "new",
  "workflow_config_snapshot": { ... },
  "service_config_snapshot": { ... },
  "system_snapshot": { ... },
  "workspace_snapshot": { ... }
}
```

All nodes access snapshots from this webhook payload via n8n expressions.

---

## Shared: Idempotency Key Generation

Nodes that call the `/log` endpoint generate a UUID (`crypto.randomUUID()`) per log entry. If the `/log` call itself fails and is retried, the same key is reused — preventing duplicate log rows and double-counted costs.

The key is tied to the log entry, not to the external API call attempt. If the Agent node retries an AI call 3 times, each attempt generates its own idempotency key (because each is a separate log entry recording a separate attempt).

Idempotency keys are never exposed to or configured by the user.

---

## Shared: Duration Measurement

All nodes that report `duration_seconds` measure wall-clock time from the moment the node is triggered — including config resolution, validation, prompt building, and the external API call itself. Not just the API call latency.

```ts
const startTime = Date.now()
// ... all node work ...
const durationSeconds = (Date.now() - startTime) / 1000
```

---

## 1. Agent Node

### Purpose

Enables operator-controlled AI execution. The operator configures models, prompts, and agents in the Circus UI. The workflow developer places the Agent node in n8n and specifies which agent (by slug) to use. The Agent node reads the snapshot to determine which model, prompt, parameters, and API endpoint to use at runtime — no hardcoded AI provider configuration in n8n.

**Why this node exists:** Without it, changing a model from GPT-4o to Claude, or updating a prompt, requires editing the n8n workflow. With the Agent node, the operator makes these changes in the Circus UI and the next execution automatically uses the new configuration.

### User Configuration (n8n UI)

**Main tab:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `agentSlug` | string | Yes | — | Agent slug matching an entry in `workflow_config_snapshot.agent_assignments[].agent_slug` |
| `inputText` | string | Yes | — | The work item to process. Supports n8n expressions — can reference previous node output, webhook payload fields (e.g. workspace snapshot), or static text. Sent as a separate user message after the prompt. |
| `includeSystemContext` | boolean | No | false | Whether to include system context entries in the prompt |
| `systemContextEntries` | string[] | No | all | Specific system context keys to include (if `includeSystemContext` is true). Empty means all. |
| `missingContextBehavior` | enum | No | `ignore` | How to handle missing system context entries: `ignore`, `ignore_and_report`, `fail` |

**Advanced/Settings tab:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enableRetries` | boolean | No | false | Enable automatic retries on AI API call failure |
| `maxRetries` | number | No | 0 | Number of retry attempts (only if retries enabled) |

### Runtime Behavior

**Step 0 — Start duration timer:**

```ts
const startTime = Date.now()
```

**Step 1 — Resolve agent configuration from snapshot:**

Read `workflow_config_snapshot.agent_assignments[]` from the webhook payload. Find the entry where `agent_slug` matches the configured `agentSlug`.

Snapshot entry structure:
```json
{
  "agent_id": 3,
  "agent_name": "Script Writer",
  "agent_slug": "script_writer",
  "model_id": 1,
  "model_name": "GPT-4o",
  "model_provider": "openai",
  "model_api_url": "https://api.openai.com/v1/chat/completions",
  "prompt_id": 12,
  "prompt_name": "Generate Script",
  "prompt_slug": "generate_script",
  "active_prompt_version_id": 28,
  "prompt_text": "You are a script writer...",
  "temperature": 0.7,
  "max_tokens": 4096
}
```

If no matching entry found:
1. Call `POST /api/machine/workflow-executions/:executionId/logs` with error log
2. Call `POST /api/machine/workflow-executions/:executionId/terminate` with reason: `"Agent slug '{agentSlug}' not found in workflow configuration snapshot"`
3. Throw n8n NodeOperationError to halt the workflow

**Step 2 — Validate agent parameters:**

From the resolved snapshot entry, verify:
- `model_provider` is defined and non-empty
- `model_name` is defined and non-empty
- `model_api_url` is defined and non-empty
- Corresponding AI provider API key exists in n8n credentials (named `circus_{model_provider}_api_key`)
- `max_tokens` is a positive integer
- `temperature` is between 0 and 2 (inclusive)

If any validation fails:
1. Call `/logs` endpoint with error log
2. Call `/terminate` endpoint with reason describing the missing parameter.
3. Halt the workflow

**Step 3 — Build prompt with system context:**

If `includeSystemContext` is true:
- Read `system_snapshot.system_context` from the webhook payload
- If `systemContextEntries` is empty: include all entries
- If `systemContextEntries` is specified: include only listed keys
  - For each specified key not found in `system_snapshot.system_context`, apply `missingContextBehavior`:
    - `ignore`: skip silently
    - `ignore_and_report`: skip, but call `/logs` with a warning log reporting the missing key
    - `fail`: call `/logs` with error, call `/terminate`, halt workflow

Assemble the final prompt in three parts:
- **System message:** system context entries (concatenated or structured as key-value pairs)
- **User message 1 (instruction):** `prompt_text` from the snapshot
- **User message 2 (input):** `inputText` from the node configuration — the actual work item to process

The prompt and input are sent as separate messages so the AI provider sees the prompt as the instruction and the input as the work item. The prompt does not need `{input}` placeholders or template syntax.

**Step 4 — Build provider-specific request:**

Read `model_api_url` from the snapshot. This is the endpoint the AI API call will be made to.

Read `model_provider` from the snapshot. Build the request body based on the provider:

**OpenAI / xAI / default (unknown providers):**
```json
{
  "model": "{model_name}",
  "messages": [
    { "role": "system", "content": "{system context}" },
    { "role": "user", "content": "{prompt_text from snapshot}" },
    { "role": "user", "content": "{inputText from workflow}" }
  ],
  "temperature": 0.7,
  "max_tokens": 4096
}
```

**Anthropic:**
```json
{
  "model": "{model_name}",
  "system": "{system context}",
  "messages": [
    { "role": "user", "content": "{prompt_text from snapshot}" },
    { "role": "user", "content": "{inputText from workflow}" }
  ],
  "temperature": 0.7,
  "max_tokens": 4096
}
```

**Google:**
```json
{
  "system_instruction": { "parts": [{ "text": "{system context}" }] },
  "contents": [
    { "role": "user", "parts": [{ "text": "{prompt_text from snapshot}" }] },
    { "role": "user", "parts": [{ "text": "{inputText from workflow}" }] }
  ],
  "generationConfig": {
    "temperature": 0.7,
    "maxOutputTokens": 4096
  }
}
```

The provider switch uses `model_provider` value. Unknown providers fall back to the OpenAI request structure.

**NOTE:** When a new AI provider is added to the Circus platform's model registry, a corresponding case should be added to the Agent node's request builder and response parser. Until then, the node falls back to OpenAI structure, which may or may not work with the new provider.

**Step 5 — Execute AI API call:**

Make the HTTP request to `model_api_url` with:
- The provider-specific request body from Step 4
- API key from n8n credentials (`circus_{model_provider}_api_key`)
- Appropriate headers per provider (e.g. `Content-Type: application/json`, Anthropic requires `anthropic-version` header)

**Step 6 — Parse response and extract token usage:**

Extract the AI response text and token counts using provider-specific parsing:

**OpenAI / xAI / default:**
```json
{
  "usage": {
    "prompt_tokens": 1200,
    "completion_tokens": 340
  }
}
```
- `input_size` = `usage.prompt_tokens`
- `output_size` = `usage.completion_tokens`
- Response text = `choices[0].message.content`

**Anthropic:**
```json
{
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 340
  }
}
```
- `input_size` = `usage.input_tokens`
- `output_size` = `usage.output_tokens`
- Response text = `content[0].text`

**Google:**
```json
{
  "usageMetadata": {
    "promptTokenCount": 1200,
    "candidatesTokenCount": 340
  }
}
```
- `input_size` = `usageMetadata.promptTokenCount`
- `output_size` = `usageMetadata.candidatesTokenCount`
- Response text = `candidates[0].content.parts[0].text`

**Step 7 — Log the result:**

Calculate duration:
```ts
const durationSeconds = (Date.now() - startTime) / 1000
```

Call `POST /api/machine/workflow-executions/:executionId/logs`

**Request body:**

```json
{
  "idempotency_key": "{auto-generated UUID}",
  "node_name": "{user-defined node name in n8n}",
  "worker_type": "agent",
  "worker_slug": "{agentSlug}",
  "model": "{model_name from snapshot}",
  "model_provider": "{model_provider from snapshot}",
  "status": "success" or "error",
  "duration_seconds": 4.28,
  "input_size": 1200,
  "output_size": 340,
  "error_message": "only if status is error",
  "request_payload": { "the prompt and parameters sent to AI API" },
  "response_payload": { "the AI API response" }
}
```

**Step 7.1 — Check threshold response:**

The `/logs` endpoint returns:

```json
{
  "data": {
    "max_time": 300,
    "time_consumed": 47,
    "max_cost": 5.00,
    "cost_consumed": 0.2156,
    "abort": false
  }
}
```

If `abort` is `true`:
1. Call `POST /api/machine/workflow-executions/:executionId/terminate` with reason: `"Execution aborted: cost or time threshold exceeded"`
2. Halt the workflow

**Step 8 — Handle errors with retries:**

If the AI API call returned an error:
- If retries enabled and not exhausted: go back to Step 5 (each retry also logs via Step 7, with its own idempotency key)
- If retries exhausted or not enabled:
  1. Call `/terminate` with reason describing the error
  2. Halt the workflow

**Step 9 — Success output:**

If the AI API call succeeded and `abort` is false, the node outputs:

```json
{
  "response": "the AI response text",
  "model": "GPT-4o",
  "model_provider": "openai",
  "agent_slug": "script_writer",
  "input_tokens": 1200,
  "output_tokens": 340,
  "duration_seconds": 4.28,
  "cost_consumed": 0.2156,
  "abort": false
}
```

---

## 2. Service Node

### Purpose

Executes external service API calls using configuration from the service_config_snapshot. The operator configures service URLs, headers, methods, and retry policies in the Circus UI. The workflow developer places the Service node and specifies the service slug.

### User Configuration (n8n UI)

**Main tab:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `serviceSlug` | string | Yes | — | Service slug matching an entry in `service_config_snapshot.service_assignments[].service_slug` |

**Payload tab:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `requestBody` | json | No | — | Payload to send with the API call. Works like n8n's HTTP Request node — developer configures freely. |

No retry, URL, headers, or method configuration — all provided by the snapshot.

### Runtime Behavior

**Step 0 — Start duration timer.**

**Step 1 — Resolve service configuration from snapshot:**

Read `service_config_snapshot.service_assignments[]` from the webhook payload. Find the entry where `service_slug` matches the configured `serviceSlug`.

Snapshot entry structure:
```json
{
  "service_slug": "elevenlabs-tts",
  "api_url": "https://api.elevenlabs.io/v1/text-to-speech/{{VOICE_ID}}/with-timestamps",
  "compiled_api_url": "https://api.elevenlabs.io/v1/text-to-speech/abc123def456/with-timestamps",
  "method": "POST",
  "num_retries": 2,
  "unit": "characters",
  "per_unit": 1000,
  "headers": [
    { "name": "xi-api-key", "value": "{{ELEVENLABS_API_KEY}}" }
  ],
  "variables": [
    { "name": "VOICE_ID", "value": "abc123def456" }
  ]
}
```

If no matching entry found:
1. Call `/logs` with error log
2. Call `/terminate` with reason: `"Service slug '{serviceSlug}' not found in service configuration snapshot"`
3. Halt the workflow

If the snapshot entry exists, the node assumes all values are valid and uses them as provided without additional checks.

**Step 2 — Resolve header variables:**

For each header in the snapshot entry, check for `{{...}}` patterns. For each variable:
1. Look up in n8n credentials first
2. Fall back to n8n environment variables
3. If not found: call `/logs` with a warning log explaining the unresolved variable. Do NOT halt the workflow — let the API call proceed (it may still succeed, or the external service error will be caught in Step 3).

Use `compiled_api_url` from the snapshot (URL variables already resolved by the platform).

**Step 3 — Execute service API call:**

Make the HTTP request using:
- URL: `compiled_api_url` from snapshot
- Method: `method` from snapshot
- Headers: resolved headers from Step 2
- Body: `requestBody` from user configuration

**Step 4 — Handle errors with retries:**

Retry count comes from `num_retries` in the snapshot.

If the API call failed:
- If retries not exhausted:
  1. Call `/logs` with error log (auto-generated idempotency key per attempt)
  2. Check `/logs` response for `abort` flag — if true, call `/terminate` and halt
  3. Retry the API call
- If retries exhausted or `num_retries` is 0:
  1. Call `/logs` with error log
  2. Call `/terminate` with reason describing the error
  3. Halt the workflow

**Step 5 — Success output:**

Calculate duration:
```ts
const durationSeconds = (Date.now() - startTime) / 1000
```

If the service API call succeeded, the node passes forward:

```json
{
  "response": "the service API response body",
  "statusCode": 200,
  "service_slug": "elevenlabs-tts",
  "worker_type": "service",
  "worker_slug": "elevenlabs-tts",
  "node_name": "{user-defined node name in n8n}",
  "unit": "characters",
  "per_unit": 1000,
  "duration_seconds": 2.15,
  "request_payload": { "the request sent to the service" },
  "response_payload": { "the service response" }
}
```

This output contains the fields needed by the Log node to create a cost log entry. The workflow developer is expected to place a Log node after the Service node (or after intermediate processing to extract the consumption count).

**Important:** The Service node does NOT auto-log on success. Cost reporting requires the developer to use a Log node because the consumption count (`input_size`/`output_size`) may need extraction from the service response, which is service-specific.

---

## 3. Log Node

### Purpose

Creates a log entry on the Circus platform for any workflow step. Used after Service nodes, custom HTTP nodes, or any step where the developer wants to record execution data and check cost/time thresholds.

Not used for Agent nodes — Agent nodes handle their own logging internally.

### User Configuration (n8n UI)

**Main tab:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `nodeName` | string | Yes | — | Name of the workflow step being logged |
| `workerType` | enum | Yes | — | `service` or `internal` only. Agent is not available — Agent nodes self-log. |
| `workerSlug` | string | Yes | — | Slug identifying the service for cost lookup (when `workerType` is `service`). For `internal`, use a descriptive slug. |
| `status` | enum | Yes | — | `success` or `error` |
| `durationSeconds` | number | No | — | Step execution time in seconds |
| `inputSize` | number | No | — | Consumption input (service-defined units for services, 0 for internal) |
| `outputSize` | number | No | — | Consumption output (service-defined units for services, 0 for internal) |
| `errorMessage` | string | No | — | Error description (for failed steps) |
| `requestPayload` | json | No | — | Request data to store |
| `responsePayload` | json | No | — | Response data to store |

**Advanced/Settings tab:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enableRetries` | boolean | No | false | Enable retries on /log endpoint failures |
| `maxRetries` | number | No | 0 | Number of retry attempts |
| `terminateOnError` | boolean | No | false | If true, terminate the workflow when /log call fails (after retries exhausted) |

### API Call

`POST /api/machine/workflow-executions/:executionId/logs`

**Request body:**

```json
{
  "idempotency_key": "{auto-generated UUID}",
  "node_name": "{nodeName}",
  "worker_type": "{workerType}",
  "worker_slug": "{workerSlug}",
  "status": "{status}",
  "duration_seconds": 4.28,
  "input_size": 1200,
  "output_size": 340,
  "error_message": "optional error description",
  "request_payload": {},
  "response_payload": {}
}
```

Note: `model` and `model_provider` fields are NOT sent — they are only relevant for `worker_type = agent`, which this node does not support.

The `idempotency_key` is auto-generated. If the `/log` call is retried, the same key is reused to prevent duplicate rows.

### Response Handling

**On success (201):**

Response:
```json
{
  "data": {
    "max_time": 300,
    "time_consumed": 47,
    "max_cost": 5.00,
    "cost_consumed": 0.2156,
    "abort": false
  }
}
```

If `abort` is `true`:
1. Call `POST /api/machine/workflow-executions/:executionId/terminate` with reason: `"Execution aborted: cost or time threshold exceeded"`
2. Halt the workflow

If `abort` is `false`: continue workflow execution.

**On failure:**

If retries enabled and not exhausted: retry with same idempotency key.
If retries exhausted:
- If `terminateOnError` is true:
  1. Call `/terminate` with reason: `"Log endpoint failed after {maxRetries} retries"`
  2. Halt the workflow
- If `terminateOnError` is false: continue workflow execution (log failure is swallowed).

### Output

```json
{
  "logged": true,
  "cost_consumed": 0.2156,
  "time_consumed": 47,
  "abort": false
}
```

---

## 4. Terminate Node

### Purpose

Terminates a workflow execution on the Circus platform due to an error. Used in error branches where the developer needs explicit termination control. Should not be used with nodes that self-terminate (Agent, Service, or Log with `terminateOnError` enabled).

### User Configuration (n8n UI)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `reason` | string | No | — | Termination reason. Supports static text or dynamic n8n expressions. |

### API Call

`POST /api/machine/workflow-executions/:executionId/terminate`

**Request body:**

```json
{
  "reason": "{reason or empty string}"
}
```

### Runtime Behavior

1. Make the API call to `/terminate`
2. Do not check or act on the response status — fire and forget
3. Halt the n8n workflow execution (throw NodeOperationError)

### Output

None — the workflow is terminated.

---

## 5. Complete Node

### Purpose

Marks a workflow execution as successfully completed on the Circus platform and transmits the result artifacts.

### User Configuration (n8n UI)

**Main tab:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `resultPayload` | json | Yes | — | JSON object containing the workflow output. Structure is plugin-specific and opaque to the node. |

**Advanced/Settings tab:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enableRetries` | boolean | No | false | Enable retries on /complete endpoint failures |
| `maxRetries` | number | No | 0 | Number of retry attempts |

### API Call

`POST /api/machine/workflow-executions/:executionId/complete`

**Request body:**

```json
{
  "result_payload": { ... }
}
```

The `result_payload` is the value from the `resultPayload` configuration field.

Example:
```json
{
  "result_payload": {
    "outputs": [
      { "output_type": "text", "content": "Generated script content..." },
      { "output_type": "media", "content": "https://s3.example.com/video.mp4" }
    ]
  }
}
```

### Response Handling

**On success (200):**

Response:
```json
{
  "data": {
    "message": "Execution completed successfully"
  }
}
```

The n8n workflow ends gracefully. No additional `/log` or `/terminate` calls.

**On failure (after retries exhausted):**

1. Call `/logs` with error log:
```json
{
  "idempotency_key": "{auto-generated UUID}",
  "node_name": "circus-complete",
  "worker_type": "internal",
  "worker_slug": "system",
  "status": "error",
  "error_message": "Complete endpoint failed after {maxRetries} retries: {error details}"
}
```
2. Call `/terminate` with reason: `"Failed to complete execution: {error details}"`
3. Halt the workflow (failure state)

### Output

```json
{
  "completed": true,
  "message": "Execution completed successfully"
}
```

---

## 6. Set Remote Execution ID Node

### Purpose

Registers n8n's internal execution ID with the Circus platform, enabling future remote termination of the workflow. Optional but recommended as the first node after the webhook trigger.

### User Configuration (n8n UI)

**Advanced/Settings tab:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enableRetries` | boolean | No | false | Enable retries on failures |
| `maxRetries` | number | No | 0 | Number of retry attempts |

No main tab fields — the node automatically extracts n8n's execution ID from the runtime context.

### API Call

**NOTE: This endpoint does not exist yet and will be developed as part of this work.**

`PATCH /api/machine/workflow-executions/:executionId/remote-execution-id`

**Request body:**

```json
{
  "external_execution_id": "{n8n's internal execution ID}"
}
```

The `executionId` in the URL path is the Circus workflow execution ID from the webhook payload.
The `external_execution_id` in the body is n8n's internal execution ID, obtained from n8n's runtime context.

### Response Handling

**On failure (after retries exhausted):**

Call `/logs` with error log:
```json
{
  "idempotency_key": "{auto-generated UUID}",
  "node_name": "circus-set-remote-execution-id",
  "worker_type": "internal",
  "worker_slug": "system",
  "status": "error",
  "error_message": "Failed to set remote execution ID: {error details}"
}
```

Do NOT halt the workflow — continue execution.

**On success:** Continue execution.

### Output

```json
{
  "set": true,
  "external_execution_id": "{n8n's execution ID}"
}
```

---

## Shared: Error Logging Pattern

When any node needs to log an error to the Circus platform (before terminating or continuing), it calls:

`POST /api/machine/workflow-executions/:executionId/logs`

```json
{
  "idempotency_key": "{auto-generated UUID}",
  "node_name": "{node's user-defined name or component identifier}",
  "worker_type": "internal",
  "worker_slug": "system",
  "status": "error",
  "error_message": "{descriptive error message}",
  "request_payload": null,
  "response_payload": null
}
```

For Agent and Service nodes logging their own API call results, `worker_type` and `worker_slug` match the agent/service being executed, not `internal`/`system`.

---

## Shared: Termination Pattern

When any node needs to terminate the remote execution:

`POST /api/machine/workflow-executions/:executionId/terminate`

```json
{
  "reason": "{descriptive reason}"
}
```

After calling terminate, the node halts the n8n workflow by throwing a `NodeOperationError`.

---

## n8n Node Package

### Package name

`@circus-sh/n8n-nodes-circus`

### Structure

The package must follow the n8n community nodes starter template. Scaffold using n8n's official tooling. Do not create a custom directory structure.

### Publishing

From May 1st 2026, nodes submitted for verification must be published using GitHub Actions with a provenance statement. The publishing workflow:

1. Runs on version tag push (e.g. `v1.0.0`)
2. Publishes to npm with `--provenance` flag
3. Uses GitHub's OIDC token or a traditional npm granular access token
4. Provenance lets anyone cryptographically verify which repository and commit built the package

After publishing, submit for verification through the n8n Creator Portal.

### Provider Extensibility Note

When a new AI provider is added to the Circus platform's model registry, the Agent node needs a corresponding case in its request builder (Step 4) and response parser (Step 6). Until a case is added, unknown providers fall back to the OpenAI request structure. This is a maintenance point — document new provider additions in the changelog.