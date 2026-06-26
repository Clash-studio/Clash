/**
 * NoirService - Handles Noir circuit execution and UltraHonk proof generation
 *
 * The bundled circuit MUST match `duel_commit_circuit/target/duel_commit_circuit.json`
 * (the VK baked into the deployed UltraHonk verifier). Run `npm run sync:duel-circuit`
 * in clash-frontend after `nargo compile` in duel_commit_circuit, or builds can prove
 * a different circuit than the chain verifies.
 *
 * Output format matches exactly what the shell script produces and what the
 * Soroban verifier contract expects:
 *
 *   verify_proof(public_inputs: Bytes, proof_bytes: Bytes)
 *
 * Where:
 *   public_inputs = [player_address (32B)] [session_id (32B)] [commitment_hash (32B)]
 *                 = 96 bytes total (3 field elements × 32 bytes each)
 *
 *   proof_bytes   = raw UltraHonk proof bytes (no public inputs prepended)
 *                 = proofData.proof from bb.js UltraHonkBackend.generateProof()
 *
 * public_inputs MUST be the exact limbs returned by the prover (flattened to
 * 32 bytes each) — not hand-rebuilt from noir.execute().returnValue. Barretenberg
 * binds the proof to those bytes; any mismatch fails verify_proof on-chain.
 *
 * This mirrors testnet-option.sh: split from `with_public_inputs` — bb.js does
 * the same split internally and exposes proofData.publicInputs as field strings.
 *
 * The commitment hash is the LAST 32 bytes of the flattened public_inputs
 * (circuit return value as ordered by the ACIR public outputs).
 * The Soroban contract extracts it with:
 *   let commitment_hash = public_inputs[len-32..len]
 */

import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';
import { initializeWasm, isWasmInitialized } from '@/services/wasmInit';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ClashProofInputs {
  attacks:        [number, number, number]; // 0=Slash 1=Fireball 2=Lightning
  defenses:       [number, number, number]; // 0=Block  1=Dodge    2=Counter
  playerAddress:  string;                   // Stellar G-address
  sessionId:      number;                   // u32 game session
}

/** Stages reported via the `onProgress` callback during proof generation. */
export type ClashProofStage = 'witness' | 'proof' | 'verify';

