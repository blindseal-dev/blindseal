// The released proxy version, read from packages/proxy/package.json at BUILD time (inlined into the server
// bundle; the Docker build copies that manifest). Nothing on the site hard-codes a version number.
import proxyPkg from '../../../packages/proxy/package.json';
import { RELEASES } from './changelog/releases';

export const PROXY_VERSION: string = proxyPkg.version;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const rel = RELEASES.find((r) => r.v === PROXY_VERSION);
/** "Oct 27, 2026" for the changelog entry of PROXY_VERSION; null when the changelog has no entry for it yet */
export const PROXY_RELEASE_DATE: string | null = rel ? (([y, m, d]) => `${MON[m! - 1]} ${d}, ${y}`)(rel.date.split('-').map(Number)) : null;
