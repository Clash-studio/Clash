import { Buffer } from 'buffer';
import { Keypair, TransactionBuilder, hash } from '@stellar/stellar-sdk';
import { Client as PointsTrackerClient } from '@/contracts/points-tracker/src';
import { DEFAULT_METHOD_OPTIONS, NETWORK_PASSPHRASE, RPC_URL } from '@/utils/constants';

/** Prefer `VITE_DEV_POINTS_TRACKER_CONTRACT_ID` from `.env`; fallback for local dev. */
export function getPointsTrackerContractId(): string {
  const fromEnv = (import.meta.env.VITE_DEV_POINTS_TRACKER_CONTRACT_ID as string | undefined)?.trim();
  if (fromEnv) return fromEnv;
  return 'CBGYEIOWGSY6TGM6BFGPEUKM37TKPXAEETDRYACHJKVHOBZRNBIUMD6S';
}

const pointsRead = new PointsTrackerClient({
  contractId: getPointsTrackerContractId(),
  networkPassphrase: NETWORK_PASSPHRASE,
  rpcUrl: RPC_URL,
  allowHttp: RPC_URL.startsWith('http://'),
});

function getAdminKeypair(): Keypair | null {
  const secret = (import.meta.env.VITE_DEV_POINTS_TRACKER_ADMIN_SECRET as string | undefined)?.trim();
  if (!secret) return null;
  try {
    return Keypair.fromSecret(secret);
  } catch {
    return null;
  }
}

function createAdminWriteClient(): PointsTrackerClient | null {
  const kp = getAdminKeypair();
  if (!kp) return null;

  const publicKey = kp.publicKey();
  const expected = (import.meta.env.VITE_DEV_POINTS_TRACKER_ADMIN_ADDRESS as string | undefined)?.trim();
  if (expected && expected !== publicKey) {
    console.warn(
      '[PointsService] Secret does not match VITE_DEV_POINTS_TRACKER_ADMIN_ADDRESS; using key derived from secret.'
    );
  }

  return new PointsTrackerClient({
    contractId: getPointsTrackerContractId(),
    networkPassphrase: NETWORK_PASSPHRASE,
    rpcUrl: RPC_URL,
    allowHttp: RPC_URL.startsWith('http://'),
    publicKey,
    signTransaction: async (txXdr, opts) => {
      if (!opts?.networkPassphrase) throw new Error('Missing networkPassphrase');
      const tx = TransactionBuilder.fromXDR(txXdr, opts.networkPassphrase);
      tx.sign(kp);
      return { signedTxXdr: tx.toXDR(), signerAddress: publicKey };
    },
    signAuthEntry: async (preimageXdr) => {
      const preimageBytes = Buffer.from(preimageXdr, 'base64');
      const payload = hash(preimageBytes);
      const signatureBytes = kp.sign(payload);
      return {
        signedAuthEntry: Buffer.from(signatureBytes).toString('base64'),
        signerAddress: publicKey,
      };
    },
  });
}

/**
 * Outcome of the post-resolve leaderboard write:
 * - `recorded`: admin-signed `record_result` was submitted successfully.
 * - `skipped_no_admin`: no admin secret configured, so nothing was written (not an error).
 * - `failed`: admin was configured but the write threw.
 */
export type PointsRecordStatus = 'recorded' | 'skipped_no_admin' | 'failed';

/**
 * Map a leaderboard-write status to a user-facing notice, or `null` when there is
 * nothing to surface (`recorded`, a draw, or no write attempted). Kept next to the
 * status type so the wording stays in one place and can be reused across arenas.
 */
export function leaderboardNoticeForStatus(status: PointsRecordStatus | null): string | null {
  switch (status) {
    case 'skipped_no_admin':
      return 'Leaderboard not updated (admin not configured)';
    case 'failed':
      return 'Leaderboard not updated (record failed)';
    default:
      return null;
  }
}

/**
 * Admin-signed `record_result` (uses `VITE_DEV_POINTS_TRACKER_ADMIN_SECRET`).
 * Invoked from {@link ClashGameService.resolveBattleWithSmartAccount} after a successful resolve.
 * Returns a status so the UI can surface a non-blocking notice when the leaderboard
 * was not updated (e.g. admin secret missing) without affecting the resolve flow.
 */
export async function submitPointsRecordAfterResolve(
  winner: string,
  loser: string
): Promise<PointsRecordStatus> {
  const admin = createAdminWriteClient();
  if (!admin) {
    console.warn('[PointsService] record_result skipped: set VITE_DEV_POINTS_TRACKER_ADMIN_SECRET');
    return 'skipped_no_admin';
  }
  try {
    const tx = await admin.record_result({ winner, loser }, { ...DEFAULT_METHOD_OPTIONS, fee: 100 });
    await tx.signAndSend();
    return 'recorded';
  } catch (e) {
    console.error('[PointsService] record_result failed:', e);
    return 'failed';
  }
}

/**
 * Admin-only on-chain registration of both duelists (`register_players`).
 * Requires the deployed WASM to include `register_players` (redeploy after pulling latest contract).
 */
export async function registerDuelParticipants(playerA: string, playerB: string): Promise<void> {
  try {
    const admin = createAdminWriteClient();
    if (!admin) return;
    if (!playerA?.trim() || !playerB?.trim() || playerA === playerB) return;
    const tx = await admin.register_players(
      { player_a: playerA.trim(), player_b: playerB.trim() },
      { ...DEFAULT_METHOD_OPTIONS, fee: 100 }
    );
    await tx.signAndSend();
  } catch (e) {
    console.error('[PointsService] register_players failed:', e);
  }
}

export async function getPlayerPoints(player: string): Promise<number> {
  try {
    const tx = await pointsRead.get_points({ player });
    const sim = await tx.simulate();
    const v = sim.result;
    if (v === undefined || v === null) return 0;
    return typeof v === 'bigint' ? Number(v) : Number(v);
  } catch {
    return 0;
  }
}

function toPointsNum(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  return Number(v);
}

/** Soroban `Map<Address, u64>` may arrive as JS `Map`, plain object, or array of pairs after simulation. */
function parseLeaderboardMap(raw: unknown): Array<{ address: string; points: number }> {
  if (raw == null) return [];

  if (raw instanceof Map) {
    const out: Array<{ address: string; points: number }> = [];
    raw.forEach((pts, addr) => {
      out.push({ address: String(addr), points: toPointsNum(pts) });
    });
    return out;
  }

  if (Array.isArray(raw)) {
    const out: Array<{ address: string; points: number }> = [];
    for (const entry of raw) {
      if (Array.isArray(entry) && entry.length >= 2) {
        out.push({ address: String(entry[0]), points: toPointsNum(entry[1]) });
      }
    }
    return out;
  }

  if (typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>).map(([address, pts]) => ({
      address,
      points: toPointsNum(pts),
    }));
  }

  return [];
}

/** Safe read: returns [] on failure (e.g. rail widgets). */
export async function getLeaderboard(): Promise<Array<{ address: string; points: number }>> {
  try {
    return await fetchLeaderboardData();
  } catch (e) {
    console.warn('[PointsService] getLeaderboard failed:', e);
    return [];
  }
}

/** Leaderboard page: use this so RPC/simulation errors can surface in UI. */
export async function fetchLeaderboardData(): Promise<Array<{ address: string; points: number }>> {
  const tx = await pointsRead.get_leaderboard();
  await tx.simulate();
  const raw = tx.result as unknown;
  const out = parseLeaderboardMap(raw);
  return out.sort((a, b) => b.points - a.points);
}
