/**
 * Jest Global Setup
 * Runs once before all tests to set up the environment
 */

export default async function globalSetup() {
  // Note: NODE_ENV is already set to 'test' by Jest
  
  // Use test database (in case we want to isolate test data)
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'postgresql://p2p_user:p2p_password@localhost:5432/p2p_trading';
  }
  
  if (!process.env.REDIS_URL) {
    process.env.REDIS_URL = 'redis://localhost:6379';
  }
  
  console.log('\n🧪 Global test setup complete');
  console.log(`   Database: ${process.env.DATABASE_URL}`);
  console.log(`   Redis: ${process.env.REDIS_URL}\n`);
}
