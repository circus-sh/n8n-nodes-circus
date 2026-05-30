import { randomUUID } from 'node:crypto';
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

interface ServiceAssignment {
	service_slug: string;
	api_url: string;
	compiled_api_url: string;
	method: string;
	num_retries: number;
	unit: string;
	per_unit: number;
	headers: Array<{ name: string; value: string }>;
	variables: Array<{ name: string; value: string }>;
}

export class CircusService implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Circus Service',
		name: 'circusService',
		icon: { light: 'file:circusService.svg', dark: 'file:circusService.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["serviceSlug"]}}',
		description:
			'Execute external service API calls using snapshot-configured URL, headers, and method from the Circus platform',
		defaults: {
			name: 'Circus Service',
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
				displayName: 'Service Slug',
				name: 'serviceSlug',
				type: 'string',
				required: true,
				default: '',
				description:
					'Service slug matching an entry in the service configuration snapshot',
			},
			{
				displayName: 'Request Body',
				name: 'requestBody',
				type: 'json',
				default: '',
				description: 'Payload to send with the API call',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const startTime = Date.now();

				const workflowExecutionId = this.getNodeParameter(
					'workflowExecutionId',
					i,
				) as string;
				const serviceSlug = this.getNodeParameter('serviceSlug', i) as string;
				const requestBodyRaw = this.getNodeParameter(
					'requestBody',
					i,
					'',
				) as string;
				const requestBody = requestBodyRaw
					? (JSON.parse(requestBodyRaw) as object)
					: undefined;

				const externalExecutionId = this.getExecutionId();
				const baseUrl = `/api/machine/workflow-executions/${workflowExecutionId}`;

				// Step 1 — Resolve service configuration from snapshot
				const webhookData = items[i].json.body as Record<string, unknown> | undefined;
				const serviceConfigSnapshot = webhookData?.service_config_snapshot as
					| { service_assignments: ServiceAssignment[] }
					| undefined;
				const serviceAssignments = serviceConfigSnapshot?.service_assignments ?? [];

				const serviceConfig = serviceAssignments.find(
					(s) => s.service_slug === serviceSlug,
				);

				if (!serviceConfig) {
					// Permanent failure — log + terminate + throw
					const reason = `Service slug '${serviceSlug}' not found in service configuration snapshot`;

					try {
						await this.helpers.httpRequestWithAuthentication.call(
							this,
							'circusApi',
							{
								method: 'POST',
								baseURL: '={{$credentials.apiUrl}}',
								url: `${baseUrl}/logs`,
								body: {
									idempotency_key: randomUUID(),
									external_execution_id: externalExecutionId,
									node_name: this.getNode().name,
									worker_type: 'internal',
									worker_slug: 'system',
									status: 'error',
									error_message: reason,
								},
								json: true,
							},
						);
					} catch {
						// Best-effort
					}

					try {
						await this.helpers.httpRequestWithAuthentication.call(
							this,
							'circusApi',
							{
								method: 'POST',
								baseURL: '={{$credentials.apiUrl}}',
								url: `${baseUrl}/terminate`,
								body: {
									reason,
									external_execution_id: externalExecutionId,
								},
								json: true,
							},
						);
					} catch {
						// Best-effort
					}

					throw new NodeOperationError(this.getNode(), reason, {
						itemIndex: i,
					});
				}

				// Step 2 — Resolve header variables
				// For each header, replace {{VAR_NAME}} placeholders with values
				// from n8n environment variables via the workflow data proxy.
				const envProxy = this.getWorkflowDataProxy(i).$env as Record<string, string>;
				const resolvedHeaders: Record<string, string> = {};

				for (const header of serviceConfig.headers) {
					let headerValue = header.value;

					const variablePattern = /\{\{([^}]+)\}\}/g;
					let match: RegExpExecArray | null;

					while ((match = variablePattern.exec(header.value)) !== null) {
						const varName = match[1];
						const envValue = envProxy[varName];

						if (envValue) {
							headerValue = headerValue.replace(match[0], envValue);
						} else {
							// Unresolved variable — log warning, do NOT halt
							try {
								await this.helpers.httpRequestWithAuthentication.call(
									this,
									'circusApi',
									{
										method: 'POST',
										baseURL: '={{$credentials.apiUrl}}',
										url: `${baseUrl}/logs`,
										body: {
											idempotency_key: randomUUID(),
											external_execution_id: externalExecutionId,
											node_name: this.getNode().name,
											worker_type: 'service',
											worker_slug: serviceSlug,
											status: 'error',
											error_message: `Unresolved header variable: ${varName} in header '${header.name}'. Set this as an environment variable in your n8n instance.`,
										},
										json: true,
									},
								);
							} catch {
								// Best-effort
							}
						}
					}

					resolvedHeaders[header.name] = headerValue;
				}

				// Step 3 — Execute service API call
				let serviceResponse: unknown;
				let serviceStatusCode: number | undefined;
				let serviceError: Error | undefined;

				try {
					serviceResponse = await this.helpers.httpRequest({
						method: serviceConfig.method as 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
						url: serviceConfig.compiled_api_url,
						headers: resolvedHeaders,
						body: requestBody,
						json: true,
						returnFullResponse: true,
					});

					const fullResponse = serviceResponse as {
						body: unknown;
						statusCode: number;
					};
					serviceStatusCode = fullResponse.statusCode;
					serviceResponse = fullResponse.body;
				} catch (error) {
					serviceError = error as Error;
				}

				// Step 4 — Handle errors
				if (serviceError) {
					// Log the error
					let aborted = false;
					try {
						const logResponse =
							(await this.helpers.httpRequestWithAuthentication.call(
								this,
								'circusApi',
								{
									method: 'POST',
									baseURL: '={{$credentials.apiUrl}}',
									url: `${baseUrl}/logs`,
									body: {
										idempotency_key: randomUUID(),
										external_execution_id: externalExecutionId,
										node_name: this.getNode().name,
										worker_type: 'service',
										worker_slug: serviceSlug,
										status: 'error',
										duration_seconds: (Date.now() - startTime) / 1000,
										error_message: serviceError.message,
										request_payload: requestBody ?? null,
									},
									json: true,
								},
							)) as {
								data: { abort: boolean };
							};

						if (logResponse.data.abort) {
							aborted = true;
						}
					} catch {
						// Best-effort
					}

					// If abort flag was set, terminate regardless
					if (aborted) {
						try {
							await this.helpers.httpRequestWithAuthentication.call(
								this,
								'circusApi',
								{
									method: 'POST',
									baseURL: '={{$credentials.apiUrl}}',
									url: `${baseUrl}/terminate`,
									body: {
										reason: 'Execution aborted: cost or time threshold exceeded',
										external_execution_id: externalExecutionId,
									},
									json: true,
								},
							);
						} catch {
							// Best-effort
						}
						throw new NodeOperationError(
							this.getNode(),
							'Execution aborted: cost or time threshold exceeded',
							{ itemIndex: i },
						);
					}

					// Path 1/Path 2 logic
					const continueOnFail = this.continueOnFail();
					const retryOnFail = this.getNode().retryOnFail;

					if (!continueOnFail && retryOnFail) {
						// Path 1 + retries: do NOT terminate, let n8n retry
						throw new NodeOperationError(
							this.getNode(),
							serviceError.message,
							{ itemIndex: i },
						);
					}

					// Path 1 + no retries, or Path 2: terminate
					try {
						await this.helpers.httpRequestWithAuthentication.call(
							this,
							'circusApi',
							{
								method: 'POST',
								baseURL: '={{$credentials.apiUrl}}',
								url: `${baseUrl}/terminate`,
								body: {
									reason: `Service call failed: ${serviceError.message}`,
									external_execution_id: externalExecutionId,
								},
								json: true,
							},
						);
					} catch {
						// Best-effort
					}

					throw new NodeOperationError(
						this.getNode(),
						`Service call failed: ${serviceError.message}`,
						{ itemIndex: i },
					);
				}

				// Step 5 — Success output
				const durationSeconds = (Date.now() - startTime) / 1000;

				returnData.push({
					json: {
						response: serviceResponse as object,
						statusCode: serviceStatusCode,
						service_slug: serviceSlug,
						worker_type: 'service',
						worker_slug: serviceSlug,
						node_name: this.getNode().name,
						unit: serviceConfig.unit,
						per_unit: serviceConfig.per_unit,
						duration_seconds: durationSeconds,
						request_payload: requestBody ?? null,
						response_payload: serviceResponse as object,
					},
					pairedItem: { item: i },
				});
			} catch (error) {
				if (error instanceof NodeOperationError) {
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
