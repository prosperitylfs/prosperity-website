// Product/service category availability per brand.
//
// Re-exports the exact same arrays already seeded into the database by
// crm/db/migrateBrands.js, so there is a single source of truth for the
// approved category list rather than two literal copies that could drift.
//
// IMPORTANT: products describe what a case is about AFTER its brand has
// already been resolved (see crm/lib/senderResolution.js). Nothing in this
// module — or anywhere else — infers or changes a case's brand from a
// product choice.

const { INSURANCE_LADY_PRODUCTS, PROSPERITY_PRODUCTS } = require('../db/migrateBrands');

const PRODUCTS_BY_BRAND = {
  'insurance-lady': INSURANCE_LADY_PRODUCTS,
  prosperity: PROSPERITY_PRODUCTS,
};

function getProductsForBrand(brandId) {
  return PRODUCTS_BY_BRAND[brandId] ? [...PRODUCTS_BY_BRAND[brandId]] : [];
}

module.exports = { PRODUCTS_BY_BRAND, getProductsForBrand };
