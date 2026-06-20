#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Map, Vec};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Points(Address),
    Players,
    Admin,
}

#[contract]
pub struct PointsTracker;

#[contractimpl]
impl PointsTracker {
    /// Called once at deploy time.
    /// Sets the admin (the account authorized to record results).
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        let empty: Vec<Address> = Vec::new(&env);
        env.storage().instance().set(&DataKey::Players, &empty);
    }

    /// Admin-only: register both duelists in the players list before `record_result`
    /// (same effect as the internal `ensure_registered` helper).
    pub fn register_players(env: Env, player_a: Address, player_b: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        assert!(player_a != player_b, "players must differ");

        Self::ensure_registered(&env, &player_a);
        Self::ensure_registered(&env, &player_b);
    }

    /// Record the result of a completed duel.
    /// Only callable by the admin address set at initialize.
    /// winner gets +30 points.
    /// loser loses 15 points, floor at 0 (never negative).
    /// If winner == loser (should never happen) panic.
    pub fn record_result(env: Env, winner: Address, loser: Address) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized");
        admin.require_auth();

        assert!(winner != loser, "winner and loser must differ");

        Self::ensure_registered(&env, &winner);
        Self::ensure_registered(&env, &loser);

        let winner_pts: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Points(winner.clone()))
            .unwrap_or(0u64);
        env.storage().instance().set(
            &DataKey::Points(winner.clone()),
            &(winner_pts + 30u64),
        );

        let loser_pts: u64 = env
            .storage()
            .instance()
            .get(&DataKey::Points(loser.clone()))
            .unwrap_or(0u64);
        let new_loser_pts = if loser_pts >= 15 { loser_pts - 15 } else { 0 };
        env.storage().instance().set(
            &DataKey::Points(loser.clone()),
            &new_loser_pts,
        );
    }

    /// Returns the points for a single player address.
    /// Returns 0 if the address has never played.
    pub fn get_points(env: Env, player: Address) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::Points(player))
            .unwrap_or(0u64)
    }

    /// Returns all players and their points as a map.
    pub fn get_leaderboard(env: Env) -> Map<Address, u64> {
        let players: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Players)
            .unwrap_or_else(|| Vec::new(&env));

        let mut result: Map<Address, u64> = Map::new(&env);
        let len = players.len();
        let mut i = 0u32;
        while i < len {
            let player = players.get(i).unwrap();
            let pts: u64 = env
                .storage()
                .instance()
                .get(&DataKey::Points(player.clone()))
                .unwrap_or(0u64);
            result.set(player, pts);
            i += 1;
        }
        result
    }

    /// Returns the admin address (for client-side verification).
    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    fn ensure_registered(env: &Env, player: &Address) {
        let mut players: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Players)
            .unwrap_or_else(|| Vec::new(env));

        let len = players.len();
        let mut i = 0u32;
        let mut already_in = false;
        while i < len {
            if players.get(i).unwrap() == *player {
                already_in = true;
                break;
            }
            i += 1;
        }
        if !already_in {
            players.push_back(player.clone());
            env.storage().instance().set(&DataKey::Players, &players);
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn setup(env: &Env) -> (PointsTrackerClient<'_>, Address) {
        let contract_id = env.register(PointsTracker, ());
        let client = PointsTrackerClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        (client, admin)
    }

    #[test]
    fn initialize_sets_admin() {
        let env = Env::default();
        let (client, admin) = setup(&env);
        assert_eq!(client.get_admin(), admin);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn initialize_twice_panics() {
        let env = Env::default();
        let (client, _admin) = setup(&env);
        client.initialize(&Address::generate(&env));
    }

    #[test]
    fn register_players_adds_both_to_leaderboard() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        client.register_players(&a, &b);

        let board = client.get_leaderboard();
        assert_eq!(board.len(), 2);
        assert_eq!(board.get(a).unwrap(), 0);
        assert_eq!(board.get(b).unwrap(), 0);
    }

    #[test]
    #[should_panic(expected = "players must differ")]
    fn register_players_rejects_same_address() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let a = Address::generate(&env);
        client.register_players(&a, &a);
    }

    #[test]
    fn record_result_awards_and_deducts_points() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let winner = Address::generate(&env);
        let loser = Address::generate(&env);

        // Give the loser a starting balance so the deduction is visible.
        client.record_result(&loser, &winner); // loser: +30, winner: 0 (floored)
        client.record_result(&winner, &loser); // winner: +30, loser: 30 - 15 = 15

        assert_eq!(client.get_points(&winner), 30);
        assert_eq!(client.get_points(&loser), 15);
    }

    #[test]
    fn loser_points_floor_at_zero() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let winner = Address::generate(&env);
        let loser = Address::generate(&env);

        // Loser starts at 0, so a 15 point deduction must floor at 0, never go negative.
        client.record_result(&winner, &loser);
        assert_eq!(client.get_points(&loser), 0);

        // A second loss keeps the loser at the floor.
        client.record_result(&winner, &loser);
        assert_eq!(client.get_points(&loser), 0);
        assert_eq!(client.get_points(&winner), 60);
    }

    #[test]
    #[should_panic(expected = "winner and loser must differ")]
    fn record_result_rejects_same_address() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin) = setup(&env);

        let a = Address::generate(&env);
        client.record_result(&a, &a);
    }

    #[test]
    fn record_result_requires_admin_auth() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, admin) = setup(&env);

        let winner = Address::generate(&env);
        let loser = Address::generate(&env);
        client.record_result(&winner, &loser);

        // The only authorization required for the call is the admin's.
        let auths = env.auths();
        assert_eq!(auths.len(), 1);
        assert_eq!(auths.get(0).unwrap().0, admin);
    }

    #[test]
    fn record_result_without_admin_auth_panics() {
        let env = Env::default();
        // Note: no mock_all_auths() here, so admin.require_auth() must fail.
        let (client, _admin) = setup(&env);

        let winner = Address::generate(&env);
        let loser = Address::generate(&env);
        let res = client.try_record_result(&winner, &loser);
        assert!(res.is_err());
    }
}
