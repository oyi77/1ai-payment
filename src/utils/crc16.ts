/**
 * CRC16-CCITT implementation for EMVCo / QRIS.
 *
 * Specification:
 * - Polynomial: 0x1021 (x^16 + x^12 + x^5 + 1)
 * - Initial value: 0xFFFF
 * - Reflection: None (MSB-first)
 * - Output XOR: 0x0000
 * - EMVCo Tag 63: 4 hex uppercase digits computed over everything up to and including "6304"
 */

/**
 * Compute CRC16-CCITT checksum over string or Buffer using poly 0x1021, init 0xFFFF.
 */
export function crc16Ccitt(data: string | Buffer): number {
	const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
	let crc = 0xffff;

	for (let i = 0; i < buf.length; i++) {
		crc ^= buf[i] << 8;
		for (let j = 0; j < 8; j++) {
			if ((crc & 0x8000) !== 0) {
				crc = ((crc << 1) ^ 0x1021) & 0xffff;
			} else {
				crc = (crc << 1) & 0xffff;
			}
		}
	}

	return crc & 0xffff;
}

/**
 * Format 16-bit number as 4-character uppercase hex string.
 */
export function formatCrcHex(crc: number): string {
	return (crc & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}

/**
 * Compute 4-character uppercase hex CRC for EMVCo/QRIS payload up to and including tag "6304".
 * If the payload does not already end with "6304", it is appended before calculation.
 */
export function computeQrisCrc(payloadWithoutCrc: string): string {
	const toCompute = payloadWithoutCrc.endsWith("6304")
		? payloadWithoutCrc
		: `${payloadWithoutCrc}6304`;
	const crc = crc16Ccitt(toCompute);
	return formatCrcHex(crc);
}
