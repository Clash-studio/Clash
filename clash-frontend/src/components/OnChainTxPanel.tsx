import { useEffect, useState } from 'react';
import { Activity, ChevronDown, ChevronUp, X } from 'lucide-react';
import { motion } from 'framer-motion';
import {
  getTxFeedSnapshot,
  subscribeTxFeed,
  updateTxFeedEntry,
  explorerTxUrl,
  type OnChainTxEntry,
} from '@/utils/onChainTxFeed';
import { pollTransactionMeta } from '@/utils/sorobanTxMeta';
import './OnChainTxPanel.css';

function stroopsToXlmString(stroops: string | null): string {
  if (stroops == null || stroops === '') return '—';
  try {
    const n = BigInt(stroops);
    const whole = n / 10_000_000n;
    const frac = n % 10_000_000n;
    if (frac === 0n) return `${whole} XLM`;
    const fracStr = frac.toString().padStart(7, '0').replace(/0+$/, '');
    return `${whole}.${fracStr} XLM`;
  } catch {
    return '—';
  }
}

function statusLabel(e: OnChainTxEntry): string {
  if (e.source === 'local') return 'Synced';
  switch (e.status) {
    case 'submitting':
      return 'Submitting';
    case 'pending':
      return 'Confirming…';
    case 'success':
      return 'Included';
    case 'failed':
      return 'Failed';
    case 'not_found':
      return 'Unknown';
    default:
      return e.status;
  }
}

export function OnChainTxPanel() {
  const [rows, setRows] = useState<OnChainTxEntry[]>(getTxFeedSnapshot);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => subscribeTxFeed(() => setRows(getTxFeedSnapshot())), []);

  useEffect(() => {
    const tick = async () => {
      const list = getTxFeedSnapshot();
      for (const e of list) {
        if (e.source !== 'chain' || e.hash == null || e.status !== 'pending') continue;
        try {
          const m = await pollTransactionMeta(e.hash);
          if (m.status === 'pending') continue;
          updateTxFeedEntry(e.hash, {
            status: m.status,
            feeStroops: m.feeStroops,
            ledger: m.ledger,
          });
        } catch {
          /* RPC hiccup — retry next tick */
        }
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2500);
    return () => window.clearInterval(id);
  }, []);

  return (
    <>
      <aside className="tx-mini-box" aria-label="On-chain mini activity box">
        <button className="tx-mini-header" type="button" onClick={() => setOpen(true)}>
          <span className={`tx-mini-dot ${rows.length === 0 ? 'empty' : rows.some((r) => r.status === 'pending') ? 'pending' : 'settled'}`}>◉</span>
          <span className="tx-mini-title">On-Chain Activity</span>
          <span className="tx-mini-open">↗ ALL</span>
        </button>
        <ul className="tx-mini-list">
          {rows.length === 0 ? (
            <li className="tx-mini-empty">
              <em>No transactions yet</em>
              <small>Submit an action to start</small>
            </li>
          ) : (
            rows.slice(0, 5).map((e) => {
              const key = e.hash ?? e.id;
              const expandedError = expanded[key];
              return (
                <motion.li
                  layout
                  initial={{ y: 12, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.25 }}
                  key={e.id}
                  className={`tx-mini-row ${e.status === 'success' ? 'flash-success' : ''} ${e.status === 'failed' ? 'flash-failed' : ''}`}
                >
                  <div className="tx-mini-row-top">
                    <span className={`tx-mini-status-dot ${e.status}`}>●</span>
                    <span className="tx-mini-label">{e.label}</span>
                    <span className="tx-mini-state">{statusLabel(e)}</span>
                  </div>
                  <div className="tx-mini-meta">
                    Fee: {e.source === 'local' ? '—' : stroopsToXlmString(e.feeStroops)} {e.ledger != null ? ` Ledger #${e.ledger}` : ''}
                  </div>
                  {e.hash && (
                    <a className="tx-mini-link" href={explorerTxUrl(e.hash)} target="_blank" rel="noopener noreferrer">
                      ↗ Explorer
                    </a>
                  )}
                  {e.status === 'failed' && e.detail && (
                    <>
                      <button className="tx-mini-expand" type="button" onClick={() => setExpanded((v) => ({ ...v, [key]: !expandedError }))}>
                        {expandedError ? '∧' : '∨'}
                      </button>
                      {expandedError && <pre className="tx-mini-error">{e.detail}</pre>}
                    </>
                  )}
                </motion.li>
              );
            })
          )}
        </ul>
      </aside>

      <aside className={`onchain-drawer ${open ? 'is-open' : ''}`} aria-label="On-chain transactions">
        <div className="onchain-tx-panel__header">
          <div>
            <span className="onchain-tx-panel__title">On-chain activity</span>
            <span className="onchain-tx-panel__hint">chain + session sync</span>
          </div>
          <button className="tx-close" onClick={() => setOpen(false)} aria-label="Close feed">
            <X size={14} />
          </button>
        </div>
        <ul className="onchain-tx-panel__list">
          {rows.length === 0 ? (
            <li className="onchain-tx-panel__empty">No transactions yet</li>
          ) : (
            rows.slice(0, 20).map((e) => {
              const key = e.hash ?? e.id;
              const expandedError = expanded[key];
              return (
                <li key={e.id} className="onchain-tx-panel__row">
                  <div className="onchain-tx-panel__row-top">
                    <span className="onchain-tx-panel__label">
                      <Activity size={12} /> {e.label}
                    </span>
                    <span
                      className={`onchain-tx-panel__status onchain-tx-panel__status--${e.source === 'local' ? 'local' : e.status}`}
                    >
                      {statusLabel(e)}
                    </span>
                  </div>
                  {e.detail && (
                    <div className="onchain-tx-panel__detail">
                      {e.status === 'failed' ? (
                        <>
                          {expandedError ? e.detail : `${e.detail.slice(0, 96)}...`}
                          <button
                            className="expand-link"
                            type="button"
                            onClick={() => setExpanded((v) => ({ ...v, [key]: !expandedError }))}
                          >
                            {expandedError ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                          </button>
                        </>
                      ) : (
                        e.detail
                      )}
                    </div>
                  )}
                  <div className="onchain-tx-panel__row-meta">
                    <span>Fee: {e.source === 'local' ? '—' : stroopsToXlmString(e.feeStroops)}</span>
                    {e.ledger != null && <span>Ledger: #{e.ledger}</span>}
                  </div>
                  {e.hash && (
                    <a className="onchain-tx-panel__hash" href={explorerTxUrl(e.hash)} target="_blank" rel="noopener noreferrer">
                      {e.hash.slice(0, 10)}…{e.hash.slice(-6)}
                    </a>
                  )}
                </li>
              );
            })
          )}
        </ul>
      </aside>
    </>
  );
}
