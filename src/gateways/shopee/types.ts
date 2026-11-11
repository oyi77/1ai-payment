/**
 * Shopee domain types — ported from paygateme/shopee/types.go.
 */

import type { Cookie } from "./cookie";

/** OTP request options (Shopee passport). */
export interface OtpRequestOptions {
	password?: string; // required for password-protected accounts
	channel?: number; // OTP delivery channel; 0 = default (WhatsApp)
	deviceReport?: string; // optional device-risk blob
	language?: string;
	timezone?: string;
}

/** Sensitive, short-lived state returned after an OTP is sent. */
export interface OtpChallenge {
	version: number;
	phoneNumber: string;
	channel: number;
	availableChannels?: number[];
	deviceFingerprint: string;
	riskToken: string;
	hasPassword: boolean;
	cookies: Cookie[];
	requestedAt: number; // epoch ms
}

/** Merchant summary — a merchant the account can access. */
export interface MerchantSummary {
	id: string;
	name: string;
	status: number;
	staffUserId: number;
	staffRole: number;
	staffStatus: number;
	isActive: boolean;
	isBanned: boolean;
	isCurrentLoginUser: boolean;
}

/** Intermediate state after OTP verification succeeds. */
export interface OtpVerification {
	version: number;
	tocNonce: string;
	tocUserId: number;
	spcClientId: string;
	deviceFingerprint: string;
	cookies: Cookie[];
	merchants: MerchantSummary[];
	verifiedAt: number;
}

/** Store (outlet) under a merchant. */
export interface Store {
	id: string;
	name: string;
	status: number;
}

/** Owner metadata that prevents a manually supplied QRIS crossing stores. */
export interface StaticQrisScope {
	merchantId: string;
	storeId: string;
}

/** Full merchant profile including user info. */
export interface MerchantProfile {
	merchantId: string;
	merchantName: string;
	storeId?: string;
	accountId: string;
	userId: string;
	userName: string;
	language: string;
	shopeePayServiceStatus: number;
}

/** Account-session material needed to re-mint the merchant token without OTP. */
export interface SwitchCredential {
	tocNonce: string;
	spcClientId: string;
	deviceFingerprint: string;
}

/** Persisted Shopee merchant session. */
export interface Session {
	version: number;
	cookies: Cookie[];
	accountId: string;
	merchant: MerchantSummary;
	merchants: MerchantSummary[];
	stores: Store[];
	storeId?: string;
	createdAt: number;
	expiresAt?: number;
	switchCredential?: SwitchCredential;
}

/** LoginWithOtp outcome. */
export enum LoginStatus {
	COMPLETE = "complete",
	MERCHANT_SELECTION_REQUIRED = "merchant-selection-required",
}

export interface LoginOutcome {
	status: LoginStatus;
	session?: Session;
	verification?: OtpVerification;
	merchants?: MerchantSummary[];
}

/** Decoded dashboard JWT payload (inner merchant token). */
export interface MerchantCredential {
	token: string;
	accountId: string;
	businessId: string;
	expiresAt: number; // epoch ms; 0 = unknown
}
