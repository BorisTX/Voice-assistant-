// src/data/sqlite.js
import {
  getBusinessById,
  getBusinessByName,
  insertBusiness,
  listBusinesses,
  listTables,
  getGoogleTokens,
} from "../../db.js";

export function makeSqliteData(db) {
  return {
    // db inspection
    listTables: () => listTables(db),
    listBusinesses: () => listBusinesses(db),

    // businesses
    getBusinessById: (id) => getBusinessById(db, id),
    getBusinessByName: (name) => getBusinessByName(db, name),
    insertBusiness: (payload) => insertBusiness(db, payload),

    // tokens
    getGoogleTokens: (businessId) => getGoogleTokens(db, businessId),
  };
}
