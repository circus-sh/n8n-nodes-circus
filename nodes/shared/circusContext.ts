import type { IExecuteFunctions } from 'n8n-workflow';

export interface CircusContext {
	workflowExecutionId: string;
	externalExecutionId: string;
	apiUrl: string;
	baseUrl: string;
	initNodeName: string;
}

/**
 * Read Circus execution context from n8n's execution custom data.
 * Requires that a Circus Init node has run earlier in the workflow.
 */
export async function getCircusContext(
	ctx: IExecuteFunctions,
): Promise<CircusContext> {
	const initNodeName = ctx.customData.get('circus_init_node');
	if (!initNodeName) {
		throw new Error(
			'Circus execution context not found. Ensure a Circus Init node is placed after the Webhook trigger and before this node.',
		);
	}

	const workflowExecutionId = ctx.customData.get('circus_workflow_execution_id');
	if (!workflowExecutionId) {
		throw new Error(
			'Circus workflow_execution_id not found in execution context.',
		);
	}

	const externalExecutionId =
		ctx.customData.get('circus_external_execution_id') || ctx.getExecutionId();

	const credentials = await ctx.getCredentials('circusApi');
	const apiUrl = credentials.apiUrl as string;
	const baseUrl = `${apiUrl}/api/machine/workflow-executions/${workflowExecutionId}`;

	return { workflowExecutionId, externalExecutionId, apiUrl, baseUrl, initNodeName };
}

/**
 * Read a snapshot from the Circus Init node's output via expression evaluation.
 */
export function getSnapshot<T>(
	ctx: IExecuteFunctions,
	initNodeName: string,
	snapshotKey: string,
	itemIndex: number,
): T | undefined {
	const result = ctx.evaluateExpression(
		`{{ $('${initNodeName}').item.json.body.${snapshotKey} }}`,
		itemIndex,
	);
	return result as T | undefined;
}
