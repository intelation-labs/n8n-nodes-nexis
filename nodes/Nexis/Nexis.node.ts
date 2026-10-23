import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { properties } from './descriptions';
import {
	SEP,
	friendlyApiError,
	getCatalog,
	getUsableCountries,
	isFernetKey,
	isSupportedEntity,
	nexisIdempotentPost,
	nexisRequest,
	parseCountry,
	parseCountryOrThrow,
	toList,
} from './GenericFunctions';
import type { CatalogEntity } from './GenericFunctions';

/** Every anonymization method except Encryption, read from the field's own options so the two cannot drift apart. */
const METHODS_WITHOUT_KEY = (properties.find((p) => p.name === 'anonymizationMethod')?.options ?? [])
	.map((o) => (o as INodePropertyOptions).value as string)
	.filter((v) => v !== 'encryption');

/** Longest text POST /api/detect/ accepts, in characters. */
const DETECT_MAX_CHARS = 5000;

/** Encrypted values in Nexis output look like <<ENC:token:ENC>>. */
const ENCRYPTED_VALUE = /<<ENC:[^:]+:ENC>>/g;
const countEncrypted = (text: string): number => (text.match(ENCRYPTED_VALUE) ?? []).length;

/** Reads a text parameter, rejecting objects, lists and empty values with a clear message. */
function readText(this: IExecuteFunctions, name: string, i: number, emptyHint: string): string {
	const raw = this.getNodeParameter(name, i) as unknown;
	if (raw !== null && typeof raw === 'object') {
		throw new NodeOperationError(this.getNode(), 'Text must be text, not an object or list', {
			itemIndex: i,
			description: 'Point the field at a single text value, e.g. {{ $json.message }}.',
		});
	}
	const text = String(raw ?? '');
	if (!text.trim()) {
		throw new NodeOperationError(this.getNode(), 'Text is empty', { itemIndex: i, description: emptyHint });
	}
	return text;
}

/** The Fernet key from the Nexis Encryption Key API credential, checked before it is sent. */
async function getEncryptionKey(this: IExecuteFunctions, i: number): Promise<string> {
	const { secretKey } = await this.getCredentials('nexisEncryptionApi', i);
	const key = String(secretKey ?? '').trim();
	if (!isFernetKey(key)) {
		throw new NodeOperationError(this.getNode(), 'The encryption key is not a valid Fernet key', {
			itemIndex: i,
			description: 'Open the Nexis Encryption Key API credential and enter a 44-character URL-safe base64 key ending in "=".',
		});
	}
	return key;
}

/**
 * Decrypts one item with POST /api/decrypt/. Nexis leaves a value encrypted when the key does not match
 * and still reports success, so values left over after decryption are reported as an error here.
 */
async function decryptItem(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const encryptedText = readText.call(
		this,
		'encryptedText',
		i,
		'Enter the encrypted text, or check that the field it comes from has a value for this item.',
	);
	const total = countEncrypted(encryptedText);
	if (!total) {
		throw new NodeOperationError(this.getNode(), 'No encrypted values found', {
			itemIndex: i,
			description:
				'Decrypt only works on text from the Encryption method, where each value looks like <<ENC:...:ENC>>.',
		});
	}
	const key = await getEncryptionKey.call(this, i);

	let response: IDataObject;
	try {
		response = (await nexisRequest.call(this, 'POST', '/api/decrypt/', {
			body: { encrypted_text: encryptedText, encryption_key: key },
		})) as IDataObject;
	} catch (error) {
		throw friendlyApiError(this.getNode(), error, i);
	}

	const left = countEncrypted(String(response.decrypted_text ?? ''));
	if (left) {
		throw new NodeOperationError(
			this.getNode(),
			left === total
				? 'Could not decrypt the text with this key'
				: `${left} of ${total} encrypted values could not be decrypted`,
			{
				itemIndex: i,
				description:
					'Check that the Nexis Encryption Key API credential holds the same key that was used to encrypt this text.',
			},
		);
	}
	return response;
}

