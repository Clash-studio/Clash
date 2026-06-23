#![no_std]

//! # Clash Game
//!
//! PvP combat game where both players secretly plan 3 turns of attacks and defenses,
//! commit them with zero-knowledge proofs, then watch an auto-battle resolve.
//! Combat features attack-defense mechanics with combos, crits, and strategic depth.
//!
//! **Game Hub Integration:**
//! All games must be played through the Game Hub contract for points tracking.

use soroban_sdk::auth::{Context, CustomAccountInterface};
use soroban_sdk::crypto::Hash;
use soroban_sdk::{
    Address, Bytes, BytesN, Env, IntoVal, Map, String, Vec, contract, contracterror, contractimpl,
    contracttype, vec, Vec as SorobanVec, Val, InvokeError, Symbol,
};
use stellar_accounts::smart_account::{
    AuthPayload, ContextRule, ContextRuleType, Signer, SmartAccount, SmartAccountError,
    add_context_rule as smart_add_context_rule, add_policy as smart_add_policy,
    add_signer as smart_add_signer, do_check_auth as smart_do_check_auth,
    get_context_rule as smart_get_context_rule, get_context_rules_count as smart_get_context_rules_count,
    remove_context_rule as smart_remove_context_rule, remove_policy as smart_remove_policy,
    remove_signer as smart_remove_signer, update_context_rule_name as smart_update_context_rule_name,
    update_context_rule_valid_until as smart_update_context_rule_valid_until,
};

// use ultrahonk_soroban_verifier::PROOF_BYTES;

// Import UltraHonk verifier contract
// mod ultrahonk_contract {
//     soroban_sdk::contractimport!(file = "ultrahonk_soroban_contract.wasm");
// }

// Import GameHub contract interface
#[soroban_sdk::contractclient(name = "GameHubClient")]
pub trait GameHub {
    fn start_game(
        env: Env,
        game_id: Address,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    );

    fn end_game(env: Env, session_id: u32, player1_won: bool);

    /// End a session that ended in a draw. The hub refunds both stakes from
    /// escrow (issue #1) rather than paying a pot to a winner. Kept as a
    /// separate entrypoint so draw semantics are explicit at the call site
    /// instead of overloading `end_game(session_id, false)`.
    fn end_game_draw(env: Env, session_id: u32);
}

#[soroban_sdk::contractclient(name = "ClashTokenClient")]
pub trait ClashToken {
    fn mint(env: Env, to: Address, amount: i128);
    fn balance(env: Env, id: Address) -> i128;
}

// ============================================================================
// Constants
// ============================================================================

// pub const ULTRAHONK_CONTRACT_ADDRESS: &str = "CCSORRUPEPDR4KPXLWIF4WCHERHJDOAHRAK6NTFSI2WLPPFTDVTATM74";

/// Each player starts with 100 HP
const STARTING_HP: i32 = 100;

/// Number of turns per battle
const TURNS_PER_BATTLE: u32 = 3;

/// Combo bonus damage for 2 consecutive same attacks
const COMBO_2_BONUS: i32 = 10;

/// Combo bonus damage for 3 consecutive same attacks
const COMBO_3_BONUS: i32 = 25;

/// TTL for game storage (30 days in ledgers)
const GAME_TTL_LEDGERS: u32 = 518_400;
const FORFEIT_TIMEOUT: u64 = 24 * 60 * 60; // 24 hours in seconds

/// TTL for challenges (7 days in ledgers)
const CHALLENGE_TTL_LEDGERS: u32 = 120_960;
const CSH_REWARD_PER_WIN: i128 = 10_0000000; // 10 CSH (7 decimals)

// ============================================================================
// Errors
// ============================================================================

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    GameNotFound = 1,
    NotPlayer = 2,
    AlreadyCommitted = 3,
    BothPlayersNotCommitted = 4,
    GameAlreadyEnded = 5,
    InvalidProof = 6,
    ProofVerificationFailed = 7,
    InvalidMoveSequence = 8,
    UsernameAlreadyTaken = 9,
    UsernameTooLong = 10,
    ChallengeNotFound = 11,
    ChallengeExpired = 12,
    CannotChallengeSelf = 13,
    UsernameTooShort = 14,
    InvalidUsernameFormat = 15,
    UsernameReserved = 16,
    AlreadyRevealed     = 17,
    CommitmentMismatch  = 18,
    InvalidPublicInputs = 19,
    ForfeitTooEarly = 20,
    ChallengeAlreadyAccepted = 21,
}
#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ClashError {
    CommitmentExists = 1,
    NullifierUsed = 2,
    VerificationFailed = 3,
}

