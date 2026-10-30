# Circus n8n Nodes — Detailed Specification

This document defines five custom n8n nodes for the Circus AI Workflow Orchestration Platform. It includes exact API endpoints, field names, types, and request/response structures from the core API contract.

---

## Shared: Circus API Credential Type

All Circus nodes share a single credential type for authenticating with the Circus platform. Defined once, reused by every node.

**Credential name:** `circusApi`
**Display name:** `Circus API`

**Credential fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `apiKey` | string (password) | Yes | Circus Platform API Key (JWT signed with `workflow_jwt_secret`) |
| `apiUrl` | string | Yes | Circus Platform API base URL (e.g. `https://staging.circus.sh`) |

**Authentication method:** `Authorization: Bearer {apiKey}` header on all requests to `/api/machine/*` endpoints. Implemented as a generic header auth type.

**Credential test:** On save, call `POST {apiUrl}/api/machine/health`. If 200 with `{ "data": { "status": "ok" } }`, credentials are valid.

---

## Shared: AI Provider Credentials

The Agent node requires AI provider API keys. These are stored as separate n8n credential types, one per provider. The Agent node declares all supported providers in its credential configuration and resolves the correct one at runtime based on the `model_provider` value from the snapshot.

**Supported credential types:**

| Credential name | Display name | Auth method | Test endpoint |
|-----------------|-------------|-------------|---------------|
| `circusOpenaiApi` | Circus OpenAI API | `Authorization: Bearer` header | `GET https://api.openai.com/v1/models` |
| `circusAnthropicApi` | Circus Anthropic API | `x-api-key` header + `anthropic-version: 2023-06-01` | `POST https://api.anthropic.com/v1/messages` (minimal request) |
| `circusGoogleApi` | Circus Google AI API | API key as query parameter | `GET https://generativelanguage.googleapis.com/v1beta/models?key={apiKey}` |
| `circusXaiApi` | Circus xAI API | `Authorization: Bearer` header | `GET https://api.x.ai/v1/models` |

Each credential type has a single field: `apiKey` (string, password, required).

The AI provider credentials do not use n8n's `IAuthenticateGeneric` — authentication is handled manually inside the Agent node's request builder because each provider requires a different auth scheme (Bearer header, custom header, query parameter).

At runtime, the Agent node maps `model_provider` from the snapshot to a credential name using the pattern `circus${capitalize(model_provider)}Api` (e.g. `openai` → `circusOpenaiApi`). If the credential is not configured in n8n, the node terminates the execution.

The user configures these once in n8n's credential manager — not per node.

---

## Shared: Execution Context

The Init node stores execution context in n8n's execution custom data. All downstream Circus nodes retrieve this context via the `getCircusContext()` helper function from `nodes/shared/circusContext.ts`.

**Custom data stored by Init:**

| Key | Value | Description |
|-----|-------|-------------|
| `circus_init_node` | Node name | The Init node's display name, so downstream nodes can reference it dynamically |
| `circus_workflow_execution_id` | String | From `body.workflow_execution_id` in the webhook payload |
| `circus_external_execution_id` | String | n8n's internal execution ID (via `this.getExecutionId()`) |

Note: Custom data values are limited to 255 characters per value and 10 entries total. Only short string values (IDs, node name) are stored here.

**`getCircusContext()` returns:**

```ts
interface CircusContext {
  workflowExecutionId: string
  externalExecutionId: string
  apiUrl: string
  baseUrl: string      // ${apiUrl}/api/machine/workflow-executions/${workflowExecutionId}
  initNodeName: string
}
```

If the Init node has not run (custom data missing), `getCircusContext()` throws a `NodeOperationError` instructing the user to place a Circus Init node before the current node.

**Snapshot access:** Downstream nodes access webhook payload snapshots (e.g. `workflow_config_snapshot`, `system_snapshot`) via the `getSnapshot()` helper, which evaluates the n8n expression `$('${initNodeName}').item.json.body.${snapshotKey}` against the Init node's output.

The webhook payload structure (sent by the Circus platform when starting an execution):