export class Nexis implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Nexis – PII Anonymizer',
		name: 'nexis',
		icon: { light: 'file:../../icons/nexis.svg', dark: 'file:../../icons/nexis.dark.svg' },
		group: ['transform'],
		version: 1,
		// "Decrypt", or e.g. "Redact · UK GDPR (United Kingdom)" / "Detect · UK GDPR (United Kingdom)"; the country part is left out while it is empty or an expression
		subtitle:
			'={{ $parameter["operation"] === "decrypt" ? "Decrypt" : ($parameter["operation"] === "detect" ? "Detect" : ({ encryption: "Encryption", hash: "Hash", mask: "Mask", pseudonymization: "Pseudonymization", redact: "Redact", replace: "Replace", tokenization: "Tokenization" })[$parameter["anonymizationMethod"]]) + ((typeof $parameter["country"] === "string" && $parameter["country"] && !$parameter["country"].startsWith("=")) ? " · " + $parameter["country"].split("|")[0] + " (" + $parameter["country"].split("|")[1] + ")" : "") }}',
		description: 'Regulation-aware PII anonymization – HIPAA, UK GDPR, Privacy Act',
		defaults: {
			name: 'Nexis',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'nexisApi',
				required: true,
			},
			{
				name: 'nexisEncryptionApi',
				required: true,
				testedBy: 'nexisEncryptionKeyTest',
				// Needed for the Encryption method and for Decrypt. Hiding it for every other method covers both:
				// under Decrypt the method field is not shown, so n8n ignores its value and this rule never hides it.
				// Detect hides the method field too, so it is hidden by operation.
				displayOptions: { hide: { anonymizationMethod: METHODS_WITHOUT_KEY, operation: ['detect'] } },
			},
		],
		properties,
	};

	methods = {
		credentialTest: {
			async nexisEncryptionKeyTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const key = String(credential.data?.secretKey ?? '').trim();
				return isFernetKey(key)
					? { status: 'OK', message: 'Valid Fernet key' }
					: { status: 'Error', message: 'Not a valid Fernet key: use a 44-character URL-safe base64 key ending in "="' };
			},
		},
		loadOptions: {
			async getCountries(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const countries = await getUsableCountries.call(this);
				return countries.map((r) => {
					const lang = (r.language_code ?? 'en').toUpperCase();
					const where = r.sub_region ? `${r.country} – ${r.sub_region}` : r.country;
					return {
						name: `${where} – ${r.regulation} (${lang})`,
						value: [r.regulation, r.country, r.sub_region ?? '', r.language_code ?? 'en'].join(SEP),
					};
				});
			},
			async getEntities(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const catalog = await getCatalog.call(this);
				const entities = new Map<string, string>();
				// "Coming Soon" entities are left out: Nexis accepts them but cannot detect them yet.
				const add = (e: CatalogEntity) => {
					if (isSupportedEntity(e)) entities.set(e.presidio_entity, e.display_name ?? e.presidio_entity);
				};
				// Only the entities of the chosen country – regulation; before one is chosen, the global ones.
				const chosen = this.getCurrentNodeParameter('country') as string | undefined;
				if (chosen) {
					const { regulation, country, subRegion } = parseCountry(chosen);
					(catalog.regulations ?? [])
						.filter(
							(r) => r.regulation === regulation && r.country === country && (r.sub_region ?? '') === subRegion,
						)
						.forEach((r) => (r.entities ?? []).forEach(add));
				}
				if (!entities.size) (catalog.summary?.global_entities ?? []).forEach(add);
				return [...entities]
					.map(([value, name]) => ({ name, value, description: value }))
					.sort((a, b) => a.name.localeCompare(b.name));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i, 'anonymize');
				if (operation === 'decrypt') {
					returnData.push({ json: await decryptItem.call(this, i), pairedItem: { item: i } });
					continue;
				}
				const detect = operation === 'detect';

				const picked = parseCountryOrThrow(this.getNode(), this.getNodeParameter('country', i), i);
				const text = readText.call(
					this,
					'text',
					i,
					`Enter the text to ${detect ? 'scan' : 'anonymize'}, or check that the field it comes from has a value for this item.`,
				);
				// Nexis counts characters as Unicode code points, so emoji count once.
				if (detect && [...text].length > DETECT_MAX_CHARS) {
					throw new NodeOperationError(this.getNode(), 'Text is too long for Detect', {
						itemIndex: i,
						description: `Detect accepts up to ${DETECT_MAX_CHARS.toLocaleString('en')} characters per item. Split the text into smaller parts.`,
					});
				}

				const body: IDataObject = {
					text,
					regulation: picked.regulation,
					country: picked.country,
					language: picked.language,
				};
				if (picked.subRegion) body.sub_region = picked.subRegion;

				const method = detect ? '' : (this.getNodeParameter('anonymizationMethod', i) as string);
				if (method) body.anonymisation_method = method;

				if (method === 'encryption') body.encryption_key = await getEncryptionKey.call(this, i);

				if (method === 'mask') {
					const mask = this.getNodeParameter('maskingOptions', i, {}) as IDataObject;
					const char = mask.maskingChar as string | undefined;
					if (char !== undefined && char.length !== 1) {
						throw new NodeOperationError(this.getNode(), 'Masking Character must be a single character', {
							itemIndex: i,
						});
					}
					if (char) body.masking_char = char;
					if (mask.charsToMask) {
						body.chars_to_mask = mask.charsToMask;
						if (mask.fromEnd !== undefined) body.from_end = mask.fromEnd;
					}
				}

				if (!detect) {
					const lists = this.getNodeParameter('listOptions', i, {}) as IDataObject;
					if (lists.allowList) body.allow_list = toList(lists.allowList);
					if (lists.denyList) body.deny_list = toList(lists.denyList);
				}
				if (detect && this.getNodeParameter('showExplanations', i, false)) body.show_explanations = true;

				const mode = this.getNodeParameter('detectionMode', i, 'auto');
				if (mode === 'excluded') {
					const list = this.getNodeParameter('excludedEntities', i, []) as string[];
					if (!list.length) {
						throw new NodeOperationError(this.getNode(), 'Choose at least one entity type to exclude', {
							itemIndex: i,
							description: 'Detection is set to "Exclude Entities". Pick entities, or switch Detection to Auto.',
						});
					}
					body.excluded_entities = list;
				}
				if (mode === 'selected') {
					const list = this.getNodeParameter('selectedEntities', i, []) as string[];
					if (!list.length) {
						throw new NodeOperationError(this.getNode(), 'Choose at least one entity type', {
							itemIndex: i,
							description: 'Detection is set to "Selected Entities Only". Pick entities, or switch Detection to Auto.',
						});
					}
					body.selected_entities = list;
				}

				let response: IDataObject;
				try {
					// Nexis has no Idempotency-Key support on /api/detect/, and Detect stores nothing.
					response = (
						detect
							? await nexisRequest.call(this, 'POST', '/api/detect/', { body })
							: await nexisIdempotentPost.call(this, '/api/text/', body, i)
					) as IDataObject;
				} catch (error) {
					throw friendlyApiError(this.getNode(), error, i);
				}
				returnData.push({
					json: response,
					pairedItem: { item: i },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					const { message, description } = error as Error & { description?: string | null };
					const json: IDataObject = { error: message };
					if (description) json.description = description;
					returnData.push({ json, pairedItem: { item: i } });
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
