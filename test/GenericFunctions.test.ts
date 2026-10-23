// Test-only file, not shipped (package.json "files" is dist only): Node built-ins are fine here.
/* eslint-disable @n8n/community-nodes/no-restricted-imports */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import type { INode } from 'n8n-workflow';

import {
	friendlyApiError,
	getBaseUrl,
	getUsableCountries,
	isFernetKey,
	parseCountry,
	parseCountryOrThrow,
	toList,
} from '../nodes/Nexis/GenericFunctions';

const node = { name: 'Nexis', type: 'nexis', typeVersion: 1, position: [0, 0], parameters: {} } as unknown as INode;

/** Minimal stand-in for the n8n context the helpers call into. */
function fakeContext(credentials: Record<string, unknown>, responses: Record<string, unknown> = {}) {
	const calls: string[] = [];
	const context = {
		getNode: () => node,
		getCredentials: async () => credentials,
		helpers: {
			httpRequestWithAuthentication: async (_name: string, options: { url: string }) => {
				calls.push(options.url);
				const response = responses[options.url];
				if (response instanceof Error) throw response;
				return response;
			},
		},
	};
	return { context, calls };
}

describe('parseCountry', () => {
	it('splits a full ID', () => {
		assert.deepEqual(parseCountry('GDPR|Germany||de'), {
			regulation: 'GDPR',
			country: 'Germany',
			subRegion: '',
			language: 'de',
		});
	});

	it('defaults the language to English', () => {
		assert.equal(parseCountry('UK GDPR|United Kingdom').language, 'en');
	});
});

describe('parseCountryOrThrow', () => {
	it('accepts and trims a valid ID', () => {
		assert.deepEqual(parseCountryOrThrow(node, ' HIPAA | United States | | en ', 0), {
			regulation: 'HIPAA',
			country: 'United States',
			subRegion: '',
			language: 'en',
		});
	});

	for (const bad of ['', 'GDPR', '|Germany', 'GDPR|', 'a|b|c|d|e', null, undefined, { a: 1 }]) {
		it(`rejects ${JSON.stringify(bad)}`, () => {
			assert.throws(() => parseCountryOrThrow(node, bad, 0), /Country – Regulation ID is not valid/);
		});
	}
});

describe('toList', () => {
	it('splits on commas and new lines and drops blanks', () => {
		assert.deepEqual(toList('a, b\nc,,\n  \nd'), ['a', 'b', 'c', 'd']);
	});

	it('returns an empty list for empty input', () => {
		assert.deepEqual(toList(undefined), []);
		assert.deepEqual(toList(''), []);
	});
});

describe('isFernetKey', () => {
	it('accepts a generated Fernet key', () => {
		assert.equal(isFernetKey(randomBytes(32).toString('base64url') + '='), true);
	});

	for (const bad of ['', 'abc=', 'A'.repeat(44), 'a+b/' + 'A'.repeat(39) + '=']) {
		it(`rejects "${bad}"`, () => {
			assert.equal(isFernetKey(bad), false);
		});
	}
});