```json
{
  "workflow_execution_id": "5",
  "workspace_id": "1",
  "workflow_id": "1",
  "run_reason": "new",
  "workflow_config_snapshot": { ... },
  "system_snapshot": { ... },
  "workspace_snapshot": { ... }
}
```

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

## 1. Init Node

### Purpose

Initializes the Circus execution context. Must be placed directly after the Webhook trigger node. Validates the JWT token (if present), registers execution start with the platform, and stores execution context in n8n's custom data for all downstream Circus nodes.

**Internal name:** `circusInit`
**Group:** `input`

### User Configuration (n8n UI)

**Credentials:** `circusApi` (required) — used for the `/logs` call to register execution start.

No additional user-configurable properties (the properties array is empty). The node auto-detects the webhook payload structure and JWT presence.

### Runtime Behavior

**Step 1 — Validate webhook payload:**

Verify that the input contains `body` and `body.workflow_execution_id`. If `body` is missing, throw `NodeOperationError` ("No webhook payload found. Place this node directly after a Webhook trigger node."). If `workflow_execution_id` is missing, throw `NodeOperationError` ("Missing workflow_execution_id in webhook payload.").

**Step 2 — Validate JWT (if present):**

If `jwtPayload` is present in the input item (auto-populated by n8n when the Webhook node is configured with JWT auth), validate:

- `sub` matches `workflow_execution_id` from the body (string comparison)
- `iss` is `"circus"`
- `iat` must be a finite number (`typeof === 'number' && Number.isFinite()`), and not in the future (compared to `Math.floor(Date.now() / 1000)`)
- `exp` must be a finite number (`typeof === 'number' && Number.isFinite()`), and not expired (`exp <= now` means expired, per RFC 7519)

If any check fails, throw `NodeOperationError` immediately. **Do NOT call `/terminate`** — the `workflow_execution_id` may be forged or mismatched, so it cannot be trusted to identify a valid execution on the platform. The Circus background service will detect the stale execution and mark it as failed via timeout.

If `jwtPayload` is not present (Webhook not configured with JWT auth), skip validation and proceed.

**Step 3 — Store execution context:**

Store the following in n8n's execution custom data (via `this.customData.set()`):

- `circus_init_node` — this node's name (so downstream nodes can reference it dynamically via expressions)
- `circus_workflow_execution_id` — from the webhook payload
- `circus_external_execution_id` — n8n's internal execution ID (via `this.getExecutionId()`)

**Step 4 — Register execution start:**

Call `POST /api/machine/workflow-executions/:executionId/logs` (best-effort):

```json
{
  "idempotency_key": "{auto-generated UUID}",
  "external_execution_id": "{n8n's internal execution ID}",
  "node_name": "circus-init",
  "worker_type": "internal",
  "worker_slug": "system",
  "status": "success",
  "response_payload": {
    "message": "Execution started (external_execution_id: {n8nExecutionId})"
  }
}
```

If the `/logs` call fails, the node continues — execution start registration is informational and should not block the workflow. The error is silently swallowed.

**Step 5 — Pass through:**

Forward the webhook input item unchanged.

### Output

The webhook payload, unchanged. Downstream nodes access snapshots via expression evaluation against this node's output (e.g. `$('Circus Init').item.json.body.workflow_config_snapshot`), resolved dynamically using the node name stored in custom data.

### Error Handling

`NodeOperationError` is re-thrown directly for validation failures. For unexpected errors, the node checks `continueOnFail()` — if true, pushes `{ json: { error: message } }` to output; otherwise throws `NodeOperationError`.

---

## 2. Agent Node

### Purpose

Enables operator-controlled AI execution. The operator configures models, prompts, and agents in the Circus UI. The workflow developer places the Agent node in n8n and specifies which agent (by slug) to use. The Agent node reads the snapshot to determine which model, prompt, parameters, and API endpoint to use at runtime — no hardcoded AI provider configuration in n8n.

**Internal name:** `circusAgent`
**Group:** `output`

