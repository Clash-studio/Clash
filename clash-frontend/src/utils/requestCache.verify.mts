// Temporary empirical verification for issue #19 dedupe behaviour.
// Imports the REAL requestCache.ts source (no external deps) and exercises the
// exact semantics getUsername/getAddressByUsername now rely on.
import { requestCache, createCacheKey } from './requestCache.ts';

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Mirror the key shape clashService builds.
const CONTRACT = 'CCLASHCONTRACTIDXXX';
const usernameKey = (addr: string) => createCacheKey(CONTRACT, 'get_username', addr);
const addrKey = (name: string) => createCacheKey(CONTRACT, 'get_address_by_username', name);

async function main() {
  // 1. Concurrent dedupe: N concurrent lookups of the same key => fetcher runs once.
  let calls = 0;
  const fetcher = async () => { calls++; await sleep(20); return 'alice'; };
  const key = usernameKey('GADDR1');
  const results = await Promise.all(
    Array.from({ length: 8 }, () => requestCache.dedupe(key, fetcher, 5000)),
  );
  check('8 concurrent same-key lookups => fetcher invoked once', calls === 1);
  check('all concurrent callers get the same value', results.every((r) => r === 'alice'));

  // 2. Cached within TTL: a follow-up call inside the window does NOT refetch.
  await requestCache.dedupe(key, fetcher, 5000);
  check('lookup within TTL served from cache (no refetch)', calls === 1);

  // 3. Freshness after TTL: with a short TTL, the value is refetched once expired.
  let ttlCalls = 0;
  const ttlFetcher = async () => { ttlCalls++; return `v${ttlCalls}`; };
  const ttlKey = usernameKey('GADDR_TTL');
  const first = await requestCache.dedupe(ttlKey, ttlFetcher, 50);
  await sleep(70); // let the 50ms TTL lapse
  const second = await requestCache.dedupe(ttlKey, ttlFetcher, 50);
  check('value refetched after TTL expiry', ttlCalls === 2);
  check('data still fresh after TTL (new value returned)', first === 'v1' && second === 'v2');

  // 4. Distinct addresses are NOT deduped together (no over-coalescing / N+1 still per-address).
  let aCalls = 0, bCalls = 0;
  await Promise.all([
    requestCache.dedupe(usernameKey('GA'), async () => { aCalls++; return 'a'; }, 5000),
    requestCache.dedupe(usernameKey('GB'), async () => { bCalls++; return 'b'; }, 5000),
  ]);
  check('different addresses each fetch independently', aCalls === 1 && bCalls === 1);

  // 5. getUsername vs getAddressByUsername keys can never collide.
  check('username/address keys are distinct', usernameKey('X') !== addrKey('X'));

  // 6. Invalidation (set_username path) forces a fresh read.
  let invCalls = 0;
  const invFetcher = async () => { invCalls++; return `n${invCalls}`; };
  const invKey = usernameKey('GINV');
  await requestCache.dedupe(invKey, invFetcher, 5000);
  requestCache.invalidate(invKey);
  await requestCache.dedupe(invKey, invFetcher, 5000);
  check('invalidate() drops cache so next read refetches', invCalls === 2);

  // 7. Errors are not cached as pending (failed lookup can be retried).
  let errCalls = 0;
  const errKey = usernameKey('GERR');
  try {
    await requestCache.dedupe(errKey, async () => { errCalls++; throw new Error('rpc down'); }, 5000);
  } catch { /* expected */ }
  const recovered = await requestCache.dedupe(errKey, async () => { errCalls++; return 'ok'; }, 5000);
  check('failed lookup is retryable (not stuck pending)', errCalls === 2 && recovered === 'ok');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
