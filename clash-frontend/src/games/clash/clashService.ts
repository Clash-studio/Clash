import { 
  Client as ClashGameClient, 
  type Game, 
  type Challenge, 
  type GamePlayback, 
  type Move,
  type BattleResult,
  type PvPMatch,
  type MatchState,
  Attack,
  Defense
} from './bindings';
import type { Result, u32 } from '@stellar/stellar-sdk/contract';
import type { SmartAccountService } from './smartAccountService';
import { NETWORK_PASSPHRASE, RPC_URL, DEFAULT_METHOD_OPTIONS, DEFAULT_AUTH_TTL_MINUTES, MULTI_SIG_AUTH_TTL_MINUTES } from '@/utils/constants';
import { contract, TransactionBuilder, StrKey, xdr, Address, authorizeEntry, rpc } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';
import { signAndSendViaLaunchtube } from '@/utils/transactionHelper';
import { calculateValidUntilLedger } from '@/utils/ledgerUtils';
import { injectSignedAuthEntry } from '@/utils/authEntryUtils';
import { submitPointsRecordAfterResolve, type PointsRecordStatus } from '@/services/pointsService';
import { requestCache, createCacheKey } from '@/utils/requestCache';

type ClientOptions = contract.ClientOptions;

/** Dedupe window for username <-> address lookups (ms). Keeps concurrent reads to one RPC. */
const USERNAME_LOOKUP_TTL = 5000;

function unwrapResultU32(res: Result<u32> | null | undefined): number {
  if (res == null) {
    throw new Error('Missing contract return value (expected simulated create_invite result)');
  }
  const anyRes = res as {
    isOk?: () => boolean;
    unwrap?: () => bigint | number;
    unwrapErr?: () => unknown;
    tag?: string;
    values?: readonly unknown[];
  };
  if (typeof anyRes.isOk === 'function') {
    if (!anyRes.isOk()) {
      const err =
        typeof anyRes.unwrapErr === 'function' ? anyRes.unwrapErr() : 'contract error';
      throw new Error(`create_invite: ${String(err)}`);
    }
    if (typeof anyRes.unwrap === 'function') return Number(anyRes.unwrap());
  }
  if (anyRes.tag === 'Ok' && anyRes.values?.length) {
    return Number(anyRes.values[0]);
  }
  throw new Error(`Unexpected Result<u32> shape: ${JSON.stringify(res)}`);
}

/** smart-account-kit `signAndSubmit` / legacy path return `TransactionResult`-shaped objects */
function assertSmartAccountSubmitResult(result: unknown, action: string): void {
  if (result == null) {
    throw new Error(`${action}: empty submission result`);
  }
  const r = result as { success?: boolean; error?: string };
  if (r.success === false) {
    throw new Error(`${action}: ${r.error ?? 'transaction failed'}`);
  }
  if (r.success === true) return;
  throw new Error(`${action}: unexpected submission result: ${JSON.stringify(result)}`);
}

function isMissingContextRulesSimulation(msg: string): boolean {
  if (!msg.includes('get_context_rules')) return false;
  const m = msg.toLowerCase();
  return (
    m.includes('non-existent') ||
    m.includes('missingvalue') ||
    m.includes('wasmvm')
  );
}

/** Passkey wallet WASM on-chain must expose get_context_rules (stellar-accounts / smart-account-kit). */
function rethrowWithSmartAccountWasmHint(err: unknown, action: string): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (isMissingContextRulesSimulation(msg)) {
    throw new Error(
      `${action}: Simulation hit your smart account contract without a working get_context_rules export. ` +
        `Create a new passkey wallet with "Create Fresh Wallet" (uses VITE_ACCOUNT_WASM_HASH) or deploy a stellar-accounts-compatible wallet; older wallets cannot authorize Clash calls. Original: ${msg}`
    );
  }
  throw err instanceof Error ? err : new Error(String(err));
}

/**
 * Service for interacting with the ClashGame contract

 */
export class ClashGameService {
  private baseClient: ClashGameClient;
  private contractId: string;

  constructor(contractId: string) {
    this.contractId = contractId;   
    this.baseClient = new ClashGameClient({
      contractId: this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      allowHttp: RPC_URL.startsWith('http://'),
    });
  }

  /**
   * Create a client with signing capabilities
   */
  private createSigningClient(
    publicKey: string,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>
  ): ClashGameClient {
    const options: ClientOptions = {
      contractId: this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL, 
      allowHttp: RPC_URL.startsWith('http://'), 
      publicKey,
      ...signer,
    };
    return new ClashGameClient(options);
  }

  // ========================================================================
  // Username Management
  // ========================================================================

  async setUsername(
    caller: string,
    username: string,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ) {
    const client = this.createSigningClient(caller, signer);
    const tx = await client.set_username({
      caller,
      username,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);

    try {
      const sentTx = await signAndSendViaLaunchtube(
        tx,
        DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
        validUntilLedgerSeq
      );

      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        const errorMessage = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
        throw new Error(`Transaction failed: ${errorMessage}`);
      }

      this.invalidateUsernameCache(caller, username);
      return sentTx.result;
    } catch (err) {
      if (err instanceof Error && err.message.includes('Transaction failed!')) {
        throw new Error('Failed to set username - it may already be taken or invalid');
      }
      throw err;
    }
  }

