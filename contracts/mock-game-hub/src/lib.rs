#![no_std]

use soroban_sdk::{contract, contractevent, contractimpl, contracttype, Address, Env};

/// Mock Game Hub contract for game studio development
///
/// This contract provides the same external interface that games expect
/// (start_game, end_game, end_game_draw). To make stake/escrow semantics
/// (issue #1) observable during development it keeps a lightweight internal
/// ledger: `start_game` records each player's stake as escrow, `end_game`
/// pays the pot to the winner, and `end_game_draw` refunds both stakes.
///
/// Payouts/refunds are credited to an in-contract balance map rather than a
/// real token transfer, which is enough for integration tests and local dev.
/// When no escrow exists for a session the end calls simply emit their event
/// (the "when #1 escrow exists" guard), so the hub stays usable even before
/// real staking is wired up.
#[contract]
pub struct MockGameHub;

/// Escrow held for a single session: who is playing and how much each staked.
#[contracttype]
#[derive(Clone)]
pub struct Escrow {
    pub player1: Address,
    pub player2: Address,
    pub player1_stake: i128,
    pub player2_stake: i128,
}

#[contracttype]
pub enum DataKey {
    /// Active escrow for a session, keyed by `session_id`.
    Escrow(u32),
    /// Credited balance (winnings + refunds) for an address.
    Balance(Address),
}

#[contractevent]
pub struct GameStarted {
    pub session_id: u32,
    pub game_id: Address,
    pub player1: Address,
    pub player2: Address,
    pub player1_points: i128,
    pub player2_points: i128,
}

#[contractevent]
pub struct GameEnded {
    pub session_id: u32,
    pub player1_won: bool,
}

#[contractevent]
pub struct GameEndedDraw {
    pub session_id: u32,
}

#[contractimpl]
impl MockGameHub {
    /// Start a game session and lock both stakes in escrow.
    ///
    /// # Arguments
    /// * `game_id` - Address of the game contract calling this method
    /// * `session_id` - Unique identifier for this game session
    /// * `player1` - Address of first player
    /// * `player2` - Address of second player
    /// * `player1_points` - Stake amount for player 1
    /// * `player2_points` - Stake amount for player 2
    pub fn start_game(
        env: Env,
        game_id: Address,
        session_id: u32,
        player1: Address,
        player2: Address,
        player1_points: i128,
        player2_points: i128,
    ) {
        // No auth required for mock
        env.storage().persistent().set(
            &DataKey::Escrow(session_id),
            &Escrow {
                player1: player1.clone(),
                player2: player2.clone(),
                player1_stake: player1_points,
                player2_stake: player2_points,
            },
        );

        GameStarted {
            session_id,
            game_id,
            player1,
            player2,
            player1_points,
            player2_points,
        }
        .publish(&env);
        // bump instance ttl if required
        env.storage().instance().extend_ttl(17_280, 518_400);
    }

    /// End a game session and pay the pot to the winner.
    ///
    /// # Arguments
    /// * `session_id` - The game session being ended
    /// * `player1_won` - True if player1 won, false if player2 won
    pub fn end_game(env: Env, session_id: u32, player1_won: bool) {
        // No auth required for mock
        if let Some(escrow) = Self::take_escrow(&env, session_id) {
            let pot = escrow.player1_stake + escrow.player2_stake;
            let winner = if player1_won {
                escrow.player1
            } else {
                escrow.player2
            };
            Self::credit(&env, &winner, pot);
        }

        GameEnded {
            session_id,
            player1_won,
        }
        .publish(&env);
    }

    /// End a game session that ended in a draw, refunding both stakes from escrow.
    ///
    /// # Arguments
    /// * `session_id` - The game session being ended
    pub fn end_game_draw(env: Env, session_id: u32) {
        // No auth required for mock
        if let Some(escrow) = Self::take_escrow(&env, session_id) {
            Self::credit(&env, &escrow.player1, escrow.player1_stake);
            Self::credit(&env, &escrow.player2, escrow.player2_stake);
        }

        GameEndedDraw { session_id }.publish(&env);
    }

    /// Credited balance (winnings + refunds) for an address. Returns 0 if none.
    pub fn balance(env: Env, who: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(who))
            .unwrap_or(0)
    }

    /// Remove and return the escrow for a session, if any.
    fn take_escrow(env: &Env, session_id: u32) -> Option<Escrow> {
        let key = DataKey::Escrow(session_id);
        let escrow: Option<Escrow> = env.storage().persistent().get(&key);
        if escrow.is_some() {
            env.storage().persistent().remove(&key);
        }
        escrow
    }

    /// Credit `amount` to `who`'s balance.
    fn credit(env: &Env, who: &Address, amount: i128) {
        let key = DataKey::Balance(who.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(current + amount));
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup() -> (Env, MockGameHubClient<'static>, Address, Address, Address) {
        let env = Env::default();
        let contract_id = env.register(MockGameHub, ());
        let client = MockGameHubClient::new(&env, &contract_id);
        let game_id = Address::generate(&env);
        let player1 = Address::generate(&env);
        let player2 = Address::generate(&env);
        (env, client, game_id, player1, player2)
    }

    #[test]
    fn test_win_pays_pot_to_winner() {
        let (_env, client, game_id, player1, player2) = setup();
        client.start_game(&game_id, &1, &player1, &player2, &1000, &1000);

        client.end_game(&1, &true);

        // Winner receives both stakes; loser receives nothing.
        assert_eq!(client.balance(&player1), 2000);
        assert_eq!(client.balance(&player2), 0);
    }

    #[test]
    fn test_draw_refunds_both_stakes() {
        let (_env, client, game_id, player1, player2) = setup();
        client.start_game(&game_id, &2, &player1, &player2, &1000, &750);

        client.end_game_draw(&2);

        // Each player gets their own stake back.
        assert_eq!(client.balance(&player1), 1000);
        assert_eq!(client.balance(&player2), 750);
    }

    #[test]
    fn test_end_without_escrow_is_noop() {
        let (_env, client, _game_id, player1, player2) = setup();
        // No start_game / escrow for this session — should not panic.
        client.end_game_draw(&99);
        client.end_game(&99, &true);
        assert_eq!(client.balance(&player1), 0);
        assert_eq!(client.balance(&player2), 0);
    }
}