export interface ClashProofResult {
  /** 96 bytes: [player_address(32) | session_id(32) | commitment_hash(32)] */
  publicInputs:     Uint8Array;
  /** Raw UltraHonk proof — passed directly to verify_proof / verify_and_attest_commit */
  proofBytes:       Uint8Array;
  /** Commitment hash (last 32 bytes of publicInputs) as 0x-prefixed hex */
  commitmentHash:   string;
  /** 6-byte packed moves for verify_and_attest_reveal: [atk0,atk1,atk2,def0,def1,def2] */
  movesRaw:         Uint8Array;
  /** Wall-clock proof generation time in seconds (display only) */
  proofTime:        string;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class NoirService {

  /**
   * Generate a Clash commitment proof.
   *
   * Returns exactly the bytes the verifier contract needs — no extra framing.
   */
  async generateClashProof(
    circuitName: string,
    inputs: ClashProofInputs,
    onProgress?: (stage: ClashProofStage) => void,
  ): Promise<ClashProofResult> {
  
    // ── 0. WASM init ────────────────────────────────────────────────────────
    if (!isWasmInitialized()) {
      console.log('[NoirService] Initializing WASM...');
      await initializeWasm();
    }
  
    // ── 1. Load circuit ──────────────────────────────────────────────────────
    console.log(`[1/5] Loading circuit: ${circuitName}`);
    const response = await fetch(`/circuits/${circuitName}.json`);
    if (!response.ok) {
      throw new Error(`Failed to load circuit: ${circuitName} (${response.status})`);
    }
    const circuit = await response.json();
    
    // IMPORTANT: Verify circuit structure matches what we expect
    console.log('[1/5] Circuit ABI:', circuit.abi);
    console.log('[1/5] Bytecode length:', circuit.bytecode?.length || 'missing');
  
    // ── 2. Build Noir inputs ─────────────────────────────────────────────────
    const noirInputs = {
      attacks:        inputs.attacks.map(String),
      defenses:       inputs.defenses.map(String),
      player_address: addressToField(inputs.playerAddress),
      session_id:     `0x${inputs.sessionId.toString(16).padStart(64, '0')}`,
    };
  
    console.log('[2/5] Circuit inputs prepared:', noirInputs);
  
    // ── 3. Execute circuit → witness + return value ──────────────────────────
    onProgress?.('witness');
    console.log('[3/5] Executing circuit...');
    let witness, returnValue;
    
    try {
      const noir = new Noir(circuit);
      const result = await noir.execute(noirInputs);
      witness = result.witness;
      returnValue = result.returnValue;
      console.log('[3/5] Witness generated, return value (commitment hash):', returnValue);
    } catch (err) {
      console.error('[3/5] Circuit execution failed:', err);
      throw new Error(`Circuit execution failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  
    // ── 4. Generate UltraHonk proof ──────────────────────────────────────────
    onProgress?.('proof');
    console.log('[4/5] Generating UltraHonk proof (may take 3–10s)...');
    
    let backend;
    try {
      // Make sure bytecode is passed correctly
      backend = new UltraHonkBackend(circuit.bytecode, { threads: 1 });
    } catch (err) {
      console.error('[4/5] Backend initialization failed:', err);
      throw new Error(`Failed to initialize UltraHonk backend: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  
    const proofStart = performance.now();
    let proofData: { proof: Uint8Array; publicInputs: string[] };
    
    try {
      proofData = await backend.generateProof(witness, { keccak: true });
      const proofTime = ((performance.now() - proofStart) / 1000).toFixed(2);
      console.log(`[4/5] Proof generated in ${proofTime}s`);
    } catch (err) {
      console.error('[4/5] Proof generation failed:', err);
      throw new Error(`Proof generation failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  
    const proofBytes = proofData.proof;
  
    // ── 5. Public inputs: MUST match bb.js / prover (same as on-chain verifier) ─
    console.log('[5/5] Flattening public inputs from prover…');
    const publicInputs = flattenFieldStringsToBytes(proofData.publicInputs);
    if (publicInputs.length !== 96) {
      console.warn(
        `[NoirService] Expected 96 bytes of public inputs (3 fields), got ${publicInputs.length}`,
      );
    }

    onProgress?.('verify');
    let localOk = false;
    try {
      localOk = await backend.verifyProof(proofData, { keccak: true });
    } catch (e) {
      console.error('[5/5] Local verify threw:', e);
    }
    if (!localOk) {
      throw new Error(
        'UltraHonk local verification failed — public_inputs/proof do not match the circuit VK. ' +
          'Regenerate the proof; if this persists, redeploy the verifier VK for this circuit.',
      );
    }

    const commitmentHashBytes = publicInputs.slice(64, 96);
    const commitmentHash = '0x' + bufToHex(commitmentHashBytes);
  
    // ── 6. Build moves_raw for reveal attestation ────────────────────────────
    const movesRaw = new Uint8Array([
      ...inputs.attacks,
      ...inputs.defenses,
    ]);
  
    console.log(`[Done] Commitment hash: ${commitmentHash}`);
    console.log(`[Done] public_inputs:   ${publicInputs.length} bytes`);
    console.log(`[Done] proof_bytes:     ${proofBytes.length} bytes`);
  
    return {
      publicInputs,
      proofBytes,
      commitmentHash,
      movesRaw,
      proofTime: ((performance.now() - proofStart) / 1000).toFixed(2),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert a Stellar G-address to a Noir Field (hex string).
 *
 * The script uses a fixed 32-byte numeric like 0x00...01.
 * In the frontend we derive a deterministic 31-byte representation
 * from the UTF-8 encoding of the address so it fits in a BN254 field.
 * (BN254 field prime is ~254 bits; 31 bytes = 248 bits, always safe.)
 */
export function addressToField(stellarAddress: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(stellarAddress);
  // Take first 31 bytes — safe for BN254 field
  const hex = Array.from(bytes.slice(0, 31))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `0x${hex.padStart(62, '0')}`; // 31 bytes = 62 hex chars
}

/**
 * Convert a 0x-prefixed hex field string to a 32-byte big-endian Uint8Array.
 * Works for both circuit inputs and the return value from noir.execute().
 */
function fieldToBytes32(hexValue: string): Uint8Array {
  const clean = hexValue.startsWith('0x') ? hexValue.slice(2) : hexValue;
  const padded = clean.padStart(64, '0'); // 32 bytes = 64 hex chars
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Same as bb.js `flattenFieldsAsArray` — BN254 field elements as hex strings → 32-byte big-endian limbs.
 * Used to turn `ProofData.publicInputs` into the `Bytes` the Soroban verifier checks.
 */
function flattenFieldStringsToBytes(fields: string[]): Uint8Array {
  const parts = fields.map((hex) => {
    const sanitisedHex = BigInt(hex).toString(16).padStart(64, '0');
    const len = sanitisedHex.length / 2;
    const u8 = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      u8[i] = parseInt(sanitisedHex.slice(i * 2, i * 2 + 2), 16);
    }
    return u8;
  });
  const total = parts.reduce((acc, p) => acc + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Uint8Array → lowercase hex string (no 0x prefix) */
function bufToHex(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convenience: compute just the commitment hash without generating a full proof.
 * Useful for pre-flight checks or displaying the hash in the UI before committing.
 */
export async function computeCommitmentHash(
  attacks:       [number, number, number],
  defenses:      [number, number, number],
  playerAddress: string,
  sessionId:     number,
  circuitName:   string,
): Promise<string> {
  if (attacks.length !== 3 || defenses.length !== 3) {
    throw new Error('Must provide exactly 3 attacks and 3 defenses');
  }

  const response = await fetch(`/circuits/${circuitName}.json`);
  if (!response.ok) throw new Error(`Failed to load circuit: ${circuitName}`);
  const circuit = await response.json();

  const noir = new Noir(circuit);
  const { returnValue } = await noir.execute({
    attacks:        attacks.map(String),
    defenses:       defenses.map(String),
    player_address: addressToField(playerAddress),
    session_id:     `0x${sessionId.toString(16).padStart(64, '0')}`,
  });

  return returnValue as string;
}
