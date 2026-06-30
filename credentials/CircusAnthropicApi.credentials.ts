import type {
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class CircusAnthropicApi implements ICredentialType {
	name = 'circusAnthropicApi';

	displayName = 'Circus Anthropic API';

	documentationUrl = 'https://circus.sh/docs/n8n-nodes#ai-credentials';

	icon = { light: 'file:icons/circus.svg', dark: 'file:icons/circus.dark.svg' } as const;

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			required: true,
			default: '',
			description: 'Anthropic API Key',
		},
	];

	test = {
		request: {
			baseURL: 'https://api.anthropic.com',
			url: '/v1/messages',
			method: 'POST' as const,
			headers: {
				'x-api-key': '={{$credentials.apiKey}}',
				'anthropic-version': '2023-06-01',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: 'claude-haiku-4-5-20251001',
				max_tokens: 1,
				messages: [{ role: 'user', content: 'hi' }],
			}),
		},
	};
}