// ============================================================================
// Data Types
// ============================================================================

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Attack {
    Slash = 0,    // 30 damage, stopped by Dodge
    Fireball = 1, // 40 damage, stopped by Counter
    Lightning = 2, // 35 damage, stopped by Block
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Defense {
    Block = 0,   // Stops Lightning 
    Dodge = 1,   // Stops Slash 
    Counter = 2, // Stops Fireball
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Move {
    pub attack: Attack,
    pub defense: Defense,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MoveSequence {
    pub moves: Vec<Move>, // 3 moves total
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlayerCommitment {
    pub proof_id: BytesN<32>,
    pub has_revealed: bool,
    pub moves: MoveSequence,
    pub commit_timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BattleResult {
    pub player1_hp: i32,
    pub player2_hp: i32,
    pub winner: Option<Address>,  
    pub is_draw: bool,            
    pub turn_results: Vec<TurnResult>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnResult {
    pub turn: u32,
    pub player1_damage_dealt: i32,
    pub player2_damage_dealt: i32,
    pub player1_hp_remaining: i32,
    pub player2_hp_remaining: i32,
    pub player1_defense_successful: bool,
    pub player2_defense_successful: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Game {
    pub player1: Address,
    pub player2: Address,
    pub player1_points: i128,
    pub player2_points: i128,
    pub has_player1_commitment: bool,
    pub player1_commitment: PlayerCommitment,
    pub has_player2_commitment: bool,
    pub player2_commitment: PlayerCommitment,
    pub has_battle_result: bool,
    pub battle_result: BattleResult,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Challenge {
    pub challenge_id: u32,
    pub challenger: Address,
    pub challenged: Address,
    pub points_wagered: i128,
    pub created_at: u64,
    pub expires_at: u64,
    pub is_accepted: bool,
    pub is_completed: bool,
    pub session_id: Option<u32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DetailedTurnResult {
    pub turn: u32,
    pub player1_move: Move,
    pub player2_move: Move,
    pub player1_damage_dealt: i32,
    pub player2_damage_dealt: i32,
    pub player1_damage_taken: i32,
    pub player2_damage_taken: i32,
    pub player1_hp_remaining: i32,
    pub player2_hp_remaining: i32,
    pub player1_defense_successful: bool,
    pub player2_defense_successful: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GamePlayback {
    pub session_id: u32,
    pub player1: Address,
    pub player2: Address,
    pub player1_username: Option<String>,
    pub player2_username: Option<String>,
    pub turn_results: Vec<DetailedTurnResult>,
    pub final_player1_hp: i32,
    pub final_player2_hp: i32,
    pub winner: Option<Address>, 
    pub is_draw: bool, 
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum MatchState {
    Created = 0,
    Accepted = 1,
    Active = 2,
    Finished = 3,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PvPMatch {
    pub match_id: u32,
    pub player1: Address,
    pub player2: Address,
    pub state: MatchState,
    pub current_turn: u32, // 0 for player1's turn, 1 for player2's turn
    pub player1_hp: i32,
    pub player2_hp: i32,
    // Pending move for the current turn: empty = none, one element = a move is
    // staged. Modeled as `Vec<Move>` rather than `Option<Move>` because
    // soroban-sdk's `testutils` codegen cannot derive XDR conversions for
    // `Option<CustomType>`, which breaks `cargo test` for the whole crate.
    pub last_action: Vec<Move>,
    pub winner: Option<Address>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Game(u32),
    GameHubAddress,
    Admin,
    Ultrahonkverifier,
    Username(Address),           // Address -> Username
    AddressByUsername(String),   // Username -> Address
    Challenge(u32),              // Challenge ID -> Challenge
    ChallengeCounter,            // Counter for challenge IDs
    PlayerChallenges(Address),   // Address -> Vec<challenge_id>
    Match(u32),                  // Match ID -> PvPMatch
    MatchCounter,                // Counter for match IDs
    PlayerMatches(Address),      // Address -> Vec<match_id>
    TokenContractAddress,
}

// ============================================================================
// Contract Definition
// ============================================================================

#[cfg(test)]
mod decline_test;

#[cfg(test)]
mod resolve_test;

#[contract]
pub struct ClashContract;


fn verify_proof(
    env: &Env,
    verifier: &Address,
    public_inputs: Bytes,
    proof_bytes: Bytes,
) -> Result<BytesN<32>, ClashError> {
    let mut args: SorobanVec<Val> = SorobanVec::new(env);
    args.push_back(public_inputs.clone().into_val(env));
    args.push_back(proof_bytes.into_val(env));

    env.try_invoke_contract::<(), InvokeError>(verifier, &Symbol::new(env, "verify_proof"), args)
        .map_err(|_| ClashError::VerificationFailed)?
        .map_err(|_| ClashError::VerificationFailed)?;

    // The circuit's public return value (commitment hash) is the last 32 bytes
    // of public_inputs. Layout: [player_address(32), session_id(32), hash(32)]
    let len = public_inputs.len();
    if len < 32 {
        return Err(ClashError::VerificationFailed);
    }

    // Copy the last 32 bytes into a fixed-size array
    let mut hash_array = [0u8; 32];
    let start = len - 32;
    for i in 0..32u32 {
        hash_array[i as usize] = public_inputs.get(start + i)
            .ok_or(ClashError::VerificationFailed)?;
    }

    Ok(BytesN::from_array(env, &hash_array))
}


#[contractimpl]
impl ClashContract {
    /// Initialize the contract with GameHub address and admin
    pub fn __constructor(env: Env, admin: Address, game_hub: Address, verifier_contract: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Ultrahonkverifier, &verifier_contract);
        env.storage()
            .instance()
            .set(&DataKey::GameHubAddress, &game_hub);
        env.storage().instance().set(&DataKey::ChallengeCounter, &0u32);
    }

    // ========================================================================
    // Username Management
    // ========================================================================

    pub fn set_username(env: Env, caller: Address, username: String) -> Result<(), Error> {
        caller.require_auth();
    
        // Validate username length (max 20 characters, min 3)
        if username.len() > 20 {
            return Err(Error::UsernameTooLong);
        }
        if username.len() < 3 {
            return Err(Error::UsernameTooShort);
        }
    
        // Validate username format (lowercase alphanumeric + underscore only)
        if !Self::validate_username_format(&username) {
            return Err(Error::InvalidUsernameFormat);
        }
    
        // Check for reserved usernames
        let reserved_names = vec![
            &env,
            String::from_str(&env, "admin"),
            String::from_str(&env, "system"),
            String::from_str(&env, "moderator"),
            String::from_str(&env, "support"),
        ];
        
        for reserved_name in reserved_names.iter() {
            if username == reserved_name {
                return Err(Error::UsernameReserved);
            }
        }
    
        // Check if username is already taken by someone else
        let username_key = DataKey::AddressByUsername(username.clone());
        if let Some(existing_address) = env.storage().persistent().get::<DataKey, Address>(&username_key) {
            if existing_address != caller {
                return Err(Error::UsernameAlreadyTaken);
            }
            return Ok(());
        }
    
        // Get the caller's current username (if any)
        let old_username_key = DataKey::Username(caller.clone());
        if let Some(old_username) = env.storage().persistent().get::<DataKey, String>(&old_username_key) {
            let old_reverse_key = DataKey::AddressByUsername(old_username.clone());
            if let Some(mapped_address) = env.storage().persistent().get::<DataKey, Address>(&old_reverse_key) {
                if mapped_address == caller {
                    env.storage().persistent().remove(&old_reverse_key);
                }
            }
        }
    
        // Set new username mappings
        env.storage().persistent().set(&old_username_key, &username);
        env.storage().persistent().set(&username_key, &caller);
    
        Ok(())
    }
    
    /// Get username for an address
    pub fn get_username(env: Env, address: Address) -> Option<String> {
        env.storage().persistent().get(&DataKey::Username(address))
    }
    
    /// Get address for a username
    pub fn get_address_by_username(env: Env, username: String) -> Option<Address> {
        env.storage().persistent().get(&DataKey::AddressByUsername(username))
    }

    // ========================================================================
    // Challenge System
    // ========================================================================

    /// Send a challenge to another player
    pub fn send_challenge(
        env: Env,
        challenger: Address,
        challenged: Address,
        points_wagered: i128,
    ) -> Result<u32, Error> {
        challenger.require_auth();

        // Cannot challenge self
        if challenger == challenged {
            return Err(Error::CannotChallengeSelf);
        }

        // Get and increment challenge counter
        let challenge_id: u32 = env.storage()
            .instance()
            .get(&DataKey::ChallengeCounter)
            .unwrap_or(0);
        env.storage().instance().set(&DataKey::ChallengeCounter, &(challenge_id + 1));

        // Create challenge (expires in 7 days)
        let current_time = env.ledger().timestamp();
        let challenge = Challenge {
            challenge_id,
            challenger: challenger.clone(),
            challenged: challenged.clone(),
            points_wagered,
            created_at: current_time,
            expires_at: current_time + (7 * 24 * 60 * 60), // 7 days in seconds
            is_accepted: false,
            is_completed: false,
            session_id: None,
        };

        // Store challenge
        let challenge_key = DataKey::Challenge(challenge_id);
        env.storage().temporary().set(&challenge_key, &challenge);
        env.storage().temporary().extend_ttl(&challenge_key, CHALLENGE_TTL_LEDGERS, CHALLENGE_TTL_LEDGERS);

        // Add to challenged player's list
        let mut challenges = env.storage()
            .persistent()
            .get::<DataKey, Vec<u32>>(&DataKey::PlayerChallenges(challenged.clone()))
            .unwrap_or(vec![&env]);
        challenges.push_back(challenge_id);
        env.storage().persistent().set(&DataKey::PlayerChallenges(challenged.clone()), &challenges);

        // Add to challenger's list
        let mut challenger_challenges = env.storage()
            .persistent()
            .get::<DataKey, Vec<u32>>(&DataKey::PlayerChallenges(challenger.clone()))
            .unwrap_or(vec![&env]);
        challenger_challenges.push_back(challenge_id);
        env.storage().persistent().set(&DataKey::PlayerChallenges(challenger), &challenger_challenges);

        Ok(challenge_id)
    }

    /// Accept a challenge and start a game
    pub fn accept_challenge(
        env: Env,
        challenge_id: u32,
        challenged: Address,
        session_id: u32,
    ) -> Result<(), Error> {
        challenged.require_auth();

        // Get challenge
        let challenge_key = DataKey::Challenge(challenge_id);
        let mut challenge: Challenge = env.storage()
            .temporary()
            .get(&challenge_key)
            .ok_or(Error::ChallengeNotFound)?;

        // Verify challenged is correct player
        if challenge.challenged != challenged {
            return Err(Error::NotPlayer);
        }

        // Check if expired
        if env.ledger().timestamp() > challenge.expires_at {
            return Err(Error::ChallengeExpired);
        }

        // Mark as accepted
        challenge.is_accepted = true;
        challenge.session_id = Some(session_id);
        env.storage().temporary().set(&challenge_key, &challenge);

        // Start game with wagered points. Challenger auth was already provided when
        // sending challenge, so acceptance should not require challenger to sign again.
        Self::start_game_after_auth(
            env,
            session_id,
            challenge.challenger.clone(),
            challenge.challenged.clone(),
            challenge.points_wagered,
            challenge.points_wagered,
        )?;

        Ok(())
    }

    /// Decline a pending challenge (by the challenged player) or cancel it (by the
    /// challenger). The challenge is removed from storage and from both players'
    /// challenge lists, so it disappears from the pending list for both sides.
    ///
    /// Only works on challenges that have not yet been accepted/completed. If a future
    /// change (issue #1) locks the challenger's stake at `send_challenge` time, this is
    /// the natural place to refund it before removal — today no stake is locked, so
    /// there is nothing to return.
    pub fn decline_challenge(
        env: Env,
        challenge_id: u32,
        caller: Address,
    ) -> Result<(), Error> {
        caller.require_auth();

        let challenge_key = DataKey::Challenge(challenge_id);
        let challenge: Challenge = env.storage()
            .temporary()
            .get(&challenge_key)
            .ok_or(Error::ChallengeNotFound)?;

        // Only the challenged player (decline) or the challenger (cancel) may remove it.
        if challenge.challenged != caller && challenge.challenger != caller {
            return Err(Error::NotPlayer);
        }

        // A challenge that has already been accepted has started a game and cannot be
        // declined; completed challenges are already terminal.
        if challenge.is_accepted || challenge.is_completed {
            return Err(Error::ChallengeAlreadyAccepted);
        }

        // Remove the challenge itself, then drop its id from both players' lists.
        env.storage().temporary().remove(&challenge_key);
        Self::remove_challenge_from_player(&env, &challenge.challenger, challenge_id);
        Self::remove_challenge_from_player(&env, &challenge.challenged, challenge_id);

        Ok(())
    }

    /// Remove a challenge id from a player's `PlayerChallenges` list (no-op if absent).
    fn remove_challenge_from_player(env: &Env, player: &Address, challenge_id: u32) {
        let key = DataKey::PlayerChallenges(player.clone());
        if let Some(ids) = env.storage().persistent().get::<DataKey, Vec<u32>>(&key) {
            let mut next = vec![env];
            for id in ids.iter() {
                if id != challenge_id {
                    next.push_back(id);
                }
            }
            env.storage().persistent().set(&key, &next);
        }
    }

    /// Get all challenges for a player (sorted by status)
    pub fn get_player_challenges(env: Env, player: Address) -> (Vec<Challenge>, Vec<Challenge>, Vec<Challenge>) {
        let challenge_ids = env.storage()
            .persistent()
            .get::<DataKey, Vec<u32>>(&DataKey::PlayerChallenges(player))
            .unwrap_or(vec![&env]);

        let mut active = vec![&env];
        let mut completed = vec![&env];
        let mut expired = vec![&env];

        let current_time = env.ledger().timestamp();

        for i in 0..challenge_ids.len() {
            let challenge_id = challenge_ids.get(i).unwrap();
            if let Some(challenge) = env.storage().temporary().get::<DataKey, Challenge>(&DataKey::Challenge(challenge_id)) {
                if challenge.is_completed {
                    completed.push_back(challenge);
                } else if current_time > challenge.expires_at {
                    expired.push_back(challenge);
                } else {
                    active.push_back(challenge);
                }
            }
        }

        (active, completed, expired)
    }

    // ========================================================================
    // Game Playback
    // ========================================================================

    /// Get detailed game playback with all moves and results
    pub fn get_game_playback(env: Env, session_id: u32) -> Result<GamePlayback, Error> {
        let key = DataKey::Game(session_id);
        let game: Game = env.storage()
            .temporary()
            .get(&key)
            .ok_or(Error::GameNotFound)?;

        // Check if both players have revealed
        if !game.player1_commitment.has_revealed || !game.player2_commitment.has_revealed {
            return Err(Error::BothPlayersNotCommitted);
        }

        // Get usernames
        let player1_username = Self::get_username(env.clone(), game.player1.clone());
        let player2_username = Self::get_username(env.clone(), game.player2.clone());

        // Build detailed turn results
        let mut detailed_turns = vec![&env];
        
        for turn in 0..TURNS_PER_BATTLE {
            let p1_move = game.player1_commitment.moves.moves.get(turn).unwrap();
            let p2_move = game.player2_commitment.moves.moves.get(turn).unwrap();

            // Calculate damage and defense success for this turn
            let (p1_damage, p1_defense_success) = Self::calculate_damage_and_defense(
                &env,
                p1_move.attack,
                p2_move.defense,
                &game.player1_commitment.moves.moves,
                turn,
            );

            let (p2_damage, p2_defense_success) = Self::calculate_damage_and_defense(
                &env,
                p2_move.attack,
                p1_move.defense,
                &game.player2_commitment.moves.moves,
                turn,
            );

            // Get HP from battle result
            let turn_result = game.battle_result.turn_results.get(turn).unwrap();

            detailed_turns.push_back(DetailedTurnResult {
                turn,
                player1_move: p1_move,
                player2_move: p2_move,
                player1_damage_dealt: p1_damage,
                player2_damage_dealt: p2_damage,
                player1_damage_taken: p2_damage,
                player2_damage_taken: p1_damage,
                player1_hp_remaining: turn_result.player1_hp_remaining,
                player2_hp_remaining: turn_result.player2_hp_remaining,
                player1_defense_successful: p1_defense_success,
                player2_defense_successful: p2_defense_success,
            });
        }

        Ok(GamePlayback {
            session_id,
            player1: game.player1,
            player2: game.player2,
            player1_username,
            player2_username,
            turn_results: detailed_turns,
            final_player1_hp: game.battle_result.player1_hp,
            final_player2_hp: game.battle_result.player2_hp,
            winner: game.battle_result.winner,
            is_draw: game.battle_result.is_draw,
        })
    }

    // ========================================================================
    // Existing Game Functions 
    // ========================================================================

    /// Start a new game between two players with points
    pub fn start_game(
        env: Env,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    ) -> Result<(), Error> {
        // Prevent self-play
        if player1 == player2 {
            panic!("Cannot play against yourself");
        }

        // Require authentication from both players
        player1.require_auth_for_args(vec![
            &env,
            session_id.into_val(&env),
            player1_points.into_val(&env),
        ]);
        // player2.require_auth_for_args(vec![
        //     &env,
        //     session_id.into_val(&env),
        //     player2_points.into_val(&env),
        // ]);

        Self::start_game_after_auth(
            env,
            session_id,
            player1,
            player2,
            player1_points,
            player2_points,
        )
    }

    fn start_game_after_auth(
        env: Env,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    ) -> Result<(), Error> {
        if player1 == player2 {
            panic!("Cannot play against yourself");
        }

        // Get GameHub address
        let game_hub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("GameHub address not set");

        // Create GameHub client
        let game_hub = GameHubClient::new(&env, &game_hub_addr);

        // Call Game Hub to start the session and lock points
        game_hub.start_game(
            &env.current_contract_address(),
            &session_id,
            &player1,
            &player2,
            &player1_points,
            &player2_points,
        );

        // Create empty default commitment
        let empty_commitment = PlayerCommitment {
            proof_id: BytesN::from_array(&env, &[0u8; 32]),
            has_revealed: false,
            moves: MoveSequence { moves: vec![&env] },
            commit_timestamp: 0,
        };

        // Create empty battle result
        let empty_result = BattleResult {
            player1_hp: 0,
            player2_hp: 0,
            winner: None,
            is_draw: false,
            turn_results: vec![&env],
        };

        // Create game
        let game = Game {
            player1: player1.clone(),
            player2: player2.clone(),
            player1_points,
            player2_points,
            has_player1_commitment: false,
            player1_commitment: empty_commitment.clone(),
            has_player2_commitment: false,
            player2_commitment: empty_commitment,
            has_battle_result: false,
            battle_result: empty_result,
        };

        // Store game in temporary storage with TTL
        let game_key = DataKey::Game(session_id);
        env.storage().temporary().set(&game_key, &game);
        env.storage()
            .temporary()
            .extend_ttl(&game_key, GAME_TTL_LEDGERS, GAME_TTL_LEDGERS);

        Ok(())
    }

    /// Commit move sequence with ZK proof
/// Player proves they know valid moves WITHOUT revealing them.
/// The proof's public output (commitment hash) is stored.
pub fn commit_moves(
    env: Env,
    session_id: u32,
    player: Address,
    public_inputs: Bytes,
    proof_bytes: Bytes,
) -> Result<BytesN<32>, Error> {
    player.require_auth();

    let key = DataKey::Game(session_id);
    let mut game: Game = env
        .storage()
        .temporary()
        .get(&key)
        .ok_or(Error::GameNotFound)?;

    if game.has_battle_result {
        return Err(Error::GameAlreadyEnded);
    }

    let ultrahonk_addr = env.storage()
    .instance()
    .get(&DataKey::Ultrahonkverifier)
    .expect("verifier address not set");
            
    // verify_proof now returns Result<BytesN<32>, ClashError>
    let commitment_hash = verify_proof(&env, &ultrahonk_addr, public_inputs, proof_bytes)
        .map_err(|_| Error::ProofVerificationFailed)?;

    let commitment = PlayerCommitment {
        proof_id: commitment_hash.clone(),
        has_revealed: false,
        moves: MoveSequence { moves: vec![&env] },
        commit_timestamp: env.ledger().timestamp(),
    };

    if player == game.player1 {
        if game.has_player1_commitment {
            return Err(Error::AlreadyCommitted);
        }
        game.player1_commitment = commitment;
        game.has_player1_commitment = true;
    } else if player == game.player2 {
        if game.has_player2_commitment {
            return Err(Error::AlreadyCommitted);
        }
        game.player2_commitment = commitment;
        game.has_player2_commitment = true;
    } else {
        return Err(Error::NotPlayer);
    }

    env.storage().temporary().set(&key, &game);
    Ok(commitment_hash)
}

/// Reveal moves — player re-proves with moves now PUBLIC.
/// The contract verifies the new proof's commitment output
/// matches what was stored at commit time.
pub fn reveal_moves(
    env: Env,
    session_id: u32,
    player: Address,
    public_inputs: Bytes,
    moves: Vec<Move>,
) -> Result<(), Error> {
    player.require_auth();

    if moves.len() != TURNS_PER_BATTLE {
        return Err(Error::InvalidMoveSequence);
    }

    let key = DataKey::Game(session_id);
    let mut game: Game = env
        .storage()
        .temporary()
        .get(&key)
        .ok_or(Error::GameNotFound)?;

    if !game.has_player1_commitment || !game.has_player2_commitment {
        return Err(Error::BothPlayersNotCommitted);
    }

    let revealed_hash = Self::extract_commitment_hash(&env, &public_inputs)?;

    if player == game.player1 {
        if game.player1_commitment.has_revealed {
            return Err(Error::AlreadyRevealed);
        }
        if revealed_hash != game.player1_commitment.proof_id {
            return Err(Error::CommitmentMismatch);
        }
        game.player1_commitment.moves = MoveSequence { moves };
        game.player1_commitment.has_revealed = true;
    } else if player == game.player2 {
        if game.player2_commitment.has_revealed {
            return Err(Error::AlreadyRevealed);
        }
        if revealed_hash != game.player2_commitment.proof_id {
            return Err(Error::CommitmentMismatch);
        }
        game.player2_commitment.moves = MoveSequence { moves };
        game.player2_commitment.has_revealed = true;
    } else {
        return Err(Error::NotPlayer);
    }

    env.storage().temporary().set(&key, &game);
    Ok(())
}


    /// Resolve the battle after both players have revealed their moves
    pub fn resolve_battle(env: Env, session_id: u32) -> Result<BattleResult, Error> {
        // Get game from storage
        let key = DataKey::Game(session_id);
        let mut game: Game = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::GameNotFound)?;

        // Check if already resolved
        if game.has_battle_result {
            // Update associated challenge if exists
            Self::mark_challenge_completed(&env, session_id);
            return Ok(game.battle_result.clone());
        }

        // Check both players have revealed moves
        if !game.player1_commitment.has_revealed || !game.player2_commitment.has_revealed {
            return Err(Error::BothPlayersNotCommitted);
        }

        // Simulate battle
        let battle_result = Self::simulate_battle(
            &env,
            &game.player1,
            &game.player2,
            &game.player1_commitment.moves,
            &game.player2_commitment.moves,
        );

        // Store result
        game.battle_result = battle_result.clone();
        game.has_battle_result = true;
        env.storage().temporary().set(&key, &game);

        // Mark challenge as completed
        Self::mark_challenge_completed(&env, session_id);

        // Report to GameHub
        let game_hub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("GameHub address not set");

        let game_hub = GameHubClient::new(&env, &game_hub_addr);
        if battle_result.is_draw {
            // Explicit draw semantics: the hub refunds both stakes from escrow
            // (issue #1) instead of paying a pot. No CSH reward is minted on a draw.
            game_hub.end_game_draw(&session_id);
        } else {
            let winner = battle_result.winner.as_ref().unwrap();
            let player1_won = winner == &game.player1;
            game_hub.end_game(&session_id, &player1_won);
            Self::mint_csh_reward(&env, winner.clone());
        }

        Ok(battle_result)
    }

    /// Forfeit a game when opponent never reveals within timeout
    pub fn forfeit_unrevealed(env: Env, session_id: u32, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        let key = DataKey::Game(session_id);
        let mut game: Game = env
            .storage()
            .temporary()
            .get(&key)
            .ok_or(Error::GameNotFound)?;

        // Determine player role
        let (is_caller_player1, opponent_commit, opponent_has_commit, opponent_addr) = if caller == game.player1 {
            (true, &mut game.player2_commitment, game.has_player2_commitment, game.player2.clone())
        } else if caller == game.player2 {
            (false, &mut game.player1_commitment, game.has_player1_commitment, game.player1.clone())
        } else {
            return Err(Error::NotPlayer);
        };

        // Opponent must have committed and not revealed
        if !opponent_has_commit {
            return Err(Error::BothPlayersNotCommitted);
        }
        if opponent_commit.has_revealed {
            return Err(Error::AlreadyRevealed);
        }

        // Check timeout
        let current_ts = env.ledger().timestamp();
        if current_ts < opponent_commit.commit_timestamp + FORFEIT_TIMEOUT {
            return Err(Error::ForfeitTooEarly);
        }

        // Resolve in favor of caller
        let winner = caller.clone();
        let battle_result = BattleResult {
            player1_hp: STARTING_HP,
            player2_hp: STARTING_HP,
            winner: Some(winner.clone()),
            is_draw: false,
            turn_results: vec![&env],
        };
        game.battle_result = battle_result.clone();
        game.has_battle_result = true;
        env.storage().temporary().set(&key, &game);

        // Report to GameHub
        let hub_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("GameHub address not set");
        let hub = GameHubClient::new(&env, &hub_addr);
        let player1_won = if is_caller_player1 { true } else { false };
        hub.end_game(&session_id, &player1_won);
        Self::mint_csh_reward(&env, winner);
        Ok(())
    }

    /// Get game information
    pub fn get_game(env: Env, session_id: u32) -> Result<Game, Error> {
        let key = DataKey::Game(session_id);
        env.storage()
            .temporary()
            .get(&key)
            .ok_or(Error::GameNotFound)
    }

    // ========================================================================
    // Internal Battle Logic
    // ========================================================================

    fn extract_commitment_hash(env: &Env, public_inputs: &Bytes) -> Result<BytesN<32>, Error> {
        // Public inputs structure: [player_address (32 bytes), session_id (32 bytes), commitment_hash (32 bytes)]
        // The commitment hash is the last 32 bytes
        
        let len = public_inputs.len();
        if len < 32 {
            return Err(Error::InvalidPublicInputs);
        }
        
        // Extract last 32 bytes
        let hash_slice = public_inputs.slice((len - 32)..len);
        
        // Convert to array
        let mut array = [0u8; 32];
        for i in 0..32 {
            array[i] = hash_slice.get(i as u32).ok_or(Error::InvalidPublicInputs)?;
        }
        
        Ok(BytesN::from_array(env, &array))
    }


    fn validate_username_format(username: &String) -> bool {
        let bytes = username.to_bytes();
        
        for i in 0..bytes.len() {
            let byte = bytes.get(i).unwrap();
            // Only allow lowercase a-z (97-122), 0-9 (48-57), and underscore (95)
            let is_valid = (byte >= 97 && byte <= 122) || // a-z only
                           (byte >= 48 && byte <= 57) ||  // 0-9
                           byte == 95;                     // underscore
            
            if !is_valid {
                return false;
            }
        }
        
        true
    }

    fn simulate_battle(
        env: &Env,
        player1: &Address,
        player2: &Address,
        p1_moves: &MoveSequence,
        p2_moves: &MoveSequence,
    ) -> BattleResult {
        let mut p1_hp = STARTING_HP;
        let mut p2_hp = STARTING_HP;
        let mut turn_results = Vec::new(env);
    
        for turn in 0..TURNS_PER_BATTLE {
            let p1_move = &p1_moves.moves.get(turn).unwrap();
            let p2_move = &p2_moves.moves.get(turn).unwrap();
    
            // Calculate damage
            let (p1_damage, p1_defense_success) = Self::calculate_damage_and_defense(
                env,
                p1_move.attack,
                p2_move.defense,
                &p1_moves.moves,
                turn,
            );
            let (p2_damage, p2_defense_success) = Self::calculate_damage_and_defense(
                env,
                p2_move.attack,
                p1_move.defense,
                &p2_moves.moves,
                turn,
            );
    
            // Apply damage SIMULTANEOUSLY
            p1_hp -= p2_damage;
            p2_hp -= p1_damage;
    
            // Store turn result
            turn_results.push_back(TurnResult {
                turn,
                player1_damage_dealt: p1_damage,
                player2_damage_dealt: p2_damage,
                player1_hp_remaining: p1_hp,
                player2_hp_remaining: p2_hp,
                player1_defense_successful: p1_defense_success,
                player2_defense_successful: p2_defense_success,
            });
    
            // Check for knockout AFTER storing the result
            if p1_hp <= 0 || p2_hp <= 0 {
                break;
            }
        }
    
        // Determine winner with proper draw handling
        let (winner, is_draw) = if p1_hp <= 0 && p2_hp <= 0 {
            // Both died - it's a DRAW
            (None, true)
        } else if p1_hp > p2_hp {
            // Player 1 wins
            (Some(player1.clone()), false)
        } else if p2_hp > p1_hp {
            // Player 2 wins
            (Some(player2.clone()), false)
        } else {
            // Equal HP but both alive - tie-breaker to Player 1
            (Some(player1.clone()), false)
        };
    
        BattleResult {
            player1_hp: p1_hp,
            player2_hp: p2_hp,
            winner,
            is_draw,
            turn_results,
        }
    }

    
    fn calculate_damage_and_defense(
        _env: &Env,
        attack: Attack,
        defense: Defense,
        move_sequence: &Vec<Move>,
        current_turn: u32,
    ) -> (i32, bool) {
        // Base damage for each attack type
        let base_damage = match attack {
            Attack::Slash => 30,
            Attack::Fireball => 40,
            Attack::Lightning => 35,
        };

        // Pure RPS: Check if defense STOPS the attack
        let blocked = match (attack, defense) {
            (Attack::Slash, Defense::Dodge) => true,
            (Attack::Fireball, Defense::Counter) => true,
            (Attack::Lightning, Defense::Block) => true,
            _ => false,
        };

        // If blocked, no damage and defense was successful
        if blocked {
            return (0, true);
        }

        // Calculate combo bonus
        let mut combo_bonus = 0;
        if current_turn >= 1 {
            let prev_attack = move_sequence.get(current_turn - 1).unwrap().attack;
            if prev_attack == attack {
                combo_bonus = COMBO_2_BONUS;
            }
        }
        if current_turn >= 2 {
            let prev2_attack = move_sequence.get(current_turn - 2).unwrap().attack;
            let prev1_attack = move_sequence.get(current_turn - 1).unwrap().attack;
            if prev2_attack == attack && prev1_attack == attack {
                combo_bonus = COMBO_3_BONUS;
            }
        }

        (base_damage + combo_bonus, false)
    }

    // fn calculate_damage(
    //     env: &Env,
    //     attack: Attack,
    //     defense: Defense,
    //     move_sequence: &Vec<Move>,
    //     current_turn: u32,
    // ) -> i32 {
    //     let (damage, _) = Self::calculate_damage_and_defense(env, attack, defense, move_sequence, current_turn);
    //     damage
    // }

    fn mark_challenge_completed(env: &Env, session_id: u32) {
        // Find and mark challenge as completed
        let challenge_counter: u32 = env.storage()
            .instance()
            .get(&DataKey::ChallengeCounter)
            .unwrap_or(0);

        for challenge_id in 0..challenge_counter {
            if let Some(mut challenge) = env.storage().temporary().get::<DataKey, Challenge>(&DataKey::Challenge(challenge_id)) {
                if let Some(chal_session_id) = challenge.session_id {
                    if chal_session_id == session_id {
                        challenge.is_completed = true;
                        env.storage().temporary().set(&DataKey::Challenge(challenge_id), &challenge);
                        break;
                    }
                }
            }
        }
    }

    // ============================================================================
    // PVP Match Functions
    // ============================================================================

    pub fn create_invite(env: Env, inviter: Address, opponent: Address) -> Result<u32, Error> {
        inviter.require_auth();

        if inviter == opponent {
            return Err(Error::CannotChallengeSelf);
        }

        let match_id: u32 = env.storage()
            .instance()
            .get(&DataKey::MatchCounter)
            .unwrap_or(0);
        env.storage().instance().set(&DataKey::MatchCounter, &(match_id + 1));

        let pvp_match = PvPMatch {
            match_id,
            player1: inviter.clone(),
            player2: opponent.clone(),
            state: MatchState::Created,
            current_turn: 0,
            player1_hp: STARTING_HP,
            player2_hp: STARTING_HP,
            last_action: vec![&env], // no move staged yet
            winner: None,
        };

        env.storage().persistent().set(&DataKey::Match(match_id), &pvp_match);

        // Add to players' lists
        let mut inviter_matches = env.storage()
            .persistent()
            .get::<DataKey, Vec<u32>>(&DataKey::PlayerMatches(inviter.clone()))
            .unwrap_or(vec![&env]);
        inviter_matches.push_back(match_id);
        env.storage().persistent().set(&DataKey::PlayerMatches(inviter), &inviter_matches);

        let mut opponent_matches = env.storage()
            .persistent()
            .get::<DataKey, Vec<u32>>(&DataKey::PlayerMatches(opponent.clone()))
            .unwrap_or(vec![&env]);
        opponent_matches.push_back(match_id);
        env.storage().persistent().set(&DataKey::PlayerMatches(opponent), &opponent_matches);

        Ok(match_id)
    }

    pub fn accept_invite(env: Env, accepter: Address, match_id: u32) -> Result<(), Error> {
        accepter.require_auth();

        let mut pvp_match: PvPMatch = env.storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::GameNotFound)?;

        if pvp_match.player2 != accepter || pvp_match.state != MatchState::Created {
            return Err(Error::NotPlayer);
        }

        pvp_match.state = MatchState::Active;
        env.storage().persistent().set(&DataKey::Match(match_id), &pvp_match);

        Ok(())
    }

    pub fn reject_invite(env: Env, rejecter: Address, match_id: u32) -> Result<(), Error> {
        rejecter.require_auth();

        let mut pvp_match: PvPMatch = env.storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::GameNotFound)?;

        if pvp_match.player2 != rejecter || pvp_match.state != MatchState::Created {
            return Err(Error::NotPlayer);
        }

        pvp_match.state = MatchState::Finished;
        env.storage().persistent().set(&DataKey::Match(match_id), &pvp_match);

        Ok(())
    }

    pub fn play_turn(env: Env, player: Address, match_id: u32, action: Move) -> Result<(), Error> {
        player.require_auth();

        let mut pvp_match: PvPMatch = env.storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::GameNotFound)?;

        if pvp_match.state != MatchState::Active {
            return Err(Error::GameAlreadyEnded);
        }

        let is_player1 = pvp_match.player1 == player;
        let is_player2 = pvp_match.player2 == player;
        if !is_player1 && !is_player2 {
            return Err(Error::NotPlayer);
        }

        let current_player_turn = pvp_match.current_turn % 2 == 0;
        if (current_player_turn && !is_player1) || (!current_player_turn && !is_player2) {
            return Err(Error::NotPlayer); // not their turn
        }

        // Apply the action
        if let Some(last_move) = pvp_match.last_action.first() {
            // Resolve with last move
            let (damage1, damage2) = Self::resolve_turn(last_move, action);
            pvp_match.player1_hp -= damage1;
            pvp_match.player2_hp -= damage2;

            if pvp_match.player1_hp <= 0 || pvp_match.player2_hp <= 0 {
                pvp_match.state = MatchState::Finished;
                if pvp_match.player1_hp <= 0 && pvp_match.player2_hp <= 0 {
                    pvp_match.winner = None; // draw
                } else if pvp_match.player1_hp <= 0 {
                    pvp_match.winner = Some(pvp_match.player2.clone());
                } else {
                    pvp_match.winner = Some(pvp_match.player1.clone());
                }
            } else {
                pvp_match.current_turn += 1;
            }
            pvp_match.last_action = vec![&env]; // clear the staged move
        } else {
            pvp_match.last_action = vec![&env, action]; // stage this player's move
            pvp_match.current_turn += 1;
        }

        env.storage().persistent().set(&DataKey::Match(match_id), &pvp_match);

        Ok(())
    }

    fn resolve_turn(move1: Move, move2: Move) -> (i32, i32) {
        let mut damage1 = 0;
        let mut damage2 = 0;

        // Simple resolution: if attack not defended, deal damage
        if move1.attack == Attack::Slash && move2.defense != Defense::Dodge {
            damage2 += 30;
        }
        if move1.attack == Attack::Fireball && move2.defense != Defense::Counter {
            damage2 += 40;
        }
        if move1.attack == Attack::Lightning && move2.defense != Defense::Block {
            damage2 += 35;
        }

        if move2.attack == Attack::Slash && move1.defense != Defense::Dodge {
            damage1 += 30;
        }
        if move2.attack == Attack::Fireball && move1.defense != Defense::Counter {
            damage1 += 40;
        }
        if move2.attack == Attack::Lightning && move1.defense != Defense::Block {
            damage1 += 35;
        }

        (damage1, damage2)
    }

    pub fn end_match(env: Env, player: Address, match_id: u32) -> Result<(), Error> {
        player.require_auth();

        let mut pvp_match: PvPMatch = env.storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::GameNotFound)?;

        if pvp_match.player1 != player && pvp_match.player2 != player {
            return Err(Error::NotPlayer);
        }

        if pvp_match.state == MatchState::Finished {
            return Err(Error::GameAlreadyEnded);
        }

        pvp_match.state = MatchState::Finished;
        env.storage().persistent().set(&DataKey::Match(match_id), &pvp_match);

        Ok(())
    }

    pub fn get_match(env: Env, match_id: u32) -> Result<PvPMatch, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Match(match_id))
            .ok_or(Error::GameNotFound)
    }

    pub fn get_player_matches(env: Env, player: Address) -> Vec<u32> {
        env.storage()
            .persistent()
            .get::<DataKey, Vec<u32>>(&DataKey::PlayerMatches(player))
            .unwrap_or(vec![&env])
    }

    // ========================================================================
    // Admin Functions
    // ========================================================================

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Admin not set")
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        let admin: Address = Self::get_admin(env.clone());
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    pub fn get_hub(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::GameHubAddress)
            .expect("GameHub address not set")
    }

    pub fn set_hub(env: Env, new_hub: Address) {
        let admin: Address = Self::get_admin(env.clone());
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::GameHubAddress, &new_hub);
    }

    pub fn set_token_contract(env: Env, token_contract: Address) {
        let admin: Address = Self::get_admin(env.clone());
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::TokenContractAddress, &token_contract);
    }

    pub fn get_token_contract(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::TokenContractAddress)
    }

    pub fn get_csh_balance(env: Env, player: Address) -> i128 {
        let Some(token_addr) = Self::get_token_contract(env.clone()) else {
            return 0;
        };
        let token = ClashTokenClient::new(&env, &token_addr);
        token.balance(&player)
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        let admin: Address = Self::get_admin(env.clone());
        admin.require_auth();
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    fn mint_csh_reward(env: &Env, winner: Address) {
        let Some(token_addr) = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::TokenContractAddress)
        else {
            return;
        };
        let token = ClashTokenClient::new(env, &token_addr);
        token.mint(&winner, &CSH_REWARD_PER_WIN);
    }
}

