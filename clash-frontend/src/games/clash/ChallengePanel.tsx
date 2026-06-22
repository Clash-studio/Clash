import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { Challenge } from './bindings';
import type { ClashGameService } from './clashService';
import type { SmartAccountService } from './smartAccountService';

interface ChallengePanelProps {
  userAddress: string;
  clashService: ClashGameService;
  smartAccountService: SmartAccountService;
  busy: boolean;
  setBusy: (v: boolean) => void;
  setError: (v: string | null) => void;
  setSuccess: (v: string | null) => void;
  setCriticalError: (v: string | null) => void;
  onAcceptChallenge: (challengeId: number) => Promise<void>;
  onEnterSession: (sid: number) => void;
}

const POINTS_DECIMALS = 7;
const DEFAULT_POINTS = '0.1';

function parsePoints(value: string): bigint | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('.');
  if (parts.length > 2) return null;
  let intPart = parts[0];
  let decPart = parts[1] ?? '';
  if (decPart.length > POINTS_DECIMALS) decPart = decPart.slice(0, POINTS_DECIMALS);
  decPart = decPart.padEnd(POINTS_DECIMALS, '0');
  const combined = intPart + decPart;
  try {
    return BigInt(combined);
  } catch {
    return null;
  }
}

function truncateAddr(a: string) {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function ChallengePanel({
  userAddress,
  clashService,
  smartAccountService,
  busy,
  setBusy,
  setError,
  setSuccess,
  setCriticalError,
  onAcceptChallenge,
  onEnterSession,
}: ChallengePanelProps) {
  const [opponentUsername, setOpponentUsername] = useState('');
  const [pointsStr, setPointsStr] = useState(DEFAULT_POINTS);
  const [startingDuel, setStartingDuel] = useState(false);
  const [allChallenges, setAllChallenges] = useState<{
    active: Challenge[];
    completed: Challenge[];
    expired: Challenge[];
  }>({ active: [], completed: [], expired: [] });
  const [challengeUsernames, setChallengeUsernames] = useState<Record<string, string | null>>({});
  const [challengeOutcomes, setChallengeOutcomes] = useState<Record<number, 'win' | 'loss' | 'draw' | 'unknown'>>({});
  const [challengesLoading, setChallengesLoading] = useState(false);

  const handleStartGame = async () => {
    setError(null);
    setSuccess(null);
    const pts = parsePoints(pointsStr);
    if (!pts || pts <= 0n) {
      setError('Enter a valid points amount');
      return;
    }
    if (!opponentUsername.trim()) {
      setError('Enter opponent username');
      return;
    }
    setBusy(true);
    setStartingDuel(true);
    try {
      const targetAddress = await clashService.getAddressByUsername(opponentUsername.trim().toLowerCase());
      if (!targetAddress) {
        setError('Username not found');
        return;
      }
      if (targetAddress === userAddress) {
        setError('Cannot challenge yourself');
        return;
      }
      await clashService.sendChallengeWithSmartAccount(
        userAddress,
        targetAddress,
        pts,
        smartAccountService
      );
      setSuccess(`Challenge sent to @${opponentUsername.trim().toLowerCase()}`);
    } catch (e) {
      setCriticalError(e instanceof Error ? e.message : 'Failed to start game');
    } finally {
      setBusy(false);
      setStartingDuel(false);
    }
  };

  const loadChallenges = useCallback(async () => {
    setChallengesLoading(true);
    try {
      const res = await clashService.getPlayerChallenges(userAddress);
      setAllChallenges({
        active: res.active,
        completed: res.completed,
        expired: res.expired,
      });
      const challengeAddresses = new Set<string>();
      for (const challenge of [...res.active, ...res.completed, ...res.expired]) {
        if (challenge.challenger) challengeAddresses.add(challenge.challenger);
        if (challenge.challenged) challengeAddresses.add(challenge.challenged);
      }
      if (challengeAddresses.size > 0) {
        const usernames = await Promise.all(
          Array.from(challengeAddresses).map(async (address) => {
            try {
              const name = await clashService.getUsername(address);
              return [address, name] as const;
            } catch {
              return [address, null] as const;
            }
          })
        );
        setChallengeUsernames((prev) => ({ ...prev, ...Object.fromEntries(usernames) }));
      }
      const completedSessionIds = Array.from(
        new Set(
          res.completed
            .map((challenge) => (challenge.session_id == null ? null : Number(challenge.session_id)))
            .filter((sid): sid is number => sid !== null && sid > 0)
        )
      );
      const missingOutcomes = completedSessionIds.filter((sid) => challengeOutcomes[sid] === undefined);
      if (missingOutcomes.length > 0) {
        const outcomes = await Promise.all(
          missingOutcomes.map(async (sid) => {
            try {
              const playback = await clashService.getGamePlayback(sid);
              if (!playback) return [sid, 'unknown'] as const;
              if (playback.is_draw) return [sid, 'draw'] as const;
              const winner = playback.winner?.toString?.() ?? '';
              if (!winner) return [sid, 'unknown'] as const;
              return [sid, winner === userAddress ? 'win' : 'loss'] as const;
            } catch {
              return [sid, 'unknown'] as const;
            }
          })
        );
        setChallengeOutcomes((prev) => ({ ...prev, ...Object.fromEntries(outcomes) }));
      }
    } finally {
      setChallengesLoading(false);
    }
  }, [challengeOutcomes, clashService, userAddress]);

  useEffect(() => {
    void loadChallenges();
    const id = window.setInterval(() => void loadChallenges(), 8000);
    return () => clearInterval(id);
  }, [loadChallenges]);

  const [challengeTab, setChallengeTab] = useState<'pending' | 'active' | 'history'>('pending');

  // Pending: not yet accepted (both incoming and outgoing)
  const pendingChallenges = useMemo(
    () => allChallenges.active
      .filter((c) => !c.is_accepted)
      .sort((a, b) => Number(b.created_at) - Number(a.created_at)),
    [allChallenges.active]
  );

  // Active: accepted but not completed — sessions you can enter
  const activeChallenges = useMemo(
    () => allChallenges.active
      .filter((c) => c.is_accepted && !c.is_completed)
      .sort((a, b) => Number(b.created_at) - Number(a.created_at)),
    [allChallenges.active]
  );

  // History: completed + expired
  const historyChallenges = useMemo(
    () => [...allChallenges.completed, ...allChallenges.expired]
      .sort((a, b) => Number(b.created_at) - Number(a.created_at)),
    [allChallenges.completed, allChallenges.expired]
  );

  return (
    <>
      <section className="arena-card">
        <h3>Challenge by Username</h3>
        <label>Stake / Points</label>
        <div className="field-with-unit">
          <input value={pointsStr} onChange={(e) => setPointsStr(e.target.value)} placeholder="0.1" />
          <span>XLM</span>
          <div className="chip-row">
            <button type="button" className="chip-btn" onClick={() => setPointsStr("0.1")}>0.1</button>
            <button type="button" className="chip-btn" onClick={() => setPointsStr("0.5")}>0.5</button>
            <button type="button" className="chip-btn" onClick={() => setPointsStr("1")}>1</button>
          </div>
        </div>
        <label>Opponent Username</label>
        <input value={opponentUsername} onChange={(e) => setOpponentUsername(e.target.value)} placeholder="captain_name" />
        <button
          type="button"
          className={`btn-arena-primary ${startingDuel ? 'btn-arena-primary--loading' : ''}`}
          disabled={busy}
          onClick={() => void handleStartGame()}
          aria-busy={startingDuel}
          aria-label={startingDuel ? 'Starting duel' : 'Start duel'}
        >
          {startingDuel ? (
            <Loader2 className="start-duel-btn-spinner" size={22} aria-hidden />
          ) : (
            '⚔ SEND CHALLENGE'
          )}
        </button>
        <div className="mono dim" style={{ marginTop: 10 }}>
          Game starts only when opponent accepts.
        </div>
      </section>

      <section className="arena-card">
        <h3>Challenges</h3>

        {/* Tab bar */}
        <div className="challenge-tabs" role="tablist" aria-label="Challenge list tabs">
          {(
            [
              { key: 'pending', label: 'Pending', count: pendingChallenges.length },
              { key: 'active',  label: 'Active',  count: activeChallenges.length  },
              { key: 'history', label: 'History', count: historyChallenges.length  },
            ] as const
          ).map(({ key, label, count }) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={challengeTab === key}
              className={`challenge-tab${challengeTab === key ? ' challenge-tab--active' : ''}`}
              onClick={() => setChallengeTab(key)}
            >
              {label}
              {count > 0 && (
                <span className={`challenge-tab-badge${challengeTab === key ? ' challenge-tab-badge--active' : ''}`}>
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── Pending tab ───────────────────────────────────────────── */}
        {challengeTab === 'pending' && (
          <div role="tabpanel" aria-label="Pending challenges">
            {challengesLoading && pendingChallenges.length === 0 && (
              <p className="mono dim">Loading…</p>
            )}
            {!challengesLoading && pendingChallenges.length === 0 && (
              <p className="mono dim">No pending challenges</p>
            )}
            {pendingChallenges.map((challenge) => {
              const isIncoming = challenge.challenged === userAddress;
              const otherAddress = isIncoming ? challenge.challenger : challenge.challenged;
              const otherUsername = challengeUsernames[otherAddress];
              const displayName = otherUsername ? `@${otherUsername}` : truncateAddr(otherAddress);
              const wager = Number(challenge.points_wagered) / 10_0000000;
              return (
                <div
                  key={`pending-${challenge.challenge_id}`}
                  className="status-pill warning challenge-history-item"
                >
                  <div className="challenge-history-row">
                    <strong>{isIncoming ? 'From' : 'To'} {displayName}</strong>
                    <span className="challenge-pending-label">
                      {isIncoming ? '⚔ Incoming' : 'Sent'}
                    </span>
                  </div>
                  <div className="challenge-history-meta">
                    <span>Wager: {wager} XLM</span>
                    <span>ID: {Number(challenge.challenge_id)}</span>
                  </div>
                  {isIncoming && (
                    <button
                      type="button"
                      className="btn-arena-secondary"
                      style={{ marginTop: '0.55rem' }}
                      disabled={busy}
                      onClick={() => void onAcceptChallenge(Number(challenge.challenge_id))}
                    >
                      Accept Challenge
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Active tab ────────────────────────────────────────────── */}
        {challengeTab === 'active' && (
          <div role="tabpanel" aria-label="Active challenges">
            {challengesLoading && activeChallenges.length === 0 && (
              <p className="mono dim">Loading…</p>
            )}
            {!challengesLoading && activeChallenges.length === 0 && (
              <p className="mono dim">No active sessions</p>
            )}
            {activeChallenges.map((challenge) => {
              const isIncoming = challenge.challenged === userAddress;
              const otherAddress = isIncoming ? challenge.challenger : challenge.challenged;
              const otherUsername = challengeUsernames[otherAddress];
              const displayName = otherUsername ? `@${otherUsername}` : truncateAddr(otherAddress);
              const sessionId = challenge.session_id == null ? null : Number(challenge.session_id);
              const wager = Number(challenge.points_wagered) / 10_0000000;
              return (
                <button
                  key={`active-${challenge.challenge_id}`}
                  type="button"
                  className="status-pill success challenge-history-item challenge-history-item--link"
                  onClick={() => { if (sessionId !== null) onEnterSession(sessionId); }}
                  disabled={busy || sessionId === null}
                  title="Enter this active challenge session"
                >
                  <div className="challenge-history-row">
                    <strong>{isIncoming ? 'From' : 'To'} {displayName}</strong>
                    <span>Active · Enter ▶</span>
                  </div>
                  <div className="challenge-history-meta">
                    <span>Wager: {wager} XLM</span>
                    <span>ID: {Number(challenge.challenge_id)}</span>
                    <span>Session: {sessionId === null ? '—' : sessionId}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* ── History tab ───────────────────────────────────────────── */}
        {challengeTab === 'history' && (
          <div role="tabpanel" aria-label="Challenge history">
            {challengesLoading && historyChallenges.length === 0 && (
              <p className="mono dim">Loading…</p>
            )}
            {!challengesLoading && historyChallenges.length === 0 && (
              <p className="mono dim">No challenge history yet</p>
            )}
            {historyChallenges.map((challenge) => {
              const isIncoming = challenge.challenged === userAddress;
              const otherAddress = isIncoming ? challenge.challenger : challenge.challenged;
              const otherUsername = challengeUsernames[otherAddress];
              const displayName = otherUsername ? `@${otherUsername}` : truncateAddr(otherAddress);
              const sessionId = challenge.session_id == null ? null : Number(challenge.session_id);
              const isExpired = !challenge.is_completed;
              const completedOutcome = sessionId != null ? challengeOutcomes[sessionId] : undefined;
              const concludedLabel =
                completedOutcome === 'win'  ? 'Won'
                : completedOutcome === 'loss' ? 'Lost'
                : completedOutcome === 'draw' ? 'Draw'
                : 'Concluded';
              const wager = Number(challenge.points_wagered) / 10_0000000;
              return (
                <button
                  key={`history-${challenge.challenge_id}`}
                  type="button"
                  className="status-pill challenge-history-item"
                  style={{ borderColor: isExpired ? 'rgba(255,255,255,0.1)' : undefined }}
                  disabled
                >
                  <div className="challenge-history-row">
                    <strong>{isIncoming ? 'From' : 'To'} {displayName}</strong>
                    <span>
                      {isExpired ? (
                        <span className="challenge-history-outcome" style={{ color: '#5a5a72' }}>Expired</span>
                      ) : (
                        <>
                          Concluded{' '}
                          <span
                            className={`challenge-history-outcome ${
                              completedOutcome === 'win'  ? 'challenge-history-outcome--win'
                              : completedOutcome === 'loss' ? 'challenge-history-outcome--loss'
                              : completedOutcome === 'draw' ? 'challenge-history-outcome--draw'
                              : ''
                            }`}
                          >
                            {concludedLabel}
                          </span>
                        </>
                      )}
                    </span>
                  </div>
                  <div className="challenge-history-meta">
                    <span>Wager: {wager} XLM</span>
                    <span>ID: {Number(challenge.challenge_id)}</span>
                    {sessionId !== null && <span>Session: {sessionId}</span>}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
