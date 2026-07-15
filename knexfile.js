import "dotenv/config";

const url = process.env.DATABASE_URL || "sqlite:./data/dev.sqlite3";

/** @type {import('knex').Knex.Config} */
let connectionCfg;
if (url.startsWith("sqlite:")) {
  connectionCfg = {
    client: "better-sqlite3",
    connection: { filename: url.replace("sqlite:", "") },
    useNullAsDefault: true,
    pool: {
      afterCreate: (conn, done) => {
        conn.pragma("journal_mode = WAL");
        conn.pragma("foreign_keys = ON");
        done(null, conn);
      },
    },
  };
} else {
  connectionCfg = {
    client: "mysql2",
    connection: url,
    pool: { min: 1, max: 8 },
  };
}

export default {
  ...connectionCfg,
  migrations: { directory: "./migrations" },
  seeds: { directory: "./seeds" },
};
