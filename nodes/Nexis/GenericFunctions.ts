import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { createHash } from 'node:crypto';

type Context = IExecuteFunctions | ILoadOptionsFunctions;

// Country option values are "regulation|country|sub_region|language"
export const SEP = '|';

export interface CatalogEntity {
	presidio_entity: string;
	display_name?: string;
	/** "Supported", or "Coming Soon" for an entity Nexis accepts but cannot detect yet */
	support_status?: string;
}

/** Whether an entity can be detected today. Global entities come without a status and are always supported. */
export const isSupportedEntity = (e: CatalogEntity): boolean => !e.support_status || e.support_status === 'Supported';

export interface CatalogRegulation {
	country: string;
	regulation: string;
	sub_region?: string | null;
	language_code?: string;
	entities?: CatalogEntity[];
}

export interface Catalog {
	summary?: { global_entities?: CatalogEntity[] };
	regulations?: CatalogRegulation[];
}

export async function getBaseUrl(this: Context): Promise<string> {
	const { baseUrl } = await this.getCredentials('nexisApi');
	const url = String(baseUrl || 'https://api.nexis.intelation.com').trim().replace(/\/+$/, '');
	if (!/^https?:\/\//i.test(url)) {
		throw new NodeOperationError(this.getNode(), 'Base URL must start with http:// or https://');
	}
	return url;
}

/** Sends an authenticated JSON request to the Nexis API. */
export async function nexisRequest(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	options: Partial<IHttpRequestOptions> = {},
): Promise<unknown> {
	const base = await getBaseUrl.call(this);
	return await this.helpers.httpRequestWithAuthentication.call(this, 'nexisApi', {
		method,
		url: `${base}${path}`,
		json: true,
		...options,
	});
}

export async function getCatalog(this: ILoadOptionsFunctions): Promise<Catalog> {
	return (await nexisRequest.call(this, 'GET', '/catalog/')) as Catalog;
}

/** Nexis replies to a reused Idempotency-Key whose first request failed, or never finished (e.g. rejected for quota). */
const IDEMPOTENCY_RETRY_CODES = ['IDEMPOTENCY_PREVIOUS_FAILURE', 'IDEMPOTENCY_DUPLICATE_IN_PROGRESS'];

/** Retry On Fail runs a node at most 5 times, so an item never needs more keys than that. */
const MAX_IDEMPOTENCY_KEYS = 5;

/**
 * POST with an Idempotency-Key that stays the same when n8n retries the node (Retry On Fail), so an item that
 * already succeeded comes back from the Nexis cache instead of being processed and billed again. The key is a
 * hash of the execution, node, run, item and body. Nexis keeps failures under a key too, so when it replies that the
 * key's earlier request failed or is stuck, the request is sent again under the next key in the series.
 */
export async function nexisIdempotentPost(
	this: IExecuteFunctions,
	path: string,
	body: IDataObject,
	itemIndex: number,
): Promise<unknown> {
	const executionId = this.getExecutionId();
	// Without an execution ID, a key could repeat across executions and return another run's result.
	if (!executionId) return await nexisRequest.call(this, 'POST', path, { body });

	// The run index stays the same on Retry On Fail but changes on each pass of a loop, so a loop gets fresh results.
	const runIndex = this.getWorkflowDataProxy(itemIndex).$runIndex;
	const key =
		'n8n-' +
		createHash('sha256')
			.update([executionId, this.getNode().id, runIndex, itemIndex, JSON.stringify(body)].join('\n'))
			.digest('hex');
	let lastError: unknown;
	for (let attempt = 0; attempt < MAX_IDEMPOTENCY_KEYS; attempt++) {
		try {
			return await nexisRequest.call(this, 'POST', path, {
				body,
				headers: { 'Idempotency-Key': attempt ? `${key}-${attempt}` : key },
			});
		} catch (error) {
			lastError = error;
			if (!IDEMPOTENCY_RETRY_CODES.includes(String(apiErrorDetails(error).body.error_code ?? ''))) break;
		}
	}
	// The caller turns the API error into a friendly message (friendlyApiError).
	throw lastError;
}

/** Fernet key: 32 bytes as URL-safe base64, i.e. 43 characters plus one "=" of padding. */
export const isFernetKey = (key: string): boolean => /^[A-Za-z0-9_-]{43}=$/.test(key);

export const toList = (value: unknown): string[] =>
	String(value ?? '')
		.split(/[\n,]/)
		.map((s) => s.trim())
		.filter(Boolean);

export interface CountryRegulation {
	regulation: string;
	country: string;
	subRegion: string;
	language: string;
}

export function parseCountry(value: string): CountryRegulation {
	const [regulation, country, subRegion, language] = value.split(SEP);
	return { regulation, country, subRegion: subRegion ?? '', language: language || 'en' };
}

