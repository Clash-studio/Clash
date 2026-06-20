/**
 * In-memory feed of recent on-chain txs (for the activity panel).
 * Subscribers get notified when entries are added or updated by the poller.
 */

import { NETWORK } from '@/utils/constants';

/**
 * stellar.expert path segment for the active network.
 * NETWORK is 'testnet' | 'mainnet' (derived from the RPC URL in constants.ts);
 * stellar.expert names mainnet 'public'.
 */
function explorerNetwork(): string {
  return NETWORK === 'mainnet' ? 'public' : 'testnet';
}

/** stellar.expert link for a transaction hash, on the active network. */
export function explorerTxUrl(hash: string): string {
  return `https://stellar.expert/explorer/${explorerNetwork()}/tx/${hash}`;
}

/** stellar.expert link for a contract id, on the active network. */
export function explorerContractUrl(contractId: string): string {
  return `https://stellar.expert/explorer/${explorerNetwork()}/contract/${contractId}`;
}

export type TxFeedStatus = 'submitting' | 'pending' | 'success' | 'failed' | 'not_found';

export type OnChainTxEntry = {
  id: string;
  /** Soroban tx hash; null when this row is a local/RPC-only action (e.g. player 2 loading a session). */
  hash: string | null;
  label: string;
  /** chain = submitted via smart account; local = no submission (e.g. getGame only). */
  source: 'chain' | 'local';
  /** Extra line for local rows (session id, hint). */
  detail?: string;
  status: TxFeedStatus;
  /** Max fee authorized by the tx envelope (stroops), when known */
  feeStroops: string | null;
  ledger: number | null;
  createdAt: number;
  updatedAt: number;
};

const MAX_ENTRIES = 25;
let entries: OnChainTxEntry[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

export function subscribeTxFeed(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getTxFeedSnapshot(): OnChainTxEntry[] {
  return [...entries];
}

export function recordOnChainTx(args: { hash: string; label: string }): void {
  const id = `${args.hash}-${Date.now()}`;
  const now = Date.now();
  entries = [
    {
      id,
      hash: args.hash,
      source: 'chain' as const,
      label: args.label,
      status: 'pending' as TxFeedStatus,
      feeStroops: null,
      ledger: null,
      createdAt: now,
      updatedAt: now,
    },
    ...entries.filter((e) => e.hash !== args.hash),
  ].slice(0, MAX_ENTRIES);
  notify();
}

/**
 * Player 2 "join" is implemented as `getGame` + UI state only — there is no second `start_game` tx.
 * Record that sync so the activity panel matches player 1’s start_game row.
 */
export function recordSessionLoadActivity(args: { sessionId: number }): void {
  const now = Date.now();
  const id = `load-session-${args.sessionId}-${now}`;
  entries = [
    {
      id,
      hash: null,
      source: 'local' as const,
      label: 'load_session',
      detail: `Session #${args.sessionId} (RPC sync — no chain tx)`,
      status: 'success' as TxFeedStatus,
      feeStroops: null,
      ledger: null,
      createdAt: now,
      updatedAt: now,
    },
    ...entries,
  ].slice(0, MAX_ENTRIES);
  notify();
}

export function updateTxFeedEntry(
  hash: string,
  patch: Partial<Pick<OnChainTxEntry, 'status' | 'feeStroops' | 'ledger'>>,
): void {
  const i = entries.findIndex((e) => e.source === 'chain' && e.hash === hash);
  if (i < 0) return;
  entries[i] = {
    ...entries[i],
    ...patch,
    updatedAt: Date.now(),
  };
  notify();
}
