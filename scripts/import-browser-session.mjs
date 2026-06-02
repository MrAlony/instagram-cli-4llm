#!/usr/bin/env node

import process from 'node:process';
import {IgApiClient} from 'instagram-private-api';
import {ConfigManager} from '../dist/config.js';
import {SessionManager} from '../dist/session.js';

function usage() {
	console.error('Usage: node scripts/import-browser-session.mjs <username>');
	console.error(
		'Paste a Cookie header on stdin, or set INSTAGRAM_COOKIE_HEADER.',
	);
}

function readStdin() {
	return new Promise((resolve, reject) => {
		let data = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', chunk => {
			data += chunk;
		});
		process.stdin.on('end', () => resolve(data));
		process.stdin.on('error', reject);
	});
}

function parseCookieHeader(raw) {
	const cleaned = raw
		.trim()
		.replace(/^cookie:\s*/i, '')
		.replace(/^['"]|['"]$/g, '');
	const pairs = new Map();
	for (const part of cleaned.split(';')) {
		const index = part.indexOf('=');
		if (index === -1) {
			continue;
		}
		const name = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (name && value) {
			pairs.set(name, value);
		}
	}
	return pairs;
}

async function setCookie(jar, name, value) {
	const encoded = `${name}=${value}; Domain=.instagram.com; Path=/; Secure; HttpOnly`;
	await new Promise((resolve, reject) => {
		jar.setCookie(encoded, 'https://i.instagram.com/', error => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}

const username = process.argv[2]?.trim();
if (!username) {
	usage();
	process.exit(2);
}

const rawCookieHeader =
	process.env.INSTAGRAM_COOKIE_HEADER || (await readStdin());
const cookies = parseCookieHeader(rawCookieHeader);
const required = ['sessionid', 'ds_user_id', 'csrftoken'];
const missing = required.filter(name => !cookies.has(name));
if (missing.length > 0) {
	console.error(`Missing required Instagram cookie(s): ${missing.join(', ')}`);
	console.error(
		'Open instagram.com while logged in, copy the Cookie request header, and retry.',
	);
	process.exit(1);
}

const ig = new IgApiClient();
ig.state.generateDevice(username);

for (const [name, value] of cookies) {
	await setCookie(ig.state.cookieJar, name, value);
}

ig.state.authorization = `Bearer IGT:2:${Buffer.from(
	JSON.stringify({
		ds_user_id: cookies.get('ds_user_id'),
		sessionid: cookies.get('sessionid'),
		should_use_header_over_cookie: '1',
	}),
).toString('base64')}`;

if (cookies.has('ig_did')) {
	ig.state.uuid = cookies.get('ig_did');
}

try {
	let user;
	try {
		user = await ig.account.currentUser();
	} catch {
		const response = await ig.request.send({
			url: '/api/v1/users/web_profile_info/',
			qs: {username},
		});
		const webUser = response.body?.data?.user;
		if (!webUser?.id) {
			throw new Error(
				'Imported cookies did not authenticate against mobile or web-profile API.',
			);
		}
		user = {username: webUser.username ?? username, pk: webUser.id};
	}
	const config = ConfigManager.getInstance();
	await config.initialize();
	const sessionManager = new SessionManager(username);
	await sessionManager.saveSession(await ig.state.serialize());
	await config.set('login.currentUsername', username);
	if (!config.get('login.defaultUsername')) {
		await config.set('login.defaultUsername', username);
	}
	console.log(`Imported browser session for @${user.username} (${user.pk}).`);
	console.log(`Saved CLI session as @${username}.`);
} catch (error) {
	console.error(
		'Browser cookies were imported into the API client, but Instagram rejected them.',
	);
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
