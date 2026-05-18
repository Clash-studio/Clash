import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, type Variants } from 'framer-motion';
import { Loader2, Lock, ShieldAlert } from 'lucide-react';
import { Buffer } from 'buffer';
import { NoirService, type ClashProofResult } from '@/utils/NoirService';
import type { ClashGameService } from './clashService';
import type { SmartAccountService } from './smartAccountService';
import type { Challenge, DetailedTurnResult, Game, GamePlayback, Move } from './bindings';
import { Attack, Defense } from './bindings';
import type { SelectedMove } from '@/components/Clashgamecomponents';
import { createEmptyMoves } from '@/components/Clashgamecomponents';
import { recordSessionLoadActivity } from '@/utils/onChainTxFeed';
import { CopyChip } from './components/CopyChip';
import { CLASH_CONTRACT, NETWORK } from '@/utils/constants';
import { registerDuelParticipants } from '@/services/pointsService';

type ZkPhase = 'create' | 'commit' | 'waiting_reveal' | 'reveal' | 'resolve' | 'complete';
const STEP_KEYS = ['moves', 'proof', 'commit', 'reveal', 'resolve'] as const;
const POINTS_DECIMALS = 7;
const DEFAULT_POINTS = '0.1';
const ATTACK_MOVES = [
  { index: 0, icon: '⚔️', name: 'Cutlass Slash', damage: 30, counters: 'Counter', blockedBy: 'Dodge' },
  { index: 1, icon: '🔥', name: 'Cannon Blast', damage: 40, counters: 'Dodge', blockedBy: 'Counter' },
  { index: 2, icon: '⚡', name: 'Lightning Strike', damage: 35, counters: 'Block', blockedBy: 'Block' },
] as const;
const DEFENSE_MOVES = [
  { index: 0, icon: '🛡️', name: 'Raised Shield', label: 'Block', stops: 'Lightning Strike', stopsIcon: '⚡' },
  { index: 1, icon: '🏃', name: 'Quick Sidestep', label: 'Dodge', stops: 'Cutlass Slash', stopsIcon: '⚔️' },
  { index: 2, icon: '🔄', name: 'Riposte', label: 'Counter', stops: 'Cannon Blast', stopsIcon: '🔥' },
] as const;
const COUNTER_DEFENSE_BY_ATTACK: Record<number, number> = {
  [Attack.Slash]: Defense.Dodge,
  [Attack.Fireball]: Defense.Counter,
  [Attack.Lightning]: Defense.Block,
};

const MATRIX_CHARS = 'アイウエオカキクケコ0123456789ABCDEF<>{}[]|/\\';
const PROOF_TERMINAL_LINES = [
  '> LOADING CIRCUIT: duel_commit_circuit.json',
  '> EXECUTING WITNESS GENERATION...',
  '> COMPUTING PEDERSEN HASH COMMITMENT...',
  '> RUNNING ULTRAHONK PROVER...',
  '> VERIFYING SUMCHECK PROTOCOL...',
  '> VERIFYING SHPLEMINI POLYNOMIAL...',
  '> BUILDING PUBLIC INPUTS [96 BYTES]...',
  '> PROOF SIZE: ~2KB',
  '> FINALIZING...',
] as const;

const ROUND_TITLES = ['Round 1 — The Opening Gambit', 'Round 2 — Clash of pirates', 'Round 3 — The Final Reckoning'] as const;

const FORGING_BUTTON_LINES = [
  '⚡ FORGING ZERO-KNOWLEDGE PROOF...',
  '⚡ COMPILING ARITHMETIZATION...',
  '⚡ GENERATING WITNESS POLYNOMIALS...',
  '⚡ INVOKING BARRETENBERG PROVER...',
] as const;

type SpriteAnim = 'idle' | 'attack' | 'hit' | 'block' | 'victory' | 'defeated';

/** Playback narration line — uses ATTACK_MOVES / DEFENSE_MOVES names only (via builders). */
type NarrationModel = {
  key: string;
  attackerIsP1: boolean;
  hit: boolean;
  atkIcon: string;
  atkName: string;
  dmg?: number;
  defName?: string;
  comboBonus?: number;
};

type BattlePlaybackUi = {
  round: number;
  segment: 'idle' | 'intro' | 'p1Reveal' | 'p1Impact' | 'p2Reveal' | 'p2Impact' | 'exchange' | 'hp' | 'winner' | 'post';
  hp1: number;
  hp2: number;
  p1Anim: SpriteAnim;
  p2Anim: SpriteAnim;
  floatText: string | null;
  floatTone: 'crimson' | 'cyan';
  floatSide: 'left' | 'right' | null;
  showRoundTitle: boolean;
  roundTitleText: string;
  p1AtkCard: boolean;
  p1DefCard: boolean;
  p2AtkCard: boolean;
  p2DefCard: boolean;
  narration: NarrationModel | null;
  exchangeFlash: boolean;
  vignetteHit: boolean;
  showWinnerOverlay: boolean;
  showEndTable: boolean;
  showEndButtons: boolean;
  outcome: 'win' | 'loss' | 'draw' | null;
};

function isLocalPlayer(address: string, walletAddress: string) {
  return address?.toLowerCase() === walletAddress?.toLowerCase();
}

function truncateAddr(a: string) {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function attackMeta(a: Attack) {
  return ATTACK_MOVES.find((m) => m.index === a) ?? ATTACK_MOVES[0];
}
function defenseMeta(d: Defense) {
  return DEFENSE_MOVES.find((m) => m.index === d) ?? DEFENSE_MOVES[0];
}

function PlaybackNarrationBar({ n, isP1Local }: { n: NarrationModel; isP1Local: boolean }) {
  const body = '#C0C0D0';
  const move = (
    <>
      <span className="playback-narr-move-icon" aria-hidden>
        {n.atkIcon}
      </span>{' '}
      <span className="playback-narr-move-name">{n.atkName}</span>
    </>
  );
  const combo =
    n.comboBonus != null && n.comboBonus > 0 ? (
      <span className="playback-narr-combo">
        {' '}
        (+{n.comboBonus} combo bonus)
      </span>
    ) : null;

  if (n.attackerIsP1) {
    if (n.hit && n.dmg != null) {
      if (isP1Local) {
        return (
          <p className="playback-narr-text" style={{ color: body }}>
            <span className="playback-narr-you">You</span> attacked your opponent with {move} —{' '}
            <span className="playback-narr-dmg">{n.dmg}</span> damage!{combo}
          </p>
        );
      }
      return (
        <p className="playback-narr-text" style={{ color: body }}>
          <span className="playback-narr-opp">Opponent</span> attacked you with {move} —{' '}
          <span className="playback-narr-dmg">{n.dmg}</span> damage!{combo}
        </p>
      );
    }
    const defNm = n.defName ?? defenseMeta(Defense.Block).name;
    if (isP1Local) {
      return (
        <p className="playback-narr-text" style={{ color: body }}>
          <span className="playback-narr-you">You</span> attacked with {move} — <span className="playback-narr-blocked">blocked</span> by their {defNm}!
        </p>
      );
    }
    return (
      <p className="playback-narr-text" style={{ color: body }}>
        <span className="playback-narr-opp">Opponent</span> attacked with {move} — <span className="playback-narr-blocked">blocked</span> by your {defNm}!
      </p>
    );
  }

  if (n.hit && n.dmg != null) {
    if (isP1Local) {
      return (
        <p className="playback-narr-text" style={{ color: body }}>
          <span className="playback-narr-opp">Opponent</span> attacked you with {move} —{' '}
          <span className="playback-narr-dmg">{n.dmg}</span> damage!{combo}
        </p>
      );
    }
    return (
      <p className="playback-narr-text" style={{ color: body }}>
        <span className="playback-narr-you">You</span> attacked your opponent with {move} —{' '}
        <span className="playback-narr-dmg">{n.dmg}</span> damage!{combo}
      </p>
    );
  }
  const defNm = n.defName ?? defenseMeta(Defense.Block).name;
  if (isP1Local) {
    return (
      <p className="playback-narr-text" style={{ color: body }}>
        <span className="playback-narr-opp">Opponent</span> attacked with {move} — <span className="playback-narr-blocked">blocked</span> by your {defNm}!
      </p>
    );
  }
  return (
    <p className="playback-narr-text" style={{ color: body }}>
      <span className="playback-narr-you">You</span> attacked with {move} — <span className="playback-narr-blocked">blocked</span> by their {defNm}!
    </p>
  );
}

const TIMING = {
  ROUND_TITLE_HOLD: 1400,
  ROUND_TITLE_FADEOUT: 400,
  MOVE_REVEAL_DELAY: 600,
  MOVE_REVEAL_ANIM: 500,
  NARRATION_HOLD: 2200,
  NARRATION_FADEOUT: 300,
  ATTACK_ANIM_DURATION: 600,
  IMPACT_FLOAT_DURATION: 900,
  EXCHANGE_FLASH_HOLD: 700,
  HP_BAR_ANIM: 900,
  BETWEEN_PLAYERS: 1000,
  BETWEEN_ROUNDS: 1800,
  WINNER_REVEAL_DELAY: 1200,
} as const;

function buildNarrationP1(tr: DetailedTurnResult, r: number): NarrationModel {
  const atk = attackMeta(tr.player1_move.attack);
  const def = defenseMeta(tr.player2_move.defense);
  const p2dmg = Number(tr.player2_damage_taken);
  const base = atk.damage;
  const hit = p2dmg > 0;
  const comboBonus = hit && p2dmg > base ? p2dmg - base : undefined;
  return {
    key: `n-p1-${r}-${tr.turn}`,
    attackerIsP1: true,
    hit,
    atkIcon: atk.icon,
    atkName: atk.name,
    dmg: hit ? p2dmg : undefined,
    defName: hit ? undefined : def.name,
    comboBonus,
  };
}

function buildNarrationP2(tr: DetailedTurnResult, r: number): NarrationModel {
  const atk = attackMeta(tr.player2_move.attack);
  const def = defenseMeta(tr.player1_move.defense);
  const p1dmg = Number(tr.player1_damage_taken);
  const base = atk.damage;
  const hit = p1dmg > 0;
  const comboBonus = hit && p1dmg > base ? p1dmg - base : undefined;
  return {
    key: `n-p2-${r}-${tr.turn}`,
    attackerIsP1: false,
    hit,
    atkIcon: atk.icon,
    atkName: atk.name,
    dmg: hit ? p1dmg : undefined,
    defName: hit ? undefined : def.name,
    comboBonus,
  };
}

function MatrixRain({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const raf = useRef<number>(0);

  useEffect(() => {
    if (!active) return;
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = 0;
    let h = 0;
    const fontSize = 13;
    const drops: number[] = [];
    const speeds: number[] = [];

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      w = Math.max(1, Math.floor(rect.width));
      h = Math.max(1, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const colCount = Math.ceil(w / fontSize);
      drops.length = 0;
      speeds.length = 0;
      for (let i = 0; i < colCount; i++) {
        drops[i] = Math.random() * -h;
        speeds[i] = 1 + Math.floor(Math.random() * 3);
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    const draw = () => {
      ctx.fillStyle = 'rgba(5, 5, 8, 0.15)';
      ctx.fillRect(0, 0, w, h);
      ctx.font = `${fontSize}px "JetBrains Mono", monospace`;

      for (let i = 0; i < drops.length; i++) {
        const x = i * fontSize;
        const headY = drops[i]!;
        const ch = MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)]!;
        const trailLen = 18;
        for (let j = 0; j < trailLen; j++) {
          const y = headY - j * fontSize;
          if (y < -fontSize || y > h + fontSize) continue;
          const tail = j / trailLen;
          const headG = 0xff;
          const dimG = 0x3b;
          const g = Math.round(dimG + (1 - tail) * (headG - dimG));
          ctx.fillStyle = j === 0 ? '#00FF41' : `rgb(0, ${g}, ${Math.round(0x00 + tail * 0x41)})`;
          const c = j === 0 ? ch : MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)]!;
          ctx.fillText(c, x, y);
        }
        drops[i]! += speeds[i]! * (fontSize * 0.35);
        if (drops[i]! > h + 40) {
          drops[i] = Math.random() * -h * 0.8;
          speeds[i] = 1 + Math.floor(Math.random() * 3);
        }
      }

      raf.current = requestAnimationFrame(draw);
    };
    raf.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf.current);
      ro.disconnect();
    };
  }, [active]);

  return (
    <canvas
      ref={ref}
      className="zk-matrix-rain-canvas"
      aria-hidden
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: active ? 0.18 : 0, transition: 'opacity 0.5s ease' }}
    />
  );
}

