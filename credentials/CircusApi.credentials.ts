import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class CircusApi implements ICredentialType {
	name = 'circusApi';

	displayName = 'Circus API';

	documentationUrl = 'https://circus.sh/docs/n8n-nodes#credentials';

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
			description: 'Circus Platform API Key',
		},
		{
			displayName: 'API URL',
			name: 'apiUrl',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'https://your-circus-instance.com',
			description: 'Base URL of your Circus platform instance',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.apiUrl}}',
			url: '/api/machine/health',
			method: 'POST',
		},
	};
}
