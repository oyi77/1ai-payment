#!/usr/bin/env bun
/**
 * Register the Telegram Stars webhook with the Bot API.
 *
 * One-shot operator script: Telegram allows exactly one webhook URL per bot,
 * so this must be run for the DEDICATED payment bot only. Running it against a
 * bot that other services poll or receive updates on will silently steal those
 * updates.
 *
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
 *     bun run scripts/set-telegram-stars-webhook.ts [baseUrl]
 *
 * The secret is echoed back by Telegram on every update in the
 * `X-Telegram-Bot-Api-Secret-Token` header, which is what the gateway verifies.
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const baseUrl = (process.argv[2] || process.env.PUBLIC_BASE_URL || "").replace(
	/\/$/,
	"",
);

if (!token) {
	console.error("TELEGRAM_BOT_TOKEN is required");
	process.exit(1);
}
if (!secret) {
	console.error(
		"TELEGRAM_WEBHOOK_SECRET is required (Telegram sends it back on every update)",
	);
	process.exit(1);
}
if (!baseUrl.startsWith("https://")) {
	console.error(`A public https base URL is required (got "${baseUrl}")`);
	process.exit(1);
}

const webhookUrl = `${baseUrl}/webhook/telegram_stars`;

async function api(method: string, body?: unknown): Promise<unknown> {
	const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const json = (await res.json()) as { ok: boolean; description?: string };
	if (!json.ok) throw new Error(`${method} failed: ${json.description}`);
	return json;
}

// Refuse to clobber an existing webhook on a bot that is already in use.
const info = (await api("getWebhookInfo")) as {
	result?: { url?: string };
};
const current = info.result?.url ?? "";
if (current && current !== webhookUrl) {
	console.error(
		`Refusing to overwrite existing webhook "${current}".\n` +
			"This bot is already receiving updates elsewhere. Use a dedicated payment bot.",
	);
	process.exit(2);
}

const me = (await api("getMe")) as { result?: { username?: string } };
console.log(`Bot: @${me.result?.username ?? "unknown"}`);

await api("setWebhook", {
	url: webhookUrl,
	secret_token: secret,
	allowed_updates: ["message", "pre_checkout_query"],
	drop_pending_updates: false,
});

const after = (await api("getWebhookInfo")) as {
	result?: { url?: string; pending_update_count?: number };
};
console.log(`Webhook set: ${after.result?.url}`);
console.log(`Pending updates: ${after.result?.pending_update_count ?? 0}`);
