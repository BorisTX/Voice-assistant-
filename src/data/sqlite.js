// src/data/sqlite.js
import {
  // businesses
  getBusinessById,
  getBusinessByName,
  listBusinesses,
  insertBusiness,
  createOAuthFlow,
  consumeOAuthFlow,
  // tokens
  getGoogleTokens,
  upsertGoogleTokens,
  assertBusinessExists,

  // debug
  listTables,

  // bookings
  cleanupExpiredHolds,
  findOverlappingActiveBookings,
  createPendingHold,
  createPendingHoldIfAvailableTx,
  confirmBooking,
  failBooking,
  cancelBooking,
  logSmsAttempt,
  logEmergencyAttempt,
} from "../../db.js";

// адаптер: превращаем функции вида (db, ...) в методы data-layer вида (...) с замкнутым db
export function makeSqliteData(db) {
  if (!db) throw new Error("makeSqliteData: missing db");

  return {
    // debug
    listTables: () => listTables(db),
    // oauth flows (PKCE)
    createOAuthFlow: (payload) => createOAuthFlow(db, payload),
    consumeOAuthFlow: (nonce) => consumeOAuthFlow(db, nonce),
    // businesses
    getBusinessById: (businessId) => getBusinessById(db, businessId),
    getBusinessByName: (name) => getBusinessByName(db, name),
    listBusinesses: () => listBusinesses(db),
    insertBusiness: (business) => insertBusiness(db, business),

    // tokens (важно для googleAuth.js)
    getGoogleTokens: (businessId) => getGoogleTokens(db, businessId),
    upsertGoogleTokens: (businessId, tokens) => upsertGoogleTokens(db, businessId, tokens),
    assertBusinessExists: (businessId) => assertBusinessExists(db, businessId),

    // bookings
    cleanupExpiredHolds: (businessId) => cleanupExpiredHolds(db, businessId),
    findOverlappingActiveBookings: (businessId, startUtcIso, endUtcIso) =>
      findOverlappingActiveBookings(db, businessId, startUtcIso, endUtcIso),
    createPendingHold: (payload) => createPendingHold(db, payload),
    createPendingHoldIfAvailableTx: (payload) => createPendingHoldIfAvailableTx(db, payload),
    confirmBooking: (bookingId, gcalEventId) => confirmBooking(db, bookingId, gcalEventId),
    failBooking: (bookingId, reason) => failBooking(db, bookingId, reason),
    cancelBooking: (bookingId) => cancelBooking(db, bookingId),
    logSmsAttempt: (payload) => logSmsAttempt(db, payload),
    logEmergencyAttempt: (payload) => logEmergencyAttempt(db, payload),
  };
}
