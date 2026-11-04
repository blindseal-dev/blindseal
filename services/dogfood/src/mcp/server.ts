/// The dogfood MCP server (stdio). It runs BEHIND the Blindseal proxy, so every call it receives has had
/// its arguments screened and every reply it sends is screened before the agent sees it. Two tools:
///
///   buy_resource { url }   — pay for the one configured x402 resource (Solana USDC, "exact" scheme) with the
///                            x402-solana client and return the receipt plus the resource body. The body is
///                            returned on purpose: it is untrusted content, and the proxy screens it.
///   transfer_sol { to, lamports, from, memo? }
///                          — does NOT move funds. It validates the request and hands back the canonical tool
///                            call; the transfer is executed by transfer-gate once `blindseal attest` has
///                            proved the screened call and `blindseal submit` has sent it.
///
/// Configuration is by environment (set by the agent on the proxy, inherited here):
///   DOGFOOD_RESOURCE_URL        the only URL buy_resource will pay for
///   DOGFOOD_X402_NETWORK        solana | solana-devnet (default solana)
///   DOGFOOD_X402_RPC_URL        RPC for the payment transaction (mint, blockhash); dry run: the mock
///   DOGFOOD_MAX_PRICE_ATOMIC    refuse a 402 asking for more than this (USDC atomic units)
///   DOGFOOD_PAYTO_ALLOWLIST     comma-separated payTo addresses (empty = any)
///   DOGFOOD_WALLET_PATH         keypair file that signs the payment, or
///   DOGFOOD_WALLET_EPHEMERAL=1  a fresh in-memory keypair (dry run: never written anywhere)
/// The secret key never leaves this process and is never printed.
import { createInterface } from 'node:readline';
import { Keypair, PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { createX402Client } from 'x402-solana/client';
import { keypairFromFile } from '../wallet.js';
import { decodeReceiptHeader } from '../x402-receipt.js';

interface Rpc { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }

const env = process.env;
const RESOURCE_URL = env.DOGFOOD_RESOURCE_URL ?? '';
const NETWORK: 'solana' | 'solana-devnet' = env.DOGFOOD_X402_NETWORK === 'solana-devnet' ? 'solana-devnet' : 'solana';
const RPC_URL = env.DOGFOOD_X402_RPC_URL || env.BLINDSEAL_RPC_URL || undefined;
const MAX_PRICE = /^\d+$/.test(env.DOGFOOD_MAX_PRICE_ATOMIC ?? '') ? BigInt(env.DOGFOOD_MAX_PRICE_ATOMIC!) : 0n;
const PAYTO_ALLOW = new Set((env.DOGFOOD_PAYTO_ALLOWLIST ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const MAX_BODY_CHARS = 4000;

let wallet: Keypair | undefined;
function getWallet(): Keypair {
  if (wallet) return wallet;
  if (env.DOGFOOD_WALLET_EPHEMERAL === '1') wallet = Keypair.generate();
  else if (env.DOGFOOD_WALLET_PATH) wallet = keypairFromFile(env.DOGFOOD_WALLET_PATH);
  else throw new Error('no wallet: set DOGFOOD_WALLET_PATH or DOGFOOD_WALLET_EPHEMERAL=1');
  return wallet;
}

const TOOLS = [
  {
    name: 'buy_resource',
    description: 'Buy the configured x402 resource (HTTP 402, Solana USDC) and return the receipt and the resource body.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  {
    name: 'transfer_sol',
    description: 'Request a SOL transfer from the dogfood wallet. Execution is gated: the screened call is proved and sent through transfer-gate.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, lamports: { type: 'integer' }, from: { type: 'string' }, memo: { type: 'string' } },
      required: ['to', 'lamports', 'from'],
    },
  },
];

const text = (o: unknown, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(o) }], isError });