  /** Drop cached username/address lookups after a successful set_username so reads reflect the new mapping. */
  private invalidateUsernameCache(address: string, username: string): void {
    requestCache.invalidate(createCacheKey(this.contractId, 'get_username', address));
    requestCache.invalidate(createCacheKey(this.contractId, 'get_address_by_username', username));
  }

  async getUsername(address: string): Promise<string | null> {
    return requestCache.dedupe(
      createCacheKey(this.contractId, 'get_username', address),
      async () => {
        try {
          const tx = await this.baseClient.get_username({ address });
          const result = await tx.simulate();
          return result.result || null;
        } catch (err) {
          console.log('[getUsername] Error querying username:', err);
          return null;
        }
      },
      USERNAME_LOOKUP_TTL
    );
  }

  async getAddressByUsername(username: string): Promise<string | null> {
    return requestCache.dedupe(
      createCacheKey(this.contractId, 'get_address_by_username', username),
      async () => {
        try {
          const tx = await this.baseClient.get_address_by_username({ username });
          const result = await tx.simulate();
          return result.result || null;
        } catch (err) {
          console.log('[getAddressByUsername] Error querying address:', err);
          return null;
        }
      },
      USERNAME_LOOKUP_TTL
    );
  }

  async getCshBalance(player: string): Promise<bigint> {
    try {
      const tx = await (this.baseClient as any).get_csh_balance({ player });
      const result = await tx.simulate();
      const raw = result?.result;
      if (typeof raw === 'bigint') return raw;
      if (typeof raw === 'number') return BigInt(raw);
      if (typeof raw === 'string') return BigInt(raw);
      return 0n;
    } catch (err) {
      console.log('[getCshBalance] Error querying CSH balance:', err);
      return 0n;
    }
  }

  // ========================================================================
  // Challenge System
  // ========================================================================

  async sendChallenge(
    challenger: string,
    challenged: string,
    pointsWagered: bigint,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ) {
    const client = this.createSigningClient(challenger, signer);
    const tx = await client.send_challenge({
      challenger,
      challenged,
      points_wagered: pointsWagered,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);

    try {
      const sentTx = await signAndSendViaLaunchtube(
        tx,
        DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
        validUntilLedgerSeq
      );

      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        const errorMessage = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
        throw new Error(`Transaction failed: ${errorMessage}`);
      }

      return sentTx.result;
    } catch (err) {
      if (err instanceof Error && err.message.includes('Transaction failed!')) {
        throw new Error('Failed to send challenge - cannot challenge yourself');
      }
      throw err;
    }
  }

  async acceptChallenge(
    challengeId: number,
    challenged: string,
    sessionId: number,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ) {
    const client = this.createSigningClient(challenged, signer);
    const tx = await client.accept_challenge({
      challenge_id: challengeId,
      challenged,
      session_id: sessionId,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);

    try {
      const sentTx = await signAndSendViaLaunchtube(
        tx,
        DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
        validUntilLedgerSeq
      );

      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        const errorMessage = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
        throw new Error(`Transaction failed: ${errorMessage}`);
      }

      return sentTx.result;
    } catch (err) {
      if (err instanceof Error && err.message.includes('Transaction failed!')) {
        throw new Error('Failed to accept challenge - it may have expired or not exist');
      }
      throw err;
    }
  }

  async getPlayerChallenges(player: string): Promise<{
    active: Challenge[];
    completed: Challenge[];
    expired: Challenge[];
  }> {
    try {
      const tx = await this.baseClient.get_player_challenges({ player });
      const result = await tx.simulate();

      const [active, completed, expired] = result.result;

      return {
        active: active || [],
        completed: completed || [],
        expired: expired || [],
      };
    } catch (err) {
      console.log('[getPlayerChallenges] Error querying challenges:', err);
      return {
        active: [],
        completed: [],
        expired: [],
      };
    }
  }

  async setUsernameWithSmartAccount(
    caller: string,
    username: string,
    smartAccountService: SmartAccountService
  ): Promise<void> {
    try {
      await smartAccountService.ensureSigningReady();
      const tx = await this.baseClient.set_username({ caller, username }, DEFAULT_METHOD_OPTIONS);
      const result = await smartAccountService.signAndSubmit(tx, {
        label: 'set_username',
        clashContractId: this.contractId,
      });
      assertSmartAccountSubmitResult(result, 'set_username');
      this.invalidateUsernameCache(caller, username);
    } catch (error) {
      console.error('❌ set_username failed:', error);
      rethrowWithSmartAccountWasmHint(error, 'set_username');
    }
  }

