// src/data/sqlite.js
import {
  // businesses
  getBusinessById,
  getBusinessByName,
  listBusinesses,
  insertBusiness,

  // tokens
  getGoogleTokens,
  upsertGoogleTokens,
  assertBusinessExists,

  // debug
  listTables,
} from "../../db.js";

// адаптер: превращаем функции вида (db, ...) в методы data-layer вида (...) с замкнутым db
export function makeSqliteData(db) {
  if (!db) throw new Error("makeSqliteData: missing db");

  return {
    // debug
    listTables: () => listTables(db),

    // businesses
    getBusinessById: (businessId) => getBusinessById(db, businessId),
    getBusinessByName: (name) => getBusinessByName(db, name),
    listBusinesses: () => listBusinesses(db),
    insertBusiness: (business) => insertBusiness(db, business),

    // tokens (важно для googleAuth.js)
    getGoogleTokens: (businessId) => getGoogleTokens(db, businessId),
    upsertGoogleTokens: (businessId, tokens) => upsertGoogleTokens(db, businessId, tokens),
    assertBusinessExists: (businessId) => assertBusinessExists(db, businessId),
  };
}
