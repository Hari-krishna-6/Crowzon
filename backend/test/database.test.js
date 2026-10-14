import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../src/database.js'

test('schema v4 migration preserves existing users and product records', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'crowzon-migration-test-'))
  const filename = path.join(directory, 'legacy.sqlite')
  let migrated
  try {
    const legacy = new DatabaseSync(filename)
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        display_name TEXT NOT NULL,
        wallet_address TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        price TEXT NOT NULL,
        category TEXT NOT NULL,
        seller_id INTEGER NOT NULL REFERENCES users(id),
        image_reference TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        chain_id INTEGER,
        marketplace_address TEXT,
        listing_id INTEGER,
        deployment_id TEXT
      );
      CREATE UNIQUE INDEX products_chain_listing_unique
        ON products(chain_id, marketplace_address, deployment_id, listing_id)
        WHERE chain_id IS NOT NULL
          AND marketplace_address IS NOT NULL
          AND deployment_id IS NOT NULL
          AND listing_id IS NOT NULL;
      INSERT INTO users VALUES (3, 'Existing seller', NULL, 'created-user', 'updated-user');
      INSERT INTO products VALUES (
        9, 'Existing product', 'Retain metadata', '4.50', 'Services', 3, NULL,
        'ACTIVE', 'created-product', 'updated-product', 31337,
        '0x1111111111111111111111111111111111111111', 12,
        '1bdb4854-c6c1-4d14-9840-5befb41bf27e'
      );
      PRAGMA user_version = 3;
    `)
    legacy.close()

    migrated = openDatabase(filename)
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 7)
    assert.equal(
      migrated.prepare('PRAGMA table_info(users)').all().some((column) => column.name === 'assigned_account'),
      true,
    )
    const savedUser = migrated.prepare('SELECT id, display_name AS displayName FROM users').get()
    assert.equal(savedUser.id, 3)
    assert.equal(savedUser.displayName, 'Existing seller')
    const savedProduct = migrated.prepare(
      'SELECT id, title, seller_id AS sellerId, listing_id AS listingId FROM products',
    ).get()
    assert.equal(savedProduct.id, 9)
    assert.equal(savedProduct.title, 'Existing product')
    assert.equal(savedProduct.sellerId, 3)
    assert.equal(savedProduct.listingId, 12)
  } finally {
    migrated?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
