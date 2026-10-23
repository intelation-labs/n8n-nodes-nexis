import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

/** Fernet key for the Encryption method. Kept as a credential so it is not saved in plain text with the workflow. */
export class NexisEncryptionApi implements ICredentialType {
	name = 'nexisEncryptionApi';
	displayName = 'Nexis Encryption Key API';
	icon: Icon = {
		light: 'file:../icons/nexis.svg',
		dark: 'file:../icons/nexis.dark.svg',
	};
	documentationUrl = 'https://www.intelation.com/integrations/n8n';
	properties: INodeProperties[] = [
		{
			displayName:
				'This key encrypts personal data with the Encryption method and decrypts it again. To create one, run <code>node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\')+\'=\')"</code>. Store a copy somewhere safe: without the same key, encrypted data cannot be recovered.',
			name: 'keyNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Encryption Key',
			name: 'secretKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Fernet key (44-character URL-safe base64). Keep it safe: the same key is needed to decrypt the output.',
		},
	];
}
