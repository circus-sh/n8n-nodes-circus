import type {
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class CircusGoogleApi implements ICredentialType {
	name = 'circusGoogleApi';

	displayName = 'Circus Google AI API';

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
			description: 'Google AI API Key',
		},
	];

	test = {
		request: {
			baseURL: 'https://generativelanguage.googleapis.com',
			url: '=/v1beta/models?key={{$credentials.apiKey}}',
			method: 'GET' as const,
		},
	};
}