describe('friendlyApiError', () => {
	it('explains a country that is not in the plan', () => {
		const error = { httpCode: '403', context: { data: { error_code: 'country_not_subscribed' } } };
		assert.match(friendlyApiError(node, error).message, /not available for your plan's country/);
	});

	it('explains a rate limit by status or by code', () => {
		assert.equal(friendlyApiError(node, { httpCode: '429' }).message, 'Too many requests to Nexis');
		const byCode = { httpCode: null, context: { data: { error_code: 'AUTH_RATE_LIMIT_EXCEEDED' } } };
		assert.equal(friendlyApiError(node, byCode).message, 'Too many requests to Nexis');
	});

	it('explains an inactive key by status or by API message', () => {
		assert.equal(friendlyApiError(node, { httpCode: '401' }).message, 'Your Nexis API key is not active');
		const byMessage = { httpCode: '403', context: { data: { detail: 'API key is inactive' } } };
		assert.equal(friendlyApiError(node, byMessage).message, 'Your Nexis API key is not active');
	});

	it('explains a used-up daily API call limit, without repeating the API upgrade line', () => {
		const error = {
			httpCode: '402',
			context: {
				data: { message: 'Daily quota exceeded for api calls. Limit: 100 per day. Upgrade your plan to continue.' },
			},
		};
		const friendly = friendlyApiError(node, error) as Error & { description?: string };
		assert.equal(friendly.message, 'Daily Nexis API call limit reached');
		assert.match(String(friendly.description), /^Daily quota exceeded for api calls\. Limit: 100 per day\. The limit resets/);
		assert.doesNotMatch(String(friendly.description), /to continue/);
	});

	it('explains a used-up monthly limit', () => {
		const message = 'Monthly quota exceeded for characters. Used 10,000 of 10,000. Remaining: 0. Upgrade your plan to continue.';
		const friendly = friendlyApiError(node, { httpCode: '402', context: { data: { message } } }) as Error & {
			description?: string;
		};
		assert.equal(friendly.message, 'Nexis usage limit reached');
		assert.match(String(friendly.description), /Used 10,000 of 10,000\. Remaining: 0\. Upgrade your plan for a higher limit/);
	});

	it('explains an account with no active plan', () => {
		const error = { httpCode: '402', context: { data: { message: 'No active subscription found.' } } };
		assert.equal(friendlyApiError(node, error).message, 'Your Nexis account has no active plan');
	});

	it('explains a plan without API access', () => {
		const error = {
			httpCode: '403',
			context: { data: { error_code: 'FORBIDDEN', message: 'This feature is not available on your current plan.' } },
		};
		assert.equal(friendlyApiError(node, error).message, 'Your Nexis plan does not include API access');
	});

	it('leaves other 403 errors as they are', () => {
		const error = { httpCode: '403', context: { data: { error_code: 'FORBIDDEN', message: 'Something else' } } };
		assert.equal(friendlyApiError(node, error), error);
	});

	it('ignores keywords outside the API response, such as the user text', () => {
		const error = Object.assign(new Error('Server error'), {
			httpCode: '500',
			options: { body: { text: 'patient is inactive' } },
		});
		assert.equal(friendlyApiError(node, error), error);
	});

	it('does not crash on an error that refers to itself', () => {
		const error: Record<string, unknown> = { httpCode: '500', message: 'boom' };
		error.self = error;
		assert.equal(friendlyApiError(node, error), error);
	});
});

describe('getBaseUrl', () => {
	it('trims spaces and trailing slashes', async () => {
		const { context } = fakeContext({ baseUrl: ' https://nexis.example.com// ' });
		assert.equal(await getBaseUrl.call(context as never), 'https://nexis.example.com');
	});

	it('uses the default when empty', async () => {
		const { context } = fakeContext({ baseUrl: '' });
		assert.equal(await getBaseUrl.call(context as never), 'https://api.nexis.intelation.com');
	});

	it('rejects a URL without http or https', async () => {
		const { context } = fakeContext({ baseUrl: 'nexis.example.com' });
		await assert.rejects(getBaseUrl.call(context as never), /must start with http/);
	});
});

describe('getUsableCountries', () => {
	const base = 'https://api.nexis.intelation.com';

	it('returns the subscribed countries from the account endpoint only', async () => {
		const countries = [{ regulation: 'UK GDPR', country: 'United Kingdom', sub_region: null, language_code: 'en' }];
		const { context, calls } = fakeContext({}, { [`${base}/api/account/`]: { subscribed_countries: countries } });
		assert.deepEqual(await getUsableCountries.call(context as never), countries);
		assert.deepEqual(calls, [`${base}/api/account/`]);
	});

	it('reports a plan with no countries', async () => {
		const { context } = fakeContext({}, { [`${base}/api/account/`]: { subscribed_countries: [] } });
		await assert.rejects(getUsableCountries.call(context as never), /Your Nexis plan has no countries/);
	});

	it('shows API errors instead of falling back to the catalog', async () => {
		const error = Object.assign(new Error('Unauthorized'), { httpCode: '401' });
		const { context, calls } = fakeContext({}, { [`${base}/api/account/`]: error });
		await assert.rejects(getUsableCountries.call(context as never), /Your Nexis API key is not active/);
		assert.deepEqual(calls, [`${base}/api/account/`]);
	});
});
