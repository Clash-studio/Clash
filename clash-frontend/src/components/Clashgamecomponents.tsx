/**
 * ClashGameComponents.tsx
 */

import type { Game, Move, BattleResult, GamePlayback, DetailedTurnResult } from '@/games/clash/bindings';
import { Attack, Defense } from '@/games/clash/bindings';

// ─────────────────────────────────────────────────────────────
// Constants & Meta
// ─────────────────────────────────────────────────────────────

export const ATTACK_META: Record<number, {
  label: string; emoji: string; color: string; border: string;
  dmg: number; beats: string; loses: string;
}> = {
  [Attack.Slash]:     { label: 'Slash',     emoji: '⚔️',  dmg: 30, beats: 'Block',   loses: 'Dodge',   color: 'from-amber-500  to-yellow-400', border: 'border-amber-400'  },
  [Attack.Fireball]:  { label: 'Fireball',  emoji: '🔥',  dmg: 40, beats: 'Dodge',   loses: 'Counter', color: 'from-red-600    to-orange-400', border: 'border-red-400'    },
  [Attack.Lightning]: { label: 'Lightning', emoji: '⚡',  dmg: 35, beats: 'Counter', loses: 'Block',   color: 'from-violet-600 to-blue-400',   border: 'border-violet-400' },
};

export const DEFENSE_META: Record<number, {
  label: string; emoji: string; color: string; border: string; stops: string;
}> = {
  [Defense.Block]:   { label: 'Block',   emoji: '🛡️', stops: 'Lightning & Slash', color: 'from-sky-600   to-cyan-400',    border: 'border-sky-400'   },
  [Defense.Dodge]:   { label: 'Dodge',   emoji: '🏃', stops: 'Fireball & Slash',  color: 'from-emerald-600 to-green-400', border: 'border-emerald-400' },
  [Defense.Counter]: { label: 'Counter', emoji: '🔄', stops: 'Lightning & Fire',  color: 'from-pink-600  to-rose-400',    border: 'border-pink-400'  },
};

export function shortAddress(addr: string): string {
  if (!addr) return '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function formatPoints(raw: bigint | number): string {
  return (Number(raw) / 10_000_000).toFixed(2);
}

// ─────────────────────────────────────────────────────────────
// PhaseHeader — stepper + title
// ─────────────────────────────────────────────────────────────

type GamePhase = 'create' | 'commit' | 'waiting_reveal' | 'reveal' | 'resolve' | 'complete';

const PHASE_LABELS: Record<GamePhase, string> = {
  create:         'Prepare for Battle',
  commit:         'Choose Your 3-Turn Strategy',
  waiting_reveal: 'Waiting for Both Commitments…',
  reveal:         'Reveal Your Moves & Prove',
  resolve:        'Resolving Battle…',
  complete:       'Battle Complete',
};

const STEPS: { key: GamePhase; short: string }[] = [
  { key: 'create',  short: 'Create'  },
  { key: 'commit',  short: 'Commit'  },
  { key: 'reveal',  short: 'Reveal'  },
  { key: 'resolve', short: 'Resolve' },
  { key: 'complete',short: 'Done'    },
];

interface PhaseHeaderProps { phase: GamePhase; sessionId: number }

