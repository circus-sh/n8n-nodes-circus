import { randomUUID } from 'node:crypto';
import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

interface JwtPayload {
	sub: string;
	iss: string;
	iat: number;
	exp: number;
}

export class CircusInit implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Circus Init',
		name: 'circusInit',
		icon: { light: 'file:circusInit.svg', dark: 'file:circusInit.dark.svg' },
		group: ['input'],
		version: 1,
		subtitle: 'Initialize Circus execution context',
		description:
			'Initialize the Circus execution context, validate JWT if present, and register execution start with the platform',
		defaults: {
			name: 'Circus Init',
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

				const externalExecutionId = this.getExecutionId();

				// JWT validation — if the Webhook node was configured with JWT auth,
				// the decoded payload is available at items[i].json.jwtPayload.
				// Validation is automatic: if present, it must be valid. If absent,
				// the node proceeds without JWT checks.
				const jwtPayload = items[i].json.jwtPayload as JwtPayload | undefined;

				if (jwtPayload) {
					const now = Math.floor(Date.now() / 1000);

					if (jwtPayload.sub !== workflowExecutionId) {
						// Do not call /terminate — the workflow_execution_id may be
						// forged or mismatched, so we cannot trust it to identify
						// a valid execution on the platform.
						throw new NodeOperationError(
							this.getNode(),
							`JWT validation failed: token subject '${jwtPayload.sub}' does not match workflow_execution_id '${workflowExecutionId}'`,
							{ itemIndex: i },
						);
					}

					if (jwtPayload.iss !== 'circus') {
						throw new NodeOperationError(
							this.getNode(),
							`JWT validation failed: invalid issuer '${jwtPayload.iss}', expected 'circus'`,
							{ itemIndex: i },
						);
					}

					if (
						typeof jwtPayload.iat !== 'number' ||
						!Number.isFinite(jwtPayload.iat)
					) {
						throw new NodeOperationError(
							this.getNode(),
							'JWT validation failed: missing or invalid iat claim',
							{ itemIndex: i },
						);
					}

					if (jwtPayload.iat > now) {
						throw new NodeOperationError(
							this.getNode(),
							'JWT validation failed: token issued in the future',
							{ itemIndex: i },
						);
					}

					if (
						typeof jwtPayload.exp !== 'number' ||
						!Number.isFinite(jwtPayload.exp)
					) {
						throw new NodeOperationError(
							this.getNode(),
							'JWT validation failed: missing or invalid exp claim',
							{ itemIndex: i },
						);
					}

					if (jwtPayload.exp <= now) {
						throw new NodeOperationError(
							this.getNode(),
							'JWT validation failed: token has expired',
							{ itemIndex: i },
						);
					}
				}

				// Store context in execution custom data for downstream nodes
				this.customData.set('circus_init_node', this.getNode().name);
				this.customData.set('circus_workflow_execution_id', workflowExecutionId);
				this.customData.set('circus_external_execution_id', externalExecutionId);

				// Register execution start with the platform
				const credentials = await this.getCredentials('circusApi');
				const apiUrl = credentials.apiUrl as string;
				const baseUrl = `${apiUrl}/api/machine/workflow-executions/${workflowExecutionId}`;

				try {
					await this.helpers.httpRequestWithAuthentication.call(
						this,
						'circusApi',
						{
							method: 'POST',
							url: `${baseUrl}/logs`,
							body: {
								idempotency_key: randomUUID(),
								external_execution_id: externalExecutionId,
								node_name: 'circus-init',
								worker_type: 'internal',
								worker_slug: 'system',
								status: 'success',
								response_payload: {
									message: `Execution started (external_execution_id: ${externalExecutionId})`,
								},
							},
							json: true,
						},
					);
				} catch {
					// Best-effort — do not fail the init if the log call fails.
					// The execution can still proceed; logging is informational.
				}

				// Pass through the webhook output unchanged
				returnData.push({
					json: items[i].json,
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
