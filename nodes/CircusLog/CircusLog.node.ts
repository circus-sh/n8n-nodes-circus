import { randomUUID } from 'node:crypto';
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

export class CircusLog implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Circus Log',
		name: 'circusLog',
		icon: { light: 'file:circusLog.svg', dark: 'file:circusLog.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["workerType"] + " / " + $parameter["status"]}}',
		description: 'Create a log entry on the Circus platform and check cost/time thresholds',
		defaults: {
			name: 'Circus Log',
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
				displayName: 'Node Name',
				name: 'nodeName',
				type: 'string',
				required: true,
				default: '',
				description: 'Name of the workflow step being logged',
			},
			{
				displayName: 'Worker Type',
				name: 'workerType',
				type: 'options',
				required: true,
				options: [
					{ name: 'Internal', value: 'internal' },
					{ name: 'Service', value: 'service' },
				],
				default: 'internal',
				description:
					'Type of worker. Agent is not available — Agent nodes handle their own logging.',
			},
			{
				displayName: 'Worker Slug',
				name: 'workerSlug',
				type: 'string',
				required: true,
				default: '',
				description:
					'Slug identifying the service for cost lookup (when worker type is service). For internal, use a descriptive slug.',
			},
			{
				displayName: 'Status',
				name: 'status',
				type: 'options',
				required: true,
				options: [
					{ name: 'Error', value: 'error' },
					{ name: 'Success', value: 'success' },
				],
				default: 'success',
			},
			{
				displayName: 'Duration (Seconds)',
				name: 'durationSeconds',
				type: 'number',
				default: 0,
				description: 'Step execution time in seconds',
			},
			{
				displayName: 'Input Size',
				name: 'inputSize',
				type: 'number',
				default: 0,
				description:
					'Consumption input (service-defined units for services, 0 for internal)',
			},
			{
				displayName: 'Output Size',
				name: 'outputSize',
				type: 'number',
				default: 0,
				description:
					'Consumption output (service-defined units for services, 0 for internal)',
			},
			{
				displayName: 'Error Message',
				name: 'errorMessage',
				type: 'string',
				default: '',
				description: 'Error description (for failed steps)',
				displayOptions: {
					show: {
						status: ['error'],
					},
				},
			},
			{
				displayName: 'Request Payload',
				name: 'requestPayload',
				type: 'json',
				default: '',
				description: 'Request data to store',
			},
			{
				displayName: 'Response Payload',
				name: 'responsePayload',
				type: 'json',
				default: '',
				description: 'Response data to store',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const workflowExecutionId = this.getNodeParameter(
					'workflowExecutionId',
					i,
				) as string;
				const nodeName = this.getNodeParameter('nodeName', i) as string;
				const workerType = this.getNodeParameter('workerType', i) as string;
				const workerSlug = this.getNodeParameter('workerSlug', i) as string;
				const status = this.getNodeParameter('status', i) as string;
				const durationSeconds = this.getNodeParameter(
					'durationSeconds',
					i,
					0,
				) as number;
				const inputSize = this.getNodeParameter('inputSize', i, 0) as number;
				const outputSize = this.getNodeParameter('outputSize', i, 0) as number;
				const errorMessage =
					status === 'error'
						? (this.getNodeParameter('errorMessage', i, '') as string)
						: undefined;
				const requestPayloadRaw = this.getNodeParameter(
					'requestPayload',
					i,
					'',
				) as string;
				const responsePayloadRaw = this.getNodeParameter(
					'responsePayload',
					i,
					'',
				) as string;

				const requestPayload = requestPayloadRaw
					? (JSON.parse(requestPayloadRaw) as object)
					: undefined;
				const responsePayload = responsePayloadRaw
					? (JSON.parse(responsePayloadRaw) as object)
					: undefined;

				const externalExecutionId = this.getExecutionId();

				// A new idempotency key is generated per execute() call. If n8n's built-in
				// "Retry On Fail" re-runs this node, a new key will be generated because
				// execute() runs from scratch with no state carried over. This means
				// retries may create duplicate log rows. Deterministic key generation
				// (e.g. hashing node ID + execution ID) was considered but breaks when
				// the same node executes multiple times via loops or converging paths.
				// Accepted as a known limitation — platform-side deduplication is also
				// impractical without reliable retry-attempt context from n8n.
				const idempotencyKey = randomUUID();

				const body: Record<string, unknown> = {
					idempotency_key: idempotencyKey,
					node_name: nodeName,
					worker_type: workerType,
					worker_slug: workerSlug,
					status,
					external_execution_id: externalExecutionId,
				};

				if (durationSeconds) body.duration_seconds = durationSeconds;
				if (inputSize) body.input_size = inputSize;
				if (outputSize) body.output_size = outputSize;
				if (errorMessage) body.error_message = errorMessage;
				if (requestPayload) body.request_payload = requestPayload;
				if (responsePayload) body.response_payload = responsePayload;

				let responseData: {
					abort: boolean;
					cost_consumed: number;
					time_consumed: number;
				};

				try {
					const response = (await this.helpers.httpRequestWithAuthentication.call(
						this,
						'circusApi',
						{
							method: 'POST',
							baseURL: '={{$credentials.apiUrl}}',
							url: `/api/machine/workflow-executions/${workflowExecutionId}/logs`,
							body,
							json: true,
						},
					)) as {
						data: {
							abort: boolean;
							cost_consumed: number;
							time_consumed: number;
						};
					};
					responseData = response.data;
				} catch (logError) {
					// The /log API call itself failed
					const continueOnFail = this.continueOnFail();
					const retryOnFail = this.getNode().retryOnFail;

					if (!continueOnFail && retryOnFail) {
						// Path 1 + retries: do NOT terminate, let n8n retry
						throw new NodeOperationError(
							this.getNode(),
							(logError as Error).message,
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
								url: `/api/machine/workflow-executions/${workflowExecutionId}/terminate`,
								body: {
									reason: `Log endpoint failed: ${(logError as Error).message}`,
									external_execution_id: externalExecutionId,
								},
								json: true,
							},
						);
					} catch {
						// Fire and forget
					}
					throw new NodeOperationError(
						this.getNode(),
						`Log endpoint failed: ${(logError as Error).message}`,
						{ itemIndex: i },
					);
				}

				// Check abort threshold
				if (responseData.abort) {
					const reason = 'Execution aborted: cost or time threshold exceeded';
					try {
						await this.helpers.httpRequestWithAuthentication.call(
							this,
							'circusApi',
							{
								method: 'POST',
								baseURL: '={{$credentials.apiUrl}}',
								url: `/api/machine/workflow-executions/${workflowExecutionId}/terminate`,
								body: {
									reason,
									external_execution_id: externalExecutionId,
								},
								json: true,
							},
						);
					} catch {
						// Fire and forget
					}
					throw new NodeOperationError(this.getNode(), reason, {
						itemIndex: i,
					});
				}

				returnData.push({
					json: {
						logged: true,
						cost_consumed: responseData.cost_consumed,
						time_consumed: responseData.time_consumed,
						abort: false,
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