export function PhaseHeader({ phase, sessionId }: PhaseHeaderProps) {
  const stepKeys = STEPS.map(s => s.key);
  const current = stepKeys.indexOf(phase === 'waiting_reveal' ? 'reveal' : phase);

  return (
    <div className="mb-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-red-600 via-orange-500 to-amber-400 tracking-tight">
            ⚔️ Clash of Pirates
          </h2>
          <p className="text-sm font-semibold text-gray-500 mt-0.5">{PHASE_LABELS[phase]}</p>
        </div>
        <span className="text-[10px] font-mono text-gray-400 pt-1">#{sessionId}</span>
      </div>

      <div className="flex items-center gap-1 mt-4">
        {STEPS.map((step, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <div key={step.key} className="flex items-center gap-1">
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-black transition-all duration-300 ${
                done   ? 'bg-gradient-to-br from-green-500 to-emerald-400 text-white shadow-md'
                : active ? 'bg-gradient-to-br from-red-600 to-orange-500 text-white ring-2 ring-orange-300 shadow-lg scale-110'
                : 'bg-gray-100 text-gray-400'
              }`}>
                {done ? '✓' : i + 1}
              </div>
              {i < STEPS.length - 1 && (
                <div className={`h-0.5 w-5 rounded transition-all duration-500 ${done ? 'bg-green-400' : 'bg-gray-200'}`} />
              )}
            </div>
          );
        })}
        <span className="ml-2 text-xs font-bold text-gray-400">{STEPS[current]?.short ?? ''}</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// AlertBanner
// ─────────────────────────────────────────────────────────────

type AlertType = 'error' | 'success' | 'info' | 'warning';

const ALERT_STYLES: Record<AlertType, string> = {
  error:   'bg-gradient-to-r from-red-50   to-pink-50    border-red-200   text-red-700',
  success: 'bg-gradient-to-r from-green-50 to-emerald-50 border-green-200 text-green-700',
  info:    'bg-gradient-to-r from-blue-50  to-sky-50     border-blue-200  text-blue-700',
  warning: 'bg-gradient-to-r from-yellow-50 to-amber-50  border-yellow-200 text-yellow-800',
};

export function AlertBanner({ type, message }: { type: AlertType; message: string }) {
  return (
    <div className={`mb-4 p-4 border-2 rounded-xl text-sm font-semibold ${ALERT_STYLES[type]}`}>
      {message}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// PlayerStatusCard
// ─────────────────────────────────────────────────────────────

interface PlayerStatusCardProps {
  label: 'Player 1' | 'Player 2';
  address: string;
  points: bigint;
  isYou: boolean;
  committed: boolean;
  revealed: boolean;
}

export function PlayerStatusCard({ label, address, points, isYou, committed, revealed }: PlayerStatusCardProps) {
  return (
    <div className={`p-4 rounded-xl border-2 transition-all ${
      isYou
        ? 'border-orange-400 bg-gradient-to-br from-orange-50 to-amber-50 shadow-lg'
        : 'border-gray-200 bg-white'
    }`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">{label}</span>
        {isYou && (
          <span className="text-[10px] font-black px-2 py-0.5 bg-orange-500 text-white rounded-full">YOU</span>
        )}
      </div>
      <div className="font-mono text-xs text-gray-600 mb-1 truncate">{shortAddress(address)}</div>
      {/* <div className="text-sm font-bold text-gray-800 mb-3">{formatPoints(points)} pts wagered</div> */}

      <div className="flex gap-2">
        <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black uppercase tracking-wide border ${
          committed
            ? 'bg-green-50 text-green-700 border-green-300'
            : 'bg-gray-50 text-gray-400 border-gray-200'
        }`}>
          {committed ? '✓ Committed' : '⌛ Pending'}
        </span>
        {committed && (
          <span className={`px-2 py-0.5 rounded-lg text-[10px] font-black uppercase tracking-wide border ${
            revealed
              ? 'bg-purple-50 text-purple-700 border-purple-300'
              : 'bg-gray-50 text-gray-400 border-gray-200'
          }`}>
            {revealed ? '✓ Revealed' : '🔒 Hidden'}
          </span>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// GameStatusChecklist — live "waiting for opponent" card
// ─────────────────────────────────────────────────────────────

export interface GameStatusChecklistProps {
  /** Address of the local player */
  userAddress: string;
  player1Address: string;
  player2Address: string;
  p1Committed: boolean;
  p2Committed: boolean;
  p1Revealed: boolean;
  p2Revealed: boolean;
  resolved: boolean;
  /** ISO timestamp or null when last polled */
  lastSyncedAt: number | null;
  /** true while a poll is in flight */
  syncing: boolean;
}

interface ChecklistItemProps {
  done: boolean;
  active: boolean;
  label: string;
  detail?: string;
}

function ChecklistItem({ done, active, label, detail }: ChecklistItemProps) {
  return (
    <div className={`game-status-checklist-item ${done ? 'done' : active ? 'active' : 'pending'}`}>
      <span className="game-status-checklist-icon" aria-hidden>
        {done ? '✓' : active ? '⏳' : '○'}
      </span>
      <span className="game-status-checklist-label">
        {label}
        {detail && <span className="game-status-checklist-detail">{detail}</span>}
      </span>
    </div>
  );
}

export function GameStatusChecklist({
  userAddress,
  player1Address,
  player2Address,
  p1Committed,
  p2Committed,
  p1Revealed,
  p2Revealed,
  resolved,
  lastSyncedAt,
  syncing,
}: GameStatusChecklistProps) {
  const isP1 = player1Address === userAddress;
  const myAddr = isP1 ? player1Address : player2Address;
  const oppAddr = isP1 ? player2Address : player1Address;
  const myCommitted = isP1 ? p1Committed : p2Committed;
  const oppCommitted = isP1 ? p2Committed : p1Committed;
  const myRevealed = isP1 ? p1Revealed : p2Revealed;
  const oppRevealed = isP1 ? p2Revealed : p1Revealed;

  const syncLabel = lastSyncedAt
    ? `${Math.round((Date.now() - lastSyncedAt) / 1000)}s ago`
    : 'never';

  return (
    <div className="game-status-checklist-card">
      <div className="game-status-checklist-header">
        <span className="game-status-checklist-title">⏳ Game Progress</span>
        <span className={`game-status-checklist-sync ${syncing ? 'syncing' : ''}`}>
          {syncing ? 'Syncing…' : `Synced ${syncLabel}`}
        </span>
      </div>

      <div className="game-status-checklist-players">
        <span className="game-status-checklist-you">
          You: <span className="font-mono">{shortAddress(myAddr)}</span>
        </span>
        <span className="game-status-checklist-opp">
          Opp: <span className="font-mono">{shortAddress(oppAddr)}</span>
        </span>
      </div>

      <div className="game-status-checklist-steps">
        <ChecklistItem
          done={myCommitted}
          active={!myCommitted}
          label="Your commit"
          detail={myCommitted ? ' ✓' : ' — pending'}
        />
        <ChecklistItem
          done={oppCommitted}
          active={myCommitted && !oppCommitted}
          label="Opponent commit"
          detail={oppCommitted ? ' ✓' : myCommitted ? ' — waiting…' : ' — pending'}
        />
        <ChecklistItem
          done={myRevealed}
          active={p1Committed && p2Committed && !myRevealed}
          label="Your reveal"
          detail={myRevealed ? ' ✓' : p1Committed && p2Committed ? ' — ready to reveal' : ' — locked'}
        />
        <ChecklistItem
          done={oppRevealed}
          active={myRevealed && !oppRevealed}
          label="Opponent reveal"
          detail={oppRevealed ? ' ✓' : myRevealed ? ' — waiting…' : ' — pending'}
        />
        <ChecklistItem
          done={resolved}
          active={p1Revealed && p2Revealed && !resolved}
          label="Resolve battle"
          detail={resolved ? ' ✓' : p1Revealed && p2Revealed ? ' — ready' : ' — pending'}
        />
      </div>

      {!oppCommitted && myCommitted && (
        <p className="game-status-checklist-hint">
          Polling every 15 s — opponent still needs to commit their moves.
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MoveSelector — the 3-turn strategy builder
// ─────────────────────────────────────────────────────────────

export interface SelectedMove { attack: number | null; defense: number | null }

const EMPTY_MOVES: SelectedMove[] = [
  { attack: null, defense: null },
  { attack: null, defense: null },
  { attack: null, defense: null },
];

export function createEmptyMoves(): SelectedMove[] {
  return EMPTY_MOVES.map(m => ({ ...m }));
}

interface MoveSelectorProps {
  moves: SelectedMove[];
  onChange: (moves: SelectedMove[]) => void;
  disabled?: boolean;
}

export function MoveSelector({ moves, onChange, disabled }: MoveSelectorProps) {
  const set = (turn: number, field: 'attack' | 'defense', val: number) => {
    const next = moves.map((m, i) => i === turn ? { ...m, [field]: val } : m);
    onChange(next);
  };

  const allFilled = moves.every(m => m.attack !== null && m.defense !== null);
  const attacks = [Attack.Slash, Attack.Fireball, Attack.Lightning];
  const defenses = [Defense.Block, Defense.Dodge, Defense.Counter];

  return (
    <div className="space-y-4">
      {/* Legend */}
      <div className="grid grid-cols-2 gap-2 text-[10px] font-semibold text-gray-500">
        <div className="flex flex-col gap-1">
          {attacks.map(a => (
            <span key={a}>{ATTACK_META[a].emoji} {ATTACK_META[a].label} ({ATTACK_META[a].dmg} dmg) — beats {ATTACK_META[a].beats}</span>
          ))}
        </div>
        <div className="flex flex-col gap-1">
          {defenses.map(d => (
            <span key={d}>{DEFENSE_META[d].emoji} {DEFENSE_META[d].label} — stops {DEFENSE_META[d].stops}</span>
          ))}
        </div>
      </div>

      {/* Turn rows */}
      {[0, 1, 2].map(turn => (
        <div key={turn} className="rounded-xl border-2 border-gray-200 bg-white overflow-hidden">
          <div className="px-4 py-2 bg-gradient-to-r from-gray-900 to-gray-700 text-white text-xs font-black uppercase tracking-wider">
            Turn {turn + 1}
          </div>
          <div className="p-3 grid grid-cols-2 gap-3">
            {/* Attack column */}
            <div>
              <p className="text-[10px] font-black uppercase text-gray-400 mb-2">⚔️ Attack</p>
              <div className="flex flex-col gap-1.5">
                {attacks.map(a => {
                  const meta = ATTACK_META[a];
                  const selected = moves[turn].attack === a;
                  return (
                    <button
                      key={a}
                      disabled={disabled}
                      onClick={() => set(turn, 'attack', a)}
                      className={`px-3 py-2 rounded-lg border-2 text-xs font-bold text-left transition-all ${
                        selected
                          ? `bg-gradient-to-r ${meta.color} text-white ${meta.border} shadow-md scale-[1.02]`
                          : `bg-gray-50 border-gray-200 text-gray-600 hover:${meta.border} hover:bg-gray-100`
                      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      {meta.emoji} {meta.label}
                      <span className="ml-1 opacity-75">({meta.dmg})</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Defense column */}
            <div>
              <p className="text-[10px] font-black uppercase text-gray-400 mb-2">🛡️ Defense</p>
              <div className="flex flex-col gap-1.5">
                {defenses.map(d => {
                  const meta = DEFENSE_META[d];
                  const selected = moves[turn].defense === d;
                  return (
                    <button
                      key={d}
                      disabled={disabled}
                      onClick={() => set(turn, 'defense', d)}
                      className={`px-3 py-2 rounded-lg border-2 text-xs font-bold text-left transition-all ${
                        selected
                          ? `bg-gradient-to-r ${meta.color} text-white ${meta.border} shadow-md scale-[1.02]`
                          : `bg-gray-50 border-gray-200 text-gray-600 hover:${meta.border} hover:bg-gray-100`
                      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      {meta.emoji} {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Turn summary */}
          <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-xs font-bold text-gray-500 flex gap-4">
            <span>
              Attack: {moves[turn].attack !== null ? `${ATTACK_META[moves[turn].attack!].emoji} ${ATTACK_META[moves[turn].attack!].label}` : '—'}
            </span>
            <span>
              Defense: {moves[turn].defense !== null ? `${DEFENSE_META[moves[turn].defense!].emoji} ${DEFENSE_META[moves[turn].defense!].label}` : '—'}
            </span>
          </div>
        </div>
      ))}

      {!allFilled && (
        <p className="text-xs font-semibold text-amber-600 text-center">
          ⚠️ Select an attack AND defense for each of the 3 turns to continue.
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// StrategyPreview — compact 3-turn preview strip
// ─────────────────────────────────────────────────────────────

export function StrategyPreview({ moves }: { moves: SelectedMove[] }) {
  return (
    <div className="flex gap-3 mt-2">
      {moves.map((m, i) => (
        <div key={i} className="flex-1 rounded-lg border-2 border-gray-200 bg-white p-2 text-center">
          <div className="text-[10px] font-black text-gray-400 mb-1">T{i + 1}</div>
          <div className="text-base">{m.attack !== null ? ATTACK_META[m.attack].emoji : '?'}</div>
          <div className="text-base">{m.defense !== null ? DEFENSE_META[m.defense].emoji : '?'}</div>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// HPBar
// ─────────────────────────────────────────────────────────────

export function HPBar({ hp, maxHp = 100, label }: { hp: number; maxHp?: number; label: string }) {
  const pct = Math.max(0, (hp / maxHp) * 100);
  const color = pct > 60 ? 'from-green-500 to-emerald-400'
    : pct > 30 ? 'from-yellow-500 to-amber-400'
    : 'from-red-600 to-red-400';

  return (
    <div>
      <div className="flex justify-between text-xs font-bold text-gray-600 mb-1">
        <span>{label}</span>
        <span>{Math.max(0, hp)} / {maxHp} HP</span>
      </div>
      <div className="h-4 rounded-full bg-gray-200 overflow-hidden">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${color} transition-all duration-700`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// BattlePlayback — animated turn-by-turn result
// ─────────────────────────────────────────────────────────────

interface BattlePlaybackProps {
  playback: GamePlayback;
  userAddress: string;
}

export function BattlePlayback({ playback, userAddress }: BattlePlaybackProps) {
  const isP1 = playback.player1.toString() === userAddress;

  return (
    <div className="space-y-4">
      {/* HP bars */}
      <div className="grid grid-cols-2 gap-4 p-4 bg-gradient-to-br from-gray-900 to-gray-800 rounded-xl">
        <HPBar
          hp={playback.final_player1_hp}
          label={`${playback.player1_username ?? shortAddress(playback.player1.toString())}${isP1 ? ' (You)' : ''}`}
        />
        <HPBar
          hp={playback.final_player2_hp}
          label={`${playback.player2_username ?? shortAddress(playback.player2.toString())}${!isP1 ? ' (You)' : ''}`}
        />
      </div>

      {/* Turn-by-turn */}
      {playback.turn_results.map((turn: DetailedTurnResult) => (
        <TurnCard key={Number(turn.turn)} turn={turn} isP1={isP1} />
      ))}
    </div>
  );
}

function TurnCard({ turn, isP1 }: { turn: DetailedTurnResult; isP1: boolean }) {
  const t = Number(turn.turn);
  const p1m = turn.player1_move;
  const p2m = turn.player2_move;

  return (
    <div className="rounded-xl border-2 border-gray-200 overflow-hidden">
      <div className="px-4 py-2 bg-gradient-to-r from-gray-900 to-gray-700 text-white text-xs font-black">
        TURN {t + 1}
      </div>
      <div className="p-3 grid grid-cols-2 gap-3">
        {/* Player 1 */}
        <div className={`p-3 rounded-lg ${isP1 ? 'bg-orange-50 border border-orange-200' : 'bg-gray-50'}`}>
          <p className="text-[10px] font-black text-gray-400 mb-1">{isP1 ? 'YOUR MOVES' : 'PLAYER 1'}</p>
          <div className="flex gap-2 text-sm">
            <span title="Attack">{ATTACK_META[Number(p1m.attack)]?.emoji} {ATTACK_META[Number(p1m.attack)]?.label}</span>
            <span className="text-gray-300">|</span>
            <span title="Defense">{DEFENSE_META[Number(p1m.defense)]?.emoji} {DEFENSE_META[Number(p1m.defense)]?.label}</span>
          </div>
          <div className="mt-2 text-xs space-y-0.5">
            {Number(turn.player1_damage_dealt) > 0 && (
              <p className="text-red-600 font-bold">💥 Dealt {Number(turn.player1_damage_dealt)} dmg</p>
            )}
            {Number(turn.player1_damage_taken) > 0 && (
              <p className="text-gray-500">🩸 Took {Number(turn.player1_damage_taken)} dmg</p>
            )}
            {turn.player1_defense_successful && (
              <p className="text-green-600 font-bold">✓ Block successful!</p>
            )}
            <p className="text-gray-600 font-semibold">{Number(turn.player1_hp_remaining)} HP left</p>
          </div>
        </div>

        {/* Player 2 */}
        <div className={`p-3 rounded-lg ${!isP1 ? 'bg-orange-50 border border-orange-200' : 'bg-gray-50'}`}>
          <p className="text-[10px] font-black text-gray-400 mb-1">{!isP1 ? 'YOUR MOVES' : 'PLAYER 2'}</p>
          <div className="flex gap-2 text-sm">
            <span title="Attack">{ATTACK_META[Number(p2m.attack)]?.emoji} {ATTACK_META[Number(p2m.attack)]?.label}</span>
            <span className="text-gray-300">|</span>
            <span title="Defense">{DEFENSE_META[Number(p2m.defense)]?.emoji} {DEFENSE_META[Number(p2m.defense)]?.label}</span>
          </div>
          <div className="mt-2 text-xs space-y-0.5">
            {Number(turn.player2_damage_dealt) > 0 && (
              <p className="text-red-600 font-bold">💥 Dealt {Number(turn.player2_damage_dealt)} dmg</p>
            )}
            {Number(turn.player2_damage_taken) > 0 && (
              <p className="text-gray-500">🩸 Took {Number(turn.player2_damage_taken)} dmg</p>
            )}
            {turn.player2_defense_successful && (
              <p className="text-green-600 font-bold">✓ Block successful!</p>
            )}
            <p className="text-gray-600 font-semibold">{Number(turn.player2_hp_remaining)} HP left</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CreateGamePanel — mode tabs + import/load/create sub-panels
// ─────────────────────────────────────────────────────────────

export type CreateMode = 'create' | 'import' | 'load';

interface CreateGamePanelProps {
  createMode: CreateMode;
  setCreateMode: (m: CreateMode) => void;

  // create mode
  player1Address: string;
  setPlayer1Address: (v: string) => void;
  player1Points: string;
  setPlayer1Points: (v: string) => void;
  availablePoints: bigint;
  sessionId: number;
  exportedAuthEntryXDR: string | null;
  authEntryCopied: boolean;
  shareUrlCopied: boolean;
  onPrepareTransaction: () => void;
  onCopyAuthEntry: () => void;
  onCopyShareUrl: () => void;

  // import mode
  importAuthEntryXDR: string;
  setImportAuthEntryXDR: (v: string) => void;
  importSessionId: string;
  importPlayer1: string;
  importPlayer1Points: string;
  importPlayer2Points: string;
  setImportPlayer2Points: (v: string) => void;
  xdrParsing: boolean;
  xdrParseError: string | null;
  xdrParseSuccess: boolean;
  userAddress: string;
  onImportTransaction: () => void;

  // load mode
  loadSessionId: string;
  setLoadSessionId: (v: string) => void;
  onLoadGame: () => void;
  onCopyLoadShareUrl: () => void;

  // quickstart
  quickstartAvailable: boolean;
  quickstartLoading: boolean;
  onQuickStart: () => void;

  // shared
  loading: boolean;
  isBusy: boolean;
}

export function CreateGamePanel(p: CreateGamePanelProps) {
  return (
    <div className="create-panel-centered">
      <div className="play-button-wrapper">
        <div className="play-button-ring ring-3" />
        <div className="play-button-ring ring-2" />
        <div className="play-button-ring ring-1" />

        <button
          onClick={p.onQuickStart}
          disabled={p.isBusy || !p.quickstartAvailable}
          className="play-button-main"
        >
          <span className="play-button-icon">⚔️</span>
          <span className="play-button-label">
            {p.quickstartLoading ? 'Setting Sail…' : 'Play Game'}
          </span>
        </button>
      </div>

      {!p.quickstartAvailable && (
        <p className="play-unavailable-hint">
          Dev wallets not detected — run <code>bun run setup</code> to enable
        </p>
      )}
    </div>
  );
}