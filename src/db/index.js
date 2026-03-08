'use strict';

const path = require('path'); //help safely create path files
const fs = require('fs'); //help read and write files, also check if file exists
const Database = require('better-sqlite3'); //importing SQLite from better-sqlite3
const { POLLEN_DIR } = require('../identity/index'); //main folder file path

const DB_PATH = path.join(POLLEN_DIR, 'pollen.db');

let _db = null; //stores database connection, so we dont need to open the database multiple times, 

//open or create the database and initialize the schema,uses cache instance also
function openDb() {
  if (_db) return _db;

  if (!fs.existsSync(POLLEN_DIR)) {
    fs.mkdirSync(POLLEN_DIR, { recursive: true });
  }

  _db = new Database(DB_PATH); //if file exists, open pollen.db
  //else create pollen.db

  // Enable WAL mode for better concurrent read performance
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  // Main messages table
  _db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id           TEXT PRIMARY KEY,
      from_identity TEXT NOT NULL,
      destination  TEXT NOT NULL,
      payload      TEXT NOT NULL,      -- JSON-encoded encrypted blob
      status       TEXT NOT NULL DEFAULT 'undelivered',
                                       -- undelivered | intransit | delivered
      hop_count    INTEGER NOT NULL DEFAULT 0,
      ttl          INTEGER NOT NULL,   -- Unix epoch ms — message dies after this
      created_at   INTEGER NOT NULL
    );
  `);

  // Known peer public keys
  _db.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      identity   TEXT PRIMARY KEY,     -- e.g. raj@a3f2
      public_key TEXT NOT NULL,        -- RSA PEM
      ip         TEXT,                 -- last known IP address
      last_seen  INTEGER NOT NULL      -- Unix epoch ms
    );
  `);

  try {
    _db.exec(`ALTER TABLE peers ADD COLUMN ip TEXT`);
  } catch (_) {
     // column already exists, leave it
     //for safety purpose

  return _db;
}
}

/**
 * Close the database connection.
 * Should be called on daemon shutdown.
 */
function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}


module.exports = { openDb, closeDb, DB_PATH };
