import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class TypeSafeApi implements ICredentialType {
	name = 'typeSafeApi';

	displayName = 'TypeSafe API';

	// An external documentation link, not an n8n docs slug.
	// eslint-disable-next-line n8n-nodes-base/cred-class-field-documentation-url-miscased
	documentationUrl = 'https://docs.typesafe.ai/introduction/quickstart';

	icon = 'file:jev.svg' as const;

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Your TypeSafe API key, from the TypeSafe console',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.typesafe.ai',
			description: 'Change only when your organisation routes API traffic through a gateway or proxy',
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

	// Listing the models costs nothing and proves the key works.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/models',
			method: 'GET',
		},
	};
}
