// Test-only file, not shipped (package.json "files" is dist only): Node built-ins are fine here.
/* eslint-disable @n8n/community-nodes/no-restricted-imports */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import type { ICredentialsDecrypted, IDataObject, IExecuteFunctions, INode } from 'n8n-workflow';
import { NodeHelpers } from 'n8n-workflow';

import { Nexis } from '../nodes/Nexis/Nexis.node';

const node = {
	name: 'Nexis',
	type: 'nexis',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
} as unknown as INode;
// A fresh Fernet-format key: 32 random bytes as URL-safe base64 plus "=" padding.
const VALID_KEY = randomBytes(32).toString('base64url') + '=';

type Request = { url: string; body: IDataObject; headers?: IDataObject };

/** Runs the node's execute() on one input item with the given parameters, recording the requests. */
async function run(
	params: IDataObject,
	options: {
		continueOnFail?: boolean;
		secretKey?: string;
		response?: IDataObject;
		/** Answers each request instead of `response`; may throw to simulate an API error. */
		respond?: (request: Request) => IDataObject;
		executionId?: string;
		runIndex?: number;
	} = {},
) {
	const bodies: IDataObject[] = [];
	const urls: string[] = [];
	const keys: unknown[] = [];
	const context = {
		getInputData: () => [{ json: {} }],
		getNode: () => node,
		getExecutionId: () => options.executionId ?? 'exec-1',
		getWorkflowDataProxy: () => ({ $runIndex: options.runIndex ?? 0 }),
		continueOnFail: () => options.continueOnFail ?? false,
		getNodeParameter: (name: string, _i: number, fallback?: unknown) =>
			name in params ? params[name] : fallback,
		getCredentials: async (name: string) =>
			name === 'nexisEncryptionApi'
				? { secretKey: options.secretKey ?? VALID_KEY }
				: { baseUrl: '' },
		helpers: {
			httpRequestWithAuthentication: async (_name: string, request: Request) => {
				urls.push(request.url);
				bodies.push(request.body);
				keys.push(request.headers?.['Idempotency-Key']);
				if (options.respond) return options.respond(request);
				return options.response ?? { anonymised_text: 'Call <PERSON>', pii_entity_count: 1 };
			},
		},
	} as unknown as IExecuteFunctions;
	const output = await new Nexis().execute.call(context);
	return { output: output[0], bodies, urls, keys };
}

/** An API error as n8n's request helper throws it, with the Nexis error body. */
const apiError = (status: string, data: IDataObject) =>
	Object.assign(new Error(`Request failed with status code ${status}`), {
		httpCode: status,
		context: { data },
	});

const base = {
	country: 'UK GDPR|United Kingdom||en',
	text: 'Call John',
	anonymizationMethod: 'redact',
};

describe('Nexis execute', () => {
	it('sends the parsed country and returns the API response as is', async () => {
		const { output, bodies } = await run(base);
		assert.deepEqual(bodies[0], {
			text: 'Call John',
			regulation: 'UK GDPR',
			country: 'United Kingdom',
			anonymisation_method: 'redact',
			language: 'en',
		});
		assert.deepEqual(output[0].json, { anonymised_text: 'Call <PERSON>', pii_entity_count: 1 });
	});

	it('rejects empty text without calling the API', async () => {
		await assert.rejects(run({ ...base, text: '   ' }), /Text is empty/);
	});

	it('rejects an object in the Text field', async () => {
		await assert.rejects(run({ ...base, text: { a: 1 } }), /Text must be text/);
	});

	it('sends the key from the encryption credential', async () => {
		const { bodies } = await run({ ...base, anonymizationMethod: 'encryption' });
		assert.equal(bodies[0].encryption_key, VALID_KEY);
	});

	it('rejects a malformed encryption key before calling the API', async () => {
		await assert.rejects(
			run({ ...base, anonymizationMethod: 'encryption' }, { secretKey: 'not-a-key' }),
			/not a valid Fernet key/,
		);
	});

	it('sends masking options only when set', async () => {
		const { bodies } = await run({
			...base,
			anonymizationMethod: 'mask',
			maskingOptions: { maskingChar: '#', charsToMask: 4, fromEnd: true },
		});
		assert.equal(bodies[0].masking_char, '#');
		assert.equal(bodies[0].chars_to_mask, 4);
		assert.equal(bodies[0].from_end, true);
	});

	it('splits allow and deny lists', async () => {
		const { bodies } = await run({
			...base,
			listOptions: { allowList: 'a, b', denyList: 'Project Falcon\nX' },
		});
		assert.deepEqual(bodies[0].allow_list, ['a', 'b']);
		assert.deepEqual(bodies[0].deny_list, ['Project Falcon', 'X']);
	});

	it('requires entities in Selected Entities Only mode', async () => {
		await assert.rejects(
			run({ ...base, detectionMode: 'selected', selectedEntities: [] }),
			/at least one entity/,
		);
	});

	it('keeps the error description in Continue On Fail mode', async () => {
		const { output } = await run({ ...base, text: '' }, { continueOnFail: true });
		assert.equal(output[0].json.error, 'Text is empty');
		assert.match(String(output[0].json.description), /Enter the text to anonymize/);
		assert.deepEqual(output[0].pairedItem, { item: 0 });
	});

	it('shows a friendly message when the plan limit is reached', async () => {
		const error = apiError('402', {
			error_code: 'INTELATION',
			message:
				'Daily quota exceeded for api calls. Limit: 100 per day. Upgrade your plan to continue.',
		});
		await assert.rejects(
			run(base, {
				respond: () => {
					throw error;
				},
			}),
			/Daily Nexis API call limit reached/,
		);
	});
});

