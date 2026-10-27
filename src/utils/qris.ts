/**
 * EMVCo QRIS (Quick Response Code Indonesian Standard) utilities.
 * Implements parsing, building, and conversion of static to dynamic QRIS payloads.
 */

import { computeQrisCrc } from "./crc16";

/**
 * EMV tag identifiers (2-digit strings) as per EMVCo Book C-4 / QRIS.
 */
export const EmvTag = {
	PayloadFormatIndicator: "00",
	PointOfInitiationMethod: "01",
	MerchantAccountInformation: "26",
	MerchantCategoryCode: "52",
	TransactionCurrency: "53",
	TransactionAmount: "54",
	CountryCode: "58",
	MerchantName: "59",
	MerchantCity: "60",
	PostalCode: "61",
	AdditionalDataFieldTemplate: "62",
	Crc: "63",
	UnreservedTemplate: "64",
	UnreservedTemplate2: "65",
	UnreservedTemplate3: "66",
	UnreservedTemplate4: "67",
	UnreservedTemplate5: "68",
	UnreservedTemplate6: "69",
	UnreservedTemplate7: "70",
	UnreservedTemplate8: "71",
	UnreservedTemplate9: "72",
	UnreservedTemplate10: "73",
	UnreservedTemplate11: "74",
	UnreservedTemplate12: "75",
	UnreservedTemplate13: "76",
	UnreservedTemplate14: "77",
	UnreservedTemplate15: "78",
	UnreservedTemplate16: "79",
} as const;

/**
 * Validates the CRC checksum of an EMVCo/QRIS payload.
 * Expects the payload to include the CRC tag (63) with 4 hex digits.
 * @param payload The EMV payload string (with CRC)
 * @returns true if the CRC is valid, false otherwise
 */
export function isValidQrisChecksum(payload: string): boolean {
	if (!payload) {
		return false;
	}

	// Find the CRC tag (63) with length 04
	const crcTagPos = payload.indexOf(EmvTag.Crc);
	if (crcTagPos === -1) {
		return false;
	}

	// The CRC tag must be followed by length "04" and then 4 hex digits
	if (payload.length < crcTagPos + 8) {
		return false;
	}

	const lengthStr = payload.substring(crcTagPos + 2, crcTagPos + 4);
	if (lengthStr !== "04") {
		return false;
	}

	const payloadUpToLength = payload.substring(0, crcTagPos + 4);
	const expectedCrc = payload.substring(crcTagPos + 4, crcTagPos + 8);
	const computedCrc = computeQrisCrc(payloadUpToLength);

	return expectedCrc.toUpperCase() === computedCrc.toUpperCase();
}

/**
 * Parses an EMV payload string into a record of tag->value.
 * Assumes the payload is a concatenation of TLV (Tag, Length, Value) fields.
 * Throws Error if the payload is malformed.
 * @param payload The EMV payload string (without CRC tag)
 * @returns Record of tag (string) to value (string)
 */
export function parseEmv(payload: string): Record<string, string> {
	const result: Record<string, string> = {};
	let pos = 0;

	while (pos < payload.length) {
		if (pos + 4 > payload.length) {
			throw new Error(`Incomplete TLV at position ${pos}`);
		}

		const tag = payload.substring(pos, pos + 2);
		const lengthHex = payload.substring(pos + 2, pos + 4);
		const length = Number.parseInt(lengthHex, 10);

		if (Number.isNaN(length)) {
			throw new Error(`Invalid length at position ${pos + 2}: ${lengthHex}`);
		}

		const valueStart = pos + 4;
		const valueEnd = valueStart + length;
		if (length > 99 || valueEnd > payload.length) {
			throw new Error(`Value overflows payload at position ${pos}`);
		}

		const value = payload.substring(valueStart, valueEnd);
		result[tag] = value;

		pos = valueEnd;
	}

	return result;
}

/**
 * Builds an EMV payload string from a record of tag->value.
 * Tags are sorted numerically (as strings) for deterministic output.
 * @param tags Record of tag (string) to value (string)
 * @returns The EMV payload string (without CRC tag)
 */
export function buildEmv(tags: Record<string, string>): string {
	// Sort tags numerically (as strings) for consistent ordering
	const sortedTags = Object.keys(tags).sort((a, b) => {
		const aNum = Number.parseInt(a, 10);
		const bNum = Number.parseInt(b, 10);
		return aNum - bNum;
	});

	let payload = "";
	for (const tag of sortedTags) {
		const value = tags[tag];
		if (value === undefined || value === null) {
			continue;
		}
		const valueStr = String(value);
		const length = valueStr.length;
		if (length > 99) {
			throw new Error(`Value too long for tag ${tag}: ${length} bytes`);
		}
		const lengthStr = String(length).padStart(2, "0");
		payload += tag + lengthStr + valueStr;
	}

	return payload;
}

/**
 * Converts a static QRIS payload to a dynamic one by:
 * 1. Validating the input checksum
 * 2. Parsing the payload
 * 3. Setting POI (tag 01) to "12" (dynamic)
 * 4. Setting Transaction Amount (tag 54) to the given amount
 * 5. Rebuilding the payload and appending a new CRC
 *
 * @param staticPayload The static QRIS payload string (with valid CRC)
 * @param amount The transaction amount (must be a positive integer)
 * @returns The dynamic QRIS payload string (with CRC)
 * @throws Error if the static payload is invalid, amount is not positive, or required tags missing
 */
export function staticToDynamicQris(
	staticPayload: string,
	amount: number,
): string {
	if (!isValidQrisChecksum(staticPayload)) {
		throw new Error("Invalid static QRIS checksum");
	}

	if (!Number.isInteger(amount) || amount <= 0) {
		throw new Error("Amount must be a positive integer");
	}

	// Remove the existing CRC to work on the payload core
	const crcTagPos = staticPayload.indexOf(EmvTag.Crc);
	const payloadWithoutCrc =
		crcTagPos === -1 ? staticPayload : staticPayload.substring(0, crcTagPos);

	const tags = parseEmv(payloadWithoutCrc);

	// Validate that we have the Payload Format Indicator (tag 00) as per spec
	if (!(EmvTag.PayloadFormatIndicator in tags)) {
		throw new Error("Missing Payload Format Indicator (tag 00)");
	}

	// Set POI to dynamic (12)
	tags[EmvTag.PointOfInitiationMethod] = "12";

	// Set transaction amount (must be integer string without decimals)
	tags[EmvTag.TransactionAmount] = amount.toString();

	// Rebuild the payload (without CRC)
	const newPayloadCore = buildEmv(tags);

	// Append the new CRC
	const newCrc = computeQrisCrc(newPayloadCore);
	return `${newPayloadCore}${EmvTag.Crc}04${newCrc}`;
}
