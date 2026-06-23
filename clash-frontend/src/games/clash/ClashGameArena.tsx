import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Loader2, Lock, Power, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { rpc } from '@stellar/stellar-sdk';
import { SmartAccountService } from './smartAccountService';
import { ClashGameService } from './clashService';
import { ClashZkArena } from './ClashZkArena';
import { CopyChip } from './components/CopyChip';
import { getContractId, NETWORK_PASSPHRASE, RPC_URL } from '@/utils/constants';
import { getPlayerPoints } from '@/services/pointsService';
import { PageLoading } from '@/components/PageLoading';
import './styles.css';

const CLASH_CONTRACT_ID = getContractId('clash');
const ACCOUNT_WASM_HASH = import.meta.env.VITE_ACCOUNT_WASM_HASH ?? '';
const WEBAUTHN_VERIFIER = import.meta.env.VITE_WEBAUTHN_VERIFIER_ADDRESS ?? '';
const missingClashContract = !CLASH_CONTRACT_ID?.trim();
const missingSmartAccountEnv = !ACCOUNT_WASM_HASH?.trim() || !WEBAUTHN_VERIFIER?.trim();

/** Must match `DELEGATE_SESSION_STORAGE_KEY` in smartAccountService.ts (read-only duplicate for UI checks). */
const DELEGATE_SESSION_STORAGE_KEY = 'clash-smart-account-delegate-session-v1';

type ParsedDelegate = {
  smartAccountContractId: string;
  validUntilLedger: number;
  clashContractId: string;
};

function parseDelegateSessionFromStorage(): ParsedDelegate | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(DELEGATE_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: number } & Partial<ParsedDelegate>;
    if (parsed.v !== 1 || typeof parsed.validUntilLedger !== 'number' || typeof parsed.smartAccountContractId !== 'string') {
      return null;
    }
    return {
      smartAccountContractId: parsed.smartAccountContractId,
      validUntilLedger: parsed.validUntilLedger,
      clashContractId: typeof parsed.clashContractId === 'string' ? parsed.clashContractId : '',
    };
  } catch {
    return null;
  }
}

async function isLedgerBeforeOrAt(validUntilLedger: number): Promise<boolean> {
  const server = new rpc.Server(RPC_URL, {
    allowHttp: RPC_URL.startsWith('http://'),
  });
  const { sequence } = await server.getLatestLedger();
  return sequence <= validUntilLedger;
}

function formatBalanceNum(raw: string | undefined | null): string {
  if (raw === undefined || raw === null || raw === '') return '';
  const n = parseFloat(String(raw).replace(/[^\d.-]/g, ''));
  if (Number.isNaN(n)) return '';
  return n.toFixed(3);
}

function formatTrackerPointsRail(raw: number | null): string {
  if (raw === null) return '--';
  if (!Number.isFinite(raw)) return '--';
  return raw.toLocaleString();
}

type ClashGameArenaProps = {
  onOpenLeaderboard?: () => void;
  onWalletAddressChange?: (address: string | null) => void;
};

