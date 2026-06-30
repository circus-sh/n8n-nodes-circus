import type {
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class CircusOpenaiApi implements ICredentialType {
	name = 'circusOpenaiApi';

	displayName = 'Circus OpenAI API';

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
			description: 'OpenAI API Key',
		},
	];

	test = {
		request: {
			baseURL: 'https://api.openai.com',
			url: '/v1/models',
			method: 'GET' as const,
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};
}