**Why this node exists:** Without it, changing a model from GPT-4o to Claude, or updating a prompt, requires editing the n8n workflow. With the Agent node, the operator makes these changes in the Circus UI and the next execution automatically uses the new configuration.

### User Configuration (n8n UI)

**Credentials declared in node description:**

| Credential name | Display name | Required |
|-----------------|-------------|----------|
| `circusApi` | Circus Platform API | Yes |
| `circusOpenaiApi` | OpenAI API Key | No |
| `circusAnthropicApi` | Anthropic API Key | No |
| `circusGoogleApi` | Google AI API Key | No |
| `circusXaiApi` | xAI API Key | No |

All AI provider credentials are declared as optional in the node description. At runtime, the node determines which one to use based on `model_provider` from the snapshot.

**Main tab properties:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `agentSlug` | string | Yes | `''` | Agent slug matching an entry in `workflow_config_snapshot.agent_assignments[].agent_slug` |
| `inputText` | string | No | `''` | The work item to process. Supports n8n expressions — can reference previous node output, webhook payload fields (e.g. workspace snapshot), or static text. Sent as a separate user message after the prompt. Multi-line input (4 rows). |
| `includeSystemContext` | boolean | No | `false` | Whether to include system context entries in the prompt |
| `systemContextEntries` | string | No | `''` | Comma-separated list of system context keys to include (if `includeSystemContext` is true). Empty means all. Only shown when `includeSystemContext` is true. |
| `missingContextBehavior` | options | No | `ignore` | How to handle missing system context entries: `fail`, `ignore`, `ignore_and_report`. Only shown when `includeSystemContext` is true. |

**Advanced/Settings tab:**

No custom retry configuration. Use n8n's built-in "Retry On Fail" setting (in the node's Settings tab) for transient AI API failures. See Step 8 for how the node handles errors based on the user's On Error configuration.

### Runtime Behavior

**Step 0 — Start duration timer:**

```ts
const startTime = Date.now()
```

**Step 1 — Resolve agent configuration from snapshot:**

Call `getSnapshot()` to retrieve `workflow_config_snapshot` from the Init node's output. Find the entry in `agent_assignments[]` where `agent_slug` matches the configured `agentSlug`.

