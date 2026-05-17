import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { fetchLeaderboardData } from '@/services/pointsService';
import { ClashGameService } from '@/games/clash/clashService';
import { getContractId } from '@/utils/constants';
import { PageLoading } from '@/components/PageLoading';
import '@/games/clash/styles.css';

function truncateAddr(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

type LoadStatus = 'loading' | 'ready' | 'error';

type Props = {
  userAddress: string | null;
  onBack: () => void;
};

export function Leaderboard({ userAddress, onBack }: Props) {
  const [rows, setRows] = useState<Array<{ address: string; points: number }>>([]);
  const [usernames, setUsernames] = useState<Record<string, string | null>>({});
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const clashServiceRef = useRef<ClashGameService | null>(null);
  if (!clashServiceRef.current) {
    clashServiceRef.current = new ClashGameService(getContractId('clash'));
  }

  const fetchLeaderboard = useCallback(async (options?: { background?: boolean }) => {
    const background = options?.background ?? false;
    const hasRows = rowsRef.current.length > 0;
    if (background || hasRows) {
      setRefreshing(true);
    } else {
      setStatus('loading');
    }
    try {
      const data = await fetchLeaderboardData();
      setRows(data);
      setLastFetch(Date.now());
      setStatus('ready');
    } catch {
      if (!hasRows && !background) {
        setRows([]);
      }
      setStatus('error');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void fetchLeaderboard();
  }, [fetchLeaderboard]);

  useEffect(() => {
    const id = window.setInterval(() => void fetchLeaderboard({ background: true }), 60_000);
    return () => window.clearInterval(id);
  }, [fetchLeaderboard]);

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!copiedAddress) return;
    const id = window.setTimeout(() => setCopiedAddress(null), 1500);
    return () => window.clearTimeout(id);
  }, [copiedAddress]);

  useEffect(() => {
    if (rows.length === 0) return;
    const unresolved = rows
      .map((r) => r.address)
      .filter((address) => usernames[address] === undefined);
    if (unresolved.length === 0) return;
    let cancelled = false;
    void (async () => {
      const results = await Promise.all(
        unresolved.map(async (address) => {
          try {
            const name = await clashServiceRef.current!.getUsername(address);
            return [address, name] as const;
          } catch {
            return [address, null] as const;
          }
        })
      );
      if (cancelled) return;
      setUsernames((prev) => ({ ...prev, ...Object.fromEntries(results) }));
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, usernames]);

  const updatedLabel = useMemo(() => {
    if (!lastFetch) return '—';
    const s = Math.max(0, Math.floor((Date.now() - lastFetch) / 1000));
    return `${s}s ago`;
  }, [lastFetch, tick]);

  const myRank = useMemo(() => {
    if (!userAddress) return null;
    const idx = rows.findIndex((r) => r.address.toLowerCase() === userAddress.toLowerCase());
    if (idx < 0) return null;
    return { rank: idx + 1, row: rows[idx]! };
  }, [rows, userAddress]);

  const copyAddr = async (addr: string) => {
    await navigator.clipboard.writeText(addr);
    setCopiedAddress(addr);
  };

  const loading = status === 'loading';
  const hasError = status === 'error';
  const showFullPageLoader = loading && rows.length === 0;

  if (showFullPageLoader) {
    return (
      <div className="leaderboard-page leaderboard-page--initial">
        <header className="leaderboard-header">
          <button type="button" className="leaderboard-back" onClick={onBack}>
            ← BACK TO ARENA
          </button>
          <h1 className="leaderboard-title">⚓ CLASH LEADERBOARD</h1>
        </header>
        <PageLoading variant="viewport" title="Loading leaderboard" subtitle="Fetching on-chain standings…" />
      </div>
    );
  }

  return (
    <div className={`leaderboard-page ${refreshing ? 'leaderboard-page--refreshing' : ''}`}>
      <header className="leaderboard-header">
        <button type="button" className="leaderboard-back" onClick={onBack}>
          ← BACK TO ARENA
        </button>
        <h1 className="leaderboard-title">⚓ CLASH LEADERBOARD</h1>
      </header>

      <p className="leaderboard-sub">
        Top pirates ranked by total points earned
        <span className="leaderboard-refresh-meta">
          {' '}
          Last updated {updatedLabel}
          {refreshing ? (
            <Loader2 className="leaderboard-refresh-spinner" size={14} aria-hidden />
          ) : (
            <>
              {' '}
              <button
                type="button"
                className="leaderboard-refresh-icon"
                onClick={() => void fetchLeaderboard({ background: rows.length > 0 })}
                aria-label="Refresh"
              >
                ↻
              </button>
            </>
          )}
        </span>
      </p>

      {userAddress && myRank && (
        <div className="leaderboard-you-banner">
          <div className="leaderboard-you-label">⚡ YOUR RANK</div>
          <div className="leaderboard-you-row">
            <span className="leaderboard-you-rank">#{myRank.rank}</span>
            <span className="leaderboard-you-addr mono">
              {usernames[myRank.row.address] ? `@${usernames[myRank.row.address]} · ` : ''}
              {truncateAddr(myRank.row.address)} (YOU)
            </span>
            <span className="leaderboard-you-pts">{myRank.row.points.toLocaleString()} pts</span>
          </div>
        </div>
      )}

      {hasError && !loading && (
        <div className="leaderboard-error">
          <span>⚠ Failed to load leaderboard</span>
          <button type="button" className="leaderboard-retry" onClick={() => void fetchLeaderboard()}>
            ↻ Try Again
          </button>
        </div>
      )}

      {!hasError && !loading && rows.length === 0 && (
        <div className="leaderboard-empty">
          <p>⚓ No duels recorded yet</p>
          <p className="leaderboard-empty-sub">Be the first captain to win a battle!</p>
        </div>
      )}

      <div className="leaderboard-table-wrap">
        <table className="leaderboard-table">
          <thead>
            <tr>
              <th>#</th>
              <th>CAPTAIN</th>
              <th>POINTS</th>
              <th>BADGE</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
                const rank = i + 1;
                const isYou = userAddress && r.address.toLowerCase() === userAddress.toLowerCase();
                const rankClass =
                  rank === 1 ? 'lb-rank-gold' : rank === 2 ? 'lb-rank-silver' : rank === 3 ? 'lb-rank-bronze' : 'lb-rank-rest';
                const rowClass = [
                  'leaderboard-row',
                  i % 2 === 0 ? 'leaderboard-row-even' : 'leaderboard-row-odd',
                  isYou ? 'leaderboard-row-you' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                const badge = rank === 1 ? '🏆' : rank === 2 ? '⚔' : rank === 3 ? '🛡' : '';
                const ptsClass = rank === 1 ? 'lb-pts-top' : '';
                const copied = copiedAddress === r.address;
                return (
                  <tr key={r.address} className={rowClass}>
                    <td className={`leaderboard-rank ${rankClass}`}>{rank}</td>
                    <td className="leaderboard-captain mono">
                      {usernames[r.address] && <div className="leaderboard-username">@{usernames[r.address]}</div>}
                      <button
                        type="button"
                        className={`leaderboard-addr-btn ${copied ? 'leaderboard-addr-btn--copied' : ''}`}
                        onClick={() => void copyAddr(r.address)}
                        title={copied ? 'Copied address' : 'Copy address'}
                        aria-label={copied ? 'Address copied' : 'Copy address'}
                      >
                        <span>
                          {truncateAddr(r.address)}
                          {isYou && <span className="leaderboard-you-tag"> (YOU)</span>}
                        </span>
                        <span className="leaderboard-copy-state" aria-live="polite">
                          {copied && (
                            <>
                              <Check size={12} aria-hidden />
                              Copied
                            </>
                          )}
                        </span>
                      </button>
                    </td>
                    <td className={`leaderboard-pts ${ptsClass}`}>{r.points.toLocaleString()}</td>
                    <td className="leaderboard-badge">{badge}</td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