  async sendChallengeWithSmartAccount(
    challenger: string,
    challenged: string,
    pointsWagered: bigint,
    smartAccountService: SmartAccountService
  ): Promise<void> {
    try {
      await smartAccountService.ensureSigningReady();
      const tx = await this.baseClient.send_challenge(
        {
          challenger,
          challenged,
          points_wagered: pointsWagered,
        },
        DEFAULT_METHOD_OPTIONS
      );
      const result = await smartAccountService.signAndSubmit(tx, {
        label: 'send_challenge',
        clashContractId: this.contractId,
      });
      assertSmartAccountSubmitResult(result, 'send_challenge');
    } catch (error) {
      console.error('❌ send_challenge failed:', error);
      rethrowWithSmartAccountWasmHint(error, 'send_challenge');
    }
  }

  async acceptChallengeWithSmartAccount(
    challengeId: number,
    challenged: string,
    sessionId: number,
    smartAccountService: SmartAccountService
  ): Promise<void> {
    try {
      await smartAccountService.ensureSigningReady();
      const tx = await this.baseClient.accept_challenge(
        {
          challenge_id: challengeId,
          challenged,
          session_id: sessionId,
        },
        DEFAULT_METHOD_OPTIONS
      );
      const result = await smartAccountService.signAndSubmit(tx, {
        label: 'accept_challenge',
        clashContractId: this.contractId,
      });
      assertSmartAccountSubmitResult(result, 'accept_challenge');
    } catch (error) {
      console.error('❌ accept_challenge failed:', error);
      rethrowWithSmartAccountWasmHint(error, 'accept_challenge');
    }
  }

  // ========================================================================
  // Game Flow 
  // ========================================================================

  async getGame(sessionId: number): Promise<Game | null> {
    try {
      const tx = await this.baseClient.get_game({ session_id: sessionId });
      const result = await tx.simulate();

      if (result.result.isOk()) {
        return result.result.unwrap();
      } else {
        console.log('[getGame] Game not found for session:', sessionId);
        return null;
      }
    } catch (err) {
      console.log('[getGame] Error querying game:', err);
      return null;
    }
  }

  async startGame(
    sessionId: number,
    player1: string,
    player2: string,
    player1Points: bigint,
    player2Points: bigint,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ) {
    const client = this.createSigningClient(player1, signer);
    const tx = await client.start_game({
      session_id: sessionId,
      player1,
      player2,
      player1_points: player1Points,
      player2_points: player2Points,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);

    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      validUntilLedgerSeq
    );
    const txHash = sentTx.sendTransactionResponse?.hash;
    console.log(`[Start_game] ✅ tx hash: ${txHash}`);
    return sentTx.result;
  }

  /**
   * Commit moves with ZK proof
   *  
   * @param publicInputs - The public inputs from the ZK proof (includes commitment hash)
   * @param proofBytes - The proof bytes
   */
  async commitMoves(
    sessionId: number,
    player: string,
    publicInputs: Uint8Array | Buffer,
    proofBytes: Uint8Array | Buffer,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ) {
    const client = this.createSigningClient(player, signer);
    
    // Convert to Buffer if needed
    const publicInputsBuffer = Buffer.isBuffer(publicInputs) ? publicInputs : Buffer.from(publicInputs);
    const proofBytesBuffer = Buffer.isBuffer(proofBytes) ? proofBytes : Buffer.from(proofBytes);
    
    const tx = await client.commit_moves({
      session_id: sessionId,
      player,
      public_inputs: publicInputsBuffer,
      proof_bytes: proofBytesBuffer,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);

    try {
      const sentTx = await signAndSendViaLaunchtube(
        tx,
        DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
        validUntilLedgerSeq
      );

      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        const errorMessage = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
        throw new Error(`Transaction failed: ${errorMessage}`);
      }
      console.log(`[commitMoves] ✅ tx hash: ${sentTx.sendTransactionResponse?.hash}`);
      return sentTx.result;
    } catch (err) {
      if (err instanceof Error && err.message.includes('Transaction failed!')) {
        throw new Error('Failed to commit moves - proof may be invalid or you already committed');
      }
      throw err;
    }
  }

  /**
   * Reveal moves after both players have committed
 
   * NO proof_bytes parameter - contract re-derives hash from public_inputs and compares to stored commitment
   * 
   * @param publicInputs - The SAME public inputs from commit phase
   * @param moves - Array of 3 moves (attack + defense pairs) in plaintext
   */
  async revealMoves(
    sessionId: number,
    player: string,
    publicInputs: Uint8Array | Buffer,
    moves: Move[],
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ) {
    if (moves.length !== 3) {
      throw new Error('Must provide exactly 3 moves');
    }

    const client = this.createSigningClient(player, signer);
    
    // Convert to Buffer if needed
    const publicInputsBuffer = Buffer.isBuffer(publicInputs) ? publicInputs : Buffer.from(publicInputs);
    
    const tx = await client.reveal_moves({
      session_id: sessionId,
      player,
      public_inputs: publicInputsBuffer,
      moves,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);

    try {
      const sentTx = await signAndSendViaLaunchtube(
        tx,
        DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
        validUntilLedgerSeq
      );

      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        const errorMessage = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
        throw new Error(`Transaction failed: ${errorMessage}`);
      }
      console.log(`[revealMoves] ✅ tx hash: ${sentTx.sendTransactionResponse?.hash}`);
      return sentTx.result;
    } catch (err) {
      if (err instanceof Error && err.message.includes('Transaction failed!')) {
        throw new Error('Failed to reveal moves - both players must commit first and commitment must match');
      }
      throw err;
    }
  }