describe('Nexis Idempotency-Key', () => {
	it('stays the same when the node is retried in the same execution', async () => {
		const first = await run(base);
		const retry = await run(base);
		assert.match(String(first.keys[0]), /^n8n-[0-9a-f]{64}$/);
		assert.equal(retry.keys[0], first.keys[0]);
	});

	it('changes with the execution and with the request body', async () => {
		const {
			keys: [key],
		} = await run(base);
		const {
			keys: [otherExecution],
		} = await run(base, { executionId: 'exec-2' });
		const {
			keys: [otherText],
		} = await run({ ...base, text: 'Call Jane' });
		assert.notEqual(otherExecution, key);
		assert.notEqual(otherText, key);
	});

	it('reports which item a friendly API error came from', async () => {
		await assert.rejects(
			run(base, {
				respond: () => {
					throw apiError('429', {});
				},
			}),
			(error: Error & { context?: IDataObject }) => {
				assert.equal(error.message, 'Too many requests to Nexis');
				assert.equal(error.context?.itemIndex, 0);
				return true;
			},
		);
	});

	it('changes on each pass of a loop in the same execution', async () => {
		const {
			keys: [first],
		} = await run(base);
		const {
			keys: [second],
		} = await run(base, { runIndex: 1 });
		assert.notEqual(second, first);
	});

	it('is not sent without an execution ID', async () => {
		const { keys } = await run(base, { executionId: '' });
		assert.deepEqual(keys, [undefined]);
	});

	it('moves to the next key when the earlier request under it failed or is stuck', async () => {
		const replies = [
			apiError('400', {
				error_code: 'IDEMPOTENCY_PREVIOUS_FAILURE',
				message: 'Previous request failed',
			}),
			apiError('400', {
				error_code: 'IDEMPOTENCY_DUPLICATE_IN_PROGRESS',
				message: 'Duplicate request is in progress',
			}),
		];
		const { output, keys } = await run(base, {
			respond: () => {
				const reply = replies.shift();
				if (reply) throw reply;
				return { anonymised_text: 'Call <PERSON>' };
			},
		});
		assert.deepEqual(keys, [keys[0], `${keys[0]}-1`, `${keys[0]}-2`]);
		assert.equal(output[0].json.anonymised_text, 'Call <PERSON>');
	});

	it('gives up after five keys', async () => {
		const stuck = apiError('400', {
			error_code: 'IDEMPOTENCY_PREVIOUS_FAILURE',
			message: 'Previous request failed',
		});
		let calls = 0;
		await assert.rejects(
			run(base, {
				respond: () => {
					calls++;
					throw stuck;
				},
			}),
		);
		assert.equal(calls, 5);
	});

	it('does not resend on other errors', async () => {
		let calls = 0;
		await assert.rejects(
			run(base, {
				respond: () => {
					calls++;
					throw apiError('500', { error_code: 'INTERNAL_SERVER_ERROR', message: 'boom' });
				},
			}),
		);
		assert.equal(calls, 1);
	});

	it('is not sent for Decrypt, whose reply Nexis would keep in memory', async () => {
		const response = { decrypted_text: 'Call John', success: true, id: 'r1' };
		const { keys } = await run(
			{ operation: 'decrypt', encryptedText: 'Call <<ENC:gAAAAone:ENC>>' },
			{ response },
		);
		assert.deepEqual(keys, [undefined]);
	});
});