/** Like parseCountry, but throws a clear error when the value is not a valid "regulation|country|sub-region|language" ID. */
export function parseCountryOrThrow(node: INode, value: unknown, itemIndex: number): CountryRegulation {
	const raw = value === null || value === undefined || typeof value === 'object' ? '' : String(value).trim();
	const parts = raw.split(SEP);
	const picked = parseCountry(raw);
	if (!picked.regulation?.trim() || !picked.country?.trim() || parts.length > 4) {
		throw new NodeOperationError(node, `Country – Regulation ID is not valid: "${raw}"`, {
			itemIndex,
			description:
				'Use the format regulation|country|sub-region|language (sub-region and language can be empty). Tip: pick a country from the list, then switch to Expression to see its exact ID.',
		});
	}
	return {
		regulation: picked.regulation.trim(),
		country: picked.country.trim(),
		subRegion: picked.subRegion.trim(),
		language: picked.language.trim() || 'en',
	};
}

// ---------------------------------------------------------------------------
// Account countries and friendly errors
// ---------------------------------------------------------------------------

/** Nexis website, used for sign-up and plan upgrades. */
export const NEXIS_URL = 'https://nexis.intelation.com';

/** A country the account can use: a catalog regulation without its entity list. */
export type AccountCountry = Omit<CatalogRegulation, 'entities'>;

/** Countries (with their regulations) the account can use, from GET /api/account/. */
export async function getUsableCountries(this: Context): Promise<AccountCountry[]> {
	let account: { subscribed_countries?: AccountCountry[] };
	try {
		account = (await nexisRequest.call(this, 'GET', '/api/account/')) as typeof account;
	} catch (error) {
		throw friendlyApiError(this.getNode(), error);
	}
	const countries = account.subscribed_countries ?? [];
	if (!countries.length) {
		throw new NodeOperationError(this.getNode(), 'Your Nexis plan has no countries', {
			description: `Add a country to your plan to use this node: ${NEXIS_URL}`,
		});
	}
	return countries;
}

/** The HTTP status and JSON body of a failed Nexis API call, read without serialising the whole error. */
function apiErrorDetails(error: unknown): { status: string; body: IDataObject } {
	const e = (error ?? {}) as {
		httpCode?: string | null;
		context?: { data?: unknown };
		cause?: { response?: { status?: number; data?: unknown } };
		response?: { status?: number; data?: unknown };
	};
	const response = e.cause?.response ?? e.response;
	const data = e.context?.data ?? response?.data;
	const body = data && typeof data === 'object' && !Array.isArray(data) ? (data as IDataObject) : {};
	return { status: String(e.httpCode ?? response?.status ?? ''), body };
}

/** Turns raw Nexis API errors into messages a non-technical user can act on. */
export function friendlyApiError(node: INode, error: unknown, itemIndex?: number): Error {
	const { status, body } = apiErrorDetails(error);
	const nested = body.detail && typeof body.detail === 'object' ? (body.detail as IDataObject) : {};
	const codes = [body.code, body.error_code, body.error, nested.code];
	// Only the API's own message fields, never the request (which holds the user's text).
	const apiMessage = [body.detail, body.message, nested.message].filter((v) => typeof v === 'string').join(' ');

	if (codes.includes('country_not_subscribed')) {
		return new NodeOperationError(node, "This action is not available for your plan's country", {
			itemIndex,
			description: `Your plan does not include this country. Add countries by upgrading: ${NEXIS_URL}`,
		});
	}
	if (status === '429' || codes.includes('AUTH_RATE_LIMIT_EXCEEDED')) {
		return new NodeOperationError(node, 'Too many requests to Nexis', {
			itemIndex,
			description:
				"The rate limit for your API key was reached. Try again in a minute, or turn on Retry On Fail in this node's settings.",
		});
	}
	if (status === '401' || /not approved|inactive|invalid api key/i.test(apiMessage)) {
		return new NodeOperationError(node, 'Your Nexis API key is not active', {
			itemIndex,
			description: `Check that the key is correct and active, or get a free key: ${NEXIS_URL}`,
		});
	}
	if (status === '402') {
		if (/no active subscription/i.test(apiMessage)) {
			return new NodeOperationError(node, 'Your Nexis account has no active plan', {
				itemIndex,
				description: `Choose a plan to use this node: ${NEXIS_URL}`,
			});
		}
		// e.g. "Daily quota exceeded for api calls. Limit: 100 per day." The API's own upgrade line is replaced by ours.
		const limit = apiMessage.replace(/\s*Upgrade your plan to continue\.?\s*$/i, '');
		const daily = /daily/i.test(limit);
		return new NodeOperationError(node, daily ? 'Daily Nexis API call limit reached' : 'Nexis usage limit reached', {
			itemIndex,
			description: `${limit ? `${limit} ` : ''}${daily ? 'The limit resets at midnight UTC. ' : ''}Upgrade your plan for a higher limit: ${NEXIS_URL}`,
		});
	}
	if (status === '403' && /not available on your (current )?plan/i.test(apiMessage)) {
		return new NodeOperationError(node, 'Your Nexis plan does not include API access', {
			itemIndex,
			description: `Upgrade your plan to use this node: ${NEXIS_URL}`,
		});
	}
	return error as Error;
}