  /**
   * Resolve the battle after both players have revealed
   * NO player/callerAddress parameter needed - anyone can call once both players have revealed
   * But we still need a signer to sign the transaction
   */
  async resolveBattle(
    sessionId: number,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    callerAddress?: string,
    authTtlMinutes?: number
  ): Promise<BattleResult> {

    const address = callerAddress || 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    
    const client = this.createSigningClient(address, signer);
    const tx = await client.resolve_battle({ 
      session_id: sessionId 
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);

    try {
      const sentTx = await signAndSendViaLaunchtube(
        tx,
        DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
        validUntilLedgerSeq
      );

      if (sentTx.getTransactionResponse?.status === 'FAILED') {
        const errorMessage = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
        throw new Error(`Transaction failed: ${errorMessage}`);
      }

      
      if (sentTx.result.isOk && sentTx.result.isOk()) {
        console.log(`[resolveBattle] ✅ tx hash: ${sentTx.sendTransactionResponse?.hash}`);
        return sentTx.result.unwrap();
      }

      throw new Error('Failed to resolve battle');
    } catch (err) {
      if (err instanceof Error && err.message.includes('Transaction failed!')) {
        throw new Error('Failed to resolve battle - both players must reveal their moves first');
      }
      throw err;
    }
  }

  async getGamePlayback(sessionId: number): Promise<GamePlayback | null> {
    try {
      const tx = await this.baseClient.get_game_playback({ session_id: sessionId });
      const result = await tx.simulate();

      if (result.result.isOk && result.result.isOk()) {
        return result.result.unwrap();
      } else {
        console.log('[getGamePlayback] Playback not available for session:', sessionId);
        return null;
      }
    } catch (err) {
      console.log('[getGamePlayback] Error querying playback:', err);
      return null;
    }
  }

  // ========================================================================
  // PVP Match Functions
  // ========================================================================

  async createInvite(
    inviter: string,
    opponent: string,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>
  ): Promise<number> {
    const client = this.createSigningClient(inviter, signer);
    const tx = await client.create_invite({ inviter, opponent });
    const sentTx = await signAndSendViaLaunchtube(tx);

    if (sentTx.getTransactionResponse?.status === 'FAILED') {
      const errorMessage = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
      throw new Error(`Failed to create invite: ${errorMessage}`);
    }

    if (sentTx.result.isOk && sentTx.result.isOk()) {
      console.log(`[createInvite] ✅ tx hash: ${sentTx.sendTransactionResponse?.hash}`);
      return sentTx.result.unwrap();
    }

    throw new Error('Failed to create invite');
  }

  async acceptInvite(
    accepter: string,
    matchId: number,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>
  ): Promise<void> {
    const client = this.createSigningClient(accepter, signer);
    const tx = await client.accept_invite({ accepter, match_id: matchId });
    const sentTx = await signAndSendViaLaunchtube(tx);

    if (sentTx.getTransactionResponse?.status === 'FAILED') {
      const errorMessage = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
      throw new Error(`Failed to accept invite: ${errorMessage}`);
    }

    if (sentTx.result.isOk && sentTx.result.isOk()) {
      console.log(`[acceptInvite] ✅ tx hash: ${sentTx.sendTransactionResponse?.hash}`);
      return;
    }

    throw new Error('Failed to accept invite');
  }

  async rejectInvite(
    rejecter: string,
    matchId: number,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>
  ): Promise<void> {
    const client = this.createSigningClient(rejecter, signer);
    const tx = await client.reject_invite({ rejecter, match_id: matchId });
    const sentTx = await signAndSendViaLaunchtube(tx);

    if (sentTx.getTransactionResponse?.status === 'FAILED') {
      const errorMessage = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
      throw new Error(`Failed to reject invite: ${errorMessage}`);
    }

    if (sentTx.result.isOk && sentTx.result.isOk()) {
      console.log(`[rejectInvite] ✅ tx hash: ${sentTx.sendTransactionResponse?.hash}`);
      return;
    }

    throw new Error('Failed to reject invite');
  }

  async playTurn(
    player: string,
    matchId: number,
    move: Move,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>
  ): Promise<void> {
    const client = this.createSigningClient(player, signer);
    const tx = await client.play_turn({ player, match_id: matchId, action: move });
    const sentTx = await signAndSendViaLaunchtube(tx);

    if (sentTx.getTransactionResponse?.status === 'FAILED') {
      const errorMessage = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
      throw new Error(`Failed to play turn: ${errorMessage}`);
    }

    if (sentTx.result.isOk && sentTx.result.isOk()) {
      console.log(`[playTurn] ✅ tx hash: ${sentTx.sendTransactionResponse?.hash}`);
      return;
    }

    throw new Error('Failed to play turn');
  }

  async endMatch(
    player: string,
    matchId: number,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>
  ): Promise<void> {
    const client = this.createSigningClient(player, signer);
    const tx = await client.end_match({ player, match_id: matchId });
    const sentTx = await signAndSendViaLaunchtube(tx);

    if (sentTx.getTransactionResponse?.status === 'FAILED') {
      const errorMessage = this.extractErrorFromDiagnostics(sentTx.getTransactionResponse);
      throw new Error(`Failed to end match: ${errorMessage}`);
    }

    if (sentTx.result.isOk && sentTx.result.isOk()) {
      console.log(`[endMatch] ✅ tx hash: ${sentTx.sendTransactionResponse?.hash}`);
      return;
    }

    throw new Error('Failed to end match');
  }

  async getMatch(matchId: number): Promise<PvPMatch> {
    const tx = await this.baseClient.get_match({ match_id: matchId });
    const result = await tx.simulate();

    if (result.result.isOk && result.result.isOk()) {
      return result.result.unwrap();
    }

    throw new Error('Failed to get match');
  }

  async getPlayerMatches(player: string): Promise<number[]> {
    const tx = await this.baseClient.get_player_matches({ player });
    const sim = await tx.simulate();
    const raw = sim.result;
    if (raw == null) {
      throw new Error('Failed to get player matches');
    }
    const asAny = raw as {
      isOk?: () => boolean;
      unwrap?: () => unknown;
    };
    let vec: unknown = raw;
    if (typeof asAny.isOk === 'function' && typeof asAny.unwrap === 'function') {
      if (!asAny.isOk()) {
        throw new Error('get_player_matches returned an error');
      }
      vec = asAny.unwrap();
    }
    if (Array.isArray(vec)) {
      return vec.map((n) => Number(n));
    }
    if (vec && typeof vec === 'object' && Symbol.iterator in vec) {
      return Array.from(vec as unknown as ArrayLike<number>).map(Number);
    }
    throw new Error('Unexpected get_player_matches return shape');
  }

  // ========================================================================
  // Multi-Sig Game Start 
  // ========================================================================

  async prepareStartGame(
    sessionId: number,
    player1: string,
    player2: string,
    player1Points: bigint,
    player2Points: bigint,
    player1Signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ): Promise<string> {
    const buildClient = new ClashGameClient({
      contractId: this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      allowHttp: RPC_URL.startsWith('http://'),
      publicKey: player2,
    });

    const tx = await buildClient.start_game({
      session_id: sessionId,
      player1,
      player2,
      player1_points: player1Points,
      player2_points: player2Points,
    }, DEFAULT_METHOD_OPTIONS);

    console.log('[prepareStartGame] Transaction built and simulated, extracting auth entries');

    if (!tx.simulationData?.result?.auth) {
      throw new Error('No auth entries found in simulation');
    }

    const authEntries = tx.simulationData.result.auth;
    console.log('[prepareStartGame] Found', authEntries.length, 'auth entries in simulation');

    let player1AuthEntry = null;

    for (let i = 0; i < authEntries.length; i++) {
      const entry = authEntries[i];
      try {
        const entryAddress = entry.credentials().address().address();
        const entryAddressString = Address.fromScAddress(entryAddress).toString();

        if (entryAddressString === player1) {
          player1AuthEntry = entry;
          console.log(`[prepareStartGame] Found Player 1 auth entry at index ${i}`);
          break;
        }
      } catch (err) {
        continue;
      }
    }

    if (!player1AuthEntry) {
      throw new Error(`No auth entry found for Player 1 (${player1})`);
    }

    const validUntilLedgerSeq = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, MULTI_SIG_AUTH_TTL_MINUTES);

    if (!player1Signer.signAuthEntry) {
      throw new Error('signAuthEntry function not available');
    }

    const signedAuthEntry = await authorizeEntry(
      player1AuthEntry,
      async (preimage) => {
        if (!player1Signer.signAuthEntry) {
          throw new Error('Wallet does not support auth entry signing');
        }

        const signResult = await player1Signer.signAuthEntry(
          preimage.toXDR('base64'),
          {
            networkPassphrase: NETWORK_PASSPHRASE,
            address: player1,
          }
        );

        if (signResult.error) {
          throw new Error(`Failed to sign auth entry: ${signResult.error.message}`);
        }

        return Buffer.from(signResult.signedAuthEntry, 'base64');
      },
      validUntilLedgerSeq,
      NETWORK_PASSPHRASE,
    );

    const signedAuthEntryXdr = signedAuthEntry.toXDR('base64');
    console.log('[prepareStartGame] ✅ Successfully signed and exported Player 1 auth entry');
    return signedAuthEntryXdr;
  }

