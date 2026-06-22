import { Component, type ErrorInfo, type ReactNode } from 'react';
import './GameErrorBoundary.css';

interface Props {
  children: ReactNode;
  /** Navigate to the How to Play view. Optional — falls back to a full reload. */
  onHowToPlay?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Catches render/runtime errors thrown inside the game outlet (WASM/ZK failures,
 * etc.) so they show a recoverable fallback instead of white-screening the whole
 * app. Wrap only the game view — the Layout/header shell stays mounted and usable.
 */
export class GameErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('GameErrorBoundary caught an error:', error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleHowToPlay = () => {
    if (this.props.onHowToPlay) {
      this.setState({ hasError: false, error: null });
      this.props.onHowToPlay();
    } else {
      window.location.reload();
    }
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="game-error-boundary" role="alert">
        <div className="game-error-card">
          <div className="game-error-icon" aria-hidden="true">
            ⚠️
          </div>
          <h2 className="game-error-title">The arena hit a snag</h2>
          <p className="game-error-message">
            Something went wrong while loading the duel. This is usually a transient proof or
            on-chain hiccup — reloading the arena clears it.
          </p>
          {this.state.error?.message ? (
            <pre className="game-error-detail">{this.state.error.message}</pre>
          ) : null}
          <div className="game-error-actions">
            <button type="button" className="game-error-btn game-error-btn--primary" onClick={this.handleReload}>
              🔄 RELOAD ARENA
            </button>
            <button type="button" className="game-error-btn" onClick={this.handleHowToPlay}>
              📜 HOW TO PLAY
            </button>
          </div>
        </div>
      </div>
    );
  }
}
