import { randomUUID } from 'node:crypto';
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

export class CircusComplete implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Circus Complete',
		name: 'circusComplete',
		icon: { light: 'file:circusComplete.svg', dark: 'file:circusComplete.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: 'Complete workflow execution',
		description:
			'Mark a workflow execution as successfully completed and transmit result artifacts to the Circus platform',
		defaults: {
			name: 'Circus Complete',
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
				displayName: 'Result Payload',
				name: 'resultPayload',
				type: 'json',
				required: true,
				default: '{}',
				description:
					'JSON object containing the workflow output. Structure is plugin-specific — the node does not validate its contents.',
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
				const resultPayloadRaw = this.getNodeParameter(
					'resultPayload',
					i,
				) as string;
				const resultPayload = JSON.parse(resultPayloadRaw) as object;
				const externalExecutionId = this.getExecutionId();

				const baseUrl = `/api/machine/workflow-executions/${workflowExecutionId}`;

				try {
					await this.helpers.httpRequestWithAuthentication.call(
						this,
						'circusApi',
						{
							method: 'POST',
							baseURL: '={{$credentials.apiUrl}}',
							url: `${baseUrl}/complete`,
							body: {
								result_payload: resultPayload,
								external_execution_id: externalExecutionId,
							},
							json: true,
						},
					);
				} catch (completeError) {
					const errorDetails = (completeError as Error).message;

					// Best-effort error log
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
									node_name: 'circus-complete',
									worker_type: 'internal',
									worker_slug: 'system',
									status: 'error',
									error_message: `Complete endpoint failed: ${errorDetails}`,
									external_execution_id: externalExecutionId,
								},
								json: true,
							},
						);
					} catch {
						// Best-effort — do not fail
					}

					const continueOnFail = this.continueOnFail();
					const retryOnFail = this.getNode().retryOnFail;

					if (!continueOnFail && retryOnFail) {
						// Path 1 + retries: do NOT terminate, let n8n retry
						throw new NodeOperationError(
							this.getNode(),
							`Failed to complete execution: ${errorDetails}`,
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
									reason: `Failed to complete execution: ${errorDetails}`,
									external_execution_id: externalExecutionId,
								},
								json: true,
							},
						);
					} catch {
						// Best-effort — do not fail
					}

					throw new NodeOperationError(
						this.getNode(),
						`Failed to complete execution: ${errorDetails}`,
						{ itemIndex: i },
					);
				}

				returnData.push({
					json: {
						completed: true,
						message: 'Execution completed successfully',
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
