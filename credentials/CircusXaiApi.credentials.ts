import type {
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class CircusXaiApi implements ICredentialType {
	name = 'circusXaiApi';

	displayName = 'Circus xAI API';

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
			description: 'xAI API Key',
		},
	];

	test = {
		request: {
			baseURL: 'https://api.x.ai',
			url: '/v1/models',
			method: 'GET' as const,
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};
}