  parseAuthEntry(authEntryXdr: string): {
    sessionId: number;
    player1: string;
    player1Points: bigint;
    functionName: string;
  } {
    try {
      const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, 'base64');

      const credentials = authEntry.credentials();
      const addressCreds = credentials.address();
      const player1Address = addressCreds.address();
      const player1 = Address.fromScAddress(player1Address).toString();

      const rootInvocation = authEntry.rootInvocation();
      const authorizedFunction = rootInvocation.function();
      const contractFn = authorizedFunction.contractFn();
      const functionName = contractFn.functionName().toString();

      if (functionName !== 'start_game') {
        throw new Error(`Unexpected function: ${functionName}. Expected start_game.`);
      }

      const args = contractFn.args();

      if (args.length !== 2) {
        throw new Error(`Expected 2 arguments for start_game auth entry, got ${args.length}`);
      }

      const sessionId = args[0].u32();
      const player1Points = args[1].i128().lo().toBigInt();

      return {
        sessionId,
        player1,
        player1Points,
        functionName,
      };
    } catch (err: any) {
      console.error('[parseAuthEntry] Error parsing auth entry:', err);
      throw new Error(`Failed to parse auth entry: ${err.message}`);
    }
  }

  async importAndSignAuthEntry(
    player1SignedAuthEntryXdr: string,
    player2Address: string,
    player2Points: bigint,
    player2Signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ): Promise<string> {
    console.log('[importAndSignAuthEntry] Parsing Player 1 signed auth entry...');

    const gameParams = this.parseAuthEntry(player1SignedAuthEntryXdr);

    if (player2Address === gameParams.player1) {
      throw new Error('Cannot play against yourself. Player 2 must be different from Player 1.');
    }

    const buildClient = new ClashGameClient({
      contractId: this.contractId,
      networkPassphrase: NETWORK_PASSPHRASE,
      rpcUrl: RPC_URL,
      allowHttp: RPC_URL.startsWith('http://'),
      publicKey: player2Address,
    });

    const tx = await buildClient.start_game({
      session_id: gameParams.sessionId,
      player1: gameParams.player1,
      player2: player2Address,
      player1_points: gameParams.player1Points,
      player2_points: player2Points,
    }, DEFAULT_METHOD_OPTIONS);

    const validUntilLedgerSeq = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, MULTI_SIG_AUTH_TTL_MINUTES);

    const txWithInjectedAuth = await injectSignedAuthEntry(
      tx,
      player1SignedAuthEntryXdr,
      player2Address,
      player2Signer,
      validUntilLedgerSeq
    );

    const player2Client = this.createSigningClient(player2Address, player2Signer);
    const player2Tx = player2Client.txFromXDR(txWithInjectedAuth.toXDR());

    const needsSigning = await player2Tx.needsNonInvokerSigningBy();

    if (needsSigning.includes(player2Address)) {
      console.log('[importAndSignAuthEntry] Signing Player 2 auth entry');
      await player2Tx.signAuthEntries({ expiration: validUntilLedgerSeq });
    }

    return player2Tx.toXDR();
  }

  async finalizeStartGame(
    xdr: string,
    signerAddress: string,
    signer: Pick<contract.ClientOptions, 'signTransaction' | 'signAuthEntry'>,
    authTtlMinutes?: number
  ) {
    const client = this.createSigningClient(signerAddress, signer);
    const tx = client.txFromXDR(xdr);

    await tx.simulate();

    const validUntilLedgerSeq = authTtlMinutes
      ? await calculateValidUntilLedger(RPC_URL, authTtlMinutes)
      : await calculateValidUntilLedger(RPC_URL, DEFAULT_AUTH_TTL_MINUTES);

    const sentTx = await signAndSendViaLaunchtube(
      tx,
      DEFAULT_METHOD_OPTIONS.timeoutInSeconds,
      validUntilLedgerSeq
    );
    console.log(`[finalizeStartGame] ✅ tx hash: ${sentTx.sendTransactionResponse?.hash}`);
    return sentTx.result;
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

  createMove(attack: Attack, defense: Defense): Move {
    return { attack, defense };
  }

  async checkRequiredSignatures(
    xdr: string,
    publicKey: string
  ): Promise<string[]> {
    const client = this.createSigningClient(publicKey, {
      signTransaction: async (xdr: string) => ({ signedTxXdr: xdr }),
      signAuthEntry: async (xdr: string) => ({ signedAuthEntry: xdr }),
    });

    const tx = client.txFromXDR(xdr);
    const needsSigning = await tx.needsNonInvokerSigningBy();
    return needsSigning;
  }

  private extractErrorFromDiagnostics(transactionResponse: any): string {
    try {
      console.error('Transaction response:', JSON.stringify(transactionResponse, null, 2));

      const diagnosticEvents = transactionResponse?.diagnosticEventsXdr ||
                              transactionResponse?.diagnostic_events || [];

      for (const event of diagnosticEvents) {
        if (event?.topics) {
          const topics = Array.isArray(event.topics) ? event.topics : [];

          const hasErrorTopic = topics.some((topic: any) =>
            topic?.symbol === 'error' ||
            topic?.error
          );

          if (hasErrorTopic && event.data) {
            if (typeof event.data === 'string') {
              return event.data;
            } else if (event.data.vec && Array.isArray(event.data.vec)) {
              const messages = event.data.vec
                .filter((item: any) => item?.string)
                .map((item: any) => item.string);
              if (messages.length > 0) {
                return messages.join(': ');
              }
            }
          }
        }
      }

      const status = transactionResponse?.status || 'Unknown';
      return `Transaction ${status}. Check console for details.`;
    } catch (err) {
      console.error('Failed to extract error from diagnostics:', err);
      return 'Transaction failed with unknown error';
    }
  }

  /**
   * Create PVP invite using SmartAccount signing
   */
  async createInviteWithSmartAccount(
    inviter: string,
    opponent: string,
    smartAccountService: SmartAccountService
  ): Promise<number> {
    try {
      await smartAccountService.ensureSigningReady();
      console.log('🎮 Creating PVP invite...');
      const tx = await this.baseClient.create_invite({
        inviter,
        opponent,
      });

      const matchId = unwrapResultU32(tx.result);

      console.log('📝 Signing with SmartAccount...');
      const result = await smartAccountService.signAndSubmit(tx, {
        label: 'create_invite',
        clashContractId: this.contractId,
      });
      assertSmartAccountSubmitResult(result, 'create_invite');

      console.log('✅ Invite created with match ID:', matchId);
      return matchId;
    } catch (error) {
      console.error('❌ Create invite failed:', error);
      rethrowWithSmartAccountWasmHint(error, 'create_invite');
    }
  }

  /**
   * Accept PVP invite using SmartAccount signing
   */
  async acceptInviteWithSmartAccount(
    accepter: string,
    matchId: number,
    smartAccountService: SmartAccountService
  ): Promise<void> {
    try {
      await smartAccountService.ensureSigningReady();
      console.log('🎮 Accepting PVP invite...');
      const tx = await this.baseClient.accept_invite({
        accepter,
        match_id: matchId,
      });

      console.log('📝 Signing with SmartAccount...');
      const result = await smartAccountService.signAndSubmit(tx, {
        label: 'accept_invite',
        clashContractId: this.contractId,
      });
      assertSmartAccountSubmitResult(result, 'accept_invite');

      console.log('✅ Invite accepted');
    } catch (error) {
      console.error('❌ Accept invite failed:', error);
      rethrowWithSmartAccountWasmHint(error, 'accept_invite');
    }
  }

  /**
   * Reject PVP invite using SmartAccount signing
   */
  async rejectInviteWithSmartAccount(
    rejecter: string,
    matchId: number,
    smartAccountService: SmartAccountService
  ): Promise<void> {
    try {
      await smartAccountService.ensureSigningReady();
      console.log('🎮 Rejecting PVP invite...');
      const tx = await this.baseClient.reject_invite({
        rejecter,
        match_id: matchId,
      });

      console.log('📝 Signing with SmartAccount...');
      const result = await smartAccountService.signAndSubmit(tx, {
        label: 'reject_invite',
        clashContractId: this.contractId,
      });
      assertSmartAccountSubmitResult(result, 'reject_invite');

      console.log('✅ Invite rejected');
    } catch (error) {
      console.error('❌ Reject invite failed:', error);
      rethrowWithSmartAccountWasmHint(error, 'reject_invite');
    }
  }

  /**
   * Play turn using SmartAccount signing
   */
  async playTurnWithSmartAccount(
    player: string,
    matchId: number,
    move: Move,
    smartAccountService: SmartAccountService
  ): Promise<void> {
    try {
      await smartAccountService.ensureSigningReady();
      console.log('🎮 Playing turn...');
      const tx = await this.baseClient.play_turn({
        player,
        match_id: matchId,
        action: move,
      });

      console.log('📝 Signing with SmartAccount...');
      const result = await smartAccountService.signAndSubmit(tx, {
        label: 'play_turn',
        clashContractId: this.contractId,
      });
      assertSmartAccountSubmitResult(result, 'play_turn');

      console.log('✅ Turn played successfully');
    } catch (error) {
      console.error('❌ Play turn failed:', error);
      rethrowWithSmartAccountWasmHint(error, 'play_turn');
    }
  }

  /**
   * End match using SmartAccount signing
   */
  async endMatchWithSmartAccount(
    player: string,
    matchId: number,
    smartAccountService: SmartAccountService
  ): Promise<void> {
    try {
      await smartAccountService.ensureSigningReady();
      console.log('🎮 Ending match...');
      const tx = await this.baseClient.end_match({
        player,
        match_id: matchId,
      });

      console.log('📝 Signing with SmartAccount...');
      const result = await smartAccountService.signAndSubmit(tx, {
        label: 'end_match',
        clashContractId: this.contractId,
      });
      assertSmartAccountSubmitResult(result, 'end_match');

      console.log('✅ Match ended');
    } catch (error) {
      console.error('❌ End match failed:', error);
      rethrowWithSmartAccountWasmHint(error, 'end_match');
    }
  }

  // ========================================================================
  // ZK session game (commit / reveal) — SmartAccount signing
  // ========================================================================

  async startGameWithSmartAccount(
    sessionId: number,
    player1: string,
    player2: string,
    player1Points: bigint,
    player2Points: bigint,
    smartAccountService: SmartAccountService
  ): Promise<void> {
    try {
      await smartAccountService.ensureSigningReady();
      console.log('🎮 start_game (ZK session)...');
      const tx = await this.baseClient.start_game(
        {
          session_id: sessionId,
          player1,
          player2,
          player1_points: player1Points,
          player2_points: player2Points,
        },
        DEFAULT_METHOD_OPTIONS
      );

      const result = await smartAccountService.signAndSubmit(tx, {
        label: 'start_game',
        clashContractId: this.contractId,
      });
      assertSmartAccountSubmitResult(result, 'start_game');
      console.log('✅ Game started on-chain');
    } catch (error) {
      console.error('❌ start_game failed:', error);
      rethrowWithSmartAccountWasmHint(error, 'start_game');
    }
  }

  async commitMovesWithSmartAccount(
    sessionId: number,
    player: string,
    publicInputs: Uint8Array | Buffer,
    proofBytes: Uint8Array | Buffer,
    smartAccountService: SmartAccountService
  ): Promise<void> {
    try {
      await smartAccountService.ensureSigningReady();
      const pub = Buffer.isBuffer(publicInputs) ? publicInputs : Buffer.from(publicInputs);
      const proof = Buffer.isBuffer(proofBytes) ? proofBytes : Buffer.from(proofBytes);
      const tx = await this.baseClient.commit_moves(
        {
          session_id: sessionId,
          player,
          public_inputs: pub,
          proof_bytes: proof,
        },
        DEFAULT_METHOD_OPTIONS
      );

      const result = await smartAccountService.signAndSubmit(tx, {
        label: 'commit_moves',
        clashContractId: this.contractId,
      });
      assertSmartAccountSubmitResult(result, 'commit_moves');
      console.log('✅ commit_moves submitted');
    } catch (error) {
      console.error('❌ commit_moves failed:', error);
      rethrowWithSmartAccountWasmHint(error, 'commit_moves');
    }
  }

  async revealMovesWithSmartAccount(
    sessionId: number,
    player: string,
    publicInputs: Uint8Array | Buffer,
    moves: Move[],
    smartAccountService: SmartAccountService
  ): Promise<void> {
    if (moves.length !== 3) {
      throw new Error('Must provide exactly 3 moves');
    }
    try {
      await smartAccountService.ensureSigningReady();
      const pub = Buffer.isBuffer(publicInputs) ? publicInputs : Buffer.from(publicInputs);
      const tx = await this.baseClient.reveal_moves(
        {
          session_id: sessionId,
          player,
          public_inputs: pub,
          moves,
        },
        DEFAULT_METHOD_OPTIONS
      );

      const result = await smartAccountService.signAndSubmit(tx, {
        label: 'reveal_moves',
        clashContractId: this.contractId,
      });
      assertSmartAccountSubmitResult(result, 'reveal_moves');
      console.log('✅ reveal_moves submitted');
    } catch (error) {
      console.error('❌ reveal_moves failed:', error);
      rethrowWithSmartAccountWasmHint(error, 'reveal_moves');
    }
  }

  /**
   * Resolve the battle and record the leaderboard result.
   * Returns the leaderboard write status so the UI can show a non-blocking notice
   * when it was skipped/failed; `null` when no write applies (e.g. a draw). The
   * leaderboard step never affects the resolve outcome.
   */
  async resolveBattleWithSmartAccount(
    sessionId: number,
    smartAccountService: SmartAccountService
  ): Promise<PointsRecordStatus | null> {
    try {
      await smartAccountService.ensureSigningReady();
      const tx = await this.baseClient.resolve_battle({ session_id: sessionId }, DEFAULT_METHOD_OPTIONS);

      const result = await smartAccountService.signAndSubmit(tx, {
        label: 'resolve_battle',
        clashContractId: this.contractId,
      });
      assertSmartAccountSubmitResult(result, 'resolve_battle');
      console.log('✅ resolve_battle submitted');

      try {
        const pb = await this.getGamePlayback(sessionId);
        if (pb && !pb.is_draw) {
          const wStr = pb.winner?.toString?.() ?? '';
          if (wStr) {
            const loserAddr = wStr === pb.player1 ? pb.player2 : pb.player1;
            // Must complete before UI refreshes totals — otherwise get_points simulates stale state.
            return await submitPointsRecordAfterResolve(wStr, loserAddr);
          }
        }
      } catch (e) {
        console.warn('[resolveBattleWithSmartAccount] points tracker hook:', e);
        return 'failed';
      }
      return null;
    } catch (error) {
      console.error('❌ resolve_battle failed:', error);
      rethrowWithSmartAccountWasmHint(error, 'resolve_battle');
    }
  }
}


export { Attack, Defense };
export type { Move, Challenge, GamePlayback, BattleResult, Game };