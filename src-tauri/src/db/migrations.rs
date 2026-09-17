use rusqlite::Connection;
use tracing::info;

use crate::error::AppResult;
use crate::logging::category;

/// A single forward-only schema step. Applied inside a transaction and recorded via
/// `PRAGMA user_version`, so a partially applied migration can never be observed.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: i32,
    pub name: &'static str,
    pub sql: &'static str,
}

fn user_version(conn: &Connection) -> AppResult<i32> {
    Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
}

/// Applies every migration whose version is greater than the database's current `user_version`.
/// Returns the resulting schema version.
pub fn apply(conn: &mut Connection, migrations: &[Migration], label: &str) -> AppResult<i32> {
    debug_assert!(
        migrations
            .windows(2)
            .all(|pair| pair[0].version < pair[1].version),
        "migrations must be sorted by ascending version"
    );

    let mut current = user_version(conn)?;

    let pending: Vec<Migration> = migrations
        .iter()
        .copied()
        .filter(|migration| migration.version > current)
        .collect();

    for migration in pending {
        let tx = conn.transaction()?;
        tx.execute_batch(migration.sql)?;
        // PRAGMA does not accept bound parameters.
        tx.pragma_update(None, "user_version", migration.version)?;
        tx.commit()?;

        current = migration.version;
        info!(
            target: category::DATABASE,
            database = label,
            version = migration.version,
            name = migration.name,
            "applied migration"
        );
    }

    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIGRATIONS: [Migration; 2] = [
        Migration {
            version: 1,
            name: "create_widgets",
            sql: "CREATE TABLE widgets (id TEXT PRIMARY KEY);",
        },
        Migration {
            version: 2,
            name: "add_widget_label",
            sql: "ALTER TABLE widgets ADD COLUMN label TEXT;",
        },
    ];

    #[test]
    fn applies_all_migrations_to_a_fresh_database() {
        let mut conn = Connection::open_in_memory().expect("in-memory database");
        let version = apply(&mut conn, &MIGRATIONS, "test").expect("migrations apply");
        assert_eq!(version, 2);

        conn.execute("INSERT INTO widgets (id, label) VALUES ('a', 'b')", [])
            .expect("schema has both columns");
    }

    #[test]
    fn is_idempotent() {
        let mut conn = Connection::open_in_memory().expect("in-memory database");
        apply(&mut conn, &MIGRATIONS, "test").expect("first run");
        let version = apply(&mut conn, &MIGRATIONS, "test").expect("second run is a no-op");
        assert_eq!(version, 2);
    }

    #[test]
    fn resumes_from_an_existing_version() {
        let mut conn = Connection::open_in_memory().expect("in-memory database");
        apply(&mut conn, &MIGRATIONS[..1], "test").expect("partial run");
        assert_eq!(user_version(&conn).expect("version"), 1);

        let version = apply(&mut conn, &MIGRATIONS, "test").expect("resumed run");
        assert_eq!(version, 2);
    }

    #[test]
    fn a_failing_migration_leaves_the_version_untouched() {
        const BROKEN: [Migration; 1] = [Migration {
            version: 1,
            name: "broken",
            sql: "CREATE TABLE ok (id TEXT); THIS IS NOT SQL;",
        }];

        let mut conn = Connection::open_in_memory().expect("in-memory database");
        assert!(apply(&mut conn, &BROKEN, "test").is_err());
        assert_eq!(user_version(&conn).expect("version"), 0);
        // The transaction rolled back, so the partially created table is gone too.
        assert!(conn
            .execute("INSERT INTO ok (id) VALUES ('a')", [])
            .is_err());
    }
}
