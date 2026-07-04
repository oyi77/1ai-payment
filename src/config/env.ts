/**
 * Environment configuration — 100% externalized, no hardcoded values.
 */

export interface Config {
  PORT: number;
  NODE_ENV: 'development' | 'production' | 'test';
  DATABASE_PATH: string;
  API_KEY: string;

  // Midtrans
  MIDTRANS_SERVER_KEY: string;
  MIDTRANS_CLIENT_KEY: string;
  MIDTRANS_ENVIRONMENT: 'sandbox' | 'production';

  // Tripay
  TRIPAY_API_KEY: string;
  TRIPAY_PRIVATE_KEY: string;
  TRIPAY_MERCHANT_CODE: string;
  TRIPAY_ENVIRONMENT: 'sandbox' | 'production';

  // Duitku
  DUITKU_API_KEY: string;
  DUITKU_MERCHANT_CODE: string;
  DUITKU_ENVIRONMENT: 'sandbox' | 'production';

  // NOWPayments
  NOWPAYMENTS_API_KEY: string;
  NOWPAYMENTS_IPN_SECRET: string;
  NOWPAYMENTS_ENVIRONMENT: 'sandbox' | 'production';

  // iPaymu
  IPAYMU_API_KEY: string;
  IPAYMU_VA_KEY: string;
  IPAYMU_ENVIRONMENT: 'sandbox' | 'production';

  // Scalev
  SCALEV_API_KEY: string;
  SCALEV_MERCHANT_ID: string;
  SCALEV_ENVIRONMENT: 'sandbox' | 'production';

  // Xendit
  XENDIT_API_KEY: string;
  XENDIT_CALLBACK_TOKEN: string;
  XENDIT_ENVIRONMENT: 'sandbox' | 'production';

  // Logging
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
}

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  const optional = (key: string, fallback = ''): string =>
    process.env[key] || fallback;

  cachedConfig = {
    PORT: Number(optional('PORT', '3100')),
    NODE_ENV: (optional('NODE_ENV', 'development') as Config['NODE_ENV']),
    DATABASE_PATH: optional('DATABASE_PATH', './data/payment.db'),
    API_KEY: required('API_KEY'),

    MIDTRANS_SERVER_KEY: optional('MIDTRANS_SERVER_KEY'),
    MIDTRANS_CLIENT_KEY: optional('MIDTRANS_CLIENT_KEY'),
    MIDTRANS_ENVIRONMENT: (optional('MIDTRANS_ENVIRONMENT', 'sandbox') as Config['MIDTRANS_ENVIRONMENT']),

    TRIPAY_API_KEY: optional('TRIPAY_API_KEY'),
    TRIPAY_PRIVATE_KEY: optional('TRIPAY_PRIVATE_KEY'),
    TRIPAY_MERCHANT_CODE: optional('TRIPAY_MERCHANT_CODE'),
    TRIPAY_ENVIRONMENT: (optional('TRIPAY_ENVIRONMENT', 'sandbox') as Config['TRIPAY_ENVIRONMENT']),

    DUITKU_API_KEY: optional('DUITKU_API_KEY'),
    DUITKU_MERCHANT_CODE: optional('DUITKU_MERCHANT_CODE'),
    DUITKU_ENVIRONMENT: (optional('DUITKU_ENVIRONMENT', 'sandbox') as Config['DUITKU_ENVIRONMENT']),

    NOWPAYMENTS_API_KEY: optional('NOWPAYMENTS_API_KEY'),
    NOWPAYMENTS_IPN_SECRET: optional('NOWPAYMENTS_IPN_SECRET'),
    NOWPAYMENTS_ENVIRONMENT: (optional('NOWPAYMENTS_ENVIRONMENT', 'sandbox') as Config['NOWPAYMENTS_ENVIRONMENT']),

    IPAYMU_API_KEY: optional('IPAYMU_API_KEY'),
    IPAYMU_VA_KEY: optional('IPAYMU_VA_KEY'),
    IPAYMU_ENVIRONMENT: (optional('IPAYMU_ENVIRONMENT', 'sandbox') as Config['IPAYMU_ENVIRONMENT']),

    SCALEV_API_KEY: optional('SCALEV_API_KEY'),
    SCALEV_MERCHANT_ID: optional('SCALEV_MERCHANT_ID'),
    SCALEV_ENVIRONMENT: (optional('SCALEV_ENVIRONMENT', 'sandbox') as Config['SCALEV_ENVIRONMENT']),

    XENDIT_API_KEY: optional('XENDIT_API_KEY'),
    XENDIT_CALLBACK_TOKEN: optional('XENDIT_CALLBACK_TOKEN'),
    XENDIT_ENVIRONMENT: (optional('XENDIT_ENVIRONMENT', 'sandbox') as Config['XENDIT_ENVIRONMENT']),

    LOG_LEVEL: (optional('LOG_LEVEL', 'info') as Config['LOG_LEVEL']),
  };

  return cachedConfig;
}

export function getGatewayConfig(gateway: string) {
  const config = getConfig();
  switch (gateway) {
    case 'midtrans':
      return {
        apiKey: config.MIDTRANS_SERVER_KEY,
        environment: config.MIDTRANS_ENVIRONMENT,
      };
    case 'tripay':
      return {
        apiKey: config.TRIPAY_API_KEY,
        privateKey: config.TRIPAY_PRIVATE_KEY,
        merchantCode: config.TRIPAY_MERCHANT_CODE,
        environment: config.TRIPAY_ENVIRONMENT,
      };
    case 'duitku':
      return {
        apiKey: config.DUITKU_API_KEY,
        merchantCode: config.DUITKU_MERCHANT_CODE,
        environment: config.DUITKU_ENVIRONMENT,
      };
    case 'nowpayments':
      return {
        apiKey: config.NOWPAYMENTS_API_KEY,
        ipnSecret: config.NOWPAYMENTS_IPN_SECRET,
        environment: config.NOWPAYMENTS_ENVIRONMENT,
      };
    case 'ipaymu':
      return {
        apiKey: config.IPAYMU_API_KEY,
        vaKey: config.IPAYMU_VA_KEY,
        environment: config.IPAYMU_ENVIRONMENT,
      };
    case 'scalev':
      return {
        apiKey: config.SCALEV_API_KEY,
        merchantId: config.SCALEV_MERCHANT_ID,
        environment: config.SCALEV_ENVIRONMENT,
      };
    case 'xendit':
      return {
        apiKey: config.XENDIT_API_KEY,
        callbackToken: config.XENDIT_CALLBACK_TOKEN,
        environment: config.XENDIT_ENVIRONMENT,
      };
    default:
      throw new Error(`Unknown gateway: ${gateway}`);
  }
}