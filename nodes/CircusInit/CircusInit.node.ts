import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

export class CircusInit implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Circus Init',
		name: 'circusInit',
		icon: { light: 'file:circusInit.svg', dark: 'file:circusInit.dark.svg' },
		group: ['input'],
		version: 1,
		subtitle: 'Initialize Circus execution context',
		description:
			'Store the Circus webhook payload in execution data so all downstream Circus nodes can access it',
		defaults: {
			name: 'Circus Init',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		properties: [],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const body = items[i].json.body as Record<string, unknown> | undefined;

				if (!body) {
					throw new NodeOperationError(
						this.getNode(),
						'No webhook payload found. Place this node directly after a Webhook trigger node.',
						{ itemIndex: i },
					);
				}

				const workflowExecutionId = body.workflow_execution_id as string | undefined;
				if (!workflowExecutionId) {
					throw new NodeOperationError(
						this.getNode(),
						'Missing workflow_execution_id in webhook payload',
						{ itemIndex: i },
					);
				}

				// Store this node's name so downstream nodes can reference it dynamically
				this.customData.set('circus_init_node', this.getNode().name);
				this.customData.set('circus_workflow_execution_id', workflowExecutionId);
				this.customData.set('circus_external_execution_id', this.getExecutionId());

				// Read back to verify storage
				const verifyName = this.customData.get('circus_init_node');
				const verifyId = this.customData.get('circus_workflow_execution_id');

				// Pass through webhook output with storage verification
				returnData.push({
					json: {
						...items[i].json,
						_circusInit: {
							storedNodeName: verifyName,
							storedExecutionId: verifyId,
							allKeys: Object.keys(this.customData.getAll()),
						},
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