describe('Nexis entity list', () => {
	const catalog = {
		summary: {
			global_entities: [{ presidio_entity: 'EMAIL_ADDRESS', display_name: 'Email Address' }],
		},
		regulations: [
			{
				regulation: 'UK GDPR',
				country: 'United Kingdom',
				sub_region: null,
				language_code: 'en',
				entities: [
					{ presidio_entity: 'UK_NHS', display_name: 'NHS Number', support_status: 'Supported' },
					{ presidio_entity: 'UK_NEW', display_name: 'New Entity', support_status: 'Coming Soon' },
				],
			},
		],
	};
	const list = (country?: string) =>
		new Nexis().methods.loadOptions.getEntities.call({
			getNode: () => node,
			getCurrentNodeParameter: () => country,
			getCredentials: async () => ({ baseUrl: '' }),
			helpers: { httpRequestWithAuthentication: async () => catalog },
		} as never);

	it('lists only the supported entities of the chosen country', async () => {
		assert.deepEqual(
			(await list('UK GDPR|United Kingdom||en')).map((o) => o.value),
			['UK_NHS'],
		);
	});

	it('lists the global entities before a country is chosen', async () => {
		assert.deepEqual(
			(await list()).map((o) => o.value),
			['EMAIL_ADDRESS'],
		);
	});
});

describe('Nexis encryption credential test', () => {
	const check = (secretKey: string) =>
		new Nexis().methods.credentialTest.nexisEncryptionKeyTest.call(
			{} as never,
			{ data: { secretKey } } as unknown as ICredentialsDecrypted,
		);

	it('accepts a valid key', async () => {
		assert.equal((await check(VALID_KEY)).status, 'OK');
	});

	it('rejects an invalid key', async () => {
		assert.equal((await check('abc')).status, 'Error');
	});
});

describe('Nexis detect', () => {
	const detect = { operation: 'detect', country: 'UK GDPR|United Kingdom||en', text: 'Call John' };

	it('posts to /api/detect/ without anonymization fields or an Idempotency-Key', async () => {
		const response = {
			characters_scanned: 9,
			pii_entity_count: 1,
			detected_entities: { PERSON: 1 },
			detections: [],
		};
		const { output, bodies, urls, keys } = await run(
			{ ...detect, anonymizationMethod: 'encryption', listOptions: { allowList: 'John' } },
			{ response },
		);
		assert.match(urls[0], /\/api\/detect\/$/);
		assert.deepEqual(bodies[0], {
			text: 'Call John',
			regulation: 'UK GDPR',
			country: 'United Kingdom',
			language: 'en',
		});
		assert.deepEqual(keys, [undefined]);
		assert.deepEqual(output[0].json, response);
	});

	it('sends entity filters and explanations when set', async () => {
		const { bodies } = await run({
			...detect,
			detectionMode: 'selected',
			selectedEntities: ['PERSON'],
			showExplanations: true,
		});
		assert.deepEqual(bodies[0].selected_entities, ['PERSON']);
		assert.equal(bodies[0].show_explanations, true);
	});

	it('sends excluded entities and the sub-region', async () => {
		const { bodies } = await run({
			...detect,
			country: 'Privacy Act|Australia|New South Wales|en',
			detectionMode: 'excluded',
			excludedEntities: ['DATE_TIME'],
		});
		assert.equal(bodies[0].sub_region, 'New South Wales');
		assert.deepEqual(bodies[0].excluded_entities, ['DATE_TIME']);
	});

	it('leaves out explanations when the switch is off', async () => {
		const { bodies } = await run({ ...detect, showExplanations: false });
		assert.equal('show_explanations' in bodies[0], false);
	});

	it('requires entities when Detection is Selected Entities Only', async () => {
		await assert.rejects(
			run({ ...detect, detectionMode: 'selected', selectedEntities: [] }),
			/Choose at least one entity type/,
		);
	});

	it('rejects empty text with a Detect hint', async () => {
		await assert.rejects(
			run({ ...detect, text: ' ' }),
			(error: Error & { description?: string }) => {
				assert.equal(error.message, 'Text is empty');
				assert.match(String(error.description), /text to scan/);
				return true;
			},
		);
	});

	it('rejects an invalid country ID without calling the API', async () => {
		await assert.rejects(
			run({ ...detect, country: 'nonsense' }),
			/Country – Regulation ID is not valid/,
		);
	});

	it('ignores the encryption key, even an invalid one', async () => {
		const { bodies } = await run(
			{ ...detect, anonymizationMethod: 'encryption' },
			{ secretKey: 'not-a-key' },
		);
		assert.equal('encryption_key' in bodies[0], false);
	});

	it('turns API errors into friendly messages', async () => {
		await assert.rejects(
			run(detect, {
				respond: () => {
					throw apiError('402', {
						detail: 'Daily quota exceeded for characters. Limit: 1000 per day.',
					});
				},
			}),
			/Daily Nexis API call limit reached/,
		);
	});

	it('returns the error on the item with Continue On Fail', async () => {
		const { output } = await run({ ...detect, text: 'a'.repeat(5001) }, { continueOnFail: true });
		assert.equal(output[0].json.error, 'Text is too long for Detect');
		assert.deepEqual(output[0].pairedItem, { item: 0 });
	});

	it('rejects text over 5,000 characters without calling the API', async () => {
		const { urls } = await run({ ...detect, text: '😀'.repeat(5000) });
		assert.equal(urls.length, 1);
		await assert.rejects(run({ ...detect, text: 'a'.repeat(5001) }), /Text is too long for Detect/);
	});
});

