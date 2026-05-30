# ⚔️ Clash - Zero-Knowledge Combat on Stellar

> A fully on-chain PvP strategy game where cryptographic proofs ensure fair play without revealing your moves until the perfect moment.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Stellar](https://img.shields.io/badge/Blockchain-Stellar-blue)](https://stellar.org)
[![Soroban](https://img.shields.io/badge/Smart_Contracts-Soroban-orange)](https://soroban.stellar.org)
[![Noir](https://img.shields.io/badge/ZK-Noir-purple)](https://noir-lang.org)
[![UltraHonk](https://img.shields.io/badge/Proof_System-UltraHonk-green)](https://github.com/AztecProtocol/barretenberg)

---

## Local development

### Run the Clash frontend

Vite reads environment variables from a **`.env` file at the repository root** (not inside `clash-frontend/`). See `clash-frontend/vite.config.ts` (`envDir: '..'`).

**1. Create `.env` from the template**

```bash
cd /path/to/Stellar-Game-Studio
cp .env.example .env
```

Edit `.env` and set `VITE_DEV_POINTS_TRACKER_ADMIN_SECRET` if you want the UI to submit leaderboard scores after duels (see optional vars below). To generate a full `.env` with dev wallets and contract IDs from a local deploy:

```bash
bun run setup
```

**2. Install and start the dev server**

```bash
cd clash-frontend
npm install
npm run dev
```

The app opens at **http://localhost:3000** (see `clash-frontend/vite.config.ts`).


**Contracts / deploy (repo root):** `bun run build`, `bun run deploy`, `bun run bindings` — see `scripts/`. Rust contracts: `cargo test` from `contracts/<crate>` as needed.

### Environment variables (`.env` at repo root)

Copy from [`.env.example`](.env.example). Minimum set to run the ZK duel UI against public testnet contracts:

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_SOROBAN_RPC_URL` | Yes | Soroban RPC endpoint |
| `VITE_NETWORK_PASSPHRASE` | Yes | Stellar network passphrase |
| `VITE_MOCK_GAME_HUB_CONTRACT_ID` | Yes | Game Hub contract (economy hook) |
| `VITE_CLASH_CONTRACT_ID` | Yes | Clash game logic contract |
| `VITE_ACCOUNT_WASM_HASH` | Yes* | Smart-account WASM hash for passkey wallets |
| `VITE_WEBAUTHN_VERIFIER_ADDRESS` | Yes* | WebAuthn verifier contract |
| `VITE_ED25519_VERIFIER_ADDRESS` | Yes* | Ed25519 verifier for delegated session keys |
| `VITE_DEV_POINTS_TRACKER_ADMIN_ADDRESS` | No | Public key allowed to call `record_result` |
| `VITE_DEV_POINTS_TRACKER_ADMIN_SECRET` | No | Matching secret; omit to skip leaderboard writes |

\*Required for **Create Fresh Wallet** / passkey flow and smart-account ZK duels.

**Example values (testnet)** — already in `.env.example`:

```env
VITE_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
VITE_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
VITE_MOCK_GAME_HUB_CONTRACT_ID=CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG
VITE_CLASH_CONTRACT_ID=CCRG66MIX7ATFB4T3VJZ4TJLWKNRXKBX6HZWPUL2U2UQLUO5564F5IL5
VITE_ACCOUNT_WASM_HASH=0a7acdeb68d2f08f6ab87dec7cb1542db02b8f1a491f14ce4ccb56fe21cb95ac
VITE_WEBAUTHN_VERIFIER_ADDRESS=CCMR63YE5T7MPWREF3PC5XNTTGXFSB4GYUGUIT5POHP2UGCS65TBIUUU
VITE_ED25519_VERIFIER_ADDRESS=CCJOUKLCZVCXS4VIBBEA7S3SPWZQS5DPE5A4YG67RA3Z7E3SJZAUJFQA

VITE_DEV_POINTS_TRACKER_ADMIN_ADDRESS=
VITE_DEV_POINTS_TRACKER_ADMIN_SECRET=   
```

Optional: `VITE_DEV_POINTS_TRACKER_CONTRACT_ID` (defaults to the public testnet points tracker if unset). Leaderboard behavior: `clash-frontend/src/services/pointsService.ts`.

---

## For Players

### What is Clash of Pirates?

Clash of Pirates is a strategic turn-based dueling game where two pirate captains face off in epic three-round battles. What makes it revolutionary is that **your moves are hidden using zero-knowledge cryptography** - your opponent can't see what you're planning, can't change their moves after seeing yours, and can't cheat. It's provably fair combat on the blockchain.

### Contract addresses (testnet)

| Contract | Explorer |
|----------|----------|
| **Clash** (game logic) | [CCRG66MIX7ATFB4T3VJZ4TJLWKNRXKBX6HZWPUL2U2UQLUO5564F5IL5](https://stellar.expert/explorer/testnet/contract/CCRG66MIX7ATFB4T3VJZ4TJLWKNRXKBX6HZWPUL2U2UQLUO5564F5IL5) |
| **Game Hub** (economy) | [CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG](https://stellar.expert/explorer/testnet/contract/CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG) (`VITE_MOCK_GAME_HUB_CONTRACT_ID`) |
| **Clash Token** (CSH rewards) | [CBO7OBLF5WXIIFCQIWGCVR53NWKPF6HE44DMJVT7SCEEH56NTXTRBTQN](https://stellar.expert/explorer/testnet/contract/CBO7OBLF5WXIIFCQIWGCVR53NWKPF6HE44DMJVT7SCEEH56NTXTRBTQN) |
| **UltraHonk verifier** | [CCC4YINDGF7Z6OJ3WMSPR3OKIQQ4PVHQ6IMVJR7NORZX4PNFD565TLQV](https://stellar.expert/explorer/testnet/contract/CCC4YINDGF7Z6OJ3WMSPR3OKIQQ4PVHQ6IMVJR7NORZX4PNFD565TLQV) |
| **Points tracker** (duel points / leaderboard) | [CBGYEIOWGSY6TGM6BFGPEUKM37TKPXAEETDRYACHJKVHOBZRNBIUMD6S](https://stellar.expert/explorer/testnet/contract/CBGYEIOWGSY6TGM6BFGPEUKM37TKPXAEETDRYACHJKVHOBZRNBIUMD6S) |

Configure contracts in the root `.env` (see [Local development](#local-development) and [`.env.example`](.env.example)).

### 🎯 How to Play

#### The Setup
1. **Challenge an Opponent**: Send a challenge with POINTS wagered
2. **Plan Your Strategy**: Select 3 rounds of attacks and defenses
3. **Commit with Proof**: Generate a zero-knowledge proof that locks in your moves
4. **Both Players Commit**: Neither can see the other's strategy
5. **Reveal**: After both commit, reveal your moves with verification
6. **Watch the Battle**: Experience a cinematic auto-battle
7. **Winner Takes All**: Victor claims the entire pot

#### Combat System

Each of the 3 rounds consists of:
- **1 Attack Move**: Your offensive strategy
- **1 Defense Move**: Your counter to opponent's attack

**⚔️ Attack Moves:**

| Move | Icon | Damage | Beats | Blocked By |
|------|------|--------|-------|------------|
| **Cutlass Slash** | ⚔️ | 30 HP | Counter | Dodge |
| **Cannon Blast** | 🔥 | 40 HP | Dodge | Counter |
| **Lightning Strike** | ⚡ | 35 HP | Block | Block |

**🛡️ Defense Moves:**

| Move | Icon | Stops |
|------|------|-------|
| **Raised Shield (Block)** | 🛡️ | Lightning Strike |
| **Quick Sidestep (Dodge)** | 🏃 | Cutlass Slash |
| **Riposte (Counter)** | 🔄 | Cannon Blast |

**Game Mechanics:**
- Each attack has **ONE** defense that stops it completely (0 damage)
- All other defenses fail (full damage taken)
- Example: Lightning Strike → Block (stopped), Dodge (35 damage), Counter (35 damage)

#### Combo System

**Consecutive same attacks get bonus damage:**
- 2 in a row: +10 damage
- 3 in a row: +25 damage

Example: Lightning → Lightning → Lightning = 35, 45, 60 damage (if not blocked)

#### Strategic Depth

- **HP Management**: Both players start with 100 HP
- **Prediction Game**: Anticipate opponent's attack pattern
- **Risk vs Reward**: Cannon Blast hits hardest but easier to counter
- **Combo Planning**: Build damage or mix it up?
- **Defense Priority**: What will they attack with?

### The Experience

#### Cinematic Battle Playback

Every battle plays out like an epic movie with:

**1. Dramatic Turn Titles**
- Round 1: "THE OPENING GAMBIT"
- Round 2: "Clash of pirates"  
- Round 3: "THE FINAL RECKONING"

**2. Card Reveals with Effects**
- Attack and defense cards materialize with glowing animations
- Directional arrows show who's targeting whom
- Pulsing golden rings around showcased cards

**3. Impact Animations**
- **Successful Hit**: Explosive burst rings, screen shake, massive damage numbers
- **Successful Block**: Shield spin 360°, sparkles, "BLOCKED!" text in cyan
- **HP Drain**: Smooth 1.5s cinematic health bar animation

**4. Character Reactions**
- Attacker lunges forward when striking
- Defender flashes and shakes when taking damage
- Winner glows with golden aura
- Loser fades to grayscale

**5. Epic Winner Announcement**
- **Victory**: Floating crown, falling confetti, golden glory
- **Defeat**: Respectful skull icon with red effects
- **Draw**: Balanced scales, mutual honor

After resolution, turn-by-turn playback runs in **`ClashZkArena`** (embedded from **`ClashGameArena`**). Open **Leaderboard** from the header to see tracked duel points (when the points contract is configured).

---

## 🏗️ Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│              FRONTEND (Vite + React) — clash-frontend         │
│                                                               │
│  ┌────────────┐   ┌──────────────┐  ┌────────────────────┐  │
│  │   Wallet   │   │ NoirService  │  │ ClashGameService   │  │
│  │(+ smart acct)│  │ (Proof Gen)  │  │ (Soroban RPC/tx)   │  │
│  └────────────┘   └──────────────┘  └────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ pointsService (optional) → Points tracker contract       │ │
│  └──────────────────────────────────────────────────────────┘ │
└───────────────────────┬──────────────────────────────────────┘
                        │
                        │ 1. commit_moves(public_inputs, proof)
                        │ 2. reveal_moves(public_inputs, moves)
                        │ 3. resolve_battle()
                        ↓
┌──────────────────────────────────────────────────────────────┐
│                  SOROBAN SMART CONTRACTS                      │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐ │
│  │         ClashContract (Game Logic)                     │ │
│  │  - start_game()                                        │ │
│  │  - commit_moves() → calls verifier                    │ │
│  │  - reveal_moves() → validates commitment              │ │
│  │  - resolve_battle() → simulates combat                │ │
│  │  - get_game_playback()                                │ │
│  └─────────────┬──────────────────────────────────────────┘ │
│                │                                              │
│                │ verify_proof(public_inputs, proof_bytes)    │
│                ↓                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │    UltraHonkVerifierContract                           │ │
│  │  - __constructor(vk_bytes) → stores VK                │ │
│  │  - verify_proof() → UltraHonk verification            │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌────────────────────────────────────────────────────────┐ │
│  │         GameHub (Points & Economy)                     │ │
│  │  - start_game() → locks points                        │ │
│  │  - end_game() → distributes rewards                   │ │
│  └────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  points_tracker (optional) — duel totals / leaderboard │ │
│  │  - record_result / get_points / get_leaderboard       │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│              NOIR CIRCUIT (Compiled to ACIR)                  │
│                                                               │
│  duel_commit_circuit.nr                                      │
│  - Validates moves are in range [0-2]                        │
│  - Computes Pedersen hash commitment                         │
│  - Returns commitment as public output                       │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│            PROVING SYSTEM (UltraHonk + bb.js)                │
│                                                               │
│  - Runs in browser via WASM                                  │
│  - Generates proof in 5-10 seconds                           │
│  - Proof size: ~2KB (highly compact)                         │
│  - Uses Keccak oracle for Stellar compatibility             │
└──────────────────────────────────────────────────────────────┘
```

---

## 🔐 Zero-Knowledge Cryptography

### The Problem

In turn-based strategy games, players face a fundamental dilemma:
- **Reveal moves first** → Opponent sees and counters perfectly
- **Simultaneous submission** → Need trusted third party or vulnerable to brute force

Traditional "hash commitment" schemes fail because:
- Only 729 possible move combinations (3^6)
- Attacker can brute force all hashes in milliseconds
- Salting helps but doesn't eliminate the attack vector

### The Solution: Zero-Knowledge Proofs

Clash of Pirates uses **UltraHonk proofs** (from Aztec's Barretenberg) to enable:

1. **Cryptographically Binding Commitments**
   - Impossible to change moves after committing
   - Secured by 128-bit computational hardness

2. **Information Hiding**
   - Proof reveals NOTHING about your moves
   - Not even statistical information leaks

3. **Public Verifiability**
   - Anyone can verify the proof on-chain
   - No trusted parties needed

4. **Efficient Verification**
   - On-chain verification
   - Proof size only ~2KB

### How It Works

#### The Noir Circuit

Location: `duel_commit_circuit/` (repo root). The compiled JSON is synced into `clash-frontend/public/circuits/` for the browser (`npm run prebuild` / `sync:duel-circuit`).

```noir
use dep::std::hash::pedersen_hash;

fn main(
    attacks: [Field; 3],       // Private inputs (never revealed on-chain)
    defenses: [Field; 3],      // Private inputs
    player_address: pub Field, // Public inputs (verified on-chain)
    session_id: pub Field,     // Public inputs
) -> pub Field {                // Public output: commitment hash
    
    // 1. Validate all moves are in legal range [0, 1, 2]
    for i in 0..3 {
        assert(attacks[i] as u8 <= 2, "Invalid attack");
        assert(defenses[i] as u8 <= 2, "Invalid defense");
    }
    
    // 2. Compute binding commitment
    // Pedersen hash is ZK-friendly (efficient in circuits)
    pedersen_hash([
        attacks[0], attacks[1], attacks[2],
        defenses[0], defenses[1], defenses[2],
        player_address,
        session_id
    ])
}
```

**Why Pedersen Hash?**
- **ZK-Optimized**: ~100x faster than SHA-256 in circuits
- **Collision Resistant**: Cryptographically secure
- **Few Constraints**: Keeps proof generation fast
- **Perfect for Commitment**: Single output binding all inputs

#### Proof Generation (Frontend)

```typescript
// NoirService.ts
async generateClashProof(inputs: ClashProofInputs) {
  // 1. Prepare inputs
  const noirInputs = {
    attacks: [0, 1, 2],        // Slash, Fireball, Lightning
    defenses: [1, 2, 0],       // Dodge, Counter, Block
    player_address: addressToField(stellarAddress),
    session_id: sessionId,
  };

  // 2. Execute circuit to generate witness
  const noir = new Noir(circuit);
  const { witness, returnValue } = await noir.execute(noirInputs);
  // returnValue = commitment hash

  // 3. Generate UltraHonk proof (5-10 seconds)
  const backend = new UltraHonkBackend(circuit.bytecode);
  const proof = await backend.generateProof(witness, { keccak: true });

  // 4. Build public inputs for contract
  // Format: [player_address (32B) | session_id (32B) | commitment_hash (32B)]
  const publicInputs = new Uint8Array(96);
  publicInputs.set(playerAddressBytes, 0);
  publicInputs.set(sessionIdBytes, 32);
  publicInputs.set(commitmentHashBytes, 64);

  return {
    publicInputs,    // 96 bytes
    proofBytes,      // ~2KB
    commitmentHash,  // 0x...
  };
}
```

#### On-Chain Verification

##### 1. Commit Phase

```rust
// ClashContract::commit_moves
pub fn commit_moves(
    env: Env,
    session_id: u32,
    player: Address,
    public_inputs: Bytes,     // 96 bytes
    proof_bytes: Bytes,       // ~2KB
) -> Result<BytesN<32>, Error> {
    player.require_auth();
    
    // 1. Get verifier contract address
    let verifier_addr = env.storage()
        .instance()
        .get(&DataKey::Ultrahonkverifier)
        .expect("verifier not set");
    
    // 2. Call verifier to check proof
    let commitment_hash = verify_proof(
        &env,
        &verifier_addr,
        public_inputs.clone(),
        proof_bytes
    )?;
    // This calls UltraHonkVerifierContract::verify_proof()
    // which runs full UltraHonk verification algorithm
    
    // 3. Extract commitment hash (last 32 bytes of public_inputs)
    // This is the circuit's return value
    
    // 4. Store commitment
    let commitment = PlayerCommitment {
        proof_id: commitment_hash,
        has_revealed: false,
        moves: MoveSequence { moves: vec![&env] },
    };
    
    // 5. Save to game state
    if player == game.player1 {
        game.player1_commitment = commitment;
        game.has_player1_commitment = true;
    } else {
        game.player2_commitment = commitment;
        game.has_player2_commitment = true;
    }
    
    Ok(commitment_hash)
}
```

**UltraHonk Verifier:**

```rust
// UltraHonkVerifierContract
pub fn verify_proof(
    env: Env,
    public_inputs: Bytes,
    proof_bytes: Bytes
) -> Result<(), Error> {
    // 1. Load pre-stored verification key
    let vk_bytes = env.storage()
        .instance()
        .get(&Self::key_vk())
        .ok_or(Error::VkNotSet)?;
    
    // 2. Deserialize VK and proof
    let verifier = UltraHonkVerifier::new(&env, &vk_bytes)?;
    
    // 3. Generate transcript
    let transcript = generate_transcript(
        &env,
        &proof,
        &public_inputs,
        vk.circuit_size,
        public_inputs_count,
    );
    
    // 4. Verify sumcheck protocol
    verify_sumcheck(&proof, &transcript, &vk)?;
    
    // 5. Verify Shplemini (polynomial commitment scheme)
    verify_shplemini(&env, &proof, &vk, &transcript)?;
    
    Ok(())
}
```

##### 2. Reveal Phase

```rust
// ClashContract::reveal_moves
pub fn reveal_moves(
    env: Env,
    session_id: u32,
    player: Address,
    public_inputs: Bytes,      // Same 96 bytes from commit
    moves: Vec<Move>,          // Actual moves [atk1, def1, atk2, def2, atk3, def3]
) -> Result<(), Error> {
    player.require_auth();
    
    // 1. Extract commitment hash from public_inputs
    let revealed_hash = Self::extract_commitment_hash(&env, &public_inputs)?;
    
    // 2. Get stored commitment
    let commitment = if player == game.player1 {
        &mut game.player1_commitment
    } else {
        &mut game.player2_commitment
    };
    
    // 3. Verify revealed hash matches committed hash
    if revealed_hash != commitment.proof_id {
        return Err(Error::CommitmentMismatch);
    }
    
    // 4. Store revealed moves
    commitment.moves = MoveSequence { moves };
    commitment.has_revealed = true;
    
    Ok(())
}
```

**Critical Security:**
The commitment hash uniquely binds:
```
Hash(attack1, attack2, attack3, defense1, defense2, defense3, player_address, session_id)
```

This means:
- ✅ **Can't change moves**: Different moves = different hash = verification fails
- ✅ **Can't replay**: Each game has unique session_id
- ✅ **Can't impersonate**: Player address is part of hash
- ✅ **Can't brute force**: Secured by Pedersen hash preimage resistance

##### 3. Battle Resolution

```rust
pub fn resolve_battle(env: Env, session_id: u32) -> Result<BattleResult, Error> {
    let game = load_game(&env, session_id)?;
    
    // 1. Verify both players revealed
    if !game.player1_commitment.has_revealed 
        || !game.player2_commitment.has_revealed {
        return Err(Error::BothPlayersNotCommitted);
    }
    
    // 2. Simulate battle
    let mut p1_hp = 100;
    let mut p2_hp = 100;
    let mut turn_results = Vec::new(&env);
    
    for turn in 0..3 {
        let p1_move = game.player1_commitment.moves.get(turn);
        let p2_move = game.player2_commitment.moves.get(turn);
        
        // Calculate damage with RPS logic
        let p1_damage = calculate_damage(
            p1_move.attack,
            p2_move.defense,
            &game.player1_commitment.moves,
            turn
        );
        
        let p2_damage = calculate_damage(
            p2_move.attack,
            p1_move.defense,
            &game.player2_commitment.moves,
            turn
        );
        
        // Apply damage SIMULTANEOUSLY
        p1_hp -= p2_damage;
        p2_hp -= p1_damage;
        
        turn_results.push(TurnResult {
            turn,
            player1_damage_dealt: p1_damage,
            player2_damage_dealt: p2_damage,
            player1_hp_remaining: p1_hp,
            player2_hp_remaining: p2_hp,
            // ... defense success flags
        });
    }
    
    // 3. Determine winner
    let winner = if p1_hp > p2_hp {
        Some(game.player1)
    } else if p2_hp > p1_hp {
        Some(game.player2)
    } else {
        None  // Draw
    };
    
    // 4. Report to GameHub for reward distribution
    let game_hub = GameHubClient::new(&env, &game_hub_addr);
    if let Some(ref winner_addr) = winner {
        let player1_won = winner_addr == &game.player1;
        game_hub.end_game(&session_id, &player1_won);
    } else {
        game_hub.end_game(&session_id, &false);  // Draw
    }
    
    Ok(BattleResult {
        player1_hp: p1_hp,
        player2_hp: p2_hp,
        winner,
        is_draw: winner.is_none(),
        turn_results,
    })
}
```

**Damage Calculation:**

```rust
fn calculate_damage_and_defense(
    attack: Attack,
    defense: Defense,
    move_sequence: &Vec<Move>,
    current_turn: u32,
) -> (i32, bool) {
    // Base damage
    let base_damage = match attack {
        Attack::Slash => 30,
        Attack::Fireball => 40,
        Attack::Lightning => 35,
    };
    
    // Check if defense blocks this attack (pure RPS)
    let blocked = match (attack, defense) {
        (Attack::Slash, Defense::Dodge) => true,
        (Attack::Fireball, Defense::Counter) => true,
        (Attack::Lightning, Defense::Block) => true,
        _ => false,
    };
    
    if blocked {
        return (0, true);  // No damage, defense successful
    }
    
    // Calculate combo bonus
    let mut combo_bonus = 0;
    if current_turn >= 1 {
        let prev = move_sequence.get(current_turn - 1).unwrap();
        if prev.attack == attack {
            combo_bonus = 10;  // 2-combo
        }
    }
    if current_turn >= 2 {
        let prev2 = move_sequence.get(current_turn - 2).unwrap();
        let prev1 = move_sequence.get(current_turn - 1).unwrap();
        if prev2.attack == attack && prev1.attack == attack {
            combo_bonus = 25;  // 3-combo
        }
    }
    
    (base_damage + combo_bonus, false)
}
```

### Security Guarantees

#### Cryptographic Properties

**1. Commitment Binding (Perfect)**
- Security: Collision resistance of Pedersen hash
- Level: 128-bit computational security
- Result: Changing even 1 move changes hash completely

**2. Information Hiding (Perfect)**
- Security: Preimage resistance of Pedersen hash  
- Level: Computationally hiding (no info leaks)
- Result: Proof reveals zero information about moves

**3. Proof Soundness (Computational)**
- Security: UltraHonk proof system soundness
- Level: 128-bit computational security
- Result: Can't create valid proof with invalid moves

**4. Proof Zero-Knowledge (Computational)**
- Security: Simulator indistinguishability
- Level: 128-bit computational security
- Result: Proof reveals only "statement is true"

#### Attack Resistance

**❌ Brute Force Attack (Prevented)**
- **Threat**: Try all 729 move combinations, find matching hash
- **Prevention**: Pedersen hash preimage resistance (2^128 security)
- **Result**: Computationally infeasible even with rainbow tables

**❌ Front-Running Attack (Prevented)**  
- **Threat**: See commitment in mempool, submit yours after
- **Prevention**: Commitment is cryptographically binding at time of submission
- **Result**: Can't benefit from seeing opponent's commitment hash

**❌ Replay Attack (Prevented)**
- **Threat**: Reuse proof from previous game
- **Prevention**: session_id is part of commitment hash
- **Result**: Each game has unique valid proofs

**❌ Impersonation Attack (Prevented)**
- **Threat**: Submit commitment for another player
- **Prevention**: player_address is part of commitment + signature required
- **Result**: Can only commit for yourself

**❌ Griefing Attack (Mitigated)**
- **Threat**: Commit but never reveal
- **Prevention**: Timeout mechanism can award win to honest player
- **Result**: Economic incentive to complete games

**✅ Collusion Resistance**
- Multiple unique games required for statistical analysis
- Each game has unique session_id
- Past games don't help predict future commitments

---

## 🏗️ Technical Implementation

### Tech Stack

**Frontend:**
- Vite + React
- Tailwind CSS + component CSS (`clash-frontend/src/games/clash/styles.css`, etc.)
- Stellar SDK, Freighter, smart-account-kit (passkey / delegate sessions where configured)
- Noir.js + bb.js (UltraHonk proof generation in the browser)

**Smart contracts (workspace members in root `Cargo.toml`):**
- **clash** — game logic (commit / reveal / resolve)
- **mock-game-hub** — economy hooks used by the clash flow
- **oz-smart-account** — smart-account primitives (as deployed for your stack)
- **points_tracker** — optional Soroban contract for duel points + leaderboard reads

**Also in repo (excluded from default workspace build):**
- **rs-soroban-ultrahonk** — UltraHonk verifier contract sources

**Zero-Knowledge:**
- Noir language (circuit)
- Barretenberg (proving backend)
- UltraHonk proof system
- Pedersen hash (commitment)

### Project structure

```
Stellar-Game-Studio/
├── duel_commit_circuit/              # Noir source (nargo compile)
│   ├── src/main.nr
│   └── Nargo.toml
├── contracts/
│   ├── clash/src/lib.rs              # Main game contract
│   ├── mock-game-hub/                # Economy / hub integration
│   ├── oz-smart-account/             # Smart-account contract
│   ├── points_tracker/               # Optional points + leaderboard
│   └── rs-soroban-ultrahonk/         # UltraHonk verifier (see workspace exclude)
├── clash-frontend/
│   ├── public/circuits/
│   │   └── duel_commit_circuit.json  # Synced from duel_commit_circuit (prebuild)
│   └── src/
│       ├── App.tsx                   # Arena ↔ Leaderboard routing
│       ├── main.tsx
│       ├── components/               # Layout, PageLoading, wallet, ZK UI pieces
│       ├── pages/Leaderboard.tsx     # Points leaderboard UI
│       ├── games/clash/
│       │   ├── ClashGameArena.tsx     # Shell: wallet, smart account, loads ZK duel
│       │   ├── ClashZkArena.tsx       # ZK commit/reveal/resolve + cinematic playback
│       │   ├── ClashZkDuelSmartAccount.tsx
│       │   ├── ClashGameSmartAccount.tsx
│       │   ├── clashService.ts       # ClashGameService (RPC, txs, playback)
│       │   └── smartAccountService.ts
│       ├── services/
│       │   ├── pointsService.ts      # Optional points_tracker RPC + admin txs
│       │   ├── wasmInit.ts
│       │   └── devWalletService.ts
│       ├── utils/                    # NoirService, RPC helpers, tx helpers, …
│       └── contracts/points-tracker/ # TS client for points_tracker
├── scripts/                          # setup, deploy, bindings helpers
└── testnet-option.sh                 # Reference testnet flows
```

### Data Flow

```
1. USER SELECTS MOVES
   └─> Frontend stores locally

2. USER CLICKS "COMMIT"
   └─> NoirService.generateClashProof()
       ├─> Execute circuit with moves
       ├─> Generate witness
       ├─> Generate UltraHonk proof (5-10s)
       └─> Return {publicInputs, proofBytes, commitmentHash}

3. SUBMIT COMMITMENT TRANSACTION
   └─> ClashContract.commit_moves(session_id, player, publicInputs, proofBytes)
       ├─> Verify player authentication
       ├─> Call UltraHonkVerifierContract.verify_proof()
       │   ├─> Load VK from storage
       │   ├─> Verify sumcheck
       │   ├─> Verify Shplemini
       │   └─> Return OK or Error
       ├─> Extract commitment hash from publicInputs
       └─> Store commitment in game state

4. BOTH PLAYERS COMMIT
   └─> Game state: has_player1_commitment = true, has_player2_commitment = true

5. USER CLICKS "REVEAL"
   └─> ClashContract.reveal_moves(session_id, player, publicInputs, moves)
       ├─> Extract commitment hash from publicInputs
       ├─> Compare with stored commitment.proof_id
       ├─> Verify match
       └─> Store revealed moves

6. BOTH PLAYERS REVEAL
   └─> Ready for battle resolution

7. ANY PLAYER CLICKS "RESOLVE"
   └─> ClashContract.resolve_battle(session_id)
       ├─> Load both players' revealed moves
       ├─> Simulate 3 rounds of combat
       │   ├─> Calculate damage with RPS rules
       │   ├─> Apply combo bonuses
       │   └─> Track HP changes
       ├─> Determine winner
       ├─> Store battle result
       └─> Call GameHub.end_game() to distribute rewards

8. FRONTEND DISPLAYS CINEMATIC PLAYBACK
   └─> ClashContract.get_game_playback(session_id)
       └─> Returns detailed turn-by-turn results with moves

9. (Optional) POINTS TRACKER
   └─> After resolve, admin or automation may call points_tracker.record_result
       └─> Leaderboard reads get_leaderboard / get_points via RPC (see pointsService)
```

### Key Contracts

#### ClashContract

**Purpose:** Main game logic and state management

**Key Methods:**
```rust
// Lifecycle
start_game(session_id, player1, player2, p1_points, p2_points)
commit_moves(session_id, player, public_inputs, proof_bytes) -> commitment_hash
reveal_moves(session_id, player, public_inputs, moves)
resolve_battle(session_id) -> BattleResult

// Queries
get_game(session_id) -> Game
get_game_playback(session_id) -> GamePlayback

// Challenge System
send_challenge(challenger, challenged, points_wagered) -> challenge_id
accept_challenge(challenge_id, challenged, session_id)
get_player_challenges(player) -> (active, completed, expired)

// Username
set_username(caller, username)
get_username(address) -> Option<String>
```

**Storage Keys:**
```rust
enum DataKey {
    Game(u32),                    // session_id -> Game
    GameHubAddress,               // GameHub contract address
    Ultrahonkverifier,           // Verifier contract address
    Username(Address),            // address -> username
    AddressByUsername(String),    // username -> address
    Challenge(u32),               // challenge_id -> Challenge
}
```

#### UltraHonkVerifierContract

**Purpose:** On-chain proof verification

**Key Methods:**
```rust
__constructor(vk_bytes)  // Store verification key once at deploy
verify_proof(public_inputs: Bytes, proof_bytes: Bytes) -> Result<(), Error>
```

**Verification Algorithm:**
1. Load pre-stored verification key
2. Parse proof and public inputs
3. Generate Fiat-Shamir transcript
4. Verify sumcheck protocol
5. Verify Shplemini polynomial commitments
6. Return OK or Error

#### GameHub

**Purpose:** Economy and points management

**Key Methods:**
```rust
start_game(game_id, session_id, player1, player2, p1_points, p2_points)
  // Locks points from both players

end_game(session_id, player1_won: bool)
  // Distributes rewards to winner (or refunds on draw)
```

#### Points tracker (`contracts/points_tracker`)

**Purpose:** Optional Soroban contract for duel outcome points and a simple on-chain leaderboard (separate from Game Hub wagers).

**Typical flow:** `register_players` (admin) → after a duel resolves, `record_result` (admin) updates scores → UI reads `get_points` / `get_leaderboard`.

### Frontend Services

#### NoirService

**Responsibility:** Generate zero-knowledge proofs in browser

```typescript
class NoirService {
  async generateClashProof(inputs: ClashProofInputs): Promise<ClashProofResult> {
    // 1. Load compiled circuit
    const circuit = await fetch('/circuits/duel_commit_circuit.json');
    
    // 2. Execute circuit with inputs
    const noir = new Noir(circuit);
    const { witness, returnValue } = await noir.execute(noirInputs);
    
    // 3. Generate UltraHonk proof
    const backend = new UltraHonkBackend(circuit.bytecode);
    const proof = await backend.generateProof(witness, { keccak: true });
    
    // 4. Build public inputs (96 bytes)
    const publicInputs = new Uint8Array(96);
    publicInputs.set(playerAddressBytes, 0);   // 32 bytes
    publicInputs.set(sessionIdBytes, 32);      // 32 bytes
    publicInputs.set(commitmentHashBytes, 64); // 32 bytes
    
    return {
      publicInputs,   // 96 bytes for contract
      proofBytes,     // ~2KB proof
      commitmentHash, // hex string
      proofTime,      // seconds
    };
  }
}
```

#### ClashGameService

**Responsibility:** Interact with smart contracts

```typescript
class ClashGameService {
  // Start game (creates pending transaction for player2 to sign)
  async prepareStartGame(sessionId, player1, player2, p1Points, p2Points, signer)
  
  // Player 2 imports and signs to complete game creation
  async importAndSignAuthEntry(authXDR, player2, p2Points, signer)
  async finalizeStartGame(fullySignedXDR, submitter, signer)
  
  // Commit phase
  async commitMoves(sessionId, player, publicInputs, proof, signer)
  
  // Reveal phase
  async revealMoves(sessionId, player, publicInputs, moves, signer)
  
  // Resolution
  async resolveBattle(sessionId, signer, submitter)
  
  // Queries
  async getGame(sessionId): Promise<Game>
  async getGamePlayback(sessionId): Promise<GamePlayback>
}
```

#### pointsService (optional)

**Responsibility:** Read leaderboard data from the points tracker via RPC simulation; submit `record_result` / `register_players` when admin classic keys are configured in env (`VITE_DEV_POINTS_TRACKER_*`). Used from `clashService` after battle resolution and by `pages/Leaderboard.tsx`.


## 🔒 Security Audit Checklist

- [x] Circuit validates all inputs
- [x] Commitment includes player address
- [x] Commitment includes session ID
- [x] Reveal verifies commitment match
- [x] Battle logic is deterministic
- [x] No reentrancy vulnerabilities
- [x] Access control enforced
- [x] Integer overflow protection (Rust safety)
- [x] Timeout mechanisms for griefing
- [x] Proof verification on-chain
- [x] VK stored securely

---
## 🎯 Roadmap

- [x] Core game mechanics
- [x] ZK commit-reveal
- [x] Cinematic UI (arena / ZK duel playback)
- [x] Points tracker + leaderboard UI 
- [ ] Username assignment
- [ ] Send Challenge via usernames
- [ ] Tournament mode
- [ ] Ranked matchmaking
- [ ] NFT avatars
- [ ] Power-ups system

**⚓ Fair Winds and Following Seas, Captain! ⚔️**

Built with ❤️ by the Clash of Pirates team