Snapshot entry structure:
```json
{
  "agent_id": 3,
  "agent_name": "Script Writer",
  "agent_slug": "script_writer",
  "model_id": 1,
  "model_name": "GPT-4o",
  "model_provider": "openai",
  "model_base_url": "https://api.openai.com/v1/chat/completions",
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
2. Call `POST /api/machine/workflow-executions/:executionId/terminate` with `external_execution_id` and reason: `"Agent slug '{agentSlug}' not found in workflow configuration snapshot"`
3. Throw `NodeOperationError`.

**Step 2 — Validate agent parameters:**

From the resolved snapshot entry, verify:
- `model_provider` is defined and non-empty
- `model_name` is defined and non-empty
- `model_base_url` is defined and non-empty
- `max_tokens` is a positive integer
- `temperature` is between 0 and 2 (inclusive)
- Corresponding AI provider API key exists in n8n credentials — the credential name is constructed as `circus${capitalize(model_provider)}Api` (e.g. `openai` → `circusOpenaiApi`)

If any validation fails:
1. Call `/logs` endpoint with error log
2. Call `/terminate` endpoint with `external_execution_id` and reason describing the missing parameter.
3. Throw `NodeOperationError`.

**Step 3 — Build prompt with system context:**

If `includeSystemContext` is true:
- Call `getSnapshot()` to retrieve `system_snapshot` from the Init node's output
- Read `system_context` (a `Record<string, string>`) from the system snapshot
- If `systemContextEntries` is empty: include all entries
- If `systemContextEntries` is specified: split comma-separated string, trim whitespace, include only listed keys
  - For each specified key not found in `system_context`, apply `missingContextBehavior`:
    - `ignore`: skip silently
    - `ignore_and_report`: skip, but call `/logs` with a warning log reporting the missing key
    - `fail`: call `/logs` with error, call `/terminate` with `external_execution_id`, throw `NodeOperationError`

Build the system context string as `key: value` pairs joined by newlines.

Assemble the final prompt in up to three parts:
- **System message:** system context string (only if non-empty)
- **User message 1 (instruction):** `prompt_text` from the snapshot
- **User message 2 (input):** `inputText` from the node configuration — the actual work item to process

The prompt and input are sent as separate messages so the AI provider sees the prompt as the instruction and the input as the work item. The prompt does not need `{input}` placeholders or template syntax.

**Step 4 — Build provider-specific request:**

Read `model_base_url` from the snapshot. This is the endpoint the AI API call will be made to.

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
The system message is omitted if there is no system context. Auth via `Authorization: Bearer {apiKey}` header.

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
The `system` field is omitted if there is no system context. The `temperature` field is omitted for the `claude-opus-4-8` model (provider limitation). Auth via `x-api-key: {apiKey}` header plus `anthropic-version: 2023-06-01` header.

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
The `system_instruction` field is omitted if there is no system context. Auth via `?key={apiKey}` query parameter appended to the URL.

The provider switch uses `model_provider` value. Unknown providers fall back to the OpenAI request structure.

**NOTE:** When a new AI provider is added to the Circus platform's model registry, a corresponding case should be added to the Agent node's `buildProviderRequest()` and `parseProviderResponse()` functions. Until then, the node falls back to OpenAI structure, which may or may not work with the new provider.

**Step 5 — Execute AI API call:**

Make the HTTP request to `model_base_url` using `this.helpers.httpRequest()` (not `httpRequestWithAuthentication` — auth is handled manually in the request builder). On error, the node captures the status code and response body for logging but does not throw yet.

**Step 6 — Parse response and extract token usage:**

Extract the AI response text and token counts using provider-specific parsing via `parseProviderResponse()`:

**OpenAI / xAI / default:**
- `inputTokens` = `usage.prompt_tokens`
- `outputTokens` = `usage.completion_tokens`
- Response text = `choices[0].message.content`

**Anthropic:**
- `inputTokens` = `usage.input_tokens`
- `outputTokens` = `usage.output_tokens`
- Response text = `content[0].text`

**Google:**
- `inputTokens` = `usageMetadata.promptTokenCount`
- `outputTokens` = `usageMetadata.candidatesTokenCount`
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
  "response_payload": { "the AI API response" },
  "external_execution_id": "{n8n's internal execution ID}"
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
1. Call `POST /api/machine/workflow-executions/:executionId/terminate` with `external_execution_id` and reason: `"Execution aborted: cost or time threshold exceeded"`
2. Throw `NodeOperationError` with "Execution aborted: cost or time threshold exceeded"

**Step 8 — Handle errors:**

If the AI API call returned an error, the error is already logged in Step 7. The node then throws `NodeApiError` (API failure, not a configuration error).

**Note:** All `/logs` and `/terminate` calls made by the Agent node are best-effort — if the platform API call itself fails, the error is silently swallowed and the node continues with its primary error handling logic. This prevents a platform outage from masking the original AI API error.

**Path 1 — On Error: Stop Workflow (n8n built-in, recommended):**

- If "Retry On Fail" is enabled:
  - Do NOT call `/terminate` — let n8n retry.
  - Throw `NodeApiError`. n8n may repeat the entire node's execute() from scratch. This will include new validation, a new AI API call (with additional cost), and new logs via Step 7 with a new idempotency key.
  - The node cannot know if retries are exhausted. If n8n eventually gives up, the Circus background service detects the stale execution and marks it as failed.
- If "Retry On Fail" is not enabled:
  - Call `/terminate` with `external_execution_id` immediately — no retry is coming.
  - Throw `NodeApiError`.

**Path 2 — On Error: anything other than "Stop Workflow" (Continue variants):**

The node detects this via `this.continueOnFail()`. Instead of letting n8n continue in a broken state:

1. Call `/terminate` with `external_execution_id` to trigger remote termination. The platform calls n8n's `POST /api/v1/executions/{id}/stop` to kill the execution.
2. Throw `NodeApiError`.
3. n8n catches the error and retries or continues — but the platform's remote stop kills the execution. The remote termination may arrive after n8n has already continued to the next node, but that is acceptable.

**Step 9 — Success output:**

If the AI API call succeeded and `abort` is false, the node outputs:

```json
{
  "response": "the AI response text (parsed as JSON if valid, raw string otherwise)",
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

The `cost_consumed` value comes from the `/logs` response. If the log response data is unavailable, it defaults to `0`.

---

## 3. Log Node

### Purpose

Creates a log entry on the Circus platform for any workflow step. Used after custom HTTP nodes or any step where the developer wants to record execution data and check cost/time thresholds.

Not used for Agent nodes — Agent nodes handle their own logging internally.

**Internal name:** `circusLog`
**Group:** `output`

### User Configuration (n8n UI)

**Main tab:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `nodeName` | string | Yes | `''` | Name of the workflow step being logged |
| `workerType` | options | Yes | `internal` | `service` or `internal` only. Agent is not available — Agent nodes self-log. |
| `workerSlug` | string | Yes | `''` | Slug identifying the service for cost lookup (when `workerType` is `service`). For `internal`, use a descriptive slug. |
| `status` | options | Yes | `success` | `success` or `error` |
| `durationSeconds` | number | No | `0` | Step execution time in seconds |
| `inputSize` | number | No | `0` | Consumption input (service-defined units for services, 0 for internal) |
| `outputSize` | number | No | `0` | Consumption output (service-defined units for services, 0 for internal) |
| `errorMessage` | string | No | `''` | Error description (only shown when `status` is `error`) |
| `requestPayload` | json | No | `''` | Request data to store |
| `responsePayload` | json | No | `''` | Response data to store |

The `external_execution_id` is automatically added to the request by the node via `getCircusContext()`.

**Subtitle:** Displays `{workerType} / {status}` dynamically.

**Advanced/Settings tab:**

No custom retry or terminate configuration. Use n8n's built-in "Retry On Fail" setting for transient /log endpoint failures.

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
  "response_payload": {},
  "external_execution_id": "{n8n's internal workflow execution id}"
}
```

Note: `model` and `model_provider` fields are NOT sent — they are only relevant for `worker_type = agent`, which this node does not support.

Optional fields (`durationSeconds`, `inputSize`, `outputSize`, `errorMessage`, `requestPayload`, `responsePayload`) are only included in the request body if they have truthy values.

The `idempotency_key` is auto-generated per execution. If the `/log` call is retried by n8n, the same key is reused to prevent duplicate rows.

The API call uses `httpRequestWithAuthentication('circusApi', ...)` which automatically injects the Bearer token.

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
1. Call `POST /api/machine/workflow-executions/:executionId/terminate` with `external_execution_id` and reason: `"Execution aborted: cost or time threshold exceeded"`
2. Throw `NodeOperationError`

If `abort` is `false`: continue workflow execution.

**On failure (the /log API call itself failed):**

1. Read node settings: `this.continueOnFail()`, `node.retryOnFail`

**Path 1 — On Error: Stop Workflow (recommended):**

- If "Retry On Fail" is enabled:
  - Do NOT call `/terminate` — let n8n retry.
  - Throw `NodeApiError`. n8n may retry the node's execute() from scratch.
  - The node cannot know if retries are exhausted. If n8n eventually gives up, the Circus background service detects the stale execution and marks it as failed.
- If "Retry On Fail" is not enabled:
  - Call `/terminate` with `external_execution_id` — no retry is coming.
  - Throw `NodeApiError`.


**Path 2 — On Error: anything other than "Stop Workflow" (Continue variants):**

- Call `/terminate` with `external_execution_id` to trigger remote termination. Regardless of retry setting — continuing after a failed log is dangerous because threshold checks won't work.
- Throw `NodeApiError`.
- n8n catches the error and retries or continues — but the platform's remote stop kills the execution.

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

Terminates a workflow execution on the Circus platform due to an error. This node is intended to be the **last node** in the workflow in an error branch. Should not be used with nodes that self-terminate (Agent or Log).

**Internal name:** `circusTerminate`
**Group:** `output`

### User Configuration (n8n UI)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `reason` | string | No | `''` | Termination reason. Supports static text or dynamic n8n expressions. |

The `workflow_execution_id` and `external_execution_id` are obtained automatically via `getCircusContext()` — not configured by the user.

### API Call

`POST /api/machine/workflow-executions/:executionId/terminate`

**Request body:**

```json
{
  "reason": "{reason or empty string}",
  "external_execution_id": "{n8n's internal execution ID}"
}
```

The API call uses `httpRequestWithAuthentication('circusApi', ...)` which automatically injects the Bearer token.

### Runtime Behavior

1. Read `reason` parameter and call `getCircusContext()`.
2. Make the API call to `/terminate` with `external_execution_id`.
3. On success: return output data.
4. On failure:
   - Attempt to record a log entry by calling `/logs` (best-effort, node_name: `'circus-terminate'`, worker_type: `'internal'`, status: `'error'`)
   - Throw `NodeApiError`

### Output

```json
{
  "terminated": true,
  "reason": "{reason}"
}
```

---

## 5. Complete Node

### Purpose

Marks a workflow execution as successfully completed on the Circus platform and transmits the result artifacts. This node is intended to be used as the last node in the success branch of the workflow and to transmit ALL resulting artifacts back to the platform. Executing this node will mark the execution as completed in the Circus platform, but it will not automatically stop the workflow execution.

**Internal name:** `circusComplete`
**Group:** `output`

### User Configuration (n8n UI)

**Main tab:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `resultPayload` | json | Yes | `'{}'` | JSON object containing the workflow output. Structure is plugin-specific and opaque to the node — the node does not validate its contents. |

The `workflow_execution_id` and `external_execution_id` are obtained automatically via `getCircusContext()` — not configured by the user.

**Advanced/Settings tab:**

No custom retry configuration. Use n8n's built-in "Retry On Fail" setting for transient /complete endpoint failures.

### API Call

`POST /api/machine/workflow-executions/:executionId/complete`

**Request body:**

```json
{
  "result_payload": { ... },
  "external_execution_id": "{n8n's internal execution ID}"
}
```

The `result_payload` is the parsed value from the `resultPayload` configuration field.

The API call uses `httpRequestWithAuthentication('circusApi', ...)` which automatically injects the Bearer token.

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

**On failure (the /complete API call failed):**

1. Call `/logs` with error log (best-effort, do not fail if this also fails):
```json
{
  "idempotency_key": "{auto-generated UUID}",
  "node_name": "circus-complete",
  "worker_type": "internal",
  "worker_slug": "system",
  "status": "error",
  "error_message": "Complete endpoint failed: {error details}",
  "external_execution_id": "{n8n's internal execution ID}"
}
```

2. Read node settings: `this.continueOnFail()`, `node.retryOnFail`

**Path 1 — On Error: Stop Workflow (recommended):**

- If "Retry On Fail" is enabled:
  - Do NOT call `/terminate` — let n8n retry. The /complete call may succeed on retry.
  - Throw `NodeApiError`.
  - The node cannot know if retries are exhausted. If n8n eventually gives up, the Circus background service detects the stale execution and marks it as failed.
- If "Retry On Fail" is not enabled:
  - Call `/terminate` with `external_execution_id` and reason: `"Failed to complete execution: {error details}"` — no retry is coming.
  - Throw `NodeApiError`.

**Path 2 — On Error: anything other than "Stop Workflow" (Continue variants):**

- Call `/terminate` with `external_execution_id` and reason: `"Failed to complete execution: {error details}"`. Regardless of retry setting — continuing after a failed /complete means the execution stays in "running" state indefinitely.
- Throw `NodeApiError`.
- n8n catches the error and retries or continues — but the platform's remote stop kills the execution.

### Output

```json
{
  "completed": true,
  "message": "Execution completed successfully"
}
```

---

## Shared: Error Type Convention

All nodes use two error types from the `n8n-workflow` package:
- **`NodeApiError`** — for API call failures (AI provider calls, Circus platform `/logs`, `/terminate`, `/complete` endpoint failures). These are transient errors that may succeed on retry.
- **`NodeOperationError`** — for configuration/validation errors (missing agent slug, invalid parameters, threshold breaches). These are permanent errors that will fail identically on retry.

---

## Shared: Error Logging Pattern

When any node needs to log an error to the Circus platform (before terminating or continuing), it calls:

`POST /api/machine/workflow-executions/:executionId/logs`

```json
{
  "idempotency_key": "{auto-generated UUID}",
  "external_execution_id": "{n8n's internal execution ID}",
  "node_name": "{node's user-defined name or component identifier}",
  "worker_type": "internal",
  "worker_slug": "system",
  "status": "error",
  "error_message": "{descriptive error message}",
  "request_payload": null,
  "response_payload": null
}
```

The `external_execution_id` is included in every API call. If the platform hasn't stored it yet, it patches the database on first encounter.

For Agent nodes logging their own API call results, `worker_type` and `worker_slug` match the agent being executed, not `internal`/`system`.

---

## Shared: Termination Pattern

When any node needs to terminate the remote execution:

`POST /api/machine/workflow-executions/:executionId/terminate`

```json
{
  "reason": "{descriptive reason}",
  "external_execution_id": "{n8n's internal execution ID}"
}
```

The `external_execution_id` is obtained from n8n's runtime context via `getCircusContext()`. The platform uses it to call n8n's `POST /api/v1/executions/{id}/stop` to kill the workflow remotely.

After calling terminate, the node's behavior depends on the failure type and settings:
- **Permanent failure (missing config, validation, threshold breach):** call `/terminate`, throw an error. The platform's remote stop kills the execution.
- **Transient failure + Stop Workflow + retries on:** do NOT call `/terminate`. Throw to let n8n retry. The node cannot know if retries are exhausted.
- **Transient failure + Stop Workflow + retries off:** call `/terminate`, throw an error. No retry is coming.
- **Transient failure + Continue (any variant):** call `/terminate`, throw. The platform kills the execution remotely.

---

## n8n Node Package

### Package name

`@circus_sh/n8n-nodes-circus`

### Structure

The package follows the n8n community nodes starter template. Key directories:

```
nodes/
├── CircusInit/CircusInit.node.ts
├── CircusAgent/CircusAgent.node.ts
├── CircusLog/CircusLog.node.ts
├── CircusTerminate/CircusTerminate.node.ts
├── CircusComplete/CircusComplete.node.ts
└── shared/circusContext.ts
credentials/
├── CircusApi.credentials.ts
├── CircusOpenaiApi.credentials.ts
├── CircusAnthropicApi.credentials.ts
├── CircusGoogleApi.credentials.ts
└── CircusXaiApi.credentials.ts
```

All nodes have `usableAsTool: true` set, allowing them to be used as tools in n8n's AI agent workflows.

### Publishing

From May 1st 2026, nodes submitted for verification must be published using GitHub Actions with a provenance statement. The publishing workflow:

1. Runs on version tag push (e.g. `v1.0.0`)
2. Publishes to npm with `--provenance` flag
3. Uses GitHub's OIDC token or a traditional npm granular access token
4. Provenance lets anyone cryptographically verify which repository and commit built the package

After publishing, submit for verification through the n8n Creator Portal.

### Provider Extensibility Note

When a new AI provider is added to the Circus platform's model registry, the Agent node needs:
1. A new credential type in `credentials/` (e.g. `CircusNewProviderApi.credentials.ts`)
2. A new entry in the Agent node's `credentials` array in its description
3. A corresponding case in `buildProviderRequest()` (request builder)
4. A corresponding case in `parseProviderResponse()` (response parser)

Until these are added, unknown providers fall back to the OpenAI request structure, which may or may not work with the new provider. Document new provider additions in the changelog.
