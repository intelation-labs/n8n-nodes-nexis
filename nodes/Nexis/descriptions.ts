import type { INodeProperties } from 'n8n-workflow';

export const properties: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'anonymize',
		options: [
			{
				name: 'Anonymize Text',
				value: 'anonymize',
				action: 'Anonymize text',
				description: 'Find and remove personal data (PII) from text',
			},
			{
				name: 'Decrypt Text',
				value: 'decrypt',
				action: 'Decrypt text',
				description: 'Restore the values encrypted by the Encryption method, using the same key',
			},
			{
				name: 'Detect PII',
				value: 'detect',
				action: 'Detect PII in text',
				description: 'Find personal data (PII) in text and list each match, without changing the text',
			},
		],
	},
	{
		displayName: 'Country – Regulation Name or ID',
		name: 'country',
		displayOptions: { show: { operation: ['anonymize', 'detect'] } },
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getCountries' },
		default: '',
		required: true,
		description:
			'Personal data covered by this country and regulation is detected. Lists the countries in your Nexis plan. An ID has the format <code>regulation|country|sub-region|language</code> (sub-region and language can be empty); to see one, pick a country, then switch to Expression. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Text',
		name: 'text',
		displayOptions: { show: { operation: ['anonymize', 'detect'] } },
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		required: true,
		description: 'The text to process',
	},
	{
		displayName: 'Anonymization Method',
		name: 'anonymizationMethod',
		displayOptions: { show: { operation: ['anonymize'] } },
		type: 'options',
		default: 'redact',
		description: 'How detected personal data is transformed',
		options: [
			{ name: 'Encryption', value: 'encryption', description: 'Reversible Fernet encryption, decryptable with the same key (needs a key)' },
			{ name: 'Hash', value: 'hash', description: 'One-way hash: first 10 characters of the SHA-256 digest' },
			{ name: 'Mask', value: 'mask', description: 'Replace characters with a masking character' },
			{ name: 'Pseudonymization', value: 'pseudonymization', description: 'Replace with a realistic fake value of the same type' },
			{ name: 'Redact', value: 'redact', description: 'Replace with [REDACTED]' },
			{ name: 'Replace', value: 'replace', description: 'Replace with the entity type, e.g. &lt;PERSON&gt;' },
			{ name: 'Tokenization', value: 'tokenization', description: 'Replace with numbered placeholders, e.g. ENTITY_001, consistent within one request' },
		],
	},
	{
		displayName:
			'Encryption needs a key. Choose or create one in <b>Nexis Encryption Key API</b> at the top of this panel. Keep the key safe: the same key is needed to decrypt.',
		name: 'encryptionKeyNotice',
		type: 'notice',
		default: '',
		displayOptions: { show: { operation: ['anonymize'], anonymizationMethod: ['encryption'] } },
	},
	{
		displayName: 'Masking Options',
		name: 'maskingOptions',
		type: 'collection',
		placeholder: 'Add Masking Option',
		default: {},
		description: 'Leave empty to mask the whole value with *',
		displayOptions: { show: { operation: ['anonymize'], anonymizationMethod: ['mask'] } },
		options: [
			{
				displayName: 'Characters to Mask',
				name: 'charsToMask',
				type: 'number',
				typeOptions: { minValue: 1 },
				default: 4,
				description:
					'Mask only this many characters of each value (e.g. 4 turns 1234567890 into ****567890). When not set, or when it is at least as long as the value, the whole value is masked.',
			},
			{
				displayName: 'From End',
				name: 'fromEnd',
				type: 'boolean',
				default: false,
				description:
					'Whether to mask the last characters instead of the first. Only applies when Characters to Mask is set.',
			},
			{
				displayName: 'Masking Character',
				name: 'maskingChar',
				type: 'string',
				default: '*',
				description: 'Single character used for masking',
			},
		],
	},
	{
		displayName: 'Detection',
		name: 'detectionMode',
		displayOptions: { show: { operation: ['anonymize', 'detect'] } },
		type: 'options',
		default: 'auto',
		description: 'Process everything automatically, select only the entity types you need, or exclude the ones to leave untouched',
		options: [
			{
				name: 'Auto (All Entities in Country)',
				value: 'auto',
				description: 'Process every entity type the selected country and regulation cover',
			},
			{
				name: 'Selected Entities Only',
				value: 'selected',
				description: 'Process only the entity types you choose',
			},
			{
				name: 'Exclude Entities',
				value: 'excluded',
				description: 'Process everything except the entity types you choose',
			},
		],
	},
	{
		displayName: 'Entity Names or IDs',
		name: 'selectedEntities',
		type: 'multiOptions',
		typeOptions: { loadOptionsMethod: 'getEntities', loadOptionsDependsOn: ['country'] },
		default: [],
		required: true,
		description:
			'Only these entity types are processed. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: { show: { operation: ['anonymize', 'detect'], detectionMode: ['selected'] } },
	},
	{
		displayName: 'Excluded Entity Names or IDs',
		name: 'excludedEntities',
		type: 'multiOptions',
		typeOptions: { loadOptionsMethod: 'getEntities', loadOptionsDependsOn: ['country'] },
		default: [],
		required: true,
		description:
			'These entity types are left untouched; everything else is processed. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: { show: { operation: ['anonymize', 'detect'], detectionMode: ['excluded'] } },
	},
	{
		displayName: 'Allow and Deny Lists',
		name: 'listOptions',
		displayOptions: { show: { operation: ['anonymize'] } },
		type: 'collection',
		placeholder: 'Add List',
		default: {},
		description: 'Always keep or always anonymize specific values. Matching ignores upper/lower case.',
		options: [
			{
				displayName: 'Allow List',
				name: 'allowList',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				placeholder: 'e.g. support@example.com',
				description:
					'Values that are never anonymized, even if detected. A value is kept when a detection matches it exactly (comma or new-line separated).',
			},
			{
				displayName: 'Deny List',
				name: 'denyList',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				placeholder: 'e.g. Project Falcon',
				description:
					'Values that are always anonymized wherever they appear in the text, even if not detected (comma or new-line separated)',
			},
		],
	},
	{
		displayName: 'Include Explanations',
		name: 'showExplanations',
		type: 'boolean',
		default: false,
		description: 'Whether to also return why each value was or was not flagged',
		displayOptions: { show: { operation: ['detect'] } },
	},
	{
		displayName:
			'Decrypt needs the key that encrypted the text. Choose it in <b>Nexis Encryption Key API</b> at the top of this panel.',
		name: 'decryptionKeyNotice',
		type: 'notice',
		default: '',
		displayOptions: { show: { operation: ['decrypt'] } },
	},
	{
		displayName: 'Encrypted Text',
		name: 'encryptedText',
		type: 'string',
		typeOptions: { rows: 4 },
		default: '',
		required: true,
		placeholder: 'e.g. Call <<ENC:gAAAA...:ENC>> tomorrow',
		description:
			'Text produced by the Encryption method. Each encrypted value looks like &lt;&lt;ENC:...:ENC&gt;&gt;; the rest of the text is left as it is.',
		displayOptions: { show: { operation: ['decrypt'] } },
	},
];
