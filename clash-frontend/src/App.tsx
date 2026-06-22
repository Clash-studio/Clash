import { useState, useTransition } from 'react';
import { config } from './config';
import { Layout } from './components/Layout';
import { GameErrorBoundary } from './components/GameErrorBoundary';
import { BackgroundMusic } from './components/sound/BackgroundMusic';
import { ClashGameArena } from './games/clash/ClashGameArena';
import { Leaderboard } from './pages/Leaderboard';
import { HowToPlay } from './pages/HowToPlay';

const GAME_TITLE = import.meta.env.VITE_GAME_TITLE || 'Clash';
const GAME_TAGLINE = import.meta.env.VITE_GAME_TAGLINE || 'On-chain game on Stellar';

export default function App() {
  const [view, setView] = useState<'game' | 'leaderboard' | 'howtoplay'>('game');
  const [leaderboardWalletAddress, setLeaderboardWalletAddress] = useState<string | null>(null);
  const [viewPending, startViewTransition] = useTransition();
  const contractId = config.contractIds['clash'] || '';
  const hasContract = contractId && contractId !== 'YOUR_CONTRACT_ID';

  const toggleLeaderboard = () => {
    startViewTransition(() => {
      setView((v) => (v === 'leaderboard' ? 'game' : 'leaderboard'));
    });
  };

  const goHowToPlay = () => {
    startViewTransition(() => setView('howtoplay'));
  };

  const goArenaFromHowTo = () => {
    startViewTransition(() => setView('game'));
  };

  return (
    <Layout
      title={GAME_TITLE}
      subtitle={GAME_TAGLINE}
      contentBusy={viewPending}
      headerActions={
        <>
          <BackgroundMusic />
          {view !== 'howtoplay' ? (
            <button
              type="button"
              className="layout-leaderboard-btn"
              onClick={goHowToPlay}
              disabled={viewPending}
            >
              📜 HOW TO PLAY
            </button>
          ) : (
            <button
              type="button"
              className="layout-leaderboard-btn"
              onClick={goArenaFromHowTo}
              disabled={viewPending}
            >
              ← ARENA
            </button>
          )}
          <button
            type="button"
            className="layout-leaderboard-btn"
            onClick={toggleLeaderboard}
            disabled={viewPending}
          >
            {view === 'leaderboard' ? '← ARENA' : '🏆 LEADERBOARD'}
          </button>
        </>
      }
    >
      {view === 'howtoplay' ? (
        <HowToPlay onBack={() => startViewTransition(() => setView('game'))} />
      ) : view === 'leaderboard' ? (
        <Leaderboard userAddress={leaderboardWalletAddress} onBack={() => setView('game')} />
      ) : !hasContract ? (
        <div className="arena-card">
          <h3>Contract Not Configured</h3>
          <p style={{ color: 'var(--color-text-muted)', marginTop: '1rem' }}>
            Run <code>bun run setup</code> to deploy and configure testnet contract IDs, or set
            <code>VITE_CLASH_CONTRACT_ID</code> in the root <code>.env</code>.
          </p>
          <p style={{ color: 'var(--color-text-muted)', marginTop: '0.75rem' }}>
            You can still open the <strong>points leaderboard</strong> from the header.
          </p>
        </div>
      ) : (
        <GameErrorBoundary onHowToPlay={goHowToPlay}>
          <ClashGameArena
            onOpenLeaderboard={() => setView('leaderboard')}
            onWalletAddressChange={setLeaderboardWalletAddress}
          />
        </GameErrorBoundary>
      )}
    </Layout>
  );
}
