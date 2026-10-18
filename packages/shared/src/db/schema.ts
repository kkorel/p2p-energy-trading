/**
 * SQLite Database Schema for P2P Energy Trading
 */

export const SCHEMA = {
  // Providers table - tracks BPP trust scores
  providers: `
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trust_score REAL DEFAULT 0.5,
      total_orders INTEGER DEFAULT 0,
      successful_orders INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,
  
  // Catalog items table
  catalog_items: `
    CREATE TABLE IF NOT EXISTS catalog_items (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      delivery_mode TEXT NOT NULL,
      available_qty REAL NOT NULL,
      meter_id TEXT,
      production_windows_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (provider_id) REFERENCES providers(id)
    )
  `,
  
  // Catalog offers table
  catalog_offers: `
    CREATE TABLE IF NOT EXISTS catalog_offers (
      id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      price_value REAL NOT NULL,
      currency TEXT NOT NULL,
      max_qty REAL NOT NULL,
      time_window_json TEXT NOT NULL,
      offer_attributes_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (item_id) REFERENCES catalog_items(id),
      FOREIGN KEY (provider_id) REFERENCES providers(id)
    )
  `,
  
  // Orders table
  orders: `
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      transaction_id TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      provider_id TEXT,
      selected_offer_id TEXT,
      total_qty REAL,
      total_price REAL,
      currency TEXT,
      raw_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (provider_id) REFERENCES providers(id),
      FOREIGN KEY (selected_offer_id) REFERENCES catalog_offers(id)
    )
  `,
  
  // Events table for logging
  events: `
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      action TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('OUTBOUND', 'INBOUND')),
      raw_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,
  
  // Offer blocks table - represents individual 1-unit blocks for granular trading
  offer_blocks: `
    CREATE TABLE IF NOT EXISTS offer_blocks (
      id TEXT PRIMARY KEY,
      offer_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK(status IN ('AVAILABLE', 'RESERVED', 'SOLD')),
      order_id TEXT,
      transaction_id TEXT,
      price_value REAL NOT NULL,
      currency TEXT NOT NULL,
      time_window_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reserved_at DATETIME,
      sold_at DATETIME,
      FOREIGN KEY (offer_id) REFERENCES catalog_offers(id),
      FOREIGN KEY (item_id) REFERENCES catalog_items(id),
      FOREIGN KEY (provider_id) REFERENCES providers(id),
      FOREIGN KEY (order_id) REFERENCES orders(id)
    )
  `,

  // Settlement records - manual escrow flow (Phase 4)
  settlement_records: `
    CREATE TABLE IF NOT EXISTS settlement_records (
      trade_id TEXT PRIMARY KEY,
      order_id TEXT,
      transaction_id TEXT,
      buyer_id TEXT,
      seller_id TEXT,
      principal REAL NOT NULL,
      fee REAL NOT NULL,
      total REAL NOT NULL,
      expires_at DATETIME NOT NULL,
      status TEXT NOT NULL,
      verification_outcome TEXT,
      funded_receipt TEXT,
      payout_receipt TEXT,
      funded_at DATETIME,
      verified_at DATETIME,
      payout_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `,
  
  // Index for faster event lookups
  events_index: `
    CREATE INDEX IF NOT EXISTS idx_events_transaction_id ON events(transaction_id)
  `,
  
  events_message_index: `
    CREATE INDEX IF NOT EXISTS idx_events_message_id ON events(message_id)
  `,
  
  // Indexes for offer blocks
  blocks_offer_index: `
    CREATE INDEX IF NOT EXISTS idx_blocks_offer_id ON offer_blocks(offer_id)
  `,
  
  blocks_status_index: `
    CREATE INDEX IF NOT EXISTS idx_blocks_status ON offer_blocks(offer_id, status)
  `,
  
  settlement_trade_index: `
    CREATE INDEX IF NOT EXISTS idx_settlement_trade_id ON settlement_records(trade_id)
  `,
};

/**
 * Initialize database with all tables (works with sql.js)
 */
export function initializeSchema(db: any): void {
  db.run(SCHEMA.providers);
  db.run(SCHEMA.catalog_items);
  db.run(SCHEMA.catalog_offers);
  db.run(SCHEMA.orders);
  db.run(SCHEMA.events);
  db.run(SCHEMA.offer_blocks);
  db.run(SCHEMA.settlement_records);
  db.run(SCHEMA.events_index);
  db.run(SCHEMA.events_message_index);
  db.run(SCHEMA.blocks_offer_index);
  db.run(SCHEMA.blocks_status_index);
  db.run(SCHEMA.settlement_trade_index);
}