type CommitPhase = 'idle' | 'proving' | 'committing' | 'done' | 'proof-error' | 'commit-error';

function ProofTerminal({
  proofBundle,
  sessionId,
  allMovesComplete,
  commitPhase,
  proofError,
  onRetryProof,
}: {
  proofBundle: ClashProofResult | null;
  sessionId: number;
  allMovesComplete: boolean;
  commitPhase: CommitPhase;
  proofError: string | null;
  onRetryProof: () => void;
}) {
  const generating = commitPhase === 'proving';

  const [lines, setLines] = useState<string[]>([]);
  const [currentLine, setCurrentLine] = useState('');
  const [lineIdx, setLineIdx] = useState(0);
  const [charIdx, setCharIdx] = useState(0);
  const [progress, setProgress] = useState(0);
  const [rainActive, setRainActive] = useState(false);
  const progressTRef = useRef<number>(0);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (generating) {
      setRainActive(true);
      setLines([]);
      setCurrentLine('');
      setLineIdx(0);
      setCharIdx(0);
      setProgress(0);
      startRef.current = Date.now();
    } else if (proofBundle && (commitPhase === 'committing' || commitPhase === 'done' || commitPhase === 'commit-error')) {
      setRainActive(false);
      setProgress(100);
    } else if (commitPhase === 'proof-error') {
      setRainActive(false);
    }
  }, [generating, proofBundle, commitPhase]);

  useEffect(() => {
    if (!generating) return;
    const tick = () => {
      const elapsed = (Date.now() - startRef.current) / 1000;
      let p = 0;
      if (elapsed < 2) p = (elapsed / 2) * 40;
      else if (elapsed < 8) p = 40 + ((elapsed - 2) / 6) * 50;
      else p = 90;
      setProgress(p);
      progressTRef.current = window.requestAnimationFrame(tick);
    };
    progressTRef.current = window.requestAnimationFrame(tick);
    return () => cancelAnimationFrame(progressTRef.current);
  }, [generating]);

  useEffect(() => {
    if (proofBundle && (commitPhase === 'committing' || commitPhase === 'done' || commitPhase === 'commit-error')) setProgress(100);
  }, [proofBundle, commitPhase]);

  useEffect(() => {
    if (!generating) return;
    const line = PROOF_TERMINAL_LINES[lineIdx];
    if (!line) {
      setLineIdx(0);
      return;
    }
    if (charIdx < line.length) {
      const t = window.setTimeout(() => {
        setCurrentLine(line.slice(0, charIdx + 1));
        setCharIdx((c) => c + 1);
      }, 30);
      return () => clearTimeout(t);
    }
    const t = window.setTimeout(() => {
      setLines((prev) => [...prev, line]);
      setCurrentLine('');
      setCharIdx(0);
      setLineIdx((i) => (i + 1) % PROOF_TERMINAL_LINES.length);
    }, 800);
    return () => clearTimeout(t);
  }, [generating, lineIdx, charIdx]);

  let mode: 'idle' | 'generating' | 'valid' | 'error' = 'idle';
  if (generating) mode = 'generating';
  else if (commitPhase === 'proof-error') mode = 'error';
  else if (proofBundle && (commitPhase === 'committing' || commitPhase === 'done' || commitPhase === 'commit-error')) mode = 'valid';
  else mode = 'idle';

  const borderClass =
    mode === 'valid' ? 'zk-proof-terminal--valid' : mode === 'error' ? 'zk-proof-terminal--error' : 'zk-proof-terminal--idle';

  return (
    <div className={`zk-proof-terminal ${borderClass}`}>
      <MatrixRain active={mode === 'generating' && rainActive} />
      <div className="zk-proof-terminal-header">
        <span className="zk-term-dot zk-term-dot--red" />
        <span className="zk-term-dot zk-term-dot--amber" />
        <span className="zk-term-dot zk-term-dot--green" />
        <div className="zk-proof-terminal-titles">
          <span className="zk-proof-terminal-title">ZERO-KNOWLEDGE PROOF ENGINE v2.1.0</span>
          <span className="zk-proof-terminal-sub">UltraHonk / Barretenberg / Noir</span>
        </div>
      </div>
      <div className="zk-proof-terminal-body">
        {mode === 'idle' && (
          <div className="zk-term-text zk-term-text--dim">
            <div>&gt; PROOF ENGINE STANDING BY</div>
            <div>&gt; AWAITING MOVE COMMITMENT...</div>
            <div className="zk-term-cursor-line">
              &gt; <span className="zk-term-cursor" />
            </div>
          </div>
        )}
        {mode === 'generating' && (
          <>
            <div className="zk-term-scroll">
              {lines.map((ln) => (
                <div key={ln} className="zk-term-line zk-term-line--done">
                  {ln}
                </div>
              ))}
              <div className="zk-term-line zk-term-line--bright">
                {currentLine}
                <span className="zk-term-cursor" />
              </div>
            </div>
            <div className="zk-term-progress-row">
              <div className="zk-term-progress-track">
                <div className="zk-term-progress-fill" style={{ width: `${Math.round(progress)}%` }} />
              </div>
              <span className="zk-term-progress-label">PROVING... {Math.round(progress)}%</span>
            </div>
          </>
        )}
        {mode === 'valid' && proofBundle && (
          <div className="zk-term-text zk-term-text--valid">
            <div>&gt; PROOF GENERATED SUCCESSFULLY</div>
            <div className="zk-term-row-inline">
              &gt; YOUR COMMITMENT:{' '}
              <CopyChip
                label="YOUR COMMITMENT ⧉"
                value={proofBundle.commitmentHash}
                display={`${proofBundle.commitmentHash.slice(0, 6)}...${proofBundle.commitmentHash.slice(-4)}`}
              />
            </div>
            <div className="zk-term-row-inline">
              &gt; SESSION:{' '}
              <CopyChip label="SESSION ⧉" value={String(sessionId)} />
            </div>
            <div>&gt; PROOF SIZE: {proofBundle.proofBytes.length} bytes</div>
            <div>&gt; CIRCUIT: UltraHonk / Keccak oracle</div>
            <div className="zk-term-status-valid">&gt; STATUS: ██████████████████ VALID ✓</div>
          </div>
        )}
        {mode === 'error' && proofError && (
          <div className="zk-term-text zk-term-text--err">
            <div>&gt; ERROR: PROOF GENERATION FAILED</div>
            <div className="zk-term-err-msg">{proofError}</div>
            <div className="zk-term-cursor-line">
              &gt; <span className="zk-term-cursor zk-term-cursor--err" />
            </div>
            <button type="button" className="zk-proof-retry-btn" onClick={onRetryProof}>
              ↩ RETRY PROOF GENERATION
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PirateCharacter({
  side,
  animation,
  accentColor,
}: {
  side: 'left' | 'right';
  animation: SpriteAnim;
  accentColor: string;
}) {
  const attackX = side === 'right' ? [0, -30, 0] : [0, 30, 0];
  const variants: Variants = {
    idle: { y: [0, -4, 0], transition: { duration: 2, repeat: Infinity, ease: 'easeInOut' } },
    attack: { x: attackX, transition: { duration: 0.6, times: [0, 0.55, 1], ease: ['easeOut', 'easeIn'] } },
    hit: {
      opacity: [1, 0.2, 1, 0.2, 1, 0.2, 1],
      x: [0, -8, 8, -4, 4, 0],
      transition: { duration: 0.3 },
    },
    block: { scale: [1, 1.15, 1], transition: { duration: 0.25 } },
    victory: { y: [0, -20, 0], transition: { duration: 0.8, repeat: Infinity, ease: 'easeInOut' } },
    defeated: { rotate: 90, opacity: 0.3, y: 20, filter: 'grayscale(1)', transition: { duration: 0.6, ease: 'easeIn' } },
  };

  const victoryGlow = animation === 'victory' ? { boxShadow: '0 0 30px rgba(255, 200, 0, 0.6)' } : {};

  return (
    <motion.div
      className={`pirate-sprite ${side === 'right' ? 'pirate-sprite--mirror' : ''} ${animation === 'block' ? 'pirate-sprite--block-pulse' : ''}`}
      animate={animation}
      variants={variants}
      style={{ borderColor: accentColor, ...victoryGlow }}
    >
      <div className="pirate-hat" style={{ borderBottomColor: accentColor }} />
      <div className="pirate-body" />
      <div className="pirate-arm pirate-arm--sword" style={{ background: accentColor }} />
      <div className="pirate-legs">
        <span />
        <span />
      </div>
    </motion.div>
  );
}

function useBattlePlayback(gamePlayback: GamePlayback | null, active: boolean, userAddress: string) {
  const [ui, setUi] = useState<BattlePlaybackUi>(() => ({
    round: 0,
    segment: 'idle',
    hp1: 100,
    hp2: 100,
    p1Anim: 'idle',
    p2Anim: 'idle',
    floatText: null,
    floatTone: 'crimson',
    floatSide: null,
    showRoundTitle: false,
    roundTitleText: '',
    p1AtkCard: false,
    p1DefCard: false,
    p2AtkCard: false,
    p2DefCard: false,
    narration: null,
    exchangeFlash: false,
    vignetteHit: false,
    showWinnerOverlay: false,
    showEndTable: false,
    showEndButtons: false,
    outcome: null,
  }));

  const runIdRef = useRef(0);

  useEffect(() => {
    if (!active || !gamePlayback?.turn_results?.length) return;
    const runId = ++runIdRef.current;
    const timers: number[] = [];
    const q = (ms: number, fn: () => void) => {
      timers.push(
        window.setTimeout(() => {
          if (runId !== runIdRef.current) return;
          fn();
        }, ms)
      );
    };

    const turns = gamePlayback.turn_results;
    const isDraw = gamePlayback.is_draw;
    const wStr = gamePlayback.winner?.toString?.() ?? '';
    let outcome: 'win' | 'loss' | 'draw' = 'draw';
    if (isDraw) outcome = 'draw';
    else if (isLocalPlayer(wStr, userAddress)) outcome = 'win';
    else outcome = 'loss';

    const isP1Local = isLocalPlayer(gamePlayback.player1, userAddress);

    let hp1 = 100;
    let hp2 = 100;
    let acc = 0;

    const scheduleRound = (r: number, tr: DetailedTurnResult) => {
      const p2dmg = Number(tr.player2_damage_taken);
      const p1dmg = Number(tr.player1_damage_taken);
      const title = ROUND_TITLES[Math.min(2, r)] ?? ROUND_TITLES[0];

      q(acc, () =>
        setUi((s) => ({
          ...s,
          round: r,
          segment: 'intro',
          showRoundTitle: true,
          roundTitleText: title,
          p1AtkCard: false,
          p1DefCard: false,
          p2AtkCard: false,
          p2DefCard: false,
          narration: null,
          floatText: null,
          floatSide: null,
          exchangeFlash: false,
          vignetteHit: false,
          p1Anim: 'idle',
          p2Anim: 'idle',
        }))
      );
      acc += TIMING.ROUND_TITLE_HOLD;

      q(acc, () => setUi((s) => ({ ...s, showRoundTitle: false })));
      acc += TIMING.ROUND_TITLE_FADEOUT + TIMING.MOVE_REVEAL_DELAY;

      const p1CardT = acc;
      q(p1CardT, () => setUi((s) => ({ ...s, segment: 'p1Reveal', p1AtkCard: true, p1DefCard: false, p2AtkCard: false, p2DefCard: false })));
      q(p1CardT + 300, () => setUi((s) => ({ ...s, p1DefCard: true })));

      const n1 = buildNarrationP1(tr, r);
      const narr1T = p1CardT + TIMING.MOVE_REVEAL_ANIM;
      q(narr1T, () => setUi((s) => ({ ...s, narration: n1 })));
      q(narr1T + TIMING.NARRATION_HOLD, () => setUi((s) => ({ ...s, narration: null })));
      acc = narr1T + TIMING.NARRATION_HOLD + TIMING.NARRATION_FADEOUT;

      q(acc, () =>
        setUi((s) => ({
          ...s,
          segment: 'p1Impact',
          p1AtkCard: false,
          p1DefCard: false,
          narration: null,
          p1Anim: 'attack',
          p2Anim: p2dmg > 0 ? 'hit' : 'block',
          floatText: p2dmg > 0 ? `-${p2dmg}` : 'BLOCKED',
          floatTone: p2dmg > 0 ? 'crimson' : 'cyan',
          floatSide: isP1Local ? 'right' : 'left',
          vignetteHit: p2dmg > 0,
        }))
      );
      acc += TIMING.ATTACK_ANIM_DURATION + TIMING.IMPACT_FLOAT_DURATION;

      q(acc, () =>
        setUi((s) => ({
          ...s,
          vignetteHit: false,
          p1Anim: 'idle',
          p2Anim: 'idle',
          floatText: null,
          floatSide: null,
        }))
      );
      acc += TIMING.BETWEEN_PLAYERS;

      const p2CardT = acc;
      q(p2CardT, () => setUi((s) => ({ ...s, segment: 'p2Reveal', p2AtkCard: true, p2DefCard: false })));
      q(p2CardT + 300, () => setUi((s) => ({ ...s, p2DefCard: true })));

      const n2 = buildNarrationP2(tr, r);
      const narr2T = p2CardT + TIMING.MOVE_REVEAL_ANIM;
      q(narr2T, () => setUi((s) => ({ ...s, narration: n2 })));
      q(narr2T + TIMING.NARRATION_HOLD, () => setUi((s) => ({ ...s, narration: null })));
      acc = narr2T + TIMING.NARRATION_HOLD + TIMING.NARRATION_FADEOUT;

      q(acc, () =>
        setUi((s) => ({
          ...s,
          segment: 'p2Impact',
          p2AtkCard: false,
          p2DefCard: false,
          narration: null,
          p2Anim: 'attack',
          p1Anim: p1dmg > 0 ? 'hit' : 'block',
          floatText: p1dmg > 0 ? `-${p1dmg}` : 'BLOCKED',
          floatTone: p1dmg > 0 ? 'crimson' : 'cyan',
          floatSide: isP1Local ? 'left' : 'right',
          vignetteHit: p1dmg > 0,
        }))
      );
      acc += TIMING.ATTACK_ANIM_DURATION + TIMING.IMPACT_FLOAT_DURATION;

      q(acc, () =>
        setUi((s) => ({
          ...s,
          vignetteHit: false,
          p1Anim: 'idle',
          p2Anim: 'idle',
          floatText: null,
          floatSide: null,
        }))
      );

      q(acc, () => setUi((s) => ({ ...s, segment: 'exchange', exchangeFlash: true })));
      acc += TIMING.EXCHANGE_FLASH_HOLD;

      q(acc, () => setUi((s) => ({ ...s, exchangeFlash: false })));

      hp1 = Number(tr.player1_hp_remaining);
      hp2 = Number(tr.player2_hp_remaining);

      q(acc, () =>
        setUi((s) => ({
          ...s,
          segment: 'hp',
          p2AtkCard: false,
          p2DefCard: false,
          hp1,
          hp2,
          p1Anim: hp1 <= 0 ? 'defeated' : 'idle',
          p2Anim: hp2 <= 0 ? 'defeated' : 'idle',
          floatText: null,
          floatSide: null,
        }))
      );
      acc += TIMING.HP_BAR_ANIM;

      if (r < 2) acc += TIMING.BETWEEN_ROUNDS;
    };

    turns.slice(0, 3).forEach((tr, r) => scheduleRound(r, tr));

    q(acc, () =>
      setUi((s) => {
        const w = gamePlayback.winner?.toString?.() ?? '';
        const p1w = !isDraw && w === gamePlayback.player1;
        const p2w = !isDraw && w === gamePlayback.player2;
        return {
          ...s,
          segment: 'winner',
          showWinnerOverlay: true,
          outcome,
          p1Anim: p1w ? 'victory' : p2w ? 'defeated' : 'idle',
          p2Anim: p2w ? 'victory' : p1w ? 'defeated' : 'idle',
        };
      })
    );
    acc += TIMING.WINNER_REVEAL_DELAY;

    q(acc, () => setUi((s) => ({ ...s, showEndTable: true })));
    acc += 500;

    q(acc, () => setUi((s) => ({ ...s, showEndButtons: true })));

    return () => {
      runIdRef.current++;
      timers.forEach((id) => clearTimeout(id));
    };
  }, [active, gamePlayback, userAddress]);

  return { ui };
}

function stellarExplorerContractUrl(contractId: string) {
  const net = NETWORK === 'testnet' ? 'testnet' : 'public';
  return `https://stellar.expert/explorer/${net}/contract/${contractId}`;
}

type Props = {
  userAddress: string;
  clashService: ClashGameService;
  smartAccountService: SmartAccountService;
  fastSigning: boolean;
  hasActiveSessionKey?: boolean;
  sessionExpiresLedger?: number | null;
  onCreateSessionKey?: () => void | Promise<void>;
  onClearSessionKey?: () => void;
  fastSigningBusy?: boolean;
  onSessionKeyActivated?: () => void;
  onSessionIdChange?: (sid: number) => void;
  /** Global points from PointsTracker contract (`get_points`). */
  sessionTotalPoints?: number | null;
  sessionPointsLoading?: boolean;
  sessionPointsError?: boolean;
  onRefreshSessionPoints?: () => void;
  onBattleResolved?: () => void;
};

const CLASH_SESSION_ONBOARDING_KEY = 'clash_session_onboarding_seen';

function parsePoints(value: string): bigint | null {
  try {
    const cleaned = value.replace(/[^\d.]/g, '');
    if (!cleaned || cleaned === '.') return null;
    const [whole = '0', fraction = ''] = cleaned.split('.');
    const paddedFraction = fraction.padEnd(POINTS_DECIMALS, '0').slice(0, POINTS_DECIMALS);
    return BigInt(whole + paddedFraction);
  } catch {
    return null;
  }
}

function createRandomSessionId(): number {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    let value = 0;
    const buffer = new Uint32Array(1);
    while (value === 0) {
      crypto.getRandomValues(buffer);
      value = buffer[0];
    }
    return value;
  }
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
}

function toBuffer(arr: Uint8Array): Buffer {
  return Buffer.from(arr);
}

function toContractMoves(moves: SelectedMove[]): Move[] {
  return moves.map((m) => ({ attack: m.attack as Attack, defense: m.defense as Defense }));
}

function storageKeyPublicInputs(sid: number, addr: string) {
  return `clash_zk_public_${sid}_${addr}`;
}

function storageKeyMoves(sid: number, addr: string) {
  return `clash_zk_moves_${sid}_${addr}`;
}

function allMovesComplete(moves: SelectedMove[]) {
  return moves.every((m) => m.attack !== null && m.defense !== null);
}

function formatTrackerPointsDisplay(raw: number | null | undefined): string {
  if (raw === null || raw === undefined) return '--';
  if (!Number.isFinite(raw)) return '--';
  return Math.round(raw).toLocaleString();
}

export function ClashZkArena({
  userAddress,
  clashService,
  smartAccountService,
  fastSigning,
  hasActiveSessionKey = false,
  onCreateSessionKey,
  fastSigningBusy = false,
  onSessionKeyActivated,
  onSessionIdChange,
  sessionTotalPoints = null,
  sessionPointsLoading = false,
  sessionPointsError = false,
  onRefreshSessionPoints,
  onBattleResolved,
}: Props) {
  const noir = useRef(new NoirService());
  const [phase, setPhase] = useState<ZkPhase>('create');
  const [sessionId, setSessionId] = useState(() => createRandomSessionId());
  const [gameState, setGameState] = useState<Game | null>(null);
  const [gamePlayback, setGamePlayback] = useState<GamePlayback | null>(null);
  const [opponentUsername, setOpponentUsername] = useState('');
  const [allChallenges, setAllChallenges] = useState<{
    active: Challenge[];
    completed: Challenge[];
    expired: Challenge[];
  }>({ active: [], completed: [], expired: [] });
  const [challengeUsernames, setChallengeUsernames] = useState<Record<string, string | null>>({});
  const [challengeOutcomes, setChallengeOutcomes] = useState<Record<number, 'win' | 'loss' | 'draw' | 'unknown'>>({});
  const [challengesLoading, setChallengesLoading] = useState(false);
  const [pointsStr, setPointsStr] = useState(DEFAULT_POINTS);
  const [loadSessionId, setLoadSessionId] = useState('');
  const [selectedMoves, setSelectedMoves] = useState<SelectedMove[]>(() => createEmptyMoves());
  const [storedPublicInputs, setStoredPublicInputs] = useState<Uint8Array | null>(null);
  const [proofBundle, setProofBundle] = useState<ClashProofResult | null>(null);
  const [proofMovesKey, setProofMovesKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** True only while `handleStartGame` is awaiting (for START DUEL button spinner). */
  const [startingDuel, setStartingDuel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [criticalError, setCriticalError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [proofPulse, setProofPulse] = useState<'idle' | 'success' | 'failed'>('idle');
  const [burstTurn, setBurstTurn] = useState<number | null>(null);
  const [defenseHintPulse, setDefenseHintPulse] = useState<{ turn: number; defense: number } | null>(null);
  const [forgingLine, setForgingLine] = useState(0);
  const [showOnboardingDialog, setShowOnboardingDialog] = useState(false);
  const [sessionKeyToast, setSessionKeyToast] = useState(false);
  const [commitPhase, setCommitPhase] = useState<CommitPhase>('idle');
  const [commitTxError, setCommitTxError] = useState<string | null>(null);
  const [oppRevealToast, setOppRevealToast] = useState(false);
  const [waitingRevealFlash, setWaitingRevealFlash] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const [gameStateSyncing, setGameStateSyncing] = useState(false);
  const wasWaitingForOppRevealRef = useRef(false);

  const battlePlayback = useBattlePlayback(gamePlayback, phase === 'complete' && Boolean(gamePlayback), userAddress);

  useEffect(() => {
    const id = window.setInterval(() => setPollTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (hasActiveSessionKey) setShowOnboardingDialog(false);
  }, [hasActiveSessionKey]);

  useEffect(() => {
    try {
      if (hasActiveSessionKey) return;
      if (typeof localStorage === 'undefined') return;
      if (localStorage.getItem(CLASH_SESSION_ONBOARDING_KEY)) return;
      setShowOnboardingDialog(true);
    } catch {
      /* ignore */
    }
  }, [hasActiveSessionKey]);

  useEffect(() => {
    if (commitPhase !== 'proving') {
      setForgingLine(0);
      return;
    }
    const id = window.setInterval(() => {
      setForgingLine((i) => (i + 1) % FORGING_BUTTON_LINES.length);
    }, 2400);
    return () => clearInterval(id);
  }, [commitPhase]);

  const loadPublicInputs = (sid: number, addr: string): Uint8Array | null => {
    try {
      const b64 = localStorage.getItem(storageKeyPublicInputs(sid, addr));
      if (!b64) return null;
      const binary = atob(b64);
      return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
    } catch {
      return null;
    }
  };

  const savePublicInputs = (sid: number, addr: string, inputs: Uint8Array) => {
    try {
      const b64 = btoa(String.fromCharCode(...inputs));
      localStorage.setItem(storageKeyPublicInputs(sid, addr), b64);
    } catch {
      /* ignore */
    }
  };

  const clearPublicInputs = (sid: number, addr: string) => {
    try {
      localStorage.removeItem(storageKeyPublicInputs(sid, addr));
    } catch {
      /* ignore */
    }
  };

  const loadMovesFromStorage = (sid: number, addr: string): SelectedMove[] => {
    try {
      const raw = localStorage.getItem(storageKeyMoves(sid, addr));
      if (!raw) return createEmptyMoves();
      return JSON.parse(raw) as SelectedMove[];
    } catch {
      return createEmptyMoves();
    }
  };

  const lastPointsRegisteredSessionRef = useRef<number | null>(null);

  useEffect(() => {
    if (!gameState?.player1 || !gameState?.player2) return;
    if (lastPointsRegisteredSessionRef.current === sessionId) return;
    lastPointsRegisteredSessionRef.current = sessionId;
    void registerDuelParticipants(gameState.player1, gameState.player2);
  }, [sessionId, gameState?.player1, gameState?.player2]);

  const loadGameState = useCallback(async () => {
    setGameStateSyncing(true);
    try {
      const game = await clashService.getGame(sessionId);
      if (!game) return;
      setGameState(game);
      setLastSyncedAt(Date.now());
      const p1c = game.has_player1_commitment;
      const p2c = game.has_player2_commitment;
      const p1r = game.player1_commitment?.has_revealed ?? false;
      const p2r = game.player2_commitment?.has_revealed ?? false;
      const hasBattle = game.has_battle_result;
      const isP1 = game.player1 === userAddress;
      const isP2 = game.player2 === userAddress;
      const myCommitted = isP1 ? p1c : isP2 ? p2c : false;

      if (hasBattle) {
        setPhase('complete');
        const pb = await clashService.getGamePlayback(sessionId);
        if (pb) setGamePlayback(pb);
      } else if (p1r && p2r) {
        setPhase('resolve');
      } else if (p1c && p2c) {
        setPhase('reveal');
      } else if (myCommitted) {
        setPhase('waiting_reveal');
      } else {
        setPhase('commit');
      }
      const stored = loadPublicInputs(sessionId, userAddress);
      if (stored) setStoredPublicInputs(stored);
    } catch {
      /* ignore */
    } finally {
      setGameStateSyncing(false);
    }
  }, [clashService, sessionId, userAddress]);

  useEffect(() => {
    onSessionIdChange?.(sessionId);
  }, [sessionId, onSessionIdChange]);

  useEffect(() => {
    if (phase === 'create' || phase === 'complete') return;
    const id = window.setInterval(() => void loadGameState(), 4000);
    return () => window.clearInterval(id);
  }, [phase, loadGameState]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKeyMoves(sessionId, userAddress), JSON.stringify(selectedMoves));
    } catch {
      /* ignore */
    }
  }, [selectedMoves, sessionId, userAddress]);

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
    if (phase !== 'create') return;
    void loadChallenges();
    const id = window.setInterval(() => void loadChallenges(), 8000);
    return () => window.clearInterval(id);
  }, [phase, loadChallenges]);

  const handleAcceptChallenge = async (challengeId: number) => {
    setBusy(true);
    try {
      const sid = createRandomSessionId();
      await clashService.acceptChallengeWithSmartAccount(challengeId, userAddress, sid, smartAccountService);
      setSessionId(sid);
      const acceptedGame = await clashService.getGame(sid);
      if (acceptedGame) {
        setGameState(acceptedGame);
      }
      setPhase('commit');
      setSuccess('Challenge accepted. Duel started.');
      await loadChallenges();
    } catch (e) {
      setCriticalError(e instanceof Error ? e.message : 'Failed to accept challenge');
    } finally {
      setBusy(false);
    }
  };

  const handleLoadSession = async () => {
    setError(null);
    const sid = parseInt(loadSessionId.trim(), 10);
    if (Number.isNaN(sid) || sid <= 0) {
      setError('Enter a valid session ID');
      return;
    }
    setBusy(true);
    try {
      const game = await clashService.getGame(sid);
      if (!game) return setError('Game not found');
      if (game.player1 !== userAddress && game.player2 !== userAddress) {
        return setError('You are not a player in this game');
      }
      setSessionId(sid);
      const loaded = loadMovesFromStorage(sid, userAddress);
      setSelectedMoves(loaded);
      setStoredPublicInputs(loadPublicInputs(sid, userAddress));
      setProofBundle(null);
      setProofMovesKey(null);
      setCommitPhase('idle');
      setCommitTxError(null);
      setGameState(game);
      setLoadSessionId('');
      if (game.has_battle_result) {
        setPhase('complete');
        const pb = await clashService.getGamePlayback(sid);
        if (pb) setGamePlayback(pb);
      } else if (game.player1_commitment?.has_revealed && game.player2_commitment?.has_revealed) {
        setPhase('resolve');
      } else if (game.has_player1_commitment && game.has_player2_commitment) {
        setPhase('reveal');
      } else {
        setPhase('commit');
      }
      recordSessionLoadActivity({ sessionId: sid });
      setSuccess('Session loaded');
      await loadGameState();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load game');
    } finally {
      setBusy(false);
    }
  };

  const openSessionFromHistory = async (sid: number) => {
    setBusy(true);
    setError(null);
    try {
      const game = await clashService.getGame(sid);
      if (!game) {
        setError('Game not found for this challenge session');
        return;
      }
      if (game.player1 !== userAddress && game.player2 !== userAddress) {
        setError('You are not a player in this challenge session');
        return;
      }
      setSessionId(sid);
      const loaded = loadMovesFromStorage(sid, userAddress);
      setSelectedMoves(loaded);
      setStoredPublicInputs(loadPublicInputs(sid, userAddress));
      setProofBundle(null);
      setProofMovesKey(null);
      setCommitPhase('idle');
      setCommitTxError(null);
      setGameState(game);
      if (game.has_battle_result) {
        setPhase('complete');
        const pb = await clashService.getGamePlayback(sid);
        if (pb) setGamePlayback(pb);
      } else if (game.player1_commitment?.has_revealed && game.player2_commitment?.has_revealed) {
        setPhase('resolve');
      } else if (game.has_player1_commitment && game.has_player2_commitment) {
        setPhase('reveal');
      } else {
        const isP1 = game.player1 === userAddress;
        const hasMyCommit = isP1 ? game.has_player1_commitment : game.has_player2_commitment;
        setPhase(hasMyCommit ? 'waiting_reveal' : 'commit');
      }
      setSuccess(`Loaded challenge session #${sid}`);
      await loadGameState();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load challenge session');
    } finally {
      setBusy(false);
    }
  };

  const movesKey = useMemo(() => JSON.stringify(selectedMoves.map((m) => [m.attack, m.defense])), [selectedMoves]);
  const proofMatchesMoves = Boolean(proofBundle && proofMovesKey === movesKey);

  const handleForgeAndCommit = async () => {
    if (!allMovesComplete(selectedMoves)) return setError('Fill attack and defense for all 3 turns.');
    setCommitTxError(null);
    setError(null);
    setBusy(true);
    setCommitPhase('proving');
    let proofResult: ClashProofResult;
    try {
      const attacks = selectedMoves.map((m) => m.attack!) as [number, number, number];
      const defenses = selectedMoves.map((m) => m.defense!) as [number, number, number];
      proofResult = await noir.current.generateClashProof('duel_commit_circuit', {
        attacks,
        defenses,
        playerAddress: userAddress,
        sessionId,
      });
    } catch (e) {
      setProofPulse('failed');
      setCommitPhase('proof-error');
      setError(e instanceof Error ? e.message : 'Proof generation failed');
      setProofBundle(null);
      setProofMovesKey(null);
      setBusy(false);
      setTimeout(() => setProofPulse('idle'), 600);
      return;
    }

    const nextKey = JSON.stringify(selectedMoves.map((m) => [m.attack, m.defense]));
    setProofBundle(proofResult);
    setProofMovesKey(nextKey);
    setProofPulse('success');
    setTimeout(() => setProofPulse('idle'), 600);

    setCommitPhase('committing');
    try {
      await clashService.commitMovesWithSmartAccount(
        sessionId,
        userAddress,
        proofResult.publicInputs,
        proofResult.proofBytes,
        smartAccountService
      );
      savePublicInputs(sessionId, userAddress, proofResult.publicInputs);
      setStoredPublicInputs(proofResult.publicInputs);
      setCommitPhase('done');
      setPhase('waiting_reveal');
      setSuccess('Commit confirmed. Waiting for reveal phase.');
      await loadGameState();
    } catch (e) {
      setCommitPhase('commit-error');
      setCommitTxError(e instanceof Error ? e.message : 'Commit failed');
    } finally {
      setBusy(false);
    }
  };

  const handleRetryCommitOnly = async () => {
    if (!proofBundle || !proofMatchesMoves) return setError('Proof does not match current moves.');
    setCommitTxError(null);
    setBusy(true);
    setCommitPhase('committing');
    try {
      await clashService.commitMovesWithSmartAccount(
        sessionId,
        userAddress,
        proofBundle.publicInputs,
        proofBundle.proofBytes,
        smartAccountService
      );
      savePublicInputs(sessionId, userAddress, proofBundle.publicInputs);
      setStoredPublicInputs(proofBundle.publicInputs);
      setCommitPhase('done');
      setPhase('waiting_reveal');
      setSuccess('Commit confirmed. Waiting for reveal phase.');
      await loadGameState();
    } catch (e) {
      setCommitPhase('commit-error');
      setCommitTxError(e instanceof Error ? e.message : 'Commit failed');
    } finally {
      setBusy(false);
    }
  };

  const handleReveal = async () => {
    if (!storedPublicInputs) return setError('Missing commit public inputs from this browser.');
    setBusy(true);
    try {
      await clashService.revealMovesWithSmartAccount(
        sessionId,
        userAddress,
        toBuffer(storedPublicInputs),
        toContractMoves(selectedMoves),
        smartAccountService
      );
      clearPublicInputs(sessionId, userAddress);
      setSuccess('Moves revealed.');
      await loadGameState();
    } catch (e) {
      setCriticalError(e instanceof Error ? e.message : 'Reveal failed');
    } finally {
      setBusy(false);
    }
  };

  const handleResolve = async () => {
    setBusy(true);
    try {
      await clashService.resolveBattleWithSmartAccount(sessionId, smartAccountService);
      const pb = await clashService.getGamePlayback(sessionId);
      if (pb) setGamePlayback(pb);
      setPhase('complete');
      setSuccess('Battle resolved.');
      onBattleResolved?.();
    } catch (e) {
      setCriticalError(e instanceof Error ? e.message : 'Resolve failed');
    } finally {
      setBusy(false);
    }
  };

  const handleReset = () => {
    if (sessionId && userAddress) {
      clearPublicInputs(sessionId, userAddress);
      localStorage.removeItem(storageKeyMoves(sessionId, userAddress));
    }
    setPhase('create');
    setSessionId(createRandomSessionId());
    setGameState(null);
    setGamePlayback(null);
    setSelectedMoves(createEmptyMoves());
    setStoredPublicInputs(null);
    setProofBundle(null);
    setProofMovesKey(null);
    setError(null);
    setSuccess(null);
    setCommitPhase('idle');
    setCommitTxError(null);
  };

  const myStep = useMemo(() => {
    if (phase === 'create') return 0;
    if (phase === 'commit') {
      const step2 =
        commitPhase === 'proving' ||
        commitPhase === 'committing' ||
        commitPhase === 'done' ||
        commitPhase === 'commit-error' ||
        Boolean(proofBundle);
      return step2 ? 2 : 1;
    }
    if (phase === 'waiting_reveal') return 3;
    if (phase === 'reveal') return 4;
    return 5;
  }, [phase, proofBundle, commitPhase]);

  const syncLabel = useMemo(() => {
    if (!lastSyncedAt) return '—';
    return `${Math.max(0, Math.floor((Date.now() - lastSyncedAt) / 1000))}s ago`;
  }, [lastSyncedAt, pollTick]);

  const strategyLabel = useMemo(() => {
    const attacks = selectedMoves.map((m) => m.attack).filter((v): v is number => v !== null);
    const cannonCount = attacks.filter((a) => a === Attack.Fireball).length;
    const lowDamageCount = attacks.filter((a) => a === Attack.Slash || a === Attack.Lightning).length;
    if (cannonCount > lowDamageCount) return { text: '⚔ AGGRESSIVE CAPTAIN', cls: 'atk' };
    if (lowDamageCount > cannonCount) return { text: '🛡 DEFENSIVE CAPTAIN', cls: 'def' };
    return { text: '⚖ CUNNING STRATEGIST', cls: 'bal' };
  }, [selectedMoves]);

  const comboPreview = useMemo(() => {
    const attacks = selectedMoves.map((m) => m.attack);
    if (attacks.some((a) => a === null)) return null;
    if (attacks[0] === attacks[1] && attacks[1] === attacks[2]) {
      const move = ATTACK_MOVES.find((m) => m.index === attacks[0]);
      return { text: `${move?.icon} TRIPLE ${move?.name.toUpperCase()} +25 BONUS DMG`, cls: 'triple' };
    }
    if (attacks[0] === attacks[1] || attacks[1] === attacks[2]) {
      const idx = attacks[0] === attacks[1] ? attacks[0] : attacks[1];
      const move = ATTACK_MOVES.find((m) => m.index === idx);
      return { text: `${move?.icon} ${move?.name.toUpperCase()} COMBO x2 +10 BONUS DMG`, cls: 'double' };
    }
    return null;
  }, [selectedMoves]);

  const selectAttack = (turn: number, attackIdx: number) => {
    const next = [...selectedMoves];
    const wasComplete = next[turn].attack !== null && next[turn].defense !== null;
    next[turn] = { ...next[turn], attack: attackIdx };
    setSelectedMoves(next);
    const nowComplete = next[turn].attack !== null && next[turn].defense !== null;
    if (!wasComplete && nowComplete) {
      setBurstTurn(turn);
      setTimeout(() => setBurstTurn(null), 400);
    }
    const counterDefense = COUNTER_DEFENSE_BY_ATTACK[attackIdx];
    setDefenseHintPulse({ turn, defense: counterDefense });
    setTimeout(() => setDefenseHintPulse(null), 600);
  };

  const selectDefense = (turn: number, defenseIdx: number) => {
    const next = [...selectedMoves];
    const wasComplete = next[turn].attack !== null && next[turn].defense !== null;
    next[turn] = { ...next[turn], defense: defenseIdx };
    setSelectedMoves(next);
    const nowComplete = next[turn].attack !== null && next[turn].defense !== null;
    if (!wasComplete && nowComplete) {
      setBurstTurn(turn);
      setTimeout(() => setBurstTurn(null), 400);
    }
  };

  const movesReady = allMovesComplete(selectedMoves);
  const proofLoading = commitPhase === 'proving';
  const p1r = gameState?.player1_commitment?.has_revealed ?? false;
  const p2r = gameState?.player2_commitment?.has_revealed ?? false;
  const imP1 = gameState?.player1 === userAddress;
  const myRevealed = imP1 ? p1r : gameState?.player2 === userAddress ? p2r : false;
  const bothRevealed = p1r && p2r;

  const movesLocked = useMemo(() => {
    if (phase === 'waiting_reveal') return true;
    if (phase !== 'commit') return false;
    if (commitPhase === 'proving' || commitPhase === 'committing' || commitPhase === 'done') return true;
    if (commitPhase === 'commit-error' && proofBundle) return true;
    return Boolean(proofBundle && proofMatchesMoves);
  }, [phase, commitPhase, proofBundle, proofMatchesMoves]);

  useEffect(() => {
    if (phase === 'reveal' && myRevealed && !bothRevealed) {
      wasWaitingForOppRevealRef.current = true;
    }
  }, [phase, myRevealed, bothRevealed]);

  useEffect(() => {
    if (phase === 'resolve' && wasWaitingForOppRevealRef.current) {
      wasWaitingForOppRevealRef.current = false;
      setWaitingRevealFlash(true);
      setOppRevealToast(true);
      const t = window.setTimeout(() => setOppRevealToast(false), 3000);
      const t2 = window.setTimeout(() => setWaitingRevealFlash(false), 400);
      return () => {
        clearTimeout(t);
        clearTimeout(t2);
      };
    }
  }, [phase]);

  const battleCryBtnClass = [
    'battle-cry-btn',
    !movesReady ? 'battle-cry-btn--locked' : '',
    movesReady && commitPhase === 'idle' && !proofLoading ? 'battle-cry-btn--ready' : '',
    proofLoading ? 'battle-cry-btn--loading' : '',
    commitPhase === 'committing' ? 'battle-cry-btn--committing' : '',
    commitPhase === 'proof-error' || commitPhase === 'commit-error' ? 'battle-cry-btn--proof-fail' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const explorerHref = stellarExplorerContractUrl(CLASH_CONTRACT || '');
  const sortedChallenges = useMemo(
    () => [...allChallenges.active, ...allChallenges.completed, ...allChallenges.expired].sort((a, b) => Number(b.created_at) - Number(a.created_at)),
    [allChallenges]
  );
  const incomingPendingChallenges = useMemo(
    () => allChallenges.active.filter((c) => c.challenged === userAddress && !c.is_accepted),
    [allChallenges.active, userAddress]
  );

  const finishOnboardingSeen = () => {
    try {
      localStorage.setItem(CLASH_SESSION_ONBOARDING_KEY, '1');
    } catch {
      /* ignore */
    }
    setShowOnboardingDialog(false);
  };

  const handleOnboardingCreateKey = async () => {
    if (!onCreateSessionKey) return;
    try {
      await onCreateSessionKey();
      finishOnboardingSeen();
      onSessionKeyActivated?.();
      setSessionKeyToast(true);
      window.setTimeout(() => setSessionKeyToast(false), 2500);
    } catch {
      /* keep dialog open on failure */
    }
  };

  const handleOnboardingSkip = () => {
    finishOnboardingSeen();
  };

  return (
    <div className="duel-shell">
      {sessionKeyToast && (
        <motion.div
          initial={{ y: -24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ opacity: 0 }}
          className="clash-session-toast"
        >
          ⚡ SESSION KEY ACTIVE — ENTER THE ARENA
        </motion.div>
      )}
      {oppRevealToast && (
        <motion.div
          initial={{ y: -24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ opacity: 0 }}
          className="clash-opp-reveal-toast"
        >
          ⚔ Opponent revealed — RESOLVE THE BATTLE
        </motion.div>
      )}
      {showOnboardingDialog && (
        <div className="clash-onboarding-backdrop" role="presentation">
          <motion.div
            className="clash-onboarding-dialog"
            initial={{ scale: 0.92, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
            role="dialog"
            aria-labelledby="clash-onboarding-title"
          >
            <h2 id="clash-onboarding-title" className="clash-onboarding-title">
              ⚡ BEFORE YOU ENTER THE ARENA
            </h2>
            <p className="clash-onboarding-body">
              Create a Session Key to sign game transactions without a passkey prompt every move.
            </p>
            <p className="clash-onboarding-bullet">● Scoped only to the Clash contract</p>
            <p className="clash-onboarding-bullet">● Stored locally — never leaves your device</p>
            <p className="clash-onboarding-bullet">● Expires automatically after this session</p>
            <button
              type="button"
              className="clash-onboarding-primary"
              disabled={fastSigningBusy}
              onClick={() => void handleOnboardingCreateKey()}
            >
              {fastSigningBusy ? (
                <>
                  <Loader2 className="clash-onboarding-btn-spinner" size={18} aria-hidden />
                  Creating session key…
                </>
              ) : (
                '⚡ CREATE SESSION KEY — ENTER THE ARENA'
              )}
            </button>
            <button type="button" className="clash-onboarding-skip" onClick={handleOnboardingSkip}>
              Skip for now — I&apos;ll sign each tx manually
            </button>
          </motion.div>
        </div>
      )}
      {criticalError && (
        <motion.div initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="critical-banner">
          <ShieldAlert size={16} /> {criticalError}
          <button type="button" onClick={() => setCriticalError(null)}>
            Dismiss
          </button>
        </motion.div>
      )}

      {phase !== 'complete' && (
        <>
          <div className="arena-stepper">
            {STEP_KEYS.map((step, idx) => {
              const stepNo = idx + 1;
              const done = stepNo < myStep;
              const active = stepNo === myStep;
              const locked = stepNo > myStep;
              return (
                <div key={step} className={`step-node ${active ? 'active' : ''} ${done ? 'done' : ''} ${locked ? 'locked' : ''}`}>
                  <span>{done ? '✓' : stepNo}</span>
                  <label>{step.toUpperCase()}</label>
                  {locked && <Lock size={12} />}
                </div>
              );
            })}
          </div>

          <div
            className={`sync-row ${gameStateSyncing || fastSigningBusy ? 'sync-row--busy' : ''}`}
          >
            <span className="sync-row-left">
              {fastSigningBusy ? (
                <>
                  <Loader2 className="sync-row-spinner" size={14} aria-hidden />
                  Creating session key…
                </>
              ) : gameStateSyncing ? (
                <>
                  <Loader2 className="sync-row-spinner" size={14} aria-hidden />
                  Syncing…
                </>
              ) : (
                <>Synced {syncLabel}</>
              )}
            </span>
            <span className={fastSigningBusy ? 'fast-on' : fastSigning ? 'fast-on' : 'fast-off'}>
              {fastSigningBusy ? 'Session key…' : fastSigning ? 'Fast Sign Active' : 'Passkey Sign'}
            </span>
          </div>
        </>
      )}

      {phase === 'create' && (
        <motion.div initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="duel-setup-grid">
          <section className="arena-card">
            <h3>Challenge by Username</h3>
            <label>Stake / Points</label>
            <div className="field-with-unit">
              <input value={pointsStr} onChange={(e) => setPointsStr(e.target.value)} placeholder="0.1" />
              <span>XLM</span>
            </div>
            <label>Opponent Username</label>
            <input value={opponentUsername} onChange={(e) => setOpponentUsername(e.target.value)} placeholder="captain_name" />
            {error && <p className="inline-error">{error}</p>}
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
            <h3>Incoming Challenges</h3>
            {!challengesLoading && incomingPendingChallenges.length === 0 && <p className="mono dim">No active challenges</p>}
            {incomingPendingChallenges.map((challenge) => {
              const challengerUsername = challengeUsernames[challenge.challenger];
              const challengerLabel = challengerUsername ? `@${challengerUsername}` : truncateAddr(challenge.challenger);

              return (
                <div key={`${challenge.challenge_id}-${challenge.challenger}`} className="status-pill warning" style={{ marginBottom: 10 }}>
                  <span>From {challengerLabel} for {Number(challenge.points_wagered) / 10_0000000} XLM</span>
                  <button
                    type="button"
                    className="btn-arena-secondary"
                    style={{ marginLeft: 8 }}
                    disabled={busy}
                    onClick={() => void handleAcceptChallenge(Number(challenge.challenge_id))}
                  >
                    Accept
                  </button>
                </div>
              );
            })}
          </section>
          <section className="arena-card">
            <h3>Challenge History</h3>
            {!challengesLoading && sortedChallenges.length === 0 && <p className="mono dim">No challenges yet</p>}
            {sortedChallenges.map((challenge) => {
              const isIncoming = challenge.challenged === userAddress;
              const otherAddress = isIncoming ? challenge.challenger : challenge.challenged;
              const otherUsername = challengeUsernames[otherAddress];
              const status = challenge.is_accepted ? 'Accepted' : challenge.is_completed ? 'Completed' : 'Pending';
              const statusClass = challenge.is_accepted ? 'success' : challenge.is_completed ? 'warning' : 'warning';
              const sessionId = challenge.session_id == null ? null : Number(challenge.session_id);
              const canEnterSession = challenge.is_accepted && !challenge.is_completed && sessionId !== null;
              const completedOutcome = sessionId != null ? challengeOutcomes[sessionId] : undefined;
              const concludedLabel = completedOutcome === 'win'
                ? 'Won'
                : completedOutcome === 'loss'
                  ? 'Lost'
                  : completedOutcome === 'draw'
                    ? 'Draw'
                    : 'Concluded';
              return (
                <button
                  key={`history-${challenge.challenge_id}`}
                  type="button"
                  className={`status-pill ${statusClass} challenge-history-item ${canEnterSession ? 'challenge-history-item--link' : ''}`}
                  onClick={() => {
                    if (canEnterSession && sessionId !== null) {
                      void openSessionFromHistory(sessionId);
                    }
                  }}
                  disabled={busy || !canEnterSession}
                  title={canEnterSession ? 'Enter this active challenge session' : 'Session unavailable'}
                >
                  <div className="challenge-history-row">
                    <strong>{isIncoming ? 'From' : 'To'} {otherUsername ? `@${otherUsername}` : truncateAddr(otherAddress)}</strong>
                    <span>
                      {challenge.is_completed ? (
                        <>
                          Concluded{' '}
                          <span
                            className={`challenge-history-outcome ${
                              completedOutcome === 'win'
                                ? 'challenge-history-outcome--win'
                                : completedOutcome === 'loss'
                                  ? 'challenge-history-outcome--loss'
                                  : completedOutcome === 'draw'
                                    ? 'challenge-history-outcome--draw'
                                    : ''
                            }`}
                          >
                            {concludedLabel}
                          </span>
                        </>
                      ) : canEnterSession ? (
                        `${status} · Enter`
                      ) : (
                        status
                      )}
                    </span>
                  </div>
                  <div className="challenge-history-meta">
                    <span>Wager: {Number(challenge.points_wagered) / 10_0000000} XLM</span>
                    <span>ID: {Number(challenge.challenge_id)}</span>
                    <span>Session: {sessionId === null ? '—' : sessionId}</span>
                  </div>
                </button>
              );
            })}
          </section>
          <section className="arena-card">
            <h3>Rejoin Arena</h3>
            <label>Session ID</label>
            <input value={loadSessionId} onChange={(e) => setLoadSessionId(e.target.value)} placeholder="3533712123" />
            <button className="btn-arena-secondary" disabled={busy} onClick={() => void handleLoadSession()}>
              ↩ LOAD SESSION
            </button>
          </section>
        </motion.div>
      )}

      {phase !== 'create' && phase !== 'complete' && (
        <AnimatePresence mode="wait">
          <motion.div
            key={phase}
            initial={{ x: 30, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -30, opacity: 0 }}
            transition={{ duration: 0.28 }}
            className="arena-card"
          >
            {(phase === 'commit' || phase === 'waiting_reveal') && (
              <>
                <h3>Pick Your Moves</h3>
                <div className="turn-grid">
                  {selectedMoves.map((m, i) => {
                    const complete = m.attack !== null && m.defense !== null;
                    const partial = (m.attack !== null) !== (m.defense !== null);
                    return (
                      <motion.div
                        key={i}
                        initial={{ y: 20, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        transition={{ duration: 0.3, delay: i * 0.08 }}
                        className={`turn-card ${complete ? 'complete' : partial ? 'partial' : 'empty'} ${movesLocked ? 'proof-locked' : ''}`}
                        title={movesLocked ? 'Moves are locked for this step' : ''}
                      >
                        <strong>TURN {i + 1}</strong>
                        <div className={`row-label ${m.attack === null ? 'muted' : ''}`}>
                          ⚔ ATTACK {m.attack === null ? '(Pick attack)' : ''}
                        </div>
                        <div className="move-card-row">
                          {ATTACK_MOVES.map((atk) => (
                            <motion.button
                              key={`atk-${i}-${atk.index}`}
                              type="button"
                              whileHover={{ scale: 1.06 }}
                              animate={m.attack === atk.index ? { scale: [1, 1.1, 1] } : undefined}
                              transition={{ duration: 0.2 }}
                              disabled={movesLocked || busy || phase === 'waiting_reveal'}
                              onClick={() => selectAttack(i, atk.index)}
                              className={`move-choice attack ${m.attack === atk.index ? 'selected' : ''}`}
                            >
                              <span className="icon">{atk.icon}</span>
                              <span className="name">{atk.name}</span>
                              <span className="meta">{atk.damage} HP</span>
                              {m.attack === atk.index && <span className="pick-flash attack" />}
                              {movesLocked && proofBundle && (
                                <span className="mini-lock">
                                  <Lock size={10} />
                                </span>
                              )}
                            </motion.button>
                          ))}
                        </div>
                        <div className={`row-label ${m.defense === null ? 'muted pulse-amber' : ''}`}>
                          🛡 DEFENSE {m.defense === null ? '(Pick defense)' : ''}
                        </div>
                        <div className="move-card-row">
                          {DEFENSE_MOVES.map((def) => (
                            <motion.button
                              key={`def-${i}-${def.index}`}
                              type="button"
                              whileHover={{ scale: 1.06 }}
                              animate={m.defense === def.index ? { scale: [1, 1.1, 1] } : undefined}
                              transition={{ duration: 0.2 }}
                              disabled={movesLocked || busy || phase === 'waiting_reveal'}
                              onClick={() => selectDefense(i, def.index)}
                              className={`move-choice defense ${m.defense === def.index ? 'selected' : ''} ${
                                defenseHintPulse?.turn === i && defenseHintPulse.defense === def.index ? 'hint-pulse' : ''
                              }`}
                            >
                              <span className="icon">{def.icon}</span>
                              <span className="name">{def.label}</span>
                              <span className="meta">stops {def.stopsIcon}</span>
                              {m.defense === def.index && <span className="pick-flash defense" />}
                              {movesLocked && proofBundle && (
                                <span className="mini-lock">
                                  <Lock size={10} />
                                </span>
                              )}
                            </motion.button>
                          ))}
                        </div>
                        {complete && <span className="turn-locked">✓ LOCKED</span>}
                        {burstTurn === i && (
                          <div className="card-burst" aria-hidden="true">
                            {Array.from({ length: 6 }).map((_, k) => (
                              <i key={k} />
                            ))}
                          </div>
                        )}
                        {movesLocked && proofBundle && (
                          <div className="turn-lock-overlay">
                            <Lock size={16} /> <small>Moves locked while proof / commit is in progress</small>
                          </div>
                        )}
                      </motion.div>
                    );
                  })}
                </div>
                <AnimatePresence>
                  {comboPreview && (
                    <motion.div
                      key={comboPreview.text}
                      className={`combo-strip ${comboPreview.cls}`}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                    >
                      {comboPreview.text}
                    </motion.div>
                  )}
                </AnimatePresence>
                <AnimatePresence mode="wait">
                  <motion.p
                    key={strategyLabel.text}
                    layoutId="strategy-morph"
                    className={`strategy-label ${strategyLabel.cls}`}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.15 }}
                  >
                    {strategyLabel.text}
                  </motion.p>
                </AnimatePresence>
                {phase === 'commit' && (
                  <>
                    <motion.button
                      type="button"
                      className={battleCryBtnClass}
                      disabled={
                        !movesReady ||
                        busy ||
                        commitPhase === 'proving' ||
                        commitPhase === 'committing' ||
                        commitPhase === 'done'
                      }
                      onClick={() => {
                        if (commitPhase === 'commit-error') void handleRetryCommitOnly();
                        else void handleForgeAndCommit();
                      }}
                      title={!movesReady ? 'Select attack and defense for all 3 turns' : ''}
                      whileHover={
                        movesReady && commitPhase === 'idle' && !proofLoading ? { scale: 1.01 } : undefined
                      }
                    >
                      {!movesReady && (
                        <>
                          <span className="battle-cry-lock" aria-hidden>
                            🔒
                          </span>{' '}
                          SEAL YOUR FATE — LOCK MOVES
                        </>
                      )}
                      {movesReady && commitPhase === 'idle' && (
                        <>
                          <span aria-hidden>⚔</span> FORGE PROOF & COMMIT TO CHAIN
                        </>
                      )}
                      {commitPhase === 'proving' && (
                        <span className="battle-cry-loading-line">
                          {FORGING_BUTTON_LINES[forgingLine]}
                          <span className="battle-cry-type-cursor" />
                        </span>
                      )}
                      {commitPhase === 'committing' && <span>⛓ COMMITTING TO SOROBAN...</span>}
                      {commitPhase === 'proof-error' && <span>↩ PROOF FAILED — RETRY</span>}
                      {commitPhase === 'commit-error' && <span>↩ COMMIT FAILED — RETRY</span>}
                    </motion.button>
                    {commitTxError && commitPhase === 'commit-error' && (
                      <p className="commit-tx-error mono">Transaction failed: {commitTxError}</p>
                    )}
                    <ProofTerminal
                      proofBundle={proofBundle}
                      sessionId={sessionId}
                      allMovesComplete={movesReady}
                      commitPhase={commitPhase}
                      proofError={error}
                      onRetryProof={() => void handleForgeAndCommit()}
                    />
                  </>
                )}
                {phase === 'waiting_reveal' && <p className="status-pill warning">Waiting for opponent commit...</p>}
              </>
            )}

            {phase === 'reveal' && (
              <>
                <h3>Reveal</h3>
                {!myRevealed && (
                  <>
                    <p className="mono dim">{storedPublicInputs ? `public_inputs bytes: ${storedPublicInputs.length}` : 'No stored inputs found'}</p>
                    {!storedPublicInputs && <p className="inline-error">Reveal locked: commit data missing.</p>}
                    <button className="btn-arena-secondary" disabled={busy || !storedPublicInputs} onClick={() => void handleReveal()}>
                      👁 REVEAL MOVES
                    </button>
                  </>
                )}
                {myRevealed && !bothRevealed && (
                  <motion.div
                    className={`reveal-wait-card ${waitingRevealFlash ? 'reveal-wait-card--flash' : ''}`}
                    initial={{ opacity: 1 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.3 }}
                  >
                    <div className="reveal-wait-title">
                      <span aria-hidden>⏳</span> MOVES REVEALED
                    </div>
                    <p className="reveal-wait-lead">Waiting for your opponent to reveal their moves…</p>
                    <p className="reveal-wait-italic">Your commitment is locked in. The moment they reveal, the battle can be resolved.</p>
                    <div className="reveal-wait-poll-row">
                      <span className="reveal-wait-dots" aria-hidden>
                        <span className="reveal-wait-dot" />
                        <span className="reveal-wait-dot" />
                        <span className="reveal-wait-dot" />
                      </span>
                      <span className="reveal-wait-last mono">Last checked: {syncLabel}</span>
                    </div>
                  </motion.div>
                )}
              </>
            )}

            {phase === 'resolve' && (
              <motion.div
                className="resolve-battle-wrap"
                initial={{ y: 16, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              >
                <h3>Resolve Battle</h3>
                <button className="btn-arena-amber" disabled={busy} onClick={() => void handleResolve()}>
                  ⚔ RESOLVE BATTLE
                </button>
              </motion.div>
            )}

            {success && <p className="status-pill success">{success}</p>}
            {error && commitPhase !== 'proof-error' && <p className="status-pill error">{error}</p>}
          </motion.div>
        </AnimatePresence>
      )}

      {phase === 'complete' && gamePlayback && (
        <div className="cinematic-battle-root">
          {(() => {
            const tr = gamePlayback.turn_results[battlePlayback.ui.round] ?? gamePlayback.turn_results[0]!;
            const p1Atk = attackMeta(tr.player1_move.attack);
            const p2Def = defenseMeta(tr.player2_move.defense);
            const p2Atk = attackMeta(tr.player2_move.attack);
            const p1Def = defenseMeta(tr.player1_move.defense);
            const isP1Local = isLocalPlayer(gamePlayback.player1, userAddress);
            const leftAnim = isP1Local ? battlePlayback.ui.p1Anim : battlePlayback.ui.p2Anim;
            const rightAnim = isP1Local ? battlePlayback.ui.p2Anim : battlePlayback.ui.p1Anim;
            const localHp = isP1Local ? battlePlayback.ui.hp1 : battlePlayback.ui.hp2;
            const oppHp = isP1Local ? battlePlayback.ui.hp2 : battlePlayback.ui.hp1;
            const localAddr = isP1Local ? gamePlayback.player1 : gamePlayback.player2;
            const oppAddr = isP1Local ? gamePlayback.player2 : gamePlayback.player1;
            const localUsername = isP1Local ? gamePlayback.player1_username : gamePlayback.player2_username;
            const oppUsername = isP1Local ? gamePlayback.player2_username : gamePlayback.player1_username;
            const npTier = (hp: number) => (hp > 60 ? 'hi' : hp > 30 ? 'mid' : 'low');
            const narr = battlePlayback.ui.narration;
            return (
              <>
                <AnimatePresence>
                  {narr && (
                    <motion.div
                      key={narr.key}
                      className="playback-narration-bar"
                      initial={{ y: -56, opacity: 0 }}
                      animate={{ y: 0, opacity: 1 }}
                      exit={{ opacity: 0, transition: { duration: 0.3, ease: 'easeOut' } }}
                      transition={{ duration: 0.25, ease: 'easeOut' }}
                    >
                      <PlaybackNarrationBar n={narr} isP1Local={isP1Local} />
                    </motion.div>
                  )}
                </AnimatePresence>
                <AnimatePresence>
                  {battlePlayback.ui.exchangeFlash && (
                    <motion.div
                      className="exchange-flash-bar"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.35 }}
                    >
                      ⚔ DAMAGE APPLIED ⚔
                    </motion.div>
                  )}
                </AnimatePresence>
                <div
                  className={`cinematic-battle-canvas ${battlePlayback.ui.vignetteHit ? 'cinematic-battle-canvas--vignette' : ''}`}
                >
                  <div className="cinematic-arena-row cinematic-arena-row--with-plates cinematic-arena-row--playback-faceoff">
                    <div className="cinematic-side cinematic-side--left">
                      <div className="cinematic-pirate-wrap cinematic-pirate-wrap--faceoff">
                        <div className="pirate-faceoff-scale" aria-hidden>
                          <PirateCharacter side="left" animation={leftAnim} accentColor="#E5133A" />
                        </div>
                      </div>
                      <AnimatePresence>
                        {battlePlayback.ui.floatText && battlePlayback.ui.floatSide === 'left' && (
                          <motion.div
                            key={`fl-${battlePlayback.ui.floatText}-${battlePlayback.ui.segment}`}
                            className={`cinematic-float-above ${battlePlayback.ui.floatTone === 'cyan' ? 'cyan' : 'crimson'}`}
                            initial={{ y: 8, opacity: 1 }}
                            animate={{ y: -28, opacity: 0 }}
                            transition={{ duration: 0.9, ease: 'easeOut' }}
                          >
                            {battlePlayback.ui.floatText}
                          </motion.div>
                        )}
                      </AnimatePresence>
                      <div className="cinematic-nameplate">
                        <div className="cinematic-nameplate-title you">⚡ {localUsername ? `@${localUsername}` : 'YOU'}</div>
                        <div className="cinematic-nameplate-addr mono">{truncateAddr(localAddr)}</div>
                        <div className="cinematic-nameplate-hp">
                          <span className="cinematic-nameplate-hp-label">HP:</span>
                          <div className="nameplate-hp-track">
                            <div
                              className={`nameplate-hp-fill nameplate-hp-fill--${npTier(localHp)}`}
                              style={{ width: `${localHp}%` }}
                            />
                          </div>
                          <span className="cinematic-nameplate-hp-num">{localHp}</span>
                        </div>
                      </div>
                    </div>
                    <div className="cinematic-center">
                      <AnimatePresence>
                        {battlePlayback.ui.showRoundTitle && (
                          <motion.div
                            key={battlePlayback.ui.roundTitleText}
                            className="cinematic-round-banner cinematic-round-banner--title"
                            initial={{ y: -40, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.35 }}
                          >
                            {battlePlayback.ui.roundTitleText}
                          </motion.div>
                        )}
                      </AnimatePresence>

                      <div className="cinematic-cards-row">
                        <AnimatePresence>
                          {battlePlayback.ui.p1AtkCard && (
                            <motion.div
                              key={`c1-${battlePlayback.ui.round}`}
                              className="cinematic-move-card"
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ opacity: 0 }}
                              transition={{ type: 'spring', stiffness: 200, damping: 18 }}
                            >
                              <span>{p1Atk.icon}</span>
                              <span>{p1Atk.name}</span>
                            </motion.div>
                          )}
                        </AnimatePresence>
                        <AnimatePresence>
                          {battlePlayback.ui.p1DefCard && (
                            <motion.div
                              key={`d2-${battlePlayback.ui.round}`}
                              className="cinematic-move-card defense"
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ opacity: 0 }}
                              transition={{ type: 'spring', stiffness: 200, damping: 18 }}
                            >
                              <span>{p2Def.icon}</span>
                              <span>{p2Def.label}</span>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>

                      <div className="cinematic-cards-row cinematic-cards-row--p2">
                        <AnimatePresence>
                          {battlePlayback.ui.p2AtkCard && (
                            <motion.div
                              key={`c2-${battlePlayback.ui.round}`}
                              className="cinematic-move-card"
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ opacity: 0 }}
                              transition={{ type: 'spring', stiffness: 200, damping: 18 }}
                            >
                              <span>{p2Atk.icon}</span>
                              <span>{p2Atk.name}</span>
                            </motion.div>
                          )}
                        </AnimatePresence>
                        <AnimatePresence>
                          {battlePlayback.ui.p2DefCard && (
                            <motion.div
                              key={`d1-${battlePlayback.ui.round}`}
                              className="cinematic-move-card defense"
                              initial={{ scale: 0, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ opacity: 0 }}
                              transition={{ type: 'spring', stiffness: 200, damping: 18 }}
                            >
                              <span>{p1Def.icon}</span>
                              <span>{p1Def.label}</span>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>

                    </div>
                    <div className="cinematic-side cinematic-side--right">
                      <div className="cinematic-pirate-wrap cinematic-pirate-wrap--faceoff">
                        <div className="pirate-faceoff-scale" aria-hidden>
                          <PirateCharacter side="right" animation={rightAnim} accentColor="#00D4FF" />
                        </div>
                      </div>
                      <AnimatePresence>
                        {battlePlayback.ui.floatText && battlePlayback.ui.floatSide === 'right' && (
                          <motion.div
                            key={`fr-${battlePlayback.ui.floatText}-${battlePlayback.ui.segment}`}
                            className={`cinematic-float-above ${battlePlayback.ui.floatTone === 'cyan' ? 'cyan' : 'crimson'}`}
                            initial={{ y: 8, opacity: 1 }}
                            animate={{ y: -28, opacity: 0 }}
                            transition={{ duration: 0.9, ease: 'easeOut' }}
                          >
                            {battlePlayback.ui.floatText}
                          </motion.div>
                        )}
                      </AnimatePresence>
                      <div className="cinematic-nameplate cinematic-nameplate--opp">
                        <div className="cinematic-nameplate-title opp">{oppUsername ? `@${oppUsername}` : 'OPPONENT'}</div>
                        <div className="cinematic-nameplate-addr mono">{truncateAddr(oppAddr)}</div>
                        <div className="cinematic-nameplate-hp">
                          <span className="cinematic-nameplate-hp-label">HP:</span>
                          <div className="nameplate-hp-track">
                            <div
                              className={`nameplate-hp-fill nameplate-hp-fill--${npTier(oppHp)}`}
                              style={{ width: `${oppHp}%` }}
                            />
                          </div>
                          <span className="cinematic-nameplate-hp-num">{oppHp}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <AnimatePresence>
                  {battlePlayback.ui.showWinnerOverlay && (
                    <motion.div
                      className="cinematic-winner-overlay"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                    >
                      {battlePlayback.ui.outcome === 'win' && (
                        <motion.div
                          className="cinematic-winner-win"
                          initial={{ scale: 0.5, opacity: 0 }}
                          animate={{ scale: [0.5, 1.2, 1], opacity: 1 }}
                          transition={{ duration: 0.5 }}
                        >
                          <motion.div
                            className="cinematic-crown"
                            animate={{ y: [0, -10, 0] }}
                            transition={{ duration: 0.8, repeat: Infinity }}
                          >
                            👑
                          </motion.div>
                          <div className="cinematic-winner-title">VICTORY</div>
                          <div className="cinematic-confetti">
                            {Array.from({ length: 20 }).map((_, i) => (
                              <span key={i} className={`cf-${i % 5}`} />
                            ))}
                          </div>
                        </motion.div>
                      )}
                      {battlePlayback.ui.outcome === 'loss' && (
                        <motion.div
                          className="cinematic-winner-loss"
                          initial={{ scale: 1, opacity: 1 }}
                          animate={{ scale: 0.9, opacity: 0.6 }}
                          transition={{ duration: 0.4 }}
                        >
                          <div className="cinematic-skull">💀</div>
                          <div className="cinematic-winner-title defeat">DEFEATED</div>
                        </motion.div>
                      )}
                      {battlePlayback.ui.outcome === 'draw' && (
                        <motion.div className="cinematic-winner-draw" initial={{ scale: 0.8 }} animate={{ scale: [0.8, 1.05, 1] }} transition={{ duration: 0.4 }}>
                          <div className="cinematic-skull">⚔️</div>
                          <div className="cinematic-winner-title draw">DEADLOCK</div>
                        </motion.div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>

                {battlePlayback.ui.showEndTable && (
                  <>
                  <div className="cinematic-points-summary cinematic-points-summary--tracker">
                    <div className="cinematic-points-tracker-row">
                      <div className="cinematic-points-col">
                        <span className="cinematic-points-col-label">POINTS THIS DUEL</span>
                        <span
                          className={
                            battlePlayback.ui.outcome === 'win'
                              ? 'cinematic-duel-val cinematic-duel-val--win'
                              : battlePlayback.ui.outcome === 'loss'
                                ? 'cinematic-duel-val cinematic-duel-val--loss'
                                : 'cinematic-duel-val cinematic-duel-val--draw'
                          }
                        >
                          {battlePlayback.ui.outcome === 'win'
                            ? '+30 (victory!)'
                            : battlePlayback.ui.outcome === 'loss'
                              ? '−15'
                              : '0'}
                        </span>
                      </div>
                      <div className="cinematic-points-col cinematic-points-col--total">
                        <span className="cinematic-points-col-label">YOUR TOTAL</span>
                        <span className="cinematic-points-total-inline">
                          {sessionPointsLoading ? '-- pts' : `${formatTrackerPointsDisplay(sessionTotalPoints)} pts`}
                        </span>
                        {sessionPointsError && onRefreshSessionPoints && (
                          <button type="button" className="cinematic-points-retry" onClick={() => onRefreshSessionPoints()} aria-label="Retry points">
                            ↻
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="cinematic-summary-table-wrap">
                    <table className="cinematic-summary-table">
                      <thead>
                        <tr>
                          <th>ROUND</th>
                          <th className="cinematic-summary-you">YOU DEALT</th>
                          <th>OPPONENT DEALT</th>
                          <th>HP END</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gamePlayback.turn_results.slice(0, 3).map((t, i) => {
                          const youDealt = isP1Local ? t.player1_damage_dealt : t.player2_damage_dealt;
                          const oppDealt = isP1Local ? t.player2_damage_dealt : t.player1_damage_dealt;
                          const youHp = isP1Local ? t.player1_hp_remaining : t.player2_hp_remaining;
                          const oppHp = isP1Local ? t.player2_hp_remaining : t.player1_hp_remaining;
                          return (
                            <tr key={i}>
                              <td>{i + 1}</td>
                              <td className="cinematic-summary-you">{youDealt}</td>
                              <td>{oppDealt}</td>
                              <td>
                                YOU:{youHp} / OPP:{oppHp}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  </>
                )}

                {battlePlayback.ui.showEndButtons && (
                  <div className="cinematic-end-actions">
                    <button type="button" className="btn-arena-primary" onClick={handleReset}>
                      ⚔ DUEL AGAIN
                    </button>
                    <a className="btn-arena-secondary cinematic-explorer-btn" href={explorerHref} target="_blank" rel="noreferrer">
                      ↗ Explorer
                    </a>
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {phase === 'complete' && (success || error) && (
        <p className={`status-pill ${error ? 'error' : 'success'}`}>{error ?? success}</p>
      )}
    </div>
  );
}
