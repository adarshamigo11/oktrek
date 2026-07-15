import { MongoClient } from "mongodb";
import { config } from "../config/index.js";

let client = null;
let dbInstance = null;

export async function getDb() {
  if (dbInstance) return dbInstance;

  client = new MongoClient(config.mongoUrl, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
  });
  await client.connect();
  dbInstance = client.db();
  return dbInstance;
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = null;
    dbInstance = null;
  }
}

/** Auto-increment numeric `_id` for a collection. Returns the next sequence number. */
export async function nextId(db, collectionName) {
  const r = await db.collection("counters").findOneAndUpdate(
    { _id: collectionName },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );
  return r.seq;
}
import knex from "knex";
import knexConfig from "../../knexfile.js";

export const db = knex(knexConfig);
