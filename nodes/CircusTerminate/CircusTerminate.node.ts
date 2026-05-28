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

		for (let i = 0; i < items.length; i++) {
			try {
				const workflowExecutionId = this.getNodeParameter('workflowExecutionId', i) as string;
				const reason = this.getNodeParameter('reason', i, '') as string;

				try {
					await this.helpers.httpRequestWithAuthentication.call(this, 'circusApi', {
						method: 'POST',
						baseURL: '={{$credentials.apiUrl}}',
						url: `/api/machine/workflow-executions/${workflowExecutionId}/terminate`,
						body: { reason },
						json: true,
					});
				} catch {
					// Fire and forget — do not check or act on the response status
				}

				const message = reason
					? `Workflow execution terminated: ${reason}`
					: 'Workflow execution terminated';

				throw new NodeOperationError(this.getNode(), message, { itemIndex: i });
			} catch (error) {
				if (error instanceof NodeOperationError) {
					// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
					throw error;
				}
				if (this.continueOnFail()) {
					return [
						[
							{
								json: { error: (error as Error).message },
								pairedItem: { item: i },
							},
						],
					];
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [[]];
	}
}
