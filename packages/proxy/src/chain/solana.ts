/// Solana chain adapter ("action = parseAction(payload)"). Recognizes a
/// tool call as an on-chain Solana action and extracts the fields the attestation binds via
/// actionHash (see /docs/hashing): target program, instruction, recipient, mint, amount, source authority.
/// Returns null when the call is not a recognizable on-chain action. Key-based extraction,
/// like the trade-guard, so it works across MCP servers with different arg names.
export type SolanaChain = 'mainnet';

/// chainId 1 = Solana mainnet, the only deploy target. 2 is reserved (never devnet).
export const CHAIN_ID_SOLANA_MAINNET = 1;

export interface SolanaAction {
  chain: 'solana';
  chainId: number; // 1 = mainnet (2 reserved)
  targetProgram: string; // base58 program id
  instruction: string; // name or discriminator
  recipient: string; // base58, '' if n/a
  mint: string; // base58, '' for native SOL
  amount: string; // base units (lamports / token amount), decimal string, '' if n/a
  sourceAuthority: string; // base58 signer the action debits, '' if n/a
}

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export const RECIPIENT_KEYS = ['recipient', 'to', 'destination', 'dest', 'receiver', 'toPubkey', 'toAddress'];
export const AMOUNT_KEYS = ['amount', 'lamports', 'value', 'tokenAmount', 'quantity'];
export const MINT_KEYS = ['mint', 'token', 'tokenMint', 'mintAddress'];
export const AUTHORITY_KEYS = ['authority', 'owner', 'from', 'source', 'payer', 'fromPubkey', 'signer'];
export const PROGRAM_KEYS = ['program', 'programId', 'programAddress'];

export const TRANSFER_TOOL = /(?:^|_|\b)(?:transfer|send|pay|spl[_-]?transfer|transfer[_-]?checked)(?:_|\b|$)/i;

export function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'bigint') return v.toString();
  }
  return undefined;
}

export interface ParseOpts {
  chain?: SolanaChain; // default mainnet
}

/// Parse a tool call into a Solana action, or null if it is not an on-chain action.
export function parseSolanaAction(
  toolName: string,
  args: unknown,
  opts: ParseOpts = {},
): SolanaAction | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;

  const amount = firstString(a, AMOUNT_KEYS);
  const recipient = firstString(a, RECIPIENT_KEYS);
  // An on-chain transfer needs at least a recipient or an amount, and a transfer-shaped tool
  // name OR an explicit program id.
  const explicitProgram = firstString(a, PROGRAM_KEYS);
  const looksLikeTransfer = TRANSFER_TOOL.test(toolName);
  if (!looksLikeTransfer && !explicitProgram) return null;
  if (recipient === undefined && amount === undefined && explicitProgram === undefined) return null;

  const mint = firstString(a, MINT_KEYS);
  const sourceAuthority = firstString(a, AUTHORITY_KEYS);
  void opts; // mainnet is the only chain; the option stays for a future EVM adapter (chainId 3+)
  const chainId = CHAIN_ID_SOLANA_MAINNET;
  const targetProgram = explicitProgram ?? (mint ? TOKEN_PROGRAM : SYSTEM_PROGRAM);
  const instruction =
    (typeof a.instruction === 'string' && a.instruction) ||
    (typeof a.method === 'string' && a.method) ||
    (mint ? 'transferChecked' : 'transfer');

  return {
    chain: 'solana',
    chainId,
    targetProgram,
    instruction,
    recipient: recipient ?? '',
    mint: mint ?? '',
    amount: amount ?? '',
    sourceAuthority: sourceAuthority ?? '',
  };
}
