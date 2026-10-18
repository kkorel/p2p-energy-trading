/**
 * Seed data for Prosumer App (Combined BAP + BPP)
 * Uses Prisma ORM for PostgreSQL persistence
 */

import { prisma, connectPrisma, disconnectPrisma, clearAllTransactionStates, disconnectRedis } from '@p2p/shared';
import { generateSeedData } from '@p2p/shared';

async function seed() {
  console.log('🌱 Seeding Prosumer database...\n');

  const SEED_DATA = generateSeedData();

  await connectPrisma();

  // Clear existing data (in correct order for foreign key constraints)
  console.log('Clearing existing data...');
  await prisma.offerBlock.deleteMany();
  await prisma.order.deleteMany();
  await prisma.event.deleteMany();
  await prisma.catalogOffer.deleteMany();
  await prisma.catalogItem.deleteMany();
  await prisma.provider.deleteMany();

  // Also clear Redis transaction states
  try {
    await clearAllTransactionStates();
    console.log('✅ Cleared Redis transaction states');
  } catch (error) {
    console.log('⚠️ Could not clear Redis (may not be running)');
  }

  // Insert providers
  for (const provider of SEED_DATA.providers) {
    await prisma.provider.create({
      data: {
        id: provider.id,
        name: provider.name,
        trustScore: provider.trust_score,
        totalOrders: provider.total_orders,
        successfulOrders: provider.successful_orders,
      },
    });
    console.log(`✅ Provider: ${provider.name} (trust: ${provider.trust_score})`);
  }

  // Insert items
  for (const item of SEED_DATA.items) {
    await prisma.catalogItem.create({
      data: {
        id: item.id,
        providerId: item.provider_id,
        sourceType: item.source_type,
        deliveryMode: item.delivery_mode,
        availableQty: item.available_qty,
        meterId: item.meter_id,
        productionWindowsJson: JSON.stringify(item.production_windows),
      },
    });
    console.log(`✅ Item: ${item.id} (${item.source_type}, ${item.available_qty} kWh)`);
  }

  // Insert offers and create blocks (1 block = 1 unit)
  for (const offer of SEED_DATA.offers) {
    await prisma.catalogOffer.create({
      data: {
        id: offer.id,
        itemId: offer.item_id,
        providerId: offer.provider_id,
        priceValue: offer.price_value,
        currency: offer.currency,
        maxQty: offer.max_qty,
        timeWindowStart: new Date(offer.time_window.startTime),
        timeWindowEnd: new Date(offer.time_window.endTime),
        pricingModel: offer.offer_attributes.pricingModel,
        settlementType: offer.offer_attributes.settlementType,
      },
    });

    // Create blocks for this offer (1 block = 1 unit of energy)
    const blockData = Array.from({ length: offer.max_qty }, (_, i) => ({
      id: `block-${offer.id}-${i}`,
      offerId: offer.id,
      itemId: offer.item_id,
      providerId: offer.provider_id,
      status: 'AVAILABLE',
      priceValue: offer.price_value,
      currency: offer.currency,
    }));

    await prisma.offerBlock.createMany({
      data: blockData,
    });

    console.log(`✅ Offer: ${offer.id} (₹${offer.price_value}/kWh, ${offer.max_qty} blocks created)`);
  }

  await disconnectPrisma();
  
  // Disconnect Redis to allow process to exit cleanly
  try {
    await disconnectRedis();
  } catch (error) {
    // Ignore - Redis may not have been connected
  }

  const totalBlocks = SEED_DATA.offers.reduce((sum, o) => sum + o.max_qty, 0);
  console.log('\n🎉 Prosumer database seeding complete!');
  console.log(`   - ${SEED_DATA.providers.length} providers`);
  console.log(`   - ${SEED_DATA.items.length} items`);
  console.log(`   - ${SEED_DATA.offers.length} offers`);
  console.log(`   - ${totalBlocks} total blocks`);
}

seed()
  .then(() => {
    process.exit(0);
  })
  .catch(err => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
