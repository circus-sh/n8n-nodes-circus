import { randomUUID } from 'node:crypto';
import type {
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

interface AgentAssignment {
	agent_id: number;
	agent_name: string;
	agent_slug: string;
	model_id: number;
	model_name: string;
	model_provider: string;
	model_base_url: string;
	prompt_id: number;
	prompt_name: string;
	prompt_slug: string;
	active_prompt_version_id: number;
	prompt_text: string;
	temperature: number;
	max_tokens: number;
}

interface ProviderRequest {
	body: Record<string, unknown>;
	headers: Record<string, string>;
	url: string;
}

interface ParsedResponse {
	responseText: string;
	inputTokens: number;
	outputTokens: number;
}

function buildProviderRequest(
	provider: string,
	modelName: string,
	systemContext: string | undefined,
	promptText: string,
	inputText: string | undefined,
	temperature: number,
	maxTokens: number,
	baseUrl: string,
	apiKey: string,
): ProviderRequest {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	let url = baseUrl;
	let body: Record<string, unknown>;

	const userMessages: Array<Record<string, unknown>> = [
		{ role: 'user', content: promptText },
	];
	if (inputText) {
		userMessages.push({ role: 'user', content: inputText });
	}

	switch (provider) {
		case 'anthropic': {
			headers['x-api-key'] = apiKey;
			headers['anthropic-version'] = '2023-06-01';
			body = {
				model: modelName,
				messages: userMessages,
				temperature,
				max_tokens: maxTokens,
			};
			if (systemContext) {
				body.system = systemContext;
			}
			break;
		}
		case 'google': {
			url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}key=${apiKey}`;
			body = {
				contents: userMessages.map((m) => ({
					role: 'user',
					parts: [{ text: m.content as string }],
				})),
				generationConfig: {
					temperature,
					maxOutputTokens: maxTokens,
				},
			};
			if (systemContext) {
				body.system_instruction = { parts: [{ text: systemContext }] };
			}
			break;
		}
		default: {
			// OpenAI, xAI, and unknown providers
			headers.Authorization = `Bearer ${apiKey}`;
			const messages: Array<Record<string, unknown>> = [];
			if (systemContext) {
				messages.push({ role: 'system', content: systemContext });
			}
			messages.push(...userMessages);
			body = {
				model: modelName,
				messages,
				temperature,
				max_tokens: maxTokens,
			};
			break;
		}
	}

	return { body, headers, url };
}

function parseProviderResponse(
	provider: string,
	responseData: Record<string, unknown>,
): ParsedResponse {
	switch (provider) {
		case 'anthropic': {
			const content = responseData.content as Array<{ text: string }>;
			const usage = responseData.usage as {
				input_tokens: number;
				output_tokens: number;
			};
			return {
				responseText: content?.[0]?.text ?? '',
				inputTokens: usage?.input_tokens ?? 0,
				outputTokens: usage?.output_tokens ?? 0,
			};
		}
		case 'google': {
			const candidates = responseData.candidates as Array<{
				content: { parts: Array<{ text: string }> };
			}>;
			const usageMetadata = responseData.usageMetadata as {
				promptTokenCount: number;
				candidatesTokenCount: number;
			};
			return {
				responseText: candidates?.[0]?.content?.parts?.[0]?.text ?? '',
				inputTokens: usageMetadata?.promptTokenCount ?? 0,
				outputTokens: usageMetadata?.candidatesTokenCount ?? 0,
			};
		}
		default: {
			// OpenAI, xAI, and unknown providers
			const choices = responseData.choices as Array<{
				message: { content: string };
			}>;
			const usage = responseData.usage as {
				prompt_tokens: number;
				completion_tokens: number;
			};
			return {
				responseText: choices?.[0]?.message?.content ?? '',
				inputTokens: usage?.prompt_tokens ?? 0,
				outputTokens: usage?.completion_tokens ?? 0,
			};
		}
	}
}

export class CircusAgent implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Circus Agent',
		name: 'circusAgent',
		icon: { light: 'file:circusAgent.svg', dark: 'file:circusAgent.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["agentSlug"]}}',
		description:
			'Execute AI agent calls using operator-configured models and prompts from the Circus platform',
		defaults: {
			name: 'Circus Agent',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'circusApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Workflow Execution ID',
				name: 'workflowExecutionId',
				type: 'string',
				required: true,
				default: '={{ $json.body.workflow_execution_id }}',
				description: 'The workflow execution ID from the webhook payload',
			},
			{
				displayName: 'Agent Slug',
				name: 'agentSlug',
				type: 'string',
				required: true,
				default: '',
				description:
					'Agent slug matching an entry in the workflow configuration snapshot',
			},
			{
				displayName: 'Input Text',
				name: 'inputText',
				type: 'string',
				typeOptions: {
					rows: 4,
				},
				default: '',
				description:
					'The work item to process. Supports n8n expressions. Sent as a separate user message after the prompt.',
			},
			{
				displayName: 'Include System Context',
				name: 'includeSystemContext',
				type: 'boolean',
				default: false,
				description: 'Whether to include system context entries in the prompt',
			},
			{
				displayName: 'System Context Entries',
				name: 'systemContextEntries',
				type: 'string',
				default: '',
				description:
					'Comma-separated list of system context keys to include. Leave empty to include all.',
				displayOptions: {
					show: {
						includeSystemContext: [true],
					},
				},
			},
			{
				displayName: 'Missing Context Behavior',
				name: 'missingContextBehavior',
				type: 'options',
				options: [
					{
						name: 'Fail',
						value: 'fail',
					},
					{
						name: 'Ignore',
						value: 'ignore',
					},
					{
						name: 'Ignore and Report',
						value: 'ignore_and_report',
					},
				],
				default: 'ignore',
				description: 'How to handle missing system context entries',
				displayOptions: {
					show: {
						includeSystemContext: [true],
					},
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				// Step 0 — Start duration timer
				const startTime = Date.now();

				const workflowExecutionId = this.getNodeParameter(
					'workflowExecutionId',
					i,
				) as string;
				const agentSlug = this.getNodeParameter('agentSlug', i) as string;
				const inputText = this.getNodeParameter('inputText', i, '') as string;
				const includeSystemContext = this.getNodeParameter(
					'includeSystemContext',
					i,
					false,
				) as boolean;

				const externalExecutionId = this.getExecutionId();
				const nodeName = this.getNode().name;
				const baseUrl = `/api/machine/workflow-executions/${workflowExecutionId}`;

				const callCircusApi = async (
					path: string,
					body: Record<string, unknown>,
				): Promise<Record<string, unknown> | undefined> => {
					try {
						return (await this.helpers.httpRequestWithAuthentication.call(
							this,
							'circusApi',
							{
								method: 'POST',
								baseURL: '={{$credentials.apiUrl}}',
								url: `${baseUrl}${path}`,
								body,
								json: true,
							},
						)) as Record<string, unknown>;
					} catch {
						return undefined;
					}
				};

				const logError = async (message: string): Promise<void> => {
					await callCircusApi('/logs', {
						idempotency_key: randomUUID(),
						external_execution_id: externalExecutionId,
						node_name: nodeName,
						worker_type: 'internal',
						worker_slug: 'system',
						status: 'error',
						error_message: message,
					});
				};

				const terminate = async (reason: string): Promise<void> => {
					await callCircusApi('/terminate', {
						reason,
						external_execution_id: externalExecutionId,
					});
				};

				const throwValidationError = async (message: string): Promise<never> => {
					await logError(message);
					await terminate(message);
					throw new NodeOperationError(this.getNode(), message, {
						itemIndex: i,
					});
				};

				// Step 1 — Resolve agent configuration from snapshot
				const webhookData = items[i].json.body as
					| Record<string, unknown>
					| undefined;
				const workflowConfigSnapshot =
					webhookData?.workflow_config_snapshot as
						| { agent_assignments: AgentAssignment[] }
						| undefined;
				const agentAssignments =
					workflowConfigSnapshot?.agent_assignments ?? [];

				const agentConfig = agentAssignments.find(
					(a) => a.agent_slug === agentSlug,
				);

				if (!agentConfig) {
					await throwValidationError(
						`Agent slug '${agentSlug}' not found in workflow configuration snapshot`,
					);
					return [[]]; // unreachable, satisfies TypeScript
				}

				// Step 2 — Validate agent parameters
				if (!agentConfig.model_provider) {
					await throwValidationError('model_provider is missing or empty in agent snapshot');
					return [[]];
				}
				if (!agentConfig.model_name) {
					await throwValidationError('model_name is missing or empty in agent snapshot');
					return [[]];
				}
				if (!agentConfig.model_base_url) {
					await throwValidationError('model_base_url is missing or empty in agent snapshot');
					return [[]];
				}
				if (!agentConfig.max_tokens || agentConfig.max_tokens <= 0) {
					await throwValidationError('max_tokens must be a positive integer');
					return [[]];
				}
				if (
					agentConfig.temperature < 0 ||
					agentConfig.temperature > 2
				) {
					await throwValidationError(
						'temperature must be between 0 and 2 (inclusive)',
					);
					return [[]];
				}

				// Look up AI provider credential
				const credentialName = `circus_${agentConfig.model_provider}_api_key`;
				let providerApiKey: string;
				try {
					const providerCredentials = await this.getCredentials(credentialName, i);
					providerApiKey = providerCredentials.apiKey as string;
				} catch {
					await throwValidationError(
						`AI provider credential '${credentialName}' not found. Configure it in n8n's credential manager.`,
					);
					return [[]];
				}

				// Step 3 — Build prompt with system context
				let systemContext: string | undefined;

				if (includeSystemContext) {
					const systemSnapshot = webhookData?.system_snapshot as
						| { system_context: Record<string, string> }
						| undefined;
					const allContext = systemSnapshot?.system_context ?? {};

					const systemContextEntriesRaw = this.getNodeParameter(
						'systemContextEntries',
						i,
						'',
					) as string;
					const requestedKeys = systemContextEntriesRaw
						? systemContextEntriesRaw
								.split(',')
								.map((k) => k.trim())
								.filter((k) => k)
						: [];

					const missingContextBehavior = this.getNodeParameter(
						'missingContextBehavior',
						i,
						'ignore',
					) as string;

					let contextEntries: Record<string, string>;

					if (requestedKeys.length === 0) {
						// Include all entries
						contextEntries = allContext;
					} else {
						contextEntries = {};
						for (const key of requestedKeys) {
							if (key in allContext) {
								contextEntries[key] = allContext[key];
							} else {
								switch (missingContextBehavior) {
									case 'fail':
										await throwValidationError(
											`System context key '${key}' not found in system snapshot`,
										);
										return [[]];
									case 'ignore_and_report':
										await callCircusApi('/logs', {
											idempotency_key: randomUUID(),
											external_execution_id: externalExecutionId,
											node_name: nodeName,
											worker_type: 'agent',
											worker_slug: agentSlug,
											status: 'error',
											error_message: `System context key '${key}' not found in system snapshot`,
										});
										break;
									default:
										// ignore — skip silently
										break;
								}
							}
						}
					}

					const contextParts = Object.entries(contextEntries).map(
						([key, value]) => `${key}: ${value}`,
					);
					if (contextParts.length > 0) {
						systemContext = contextParts.join('\n');
					}
				}

				// Step 4 — Build provider-specific request
				const providerRequest = buildProviderRequest(
					agentConfig.model_provider,
					agentConfig.model_name,
					systemContext,
					agentConfig.prompt_text,
					inputText || undefined,
					agentConfig.temperature,
					agentConfig.max_tokens,
					agentConfig.model_base_url,
					providerApiKey,
				);

				// Step 5 — Execute AI API call
				let aiResponse: Record<string, unknown> | undefined;
				let aiError: Error | undefined;

				try {
					const requestOptions: IHttpRequestOptions = {
						method: 'POST',
						url: providerRequest.url,
						headers: providerRequest.headers,
						body: providerRequest.body,
						json: true,
					};
					// AI provider auth is handled manually per provider (Bearer, x-api-key,
					// query param) — httpRequestWithAuthentication can't be used here.
					// eslint-disable-next-line @n8n/community-nodes/no-http-request-with-manual-auth
					aiResponse = (await this.helpers.httpRequest(
						requestOptions,
					)) as Record<string, unknown>;
				} catch (error) {
					aiError = error as Error;
				}

				// Step 6 — Parse response
				let parsed: ParsedResponse | undefined;
				if (aiResponse && !aiError) {
					parsed = parseProviderResponse(
						agentConfig.model_provider,
						aiResponse,
					);
				}

				// Step 7 — Log the result
				const durationSeconds = (Date.now() - startTime) / 1000;
				const logStatus = aiError ? 'error' : 'success';

				const logBody: Record<string, unknown> = {
					idempotency_key: randomUUID(),
					external_execution_id: externalExecutionId,
					node_name: nodeName,
					worker_type: 'agent',
					worker_slug: agentSlug,
					model: agentConfig.model_name,
					model_provider: agentConfig.model_provider,
					status: logStatus,
					duration_seconds: durationSeconds,
					input_size: parsed?.inputTokens ?? 0,
					output_size: parsed?.outputTokens ?? 0,
					request_payload: providerRequest.body,
					response_payload: aiResponse ?? null,
				};

				if (aiError) {
					logBody.error_message = aiError.message;
				}

				const logResponse = await callCircusApi('/logs', logBody);

				// Step 7.1 — Check threshold response
				const logData = logResponse?.data as
					| {
							abort: boolean;
							cost_consumed: number;
							time_consumed: number;
					  }
					| undefined;

				if (logData?.abort) {
					const reason =
						'Execution aborted: cost or time threshold exceeded';
					await terminate(reason);
					throw new NodeOperationError(this.getNode(), reason, {
						itemIndex: i,
					});
				}

				// Step 8 — Handle errors
				if (aiError) {
					const continueOnFail = this.continueOnFail();
					const retryOnFail = this.getNode().retryOnFail;

					if (!continueOnFail && retryOnFail) {
						// Path 1 + retries: do NOT terminate, let n8n retry
						throw new NodeApiError(
							this.getNode(),
							aiError as unknown as JsonObject,
							{ message: aiError.message, itemIndex: i },
						);
					}

					// Path 1 + no retries, or Path 2: terminate
					await terminate(`AI API call failed: ${aiError.message}`);

					throw new NodeApiError(
						this.getNode(),
						aiError as unknown as JsonObject,
						{
							message: `AI API call failed: ${aiError.message}`,
							itemIndex: i,
						},
					);
				}

				// Step 9 — Success output
				returnData.push({
					json: {
						response: parsed!.responseText,
						model: agentConfig.model_name,
						model_provider: agentConfig.model_provider,
						agent_slug: agentSlug,
						input_tokens: parsed!.inputTokens,
						output_tokens: parsed!.outputTokens,
						duration_seconds: durationSeconds,
						cost_consumed: logData?.cost_consumed ?? 0,
						abort: false,
					},
					pairedItem: { item: i },
				});
			} catch (error) {
				if (
					error instanceof NodeApiError ||
					error instanceof NodeOperationError
				) {
					// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
					throw error;
				}
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, {
					itemIndex: i,
				});
			}
		}

		return [returnData];
	}
}
