import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class NexisApi implements ICredentialType {
	name = 'nexisApi';
	displayName = 'Nexis API';
	icon: Icon = {
		light: 'file:../icons/nexis.svg',
		dark: 'file:../icons/nexis.dark.svg',
	};
	documentationUrl = 'https://www.intelation.com/integrations/n8n';
	properties: INodeProperties[] = [
		{
			displayName:
				'No key yet? <a href="https://nexis.intelation.com/signup?utm_source=n8n&utm_medium=node" target="_blank">Get a free Nexis key</a>.',
			name: 'signupNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Create a key in the Nexis dashboard under API Integration',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.nexis.intelation.com',
			description: 'Only change this for a dedicated or on-premises Nexis instance',
		},
	];
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '={{"Bearer " + $credentials.apiKey}}',
			},
		},
	};
	test: ICredentialTestRequest = {
		request: {
			// Same cleanup as getBaseUrl() in GenericFunctions.ts: default, trim, strip trailing slashes
			baseURL: '={{ String($credentials.baseUrl || "https://api.nexis.intelation.com").trim().replace(/[/]+$/, "") }}',
			url: '/api/account/',
			method: 'GET',
		},
	};
}
