#![cfg(test)]
//! Tests for decline/cancel of pending challenges (issue #11).
//!
//! These are written against the *current* combat-contract API (the legacy `test.rs`
//! targets an older number-guessing API and is not wired into the build). A minimal
//! mock GameHub stands in for the real hub so `accept_challenge` -> `start_game` works.

use crate::{ClashContract, ClashContractClient, Error};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct MockGameHub;

#[contractimpl]
impl MockGameHub {
    pub fn start_game(
        _env: Env,
        _game_id: Address,
        _session_id: u32,
        _player1: Address,
        _player2: Address,
        _player1_points: i128,
        _player2_points: i128,
    ) {
    }
    pub fn end_game(_env: Env, _session_id: u32, _player1_won: bool) {}
}

fn setup() -> (Env, ClashContractClient<'static>, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let hub_addr = env.register(MockGameHub, ());
    let admin = Address::generate(&env);
    // verifier is unused by the challenge/decline/accept paths, but the constructor
    // requires an address — a generated one is fine.
    let verifier = Address::generate(&env);

    let contract_id = env.register(ClashContract, (&admin, &hub_addr, &verifier));
    let client = ClashContractClient::new(&env, &contract_id);

    let challenger = Address::generate(&env);
    let challenged = Address::generate(&env);
    (env, client, challenger, challenged)
}

/// Number of *active* (pending) challenges for a player.
fn pending_ids(client: &ClashContractClient, player: &Address) -> u32 {
    let (active, _completed, _expired) = client.get_player_challenges(player);
    active.len()
}

#[test]
fn test_decline_removes_challenge_from_pending() {
    let (_env, client, challenger, challenged) = setup();
    let points = 100_0000000i128;

    let id = client.send_challenge(&challenger, &challenged, &points);

    // Before decline: the challenged player has one active (pending) challenge.
    assert_eq!(pending_ids(&client, &challenged), 1);
    assert_eq!(pending_ids(&client, &challenger), 1);

    // Challenged player declines.
    client.decline_challenge(&id, &challenged);

    // After decline: it is gone from both players' active lists.
    assert_eq!(pending_ids(&client, &challenged), 0);
    assert_eq!(pending_ids(&client, &challenger), 0);
}

#[test]
fn test_challenger_can_cancel() {
    let (_env, client, challenger, challenged) = setup();
    let id = client.send_challenge(&challenger, &challenged, &100_0000000i128);

    // Challenger cancels their own outgoing challenge.
    client.decline_challenge(&id, &challenger);

    assert_eq!(pending_ids(&client, &challenged), 0);
    assert_eq!(pending_ids(&client, &challenger), 0);
}

#[test]
fn test_non_participant_cannot_decline() {
    let (env, client, challenger, challenged) = setup();
    let stranger = Address::generate(&env);
    let id = client.send_challenge(&challenger, &challenged, &100_0000000i128);

    let res = client.try_decline_challenge(&id, &stranger);
    assert_eq!(res, Err(Ok(Error::NotPlayer)));

    // Challenge is untouched.
    assert_eq!(pending_ids(&client, &challenged), 1);
}

#[test]
fn test_cannot_decline_after_accept() {
    let (_env, client, challenger, challenged) = setup();
    let id = client.send_challenge(&challenger, &challenged, &100_0000000i128);

    let session_id = 7u32;
    client.accept_challenge(&id, &challenged, &session_id);

    // Once accepted, the challenge cannot be declined.
    let res = client.try_decline_challenge(&id, &challenged);
    assert_eq!(res, Err(Ok(Error::ChallengeAlreadyAccepted)));
}

#[test]
fn test_decline_nonexistent_challenge() {
    let (_env, client, _challenger, challenged) = setup();
    let res = client.try_decline_challenge(&999u32, &challenged);
    assert_eq!(res, Err(Ok(Error::ChallengeNotFound)));
}

#[test]
fn test_accept_flow_still_works() {
    let (_env, client, challenger, challenged) = setup();
    let points = 100_0000000i128;
    let id = client.send_challenge(&challenger, &challenged, &points);

    let session_id = 42u32;
    client.accept_challenge(&id, &challenged, &session_id);

    // A game was created with the right participants and stakes (regression guard).
    let game = client.get_game(&session_id);
    assert_eq!(game.player1, challenger);
    assert_eq!(game.player2, challenged);
    assert_eq!(game.player1_points, points);
    assert_eq!(game.player2_points, points);
}

#[test]
fn test_decline_one_keeps_others() {
    let (env, client, challenger, challenged) = setup();
    let other = Address::generate(&env);

    let id1 = client.send_challenge(&challenger, &challenged, &100_0000000i128);
    let _id2 = client.send_challenge(&other, &challenged, &50_0000000i128);

    // Challenged has two pending challenges; decline only the first.
    assert_eq!(pending_ids(&client, &challenged), 2);
    client.decline_challenge(&id1, &challenged);

    // Exactly one remains pending for the challenged player.
    assert_eq!(pending_ids(&client, &challenged), 1);
}
