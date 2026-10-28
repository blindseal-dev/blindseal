/// Blindseal audit: hash-chained local log + encrypted content store + signed selective
/// disclosure. Entries are content-free; content is encrypted at rest.
export { AuditChain } from './chain.js';
export type { AuditEntry, AuditHead, AppendInput, VerifyResult } from './chain.js';
export { ContentStore } from './content.js';
export {
  discloseBundle,
  verifyDisclosure,
  isCleanWindow,
  loadIdentity,
  type Disclosure,
  type DisclosureVerdict,
} from './disclosure.js';
export { canonicalJson, hashEntry, genesisPrevHash } from './hash.js';
export {
  CLEAN_VERDICT,
  FLAG_VERDICT,
  BLOCK_VERDICT,
  ERROR_VERDICT,
  CHAIN_VERDICTS,
  toChainVerdict,
  type ChainVerdict,
} from './verdict.js';

import path from 'node:path';
import os from 'node:os';
import { AuditChain } from './chain.js';
import { ContentStore } from './content.js';
import { loadIdentity, discloseBundle, type Disclosure } from './disclosure.js';

/// Convenience bundle wiring the chain, content store, and identity under a base dir
/// (default ~/.blindseal). `disclose(from,to)` returns a signed disclosure over the window.
export function openAudit(baseDir: string = path.join(os.homedir(), '.blindseal')) {
  const identity = loadIdentity(path.join(baseDir, 'identity.key'));
  const chain = new AuditChain(path.join(baseDir, 'audit.log'), identity.pubkeyHex);
  const content = new ContentStore(path.join(baseDir, 'content.json'), path.join(baseDir, 'content.key'));
  return {
    chain,
    content,
    identity,
    disclose(from: number, to: number): Disclosure {
      const head = chain.head();
      if (!head) throw new Error('empty audit chain');
      return discloseBundle({
        from,
        to,
        head,
        entries: chain.slice(from, to),
        privateKey: identity.privateKey,
        pubkeyHex: identity.pubkeyHex,
      });
    },
  };
}
