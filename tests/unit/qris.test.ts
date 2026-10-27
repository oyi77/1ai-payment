import { describe, expect, test } from "bun:test";
import { crc16Ccitt, computeQrisCrc, formatCrcHex } from "../../src/utils/crc16";
import {
	EmvTag,
	isValidQrisChecksum,
	parseEmv,
	buildEmv,
	staticToDynamicQris,
} from "../../src/utils/qris";

// Known CRC16-CCITT test vector from EMVCo
const KNOWN_STATIC_QRIS =
	"00020101021126670016COM.NOBUBANK.WWW011893600915122427974002074224279740303UMI51440014ID.CO.QRIS.WWW0215ID10200156229150303UMI5204549953033605802ID5915MERCHANT NAME6007JAKARTA61051015062070703A0163044224";

describe("CRC16-CCITT", () => {
	test("computes known checksum for empty string", () => {
		// CRC16-CCITT init 0xFFFF over empty data should be 0xFFFF
		const crc = crc16Ccitt("");
		expect(crc).toBe(0xffff);
	});

	test("computes CRC for '123456789' (standard vector)", () => {
		// Standard CRC-CCITT (0xFFFF, 0x1021) over "123456789" = 0x29B1
		const crc = crc16Ccitt("123456789");
		expect(crc).toBe(0x29b1);
	});

	test("formatCrcHex pads to 4 uppercase hex", () => {
		expect(formatCrcHex(0x29b1)).toBe("29B1");
		expect(formatCrcHex(0x0001)).toBe("0001");
		expect(formatCrcHex(0xffff)).toBe("FFFF");
	});

	test("computeQrisCrc appends 6304 if missing", () => {
		const payload = "000201";
		const crc = computeQrisCrc(payload);
		expect(crc).toHaveLength(4);
		expect(crc).toBe(crc16Ccitt(payload + "6304").toString(16).toUpperCase().padStart(4, "0"));
	});

	test("computeQrisCrc does not double-append 6304", () => {
		const payload = "0002016304";
		const crc = computeQrisCrc(payload);
		expect(crc).toHaveLength(4);
		expect(crc).toBe(crc16Ccitt(payload).toString(16).toUpperCase().padStart(4, "0"));
	});
});

describe("parseEmv", () => {
	test("parses valid TLV payload", () => {
		const payload = "000201010211";
		const result = parseEmv(payload);
		expect(result["00"]).toBe("01");
		expect(result["01"]).toBe("11");
	});

	test("throws on incomplete TLV", () => {
		expect(() => parseEmv("00")).toThrow();
	});

	test("throws on length overflow", () => {
		expect(() => parseEmv("00FF" + "A".repeat(10))).toThrow();
	});

	test("throws on invalid length hex", () => {
		expect(() => parseEmv("00ZZ")).toThrow();
	});

	test("parses empty payload", () => {
		const result = parseEmv("");
		expect(Object.keys(result)).toHaveLength(0);
	});
});

describe("buildEmv", () => {
	test("builds payload in numeric tag order", () => {
		const tags: Record<string, string> = { "54": "100", "00": "01", "01": "12" };
		const result = buildEmv(tags);
		expect(result).toBe("0002010102125403100");
	});

	test("skips undefined/null values", () => {
		const tags: Record<string, string> = { "00": "01", "01": null as unknown as string };
		const result = buildEmv(tags);
		expect(result).toBe("000201");
	});

	test("throws on value too long", () => {
		const tags: Record<string, string> = { "00": "A".repeat(256) };
		expect(() => buildEmv(tags)).toThrow();
	});
});

describe("isValidQrisChecksum", () => {
	test("returns false for empty payload", () => {
		expect(isValidQrisChecksum("")).toBe(false);
	});

	test("returns false if no CRC tag", () => {
		expect(isValidQrisChecksum("000201")).toBe(false);
	});

	test("returns false if length not 04", () => {
		expect(isValidQrisChecksum("63040000" + "0000")).toBe(false);
	});

	test("validates correct checksum", () => {
		// Build a valid payload
		const core = "000201010211";
		const crc = computeQrisCrc(core);
		const payload = `${core}6304${crc}`;
		expect(isValidQrisChecksum(payload)).toBe(true);
	});

	test("returns false for wrong checksum", () => {
		const core = "000201010211";
		const payload = `${core}63040000`;
		expect(isValidQrisChecksum(payload)).toBe(false);
	});

	test("case-insensitive hex compare", () => {
		const core = "000201010211";
		const crc = computeQrisCrc(core);
		const payload = `${core}6304${crc.toLowerCase()}`;
		expect(isValidQrisChecksum(payload)).toBe(true);
	});
});

describe("staticToDynamicQris", () => {
	test("throws on invalid checksum", () => {
		expect(() => staticToDynamicQris("00020163040000", 10000)).toThrow();
	});

	test("throws on zero amount", () => {
		const core = "000201010211";
		const crc = computeQrisCrc(core);
		const payload = `${core}6304${crc}`;
		expect(() => staticToDynamicQris(payload, 0)).toThrow();
	});

	test("throws on negative amount", () => {
		const core = "000201010211";
		const crc = computeQrisCrc(core);
		const payload = `${core}6304${crc}`;
		expect(() => staticToDynamicQris(payload, -100)).toThrow();
	});

	test("throws on non-integer amount", () => {
		const core = "000201010211";
		const crc = computeQrisCrc(core);
		const payload = `${core}6304${crc}`;
		expect(() => staticToDynamicQris(payload, 100.5)).toThrow();
	});

	test("throws if missing tag 00", () => {
		const core = "010211";
		const crc = computeQrisCrc(core);
		const payload = `${core}6304${crc}`;
		expect(() => staticToDynamicQris(payload, 10000)).toThrow();
	});

	test("converts static to dynamic with correct fields", () => {
		const core = "000201010211";
		const crc = computeQrisCrc(core);
		const payload = `${core}6304${crc}`;
		const dynamic = staticToDynamicQris(payload, 10000);

		// Check that the result is valid QRIS
		expect(isValidQrisChecksum(dynamic)).toBe(true);

		// Parse and verify fields
		const crcPos = dynamic.indexOf(EmvTag.Crc);
		const coreDynamic = dynamic.substring(0, crcPos);
		const tags = parseEmv(coreDynamic);

		expect(tags[EmvTag.PayloadFormatIndicator]).toBe("01");
		expect(tags[EmvTag.PointOfInitiationMethod]).toBe("12");
		expect(tags[EmvTag.TransactionAmount]).toBe("10000");
	});
});

describe("parseEmv roundtrip", () => {
	test("roundtrips through buildEmv", () => {
		const original = "000201010211";
		const parsed = parseEmv(original);
		const rebuilt = buildEmv(parsed);
		expect(rebuilt).toBe(original);
	});
});