async function buyResource(args: Record<string, unknown>): Promise<unknown> {
  const url = typeof args.url === 'string' ? args.url : '';
  if (!RESOURCE_URL) return text({ error: 'DOGFOOD_RESOURCE_URL is not set' }, true);
  if (url !== RESOURCE_URL) return text({ error: 'not the configured resource; this tool buys exactly one URL', configured: RESOURCE_URL }, true);
  const kp = getWallet();
  let accepted: { amount: string; payTo?: string; asset?: string; network?: string } | undefined;
  const client = createX402Client({
    wallet: { address: kp.publicKey.toBase58(), signTransaction: async (tx: VersionedTransaction) => { tx.sign([kp]); return tx; } },
    network: NETWORK,
    ...(RPC_URL ? { rpcUrl: RPC_URL } : {}),
    amount: MAX_PRICE,
    beforePayment: (req) => {
      if (PAYTO_ALLOW.size > 0 && !PAYTO_ALLOW.has(req.payTo)) return { abort: true, reason: `payTo ${req.payTo} is not allowlisted` };
      accepted = { amount: req.amount, payTo: req.payTo, asset: req.asset, network: req.network };
      return undefined;
    },
  });
  let res: Response;
  try {
    res = await client.fetch(url, { method: 'GET', signal: AbortSignal.timeout(45_000) });
  } catch (e) {
    return text({ error: `x402 purchase failed: ${(e as Error).message}` }, true);
  }
  const body = (await res.text()).slice(0, MAX_BODY_CHARS);
  if (res.status === 402) return text({ error: 'resource still requires payment after paying', status: 402 }, true);
  if (!res.ok) return text({ error: `resource answered HTTP ${res.status}`, body }, true);
  const receipt = decodeReceiptHeader(res.headers);
  return text({
    status: accepted ? 'paid' : 'free',
    url,
    priceAtomic: accepted?.amount ?? '0',
    asset: accepted?.asset,
    payTo: accepted?.payTo,
    network: accepted?.network,
    payer: kp.publicKey.toBase58(),
    receipt,
    body,
  });
}

function transferSol(args: Record<string, unknown>): unknown {
  const to = args.to;
  const from = args.from;
  const lamports = args.lamports;
  const problems: string[] = [];
  if (typeof to !== 'string' || !isPubkey(to)) problems.push('to must be a base58 public key');
  if (typeof from !== 'string' || !isPubkey(from)) problems.push('from must be a base58 public key');
  if (typeof lamports !== 'number' || !Number.isSafeInteger(lamports) || lamports <= 0) problems.push('lamports must be a positive integer');
  if (problems.length) return text({ error: problems.join('; ') }, true);
  // Live: `from` must be the wallet that will sign the gated transfer. Dry run signs the x402 payment with
  // an ephemeral key and attests the fixture, so there is no wallet for `from` to match.
  if (env.DOGFOOD_WALLET_EPHEMERAL !== '1') {
    let walletPk: string | undefined;
    try { walletPk = getWallet().publicKey.toBase58(); } catch { walletPk = undefined; }
    if (walletPk && from !== walletPk) return text({ error: 'from is not the dogfood wallet' }, true);
  }
  return text({
    status: 'gated',
    note: 'nothing was sent: the transfer executes through transfer-gate after blindseal attest + submit of this exact call',
    toolName: 'transfer_sol',
    args: { to, lamports, from, ...(typeof args.memo === 'string' ? { memo: args.memo } : {}) },
  });
}

function isPubkey(s: string): boolean { try { return new PublicKey(s).toBase58() === s; } catch { return false; } }

const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

const rl = createInterface({ input: process.stdin });
let chain: Promise<void> = Promise.resolve();
rl.on('line', (line) => { chain = chain.then(() => handle(line)).catch(() => undefined); });
rl.on('close', () => { void chain.then(() => process.exit(0)); });

async function handle(line: string): Promise<void> {
  let msg: Rpc;
  try { msg = JSON.parse(line) as Rpc; } catch { return; }
  if (msg.id === undefined) return; // notification
  switch (msg.method) {
    case 'initialize':
      out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'blindseal-dogfood', version: '0.0.1' } } });
      return;
    case 'ping':
      out({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    case 'tools/list':
      out({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
      return;
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      let result: unknown;
      try {
        if (name === 'buy_resource') result = await buyResource(args);
        else if (name === 'transfer_sol') result = transferSol(args);
        else result = text({ error: `unknown tool ${String(name)}` }, true);
      } catch (e) {
        result = text({ error: (e as Error).message }, true);
      }
      out({ jsonrpc: '2.0', id: msg.id, result });
      return;
    }
    default:
      out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}
