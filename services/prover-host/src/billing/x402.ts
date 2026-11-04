/// Per-proof billing over x402 (HTTP 402 Payment Required) in USDC on Solana.
///
/// SDK: `@x402/core` (the x402 v2 reference resource server) with `@payai/facilitator` (PayAI's
/// facilitator config; its public endpoint verifies and settles Solana `exact` payments). The scheme
/// object below is the server half of `exact` on Solana: price → USDC atomic units and the facilitator's
/// fee payer copied into `extra`. The reference package for that (`@x402/svm`) would pull in `@solana/kit`
/// and friends for those two lines, so they live here instead. See the README for the choice.
///
/// Order: verify, then settle — in the same POST, before the job is queued. A Solana `exact` payment is
/// a partially signed transaction whose blockhash expires in about a minute, so settlement cannot wait
/// for a proof that takes minutes (GPU) or hours (CPU). A proof that fails after settlement is reported as
/// payment.status = 'charged-failed' with the payer recorded; the refund is the operator's, by hand.
import type { IncomingMessage } from 'node:http';
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from '@x402/core/server';
import type { HTTPAdapter, HTTPResponseInstructions } from '@x402/core/server';
import type { AssetAmount, Network, PaymentRequirements, Price, SchemeNetworkServer, SupportedKind } from '@x402/core/types';
import { createFacilitatorConfig } from '@payai/facilitator';
import type { HostConfig, PaymentNetwork } from '../config.js';
import type { JobPayment } from '../jobs/store.js';

export const SOLANA_NETWORKS: Record<PaymentNetwork, { caip2: Network; usdc: string }> = {
  solana: { caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  'solana-devnet': { caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', usdc: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' },
};
export const USDC_DECIMALS = 6;
/// How long the client's signed transaction may take to reach the facilitator.
const MAX_TIMEOUT_SECONDS = 60;

/// '0.5' → '500000'. Throws on more than six decimals.
export function usdcAtomic(price: string | number): string {
  const s = String(price).trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new Error(`not a USDC amount: ${s}`);
  return (BigInt(m[1]!) * 10n ** BigInt(USDC_DECIMALS) + BigInt((m[2] ?? '').padEnd(USDC_DECIMALS, '0'))).toString();
}

function usdcMintFor(network: Network): string {
  const hit = Object.values(SOLANA_NETWORKS).find((n) => n.caip2 === network);
  if (!hit) throw new Error(`no USDC mint known for ${network}`);
  return hit.usdc;
}

/// The server side of `exact` on Solana, USDC only.
export class ExactUsdcScheme implements SchemeNetworkServer {
  readonly scheme = 'exact';
  readonly defaultAssetTransferMethod = 'default';
  readonly paymentFlows = { default: { supported: ['authorization'] as const, default: 'authorization' as const } };

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === 'object') return price;
    return { amount: usdcAtomic(price), asset: usdcMintFor(network) };
  }

  getAssetDecimals(): number { return USDC_DECIMALS; }

  async enhancePaymentRequirements(req: PaymentRequirements, kind: SupportedKind): Promise<PaymentRequirements> {
    const feePayer = kind.extra?.feePayer;
    return { ...req, extra: { ...req.extra, ...(typeof feePayer === 'string' ? { feePayer } : {}) } };
  }
}

/// node:http request → the adapter @x402/core reads headers and the URL through.
export function nodeAdapter(req: IncomingMessage, publicUrl: string, body: unknown): HTTPAdapter {
  const header = (name: string): string | undefined => {
    const v = req.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const url = new URL(req.url ?? '/', publicUrl);
  return {
    getHeader: header,
    getMethod: () => req.method ?? 'GET',
    getPath: () => url.pathname,
    getUrl: () => url.toString(),
    getAcceptHeader: () => header('accept') ?? '',
    getUserAgent: () => header('user-agent') ?? '',
    getBody: () => body,
  };
}

export type ChargeOutcome =
  | { kind: 'paid'; payment: JobPayment; headers: Record<string, string> }
  | { kind: 'rejected'; response: HTTPResponseInstructions };

export interface Billing {
  readonly network: Network;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  /// The 402 requirements as the next client will see them (for /healthz and the README examples).
  requirements(): Promise<PaymentRequirements[]>;
  /// Verify and settle the payment on `req`, or say what the client gets instead (a 402).
  charge(req: IncomingMessage, body: unknown): Promise<ChargeOutcome>;
}

export interface BillingOptions {
  publicUrl: string;
  log?: (line: string) => void;
  /// Resource description in the 402.
  description?: string;
}

/// undefined when the price is 0 (billing off). Talks to the facilitator once at startup (/supported).
export async function createBilling(config: HostConfig, opts: BillingOptions): Promise<Billing | undefined> {
  if (/^0*(\.0*)?$/.test(config.priceUsdc)) return undefined;
  if (!config.payTo) throw new Error('payTo is required when priceUsdc is not 0');
  const net = SOLANA_NETWORKS[config.paymentNetwork];
  // PayAI's config carries the JWT auth from PAYAI_API_KEY_ID/_SECRET when set; the URL is ours so a
  // test (or another facilitator) can stand in.
  const facilitator = new HTTPFacilitatorClient({ ...createFacilitatorConfig(), url: config.facilitatorUrl });
  const server = new x402ResourceServer(facilitator).register(net.caip2, new ExactUsdcScheme());
  const resource = `${opts.publicUrl.replace(/\/$/, '')}/jobs`;
  const resourceConfig = {
    scheme: 'exact', network: net.caip2, payTo: config.payTo, price: config.priceUsdc, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  };
  const http = new x402HTTPResourceServer(server, {
    'POST /jobs': {
      accepts: resourceConfig,
      resource,
      description: opts.description ?? 'One Blindseal proof: an SP1 → Groth16 attestation of a screened tool call',
      mimeType: 'application/json',
      // The requirements travel in the PAYMENT-REQUIRED header; repeat them in the body for people.
      unpaidResponseBody: async () => ({
        contentType: 'application/json',
        body: { error: 'payment required', x402Version: 2, accepts: await server.buildPaymentRequirements(resourceConfig), hint: 'retry with a PAYMENT-SIGNATURE header (x402 v2)' },
      }),
    },
  });
  await http.initialize();
  const amount = usdcAtomic(config.priceUsdc);
  opts.log?.(`billing: ${config.priceUsdc} USDC per proof on ${config.paymentNetwork} to ${config.payTo} via ${config.facilitatorUrl}`);

  return {
    network: net.caip2, asset: net.usdc, amount, payTo: config.payTo,
    requirements: () => server.buildPaymentRequirements(resourceConfig),
    async charge(req, body) {
      const adapter = nodeAdapter(req, opts.publicUrl, body);
      const result = await http.processHTTPRequest({ adapter, path: adapter.getPath(), method: adapter.getMethod() });
      if (result.type === 'no-payment-required') throw new Error('billing route did not match POST /jobs');
      if (result.type === 'payment-error') return { kind: 'rejected', response: result.response };
      // Verified. Settle now (see the header comment for why not after the proof).
      const settled = await http.processSettlement(result.paymentPayload, result.paymentRequirements, result.declaredExtensions, { request: { adapter, path: adapter.getPath(), method: adapter.getMethod() } });
      if (!settled.success) return { kind: 'rejected', response: settled.response };
      return {
        kind: 'paid',
        headers: settled.headers,
        payment: {
          status: 'settled', network: settled.network, asset: result.paymentRequirements.asset,
          amount: settled.amount ?? result.paymentRequirements.amount, payer: settled.payer, transaction: settled.transaction,
        },
      };
    },
  };
}