#[contractimpl]
impl SmartAccount for ClashContract {
    fn get_context_rules_count(env: &Env) -> u32 {
        smart_get_context_rules_count(env)
    }

    fn get_context_rule(env: &Env, context_rule_id: u32) -> ContextRule {
        smart_get_context_rule(env, context_rule_id)
    }

    fn add_context_rule(
        env: &Env,
        context_type: ContextRuleType,
        name: String,
        valid_until: Option<u32>,
        signers: Vec<Signer>,
        policies: Map<Address, Val>,
    ) -> ContextRule {
        env.current_contract_address().require_auth();
        smart_add_context_rule(env, &context_type, &name, valid_until, &signers, &policies)
    }

    fn update_context_rule_name(env: &Env, context_rule_id: u32, name: String) -> ContextRule {
        env.current_contract_address().require_auth();
        smart_update_context_rule_name(env, context_rule_id, &name)
    }

    fn update_context_rule_valid_until(
        env: &Env,
        context_rule_id: u32,
        valid_until: Option<u32>,
    ) -> ContextRule {
        env.current_contract_address().require_auth();
        smart_update_context_rule_valid_until(env, context_rule_id, valid_until)
    }

    fn remove_context_rule(env: &Env, context_rule_id: u32) {
        env.current_contract_address().require_auth();
        smart_remove_context_rule(env, context_rule_id);
    }

    fn add_signer(env: &Env, context_rule_id: u32, signer: Signer) -> u32 {
        env.current_contract_address().require_auth();
        smart_add_signer(env, context_rule_id, &signer)
    }

    fn remove_signer(env: &Env, context_rule_id: u32, signer_id: u32) {
        env.current_contract_address().require_auth();
        smart_remove_signer(env, context_rule_id, signer_id);
    }

    fn add_policy(env: &Env, context_rule_id: u32, policy: Address, install_param: Val) -> u32 {
        env.current_contract_address().require_auth();
        smart_add_policy(env, context_rule_id, &policy, install_param)
    }

    fn remove_policy(env: &Env, context_rule_id: u32, policy_id: u32) {
        env.current_contract_address().require_auth();
        smart_remove_policy(env, context_rule_id, policy_id);
    }
}

#[contractimpl]
impl CustomAccountInterface for ClashContract {
    type Signature = AuthPayload;
    type Error = SmartAccountError;

    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signatures: AuthPayload,
        auth_contexts: Vec<Context>,
    ) -> Result<(), SmartAccountError> {
        smart_do_check_auth(&env, &signature_payload, &signatures, &auth_contexts)
    }
}