describe('Nexis decrypt', () => {
	const encrypted = 'Call <<ENC:gAAAAone:ENC>> or <<ENC:gAAAAtwo:ENC>>';
	const decrypt = { operation: 'decrypt', encryptedText: encrypted };

	it('sends the text and key to the decrypt endpoint and returns the result', async () => {
		const response = { decrypted_text: 'Call John or 07700 900123', success: true, id: 'r1' };
		const { output, bodies, urls } = await run(decrypt, { response });
		assert.deepEqual(urls, ['https://api.nexis.intelation.com/api/decrypt/']);
		assert.deepEqual(bodies[0], { encrypted_text: encrypted, encryption_key: VALID_KEY });
		assert.deepEqual(output[0].json, response);
	});

	it('rejects text with no encrypted values without calling the API', async () => {
		await assert.rejects(
			run({ ...decrypt, encryptedText: 'Call John' }),
			/No encrypted values found/,
		);
	});

	it('rejects empty text', async () => {
		await assert.rejects(run({ ...decrypt, encryptedText: '' }), /Text is empty/);
	});

	it('rejects a malformed key before calling the API', async () => {
		await assert.rejects(run(decrypt, { secretKey: 'nope' }), /not a valid Fernet key/);
	});

	it('reports a wrong key, which Nexis returns as unchanged text', async () => {
		const response = { decrypted_text: encrypted, success: true, id: 'r2' };
		await assert.rejects(run(decrypt, { response }), /Could not decrypt the text with this key/);
	});

	it('reports values that could only partly be decrypted', async () => {
		const response = {
			decrypted_text: 'Call John or <<ENC:gAAAAtwo:ENC>>',
			success: true,
			id: 'r3',
		};
		await assert.rejects(
			run(decrypt, { response }),
			/1 of 2 encrypted values could not be decrypted/,
		);
	});
});

describe('Nexis encryption credential visibility', () => {
	const description = new Nexis().description;
	const credential = description.credentials!.find((c) => c.name === 'nexisEncryptionApi')!;
	const shown = (values: IDataObject) => {
		const params = NodeHelpers.getNodeParameters(
			description.properties,
			values as never,
			true,
			false,
			null,
			description,
		);
		return NodeHelpers.displayParameter(params!, credential, null, description);
	};

	it('shows for the Encryption method', () => {
		assert.equal(shown({ operation: 'anonymize', anonymizationMethod: 'encryption' }), true);
	});

	it('hides for every other method, including the default', () => {
		for (const method of [
			'hash',
			'mask',
			'pseudonymization',
			'redact',
			'replace',
			'tokenization',
		]) {
			assert.equal(shown({ operation: 'anonymize', anonymizationMethod: method }), false, method);
		}
		assert.equal(shown({ operation: 'anonymize', anonymizationMethod: 'mask' }), false);
		assert.equal(shown({}), false);
	});

	it('hides for Detect, even if Encryption was picked before switching', () => {
		assert.equal(shown({ operation: 'detect' }), false);
		assert.equal(shown({ operation: 'detect', anonymizationMethod: 'encryption' }), false);
	});

	it('shows for Decrypt, even if a different method was picked before switching', () => {
		assert.equal(shown({ operation: 'decrypt' }), true);
		assert.equal(shown({ operation: 'decrypt', anonymizationMethod: 'redact' }), true);
	});
});
