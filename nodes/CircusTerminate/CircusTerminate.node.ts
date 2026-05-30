import { randomUUID } from 'node:crypto';
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

export class CircusTerminate implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Circus Terminate',
		name: 'circusTerminate',
		icon: { light: 'file:circusTerminate.svg', dark: 'file:circusTerminate.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: 'Terminate workflow execution',
		description: 'Terminate a workflow execution on the Circus platform',
		defaults: {
			name: 'Circus Terminate',
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
				displayName: 'Termination Reason',
				name: 'reason',
				type: 'string',
				default: '',
				description:
					'Reason for terminating the execution. Supports static text or dynamic expressions.',
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
				const reason = this.getNodeParameter('reason', i, '') as string;
				const externalExecutionId = this.getExecutionId();

				try {
					await this.helpers.httpRequestWithAuthentication.call(this, 'circusApi', {
						method: 'POST',
						baseURL: '={{$credentials.apiUrl}}',
						url: `/api/machine/workflow-executions/${workflowExecutionId}/terminate`,
						body: { reason, external_execution_id: externalExecutionId },
						json: true,
					});
				} catch (error) {
					// Terminate call failed — attempt to log the error, then throw
					try {
						await this.helpers.httpRequestWithAuthentication.call(
							this,
							'circusApi',
							{
								method: 'POST',
								baseURL: '={{$credentials.apiUrl}}',
								url: `/api/machine/workflow-executions/${workflowExecutionId}/logs`,
								body: {
									idempotency_key: randomUUID(),
									external_execution_id: externalExecutionId,
									node_name: 'circus-terminate',
									worker_type: 'internal',
									worker_slug: 'system',
									status: 'error',
									error_message: `Terminate endpoint failed: ${(error as Error).message}`,
								},
								json: true,
							},
						);
					} catch {
						// Best-effort — do not fail
					}
					throw new NodeOperationError(
						this.getNode(),
						`Terminate endpoint failed: ${(error as Error).message}`,
						{ itemIndex: i },
					);
				}

				returnData.push({
					json: {
						terminated: true,
						reason,
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
