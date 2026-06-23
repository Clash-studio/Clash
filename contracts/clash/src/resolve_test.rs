#![cfg(test)]
//! Tests for battle resolution settlement against the GameHub (issue #27).
//!
//! Written against the *current* combat-contract API (the legacy `test.rs` targets
//! an older number-guessing API and is not wired into the build). The mock GameHub
//! here mirrors the real `mock-game-hub` escrow semantics so the win/draw payout
//! paths are observable: `start_game` locks both stakes, `end_game` pays the pot to
//! the winner, and `end_game_draw` refunds both stakes.

use crate::{
    Attack, ClashContract, ClashContractClient, DataKey, Defense, Game, Move, MoveSequence,
    PlayerCommitment,
};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{contract, contractimpl, contracttype, vec, Address, BytesN, Env};

#[contracttype]
#[derive(Clone)]
pub struct HubEscrow {
    pub player1: Address,
    pub player2: Address,
    pub stake1: i128,
    pub stake2: i128,
}

#[contracttype]
pub enum HubKey {
    Escrow(u32),
    Balance(Address),
}

#[contract]
pub struct MockGameHub;

#[contractimpl]
impl MockGameHub {
    pub fn start_game(
        env: Env,
        _game_id: Address,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    ) {
        env.storage().persistent().set(
            &HubKey::Escrow(session_id),
            &HubEscrow {
                player1,
                player2,
                stake1: player1_points,
                stake2: player2_points,
            },
        );
    }

    pub fn end_game(env: Env, session_id: u32, player1_won: bool) {
        if let Some(e) = Self::take_escrow(&env, session_id) {
            let pot = e.stake1 + e.stake2;
            let winner = if player1_won { e.player1 } else { e.player2 };
            Self::credit(&env, &winner, pot);
        }
    }

    pub fn end_game_draw(env: Env, session_id: u32) {
        if let Some(e) = Self::take_escrow(&env, session_id) {
            Self::credit(&env, &e.player1, e.stake1);
            Self::credit(&env, &e.player2, e.stake2);
        }
    }

    pub fn balance(env: Env, who: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&HubKey::Balance(who))
            .unwrap_or(0)
    }

    fn take_escrow(env: &Env, session_id: u32) -> Option<HubEscrow> {
        let key = HubKey::Escrow(session_id);
        let escrow: Option<HubEscrow> = env.storage().persistent().get(&key);
        if escrow.is_some() {
            env.storage().persistent().remove(&key);
        }
        escrow
    }

    fn credit(env: &Env, who: &Address, amount: i128) {
        let key = HubKey::Balance(who.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(current + amount));
    }
}

fn setup() -> (
    Env,
    ClashContractClient<'static>,
    MockGameHubClient<'static>,
    Address,
    Address,
) {
    let env = Env::default();
    env.mock_all_auths();

    let hub_addr = env.register(MockGameHub, ());
    let hub = MockGameHubClient::new(&env, &hub_addr);

    let admin = Address::generate(&env);
    // resolve_battle does not use the verifier, but the constructor requires one.
    let verifier = Address::generate(&env);

    let contract_id = env.register(ClashContract, (&admin, &hub_addr, &verifier));
    let client = ClashContractClient::new(&env, &contract_id);

    let player1 = Address::generate(&env);
    let player2 = Address::generate(&env);
    (env, client, hub, player1, player2)
}

/// Three identical moves as a `MoveSequence`.
fn move_seq(env: &Env, attack: Attack, defense: Defense) -> MoveSequence {
    MoveSequence {
        moves: vec![
            env,
            Move { attack, defense },
            Move { attack, defense },
            Move { attack, defense },
        ],
    }
}

/// A commitment already revealed with `moves` — lets `resolve_battle` run without
/// going through the ZK commit/reveal proof flow.
fn revealed(env: &Env, moves: MoveSequence) -> PlayerCommitment {
    PlayerCommitment {
        proof_id: BytesN::from_array(env, &[0u8; 32]),
        has_revealed: true,
        moves,
        commit_timestamp: 0,
    }
}

/// Start a game, then force both commitments to "revealed" with the given moves.
fn stage_revealed_battle(
    env: &Env,
    client: &ClashContractClient,
    session_id: u32,
    player1: &Address,
    player2: &Address,
    stake: i128,
    p1_moves: MoveSequence,
    p2_moves: MoveSequence,
) {
    client.start_game(&session_id, player1, player2, &stake, &stake);

    // Storage access from test code must be scoped to the clash contract.
    let key = DataKey::Game(session_id);
    env.as_contract(&client.address, || {
        let mut game: Game = env.storage().temporary().get(&key).expect("game exists");
        game.has_player1_commitment = true;
        game.has_player2_commitment = true;
        game.player1_commitment = revealed(env, p1_moves);
        game.player2_commitment = revealed(env, p2_moves);
        env.storage().temporary().set(&key, &game);
    });
}

#[test]
fn test_resolve_draw_refunds_both_stakes() {
    let (env, client, hub, player1, player2) = setup();
    let session_id = 100u32;
    let stake = 100_0000000i128;

    // Identical move sets are symmetric, so both fighters are knocked out on the
    // final turn -> the battle is a draw.
    stage_revealed_battle(
        &env,
        &client,
        session_id,
        &player1,
        &player2,
        stake,
        move_seq(&env, Attack::Fireball, Defense::Block),
        move_seq(&env, Attack::Fireball, Defense::Block),
    );

    let result = client.resolve_battle(&session_id);
    assert!(result.is_draw, "identical move sets should end in a draw");

    // Draw path: each player gets their own stake back; no pot is paid out.
    assert_eq!(hub.balance(&player1), stake);
    assert_eq!(hub.balance(&player2), stake);
}

#[test]
fn test_resolve_win_pays_pot_to_winner() {
    let (env, client, hub, player1, player2) = setup();
    let session_id = 101u32;
    let stake = 100_0000000i128;

    // player1 Dodges every Slash (takes 0 damage) and lands Fireballs against a
    // Block (which does not stop Fireball) -> player1 wins decisively.
    stage_revealed_battle(
        &env,
        &client,
        session_id,
        &player1,
        &player2,
        stake,
        move_seq(&env, Attack::Fireball, Defense::Dodge),
        move_seq(&env, Attack::Slash, Defense::Block),
    );

    let result = client.resolve_battle(&session_id);
    assert!(!result.is_draw, "asymmetric battle should have a winner");
    assert_eq!(result.winner.unwrap(), player1);

    // Win path is unchanged: winner takes the whole pot, loser gets nothing.
    assert_eq!(hub.balance(&player1), stake + stake);
    assert_eq!(hub.balance(&player2), 0);
}
