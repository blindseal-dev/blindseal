/// The settlement receipt an x402 server returns with the paid response: PAYMENT-RESPONSE (v2) or
/// X-PAYMENT-RESPONSE (v1), base64 JSON ({ success, transaction, network, payer }). Returned as parsed
/// data when present and well-formed, else the raw header string, else undefined.
export function decodeReceiptHeader(headers: Headers): unknown {
  const raw = headers.get('payment-response') ?? headers.get('x-payment-response');
  if (!raw) return undefined;
  try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { return { raw }; }
}