export function ClashGameArena({ onOpenLeaderboard, onWalletAddressChange }: ClashGameArenaProps) {
  const [smartAccountService] = useState(
    () => new SmartAccountService(RPC_URL, NETWORK_PASSPHRASE, ACCOUNT_WASM_HASH, WEBAUTHN_VERIFIER)
  );
  const [clashService] = useState(() => new ClashGameService(CLASH_CONTRACT_ID));
  const [userAddress, setUserAddress] = useState<string | null>(null);
  const [walletConnected, setWalletConnected] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [displayBalance, setDisplayBalance] = useState(0);
  /** Passkey wallet create / sign-in on entry gate (not fund). */
  const [walletGateBusy, setWalletGateBusy] = useState<null | 'create' | 'connect'>(null);
  const [fundWalletBusy, setFundWalletBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionRestored, setSessionRestored] = useState<boolean | null>(null);
  const [fastSigning, setFastSigning] = useState(false);
  const [fastSigningBusy, setFastSigningBusy] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [sessionExpiresLedger, setSessionExpiresLedger] = useState<number | null>(null);
  const [hasActiveSessionKey, setHasActiveSessionKey] = useState(false);
  const [sessionRenewPromptOpen, setSessionRenewPromptOpen] = useState(false);
  const [sessionRenewPromptDismissed, setSessionRenewPromptDismissed] = useState(false);
  const [trackerPoints, setTrackerPoints] = useState<number | null>(null);
  const [trackerPointsLoading, setTrackerPointsLoading] = useState(false);
  const [trackerPointsError, setTrackerPointsError] = useState(false);
  const [arenaReady, setArenaReady] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [usernamePromptOpen, setUsernamePromptOpen] = useState(false);
  const [usernameInput, setUsernameInput] = useState('');
  const [usernameBusy, setUsernameBusy] = useState(false);
  const [cshBalance, setCshBalance] = useState<bigint>(0n);
  const balancePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const balanceAnimFromRef = useRef(0);
  const prevHasActiveSessionKeyRef = useRef(false);

  const refreshFastSigningState = useCallback(() => {
    setFastSigning(smartAccountService.hasClashSigningSession());
  }, [smartAccountService]);

  const fetchTrackerPoints = useCallback(async (opts?: { postRecordSettleMs?: number }) => {
    if (!userAddress) {
      setTrackerPoints(null);
      setTrackerPointsLoading(false);
      setTrackerPointsError(false);
      return;
    }
    setTrackerPointsLoading(true);
    setTrackerPointsError(false);
    try {
      if (opts?.postRecordSettleMs && opts.postRecordSettleMs > 0) {
        await new Promise((r) => setTimeout(r, opts.postRecordSettleMs));
      }
      let pts = await getPlayerPoints(userAddress);
      if (opts?.postRecordSettleMs && opts.postRecordSettleMs > 0) {
        await new Promise((r) => setTimeout(r, 400));
        pts = await getPlayerPoints(userAddress);
      }
      setTrackerPoints(pts);
    } catch {
      setTrackerPointsError(true);
      setTrackerPoints(null);
    } finally {
      setTrackerPointsLoading(false);
    }
  }, [userAddress]);

  const fetchIdentityData = useCallback(async (address: string) => {
    try {
      const [name, csh] = await Promise.all([
        clashService.getUsername(address),
        clashService.getCshBalance(address),
      ]);
      setUsername(name);
      setCshBalance(csh);
    } catch {
      setUsername(null);
      setCshBalance(0n);
    } finally {
      setIdentityLoaded(true);
    }
  }, [clashService]);

  useEffect(() => {
    void fetchTrackerPoints();
  }, [fetchTrackerPoints]);

  useEffect(() => {
    onWalletAddressChange?.(userAddress);
  }, [userAddress, onWalletAddressChange]);

  const evaluateSessionKeyUi = useCallback(
    async (address: string | null) => {
      if (!address) {
        setHasActiveSessionKey(false);
        setSessionExpiresLedger(null);
        return;
      }
      const mem = smartAccountService.getClashSigningSession();
      if (mem && mem.clashContractId === CLASH_CONTRACT_ID) {
        try {
          const ok = await isLedgerBeforeOrAt(mem.validUntilLedger);
          setSessionExpiresLedger(mem.validUntilLedger);
          setHasActiveSessionKey(ok);
          if (ok) return;
        } catch {
          setSessionExpiresLedger(mem.validUntilLedger);
          setHasActiveSessionKey(false);
        }
      }
      const stored = parseDelegateSessionFromStorage();
      if (
        stored &&
        stored.smartAccountContractId === address &&
        stored.clashContractId === CLASH_CONTRACT_ID
      ) {
        try {
          const ok = await isLedgerBeforeOrAt(stored.validUntilLedger);
          setSessionExpiresLedger(stored.validUntilLedger);
          setHasActiveSessionKey(ok);
          return;
        } catch {
          setSessionExpiresLedger(stored.validUntilLedger);
          setHasActiveSessionKey(false);
          return;
        }
      }
      setHasActiveSessionKey(false);
      setSessionExpiresLedger(null);
    },
    [smartAccountService]
  );

  const fetchBalanceWithRetry = useCallback(
    async (address: string, maxAttempts = 3) => {
      for (let i = 0; i < maxAttempts; i += 1) {
        try {
          const raw = await smartAccountService.getBalance(address);
          const formatted = formatBalanceNum(raw);
          if (formatted !== '') {
            const n = parseFloat(formatted);
            if (!Number.isNaN(n) && n > 0) {
              setBalance(formatted);
              setBalanceLoading(false);
              return;
            }
          }
        } catch {
          /* retry */
        }
        if (i < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, i === 0 ? 2000 : 5000));
        }
      }
      try {
        const raw = await smartAccountService.getBalance(address);
        const formatted = formatBalanceNum(raw);
        if (formatted !== '') {
          setBalance(formatted);
        } else {
          setBalance('0');
        }
      } catch {
        setBalance('0');
      } finally {
        setBalanceLoading(false);
      }
    },
    [smartAccountService]
  );

  useEffect(() => {
    const init = async () => {
      try {
        await smartAccountService.init();
        const restored = await smartAccountService.restoreSession();
        if (restored) {
          const contractId = smartAccountService.getContractId();
          if (contractId) {
            setUserAddress(contractId);
            setWalletConnected(true);
            setBalanceLoading(true);
            void fetchBalanceWithRetry(contractId);
            void evaluateSessionKeyUi(contractId);
            void fetchIdentityData(contractId);
          }
        }
        setSessionRestored(restored);
        refreshFastSigningState();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to initialize SmartAccount';
        setError(message);
      } finally {
        setArenaReady(true);
      }
    };
    void init();
  }, [smartAccountService, refreshFastSigningState, fetchBalanceWithRetry, evaluateSessionKeyUi, fetchIdentityData]);

  useEffect(() => {
    if (balanceLoading || balance === null) return;
    const target = parseFloat(balance);
    if (Number.isNaN(target)) return;
    const from = balanceAnimFromRef.current;
    let frame: number;
    const duration = 320;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 2;
      const v = from + (target - from) * eased;
      setDisplayBalance(v);
      if (t >= 1) balanceAnimFromRef.current = target;
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [balance, balanceLoading]);

  useEffect(() => {
    if (!userAddress || !walletConnected) {
      if (balancePollRef.current) {
        clearInterval(balancePollRef.current);
        balancePollRef.current = null;
      }
      return;
    }
    balancePollRef.current = setInterval(() => {
      void fetchBalanceWithRetry(userAddress, 1);
    }, 30000);
    return () => {
      if (balancePollRef.current) clearInterval(balancePollRef.current);
    };
  }, [userAddress, walletConnected, fetchBalanceWithRetry]);

  useEffect(() => {
    if (!userAddress || !walletConnected) return;
    const id = window.setInterval(() => {
      void evaluateSessionKeyUi(userAddress);
    }, 20000);
    return () => clearInterval(id);
  }, [userAddress, walletConnected, evaluateSessionKeyUi]);

  useEffect(() => {
    if (!walletConnected) {
      setSessionRenewPromptOpen(false);
      setSessionRenewPromptDismissed(false);
      prevHasActiveSessionKeyRef.current = false;
      return;
    }
    if (hasActiveSessionKey) {
      setSessionRenewPromptOpen(false);
      setSessionRenewPromptDismissed(false);
      prevHasActiveSessionKeyRef.current = true;
      return;
    }
    const isFirstTimeSetup = identityLoaded && username === null;
    const wasPreviouslyActive = prevHasActiveSessionKeyRef.current;
    const shouldPrompt =
      (isFirstTimeSetup || wasPreviouslyActive) &&
      !fastSigningBusy &&
      walletGateBusy === null &&
      !usernamePromptOpen &&
      (isFirstTimeSetup || !sessionRenewPromptDismissed);
    if (shouldPrompt) {
      setSessionRenewPromptOpen(true);
    }
    prevHasActiveSessionKeyRef.current = false;
  }, [
    walletConnected,
    identityLoaded,
    username,
    hasActiveSessionKey,
    fastSigningBusy,
    walletGateBusy,
    usernamePromptOpen,
    sessionRenewPromptDismissed,
  ]);

  useEffect(() => {
    const shouldOpenUsernamePrompt =
      walletConnected &&
      identityLoaded &&
      hasActiveSessionKey &&
      username === null &&
      !usernameBusy;
    if (shouldOpenUsernamePrompt) {
      setUsernamePromptOpen(true);
    } else if (!walletConnected || username !== null) {
      setUsernamePromptOpen(false);
    }
  }, [walletConnected, identityLoaded, hasActiveSessionKey, username, usernameBusy]);

  const handleCreateWallet = async () => {
    setWalletGateBusy('create');
    setError(null);
    setIdentityLoaded(false);
    try {
      const result = await smartAccountService.createFreshWallet('Clash', `player_${Date.now()}`, true);
      setUserAddress(result.contractId);
      setWalletConnected(true);
      setBalanceLoading(true);
      void fetchBalanceWithRetry(result.contractId);
      void evaluateSessionKeyUi(result.contractId);
      void fetchIdentityData(result.contractId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to create wallet: ${message}`);
    } finally {
      setWalletGateBusy(null);
    }
  };

  const handleSignInWithPasskey = async () => {
    setWalletGateBusy('connect');
    setError(null);
    setIdentityLoaded(false);
    try {
      const result = await smartAccountService.connectWallet(true);
      if (result) {
        setUserAddress(result.contractId);
        setWalletConnected(true);
        setBalanceLoading(true);
        void fetchBalanceWithRetry(result.contractId);
        void evaluateSessionKeyUi(result.contractId);
        void fetchIdentityData(result.contractId);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(`Failed to sign in: ${message}`);
    } finally {
      setWalletGateBusy(null);
    }
  };

  const handleDisconnect = async () => {
    await smartAccountService.disconnect();
    setFastSigning(false);
    setUserAddress(null);
    setWalletConnected(false);
    setBalance(null);
    setBalanceLoading(true);
    balanceAnimFromRef.current = 0;
    setDisplayBalance(0);
    setHasActiveSessionKey(false);
    setSessionExpiresLedger(null);
    setUsername(null);
    setIdentityLoaded(false);
    setCshBalance(0n);
  };

  /**
   * Mirror the contract's validate_username_format + length + reserved checks.
   * Returns an error string, or null when the value is valid.
   */
  const validateUsernameFormat = (value: string): string | null => {
    if (value.length < 3) return 'Username must be at least 3 characters.';
    if (value.length > 20) return 'Username must be 20 characters or fewer.';
    if (!/^[a-z0-9_]+$/.test(value))
      return 'Only lowercase letters (a–z), numbers, and underscores are allowed.';
    const RESERVED = ['admin', 'system', 'moderator', 'support'];
    if (RESERVED.includes(value)) return `"${value}" is a reserved name. Please choose another.`;
    return null;
  };

  const usernameValidationError =
    usernameInput.trim() === '' ? null : validateUsernameFormat(usernameInput.trim().toLowerCase());

  const handleSaveUsername = async () => {
    if (!userAddress) return;
    const normalized = usernameInput.trim().toLowerCase();
    const formatError = validateUsernameFormat(normalized);
    if (formatError) {
      setError(formatError);
      return;
    }
    setUsernameBusy(true);
    setError(null);
    try {
      const existingOwner = await clashService.getAddressByUsername(normalized);
      if (existingOwner && existingOwner !== userAddress) {
        setError('Username already taken. Try another one.');
        return;
      }
      await clashService.setUsernameWithSmartAccount(userAddress, normalized, smartAccountService);
      setUsername(normalized);
      setUsernamePromptOpen(false);
      setUsernameInput('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to set username';
      setError(message);
    } finally {
      setUsernameBusy(false);
    }
  };

  const handleUsernameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !usernameBusy && !usernameValidationError && usernameInput.trim().length >= 3) {
      void handleSaveUsername();
    }
    if (e.key === 'Escape') {
      // Only close if a username is already set (i.e. not first-time mandatory setup)
      if (username !== null) {
        setUsernamePromptOpen(false);
        setUsernameInput('');
      }
    }
  };

  const handleStartFastSigning = async () => {
    setFastSigningBusy(true);
    setError(null);
    try {
      await smartAccountService.startClashSigningSession(CLASH_CONTRACT_ID);
      refreshFastSigningState();
      await evaluateSessionKeyUi(userAddress);
      setSessionRenewPromptOpen(false);
      setSessionRenewPromptDismissed(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(`Fast signing setup failed: ${message}`);
    } finally {
      setFastSigningBusy(false);
    }
  };

  const handleClearFastSigning = () => {
    smartAccountService.clearClashSigningSession();
    refreshFastSigningState();
    void evaluateSessionKeyUi(userAddress);
  };

  const handleFundWallet = async () => {
    if (!userAddress) return;
    setFundWalletBusy(true);
    try {
      await smartAccountService.fundWallet(userAddress);
      setBalanceLoading(true);
      void fetchBalanceWithRetry(userAddress, 3);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Funding failed');
    } finally {
      setFundWalletBusy(false);
    }
  };

  const balanceNum = balance !== null ? parseFloat(balance) : NaN;
  const showLowBalance = !balanceLoading && !Number.isNaN(balanceNum) && balanceNum < 2 && balanceNum > 0;
  const showZeroBalance = !balanceLoading && !Number.isNaN(balanceNum) && balanceNum <= 0;

  return (
    <div className="arena-game-shell">
      {(missingClashContract || missingSmartAccountEnv) && (
        <div className="critical-banner">
          Missing app configuration: set contract id + smart-account env vars.
        </div>
      )}

      <div className="arena-topbar">
        <div>
          <h2>CLASH</h2>
          <p>Clash of pirates · ARENA</p>
        </div>
        <div className="arena-topbar-right">
        <div className={`wallet-pill ${walletConnected ? 'connected' : ''}`}>
          <span className={`wallet-pill-dot ${walletConnected ? 'on' : ''}`}>●</span>
          {walletConnected && userAddress ? (
            <div className="wallet-pill-identity">
              <span className="wallet-pill-you">⚡ YOU</span>
              <span className="wallet-pill-you">@{username ?? 'anonymous'}</span>
              <CopyChip label="" value={userAddress} display={`${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`} />
            </div>
          ) : (
            <>
              <Wallet size={14} />
              Wallet Locked
            </>
          )}
          {walletConnected && (
            <div className="wallet-pill-balance" title={showLowBalance ? 'Low balance — fund your wallet to continue playing' : undefined}>
              {balanceLoading ? (
                <span className="wallet-balance-loading">-- XLM</span>
              ) : showZeroBalance ? (
                <button
                  type="button"
                  className="wallet-balance-fund"
                  disabled={fundWalletBusy}
                  onClick={() => void handleFundWallet()}
                >
                  {fundWalletBusy ? (
                    <>
                      <Loader2 className="wallet-balance-fund-spinner" size={12} aria-hidden />
                      Funding…
                    </>
                  ) : (
                    '0 XLM — Fund Wallet'
                  )}
                </button>
              ) : (
                <span
                  className={`wallet-balance-value ${showLowBalance ? 'wallet-balance-low' : ''}`}
                  title={showLowBalance ? 'Low balance — fund your wallet to continue playing' : undefined}
                >
                  {displayBalance.toFixed(3)} XLM
                  {showLowBalance && <AlertTriangle size={12} className="wallet-balance-warn-icon" aria-hidden />}
                </span>
              )}
            </div>
          )}
          {walletConnected && (
            <button className="wallet-pill-disconnect" onClick={() => void handleDisconnect()} aria-label="Disconnect wallet">
              <Power size={12} />
            </button>
          )}
        </div>
        {onOpenLeaderboard && (
          <button type="button" className="arena-nav-leaderboard" onClick={() => onOpenLeaderboard()}>
            🏆 LEADERBOARD
          </button>
        )}
        </div>
      </div>

      {!arenaReady ? (
        <PageLoading variant="viewport" title="Initializing arena" subtitle="Restoring wallet session and connecting to the network…" />
      ) : !walletConnected ? (
        <motion.section
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className={`entry-gate ${walletGateBusy ? 'entry-gate--busy' : ''}`}
          aria-busy={walletGateBusy != null}
        >
          {walletGateBusy && (
            <div className="entry-gate-busy-overlay" role="status" aria-live="polite">
              <Loader2 className="entry-gate-spinner" size={28} aria-hidden />
              <p className="entry-gate-busy-text">
                {walletGateBusy === 'create'
                  ? 'Creating your passkey wallet…'
                  : 'Waiting for passkey — connecting…'}
              </p>
              <p className="entry-gate-busy-hint">Complete the prompt in your browser or device</p>
            </div>
          )}
          <div className="entry-gate-inner">
            <div className="entry-wordmark">CLASH</div>
            <p>Connect wallet to enter the arena</p>
            <button
              className="btn-arena-primary gate-btn"
              onClick={() => void handleCreateWallet()}
              disabled={walletGateBusy !== null || missingClashContract || missingSmartAccountEnv}
            >
              {walletGateBusy === 'create' ? (
                <>
                  <Loader2 className="gate-btn-spinner" size={18} aria-hidden />
                  Creating wallet…
                </>
              ) : (
                '⚡ CREATE PASSKEY WALLET'
              )}
            </button>
            <button
              className="btn-arena-secondary gate-btn"
              onClick={() => void handleSignInWithPasskey()}
              disabled={walletGateBusy !== null || missingClashContract || missingSmartAccountEnv}
            >
              {walletGateBusy === 'connect' ? (
                <>
                  <Loader2 className="gate-btn-spinner" size={18} aria-hidden />
                  Connecting…
                </>
              ) : (
                '↩ CONNECT EXISTING'
              )}
            </button>
            {sessionRestored === false && <small>Restore previous session unavailable in this browser session.</small>}
            <div className="lock-overlay">
              <Lock size={18} /> Locked until wallet is validated
            </div>
          </div>
        </motion.section>
      ) : null}

      <AnimatePresence>
        {arenaReady && walletConnected && userAddress && (
          <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} className="arena-layout">
            <aside className="left-rail">
              <div className="rail-card">
                <span>Phase</span>
                <strong>Duel Flow</strong>
              </div>
              <div className="rail-card rail-card-session">
                <span>Session</span>
                <span className="rail-you-label">YOU</span>
                <strong className="mono">{activeSessionId || 'Pending'}</strong>
              </div>
              {activeSessionId && <CopyChip label="SESSION" value={activeSessionId} />}
              <div className="rail-card rail-card-points">
                <span className="rail-points-label">⚓ YOUR POINTS</span>
                <div className="rail-points-row">
                  <strong className="rail-points-val">
                    {trackerPointsLoading ? '-- pts' : `${formatTrackerPointsRail(trackerPoints)} pts`}
                  </strong>
                  {trackerPointsError && (
                    <button
                      type="button"
                      className="rail-points-retry"
                      onClick={() => void fetchTrackerPoints()}
                      aria-label="Retry loading points"
                    >
                      <RefreshCw size={14} />
                    </button>
                  )}
                  {onOpenLeaderboard && (
                    <button type="button" className="rail-points-lb-btn" onClick={() => onOpenLeaderboard()} title="Leaderboard">
                      🏆 LB
                    </button>
                  )}
                </div>
                <small className="rail-points-sub">Across all duels (on-chain)</small>
              </div>
              <div className="rail-card">
                <span>CSH Balance</span>
                <strong className="mono rail-balance">{Number(cshBalance) / 10_0000000} CSH</strong>
              </div>
              <div className="rail-card">
                <span>Balance</span>
                <strong className={`mono rail-balance ${balanceLoading ? 'rail-balance-loading' : ''}`}>
                  {balanceLoading ? '-- XLM' : `${formatBalanceNum(balance)} XLM`}
                </strong>
              </div>
              <div
                className={`rail-card rail-fast-sign ${hasActiveSessionKey ? 'rail-fast-sign-active' : ''} ${
                  fastSigningBusy ? 'rail-fast-sign--creating' : ''
                }`}
              >
                <div className="rail-fast-header">
                  <span>⚡ FAST SIGN</span>
                  {hasActiveSessionKey ? (
                    <span className="rail-fast-status rail-fast-status-on">
                      ACTIVE <span className="rail-fast-dot">●</span>
                    </span>
                  ) : (
                    <span className="rail-fast-status rail-fast-status-off">
                      INACTIVE <span className="rail-fast-dot rail-fast-dot-off">○</span>
                    </span>
                  )}
                </div>
                <p className="rail-fast-sub">Scoped to Clash contract</p>
                {hasActiveSessionKey && sessionExpiresLedger !== null && (
                  <p className="rail-fast-expiry mono">Expires: ledger #{sessionExpiresLedger.toLocaleString()}</p>
                )}
                {hasActiveSessionKey ? (
                  <button type="button" className="rail-btn-clear-session" onClick={handleClearFastSigning}>
                    ✕ Clear Session
                  </button>
                ) : (
                  <>
                    <p className="rail-fast-hint">Skip passkey prompts per tx</p>
                    <button
                      type="button"
                      className="rail-btn-create-session"
                      disabled={fastSigningBusy}
                      onClick={() => void handleStartFastSigning()}
                    >
                      {fastSigningBusy ? (
                        <>
                          <Loader2 className="rail-btn-spinner" size={12} aria-hidden />
                          Creating session…
                        </>
                      ) : (
                        '+ CREATE SESSION KEY'
                      )}
                    </button>
                  </>
                )}
              </div>
            </aside>

            <section className="center-stage">
              {error && (
                <div className="status-pill error">
                  <ShieldCheck size={14} /> {error}
                </div>
              )}
              <ClashZkArena
                userAddress={userAddress}
                clashService={clashService}
                smartAccountService={smartAccountService}
                fastSigning={fastSigning}
                hasActiveSessionKey={hasActiveSessionKey}
                sessionExpiresLedger={sessionExpiresLedger}
                onCreateSessionKey={() => void handleStartFastSigning()}
                onClearSessionKey={handleClearFastSigning}
                fastSigningBusy={fastSigningBusy}
                onSessionKeyActivated={() => {
                  refreshFastSigningState();
                  void evaluateSessionKeyUi(userAddress);
                }}
                onSessionIdChange={(sid) => setActiveSessionId(String(sid))}
                sessionTotalPoints={trackerPoints}
                sessionPointsLoading={trackerPointsLoading}
                sessionPointsError={trackerPointsError}
                onRefreshSessionPoints={() => void fetchTrackerPoints()}
                hasUsername={username !== null}
                onBattleResolved={() =>
                  Promise.all([
                    fetchTrackerPoints({
                      // Allow RPC/ledger to reflect record_result after resolve (awaited in clashService).
                      postRecordSettleMs: 450,
                    }),
                    userAddress ? fetchIdentityData(userAddress) : Promise.resolve(),
                  ]).then(() => undefined)
                }
              />
            </section>
          </motion.div>
        )}
      </AnimatePresence>
      {walletConnected && usernamePromptOpen && (
        <div className="username-dialog-backdrop" role="presentation">
          <div
            className="username-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Choose username"
            aria-describedby="username-dialog-subtitle"
          >
            <p className="username-dialog-title">Choose your captain username</p>
            <p className="username-dialog-subtitle" id="username-dialog-subtitle">
              This is how other players find and challenge you.
            </p>
            <input
              autoFocus
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              onKeyDown={handleUsernameKeyDown}
              placeholder="lowercase letters, numbers, underscore"
              className={`username-dialog-input${usernameValidationError ? ' username-dialog-input--error' : ''}`}
              maxLength={20}
              aria-invalid={usernameValidationError !== null}
              aria-describedby={usernameValidationError ? 'username-dialog-error' : undefined}
              spellCheck={false}
              autoComplete="off"
            />
            {usernameValidationError && (
              <p className="username-dialog-error" id="username-dialog-error" role="alert">
                {usernameValidationError}
              </p>
            )}
            <p className="username-dialog-hint">
              {usernameInput.trim().length}/20 · a–z, 0–9, _ · Press <kbd>Enter</kbd> to save
              {username !== null && <> · <kbd>Esc</kbd> to cancel</>}
            </p>
            <button
              className="btn-arena-primary username-dialog-save"
              disabled={usernameBusy || Boolean(usernameValidationError) || usernameInput.trim().length < 3}
              onClick={() => void handleSaveUsername()}
            >
              {usernameBusy ? 'Saving...' : 'Save Username'}
            </button>
          </div>
        </div>
      )}
      {walletConnected && sessionRenewPromptOpen && !usernamePromptOpen && (
        <div className="session-renew-backdrop" role="presentation">
          <div className="session-renew-dialog" role="dialog" aria-label="Session key renewal">
            <p className="session-renew-title">{username === null ? 'Step 1 of 2: Create session key' : 'Session key inactive'}</p>
            <p className="session-renew-body">
              {username === null
                ? 'Create your session key first. After that, we will ask you to choose your username.'
                : 'Fast signing is off. Create a new session key to keep gasless one-tap gameplay for the next 24 hours.'}
            </p>
            <button
              type="button"
              className="btn-arena-primary session-renew-primary"
              disabled={fastSigningBusy}
              onClick={() => void handleStartFastSigning()}
            >
              {fastSigningBusy ? 'Creating session...' : 'Create New Session Key'}
            </button>
            {username !== null && (
              <button
                type="button"
                className="session-renew-dismiss"
                onClick={() => {
                  setSessionRenewPromptOpen(false);
                  setSessionRenewPromptDismissed(true);
                }}
              >
                Maybe later
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
