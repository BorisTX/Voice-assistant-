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

  // bookings
  cleanupExpiredHolds,
  findOverlappingActiveBookings,
  createPendingHold,
  createPendingHoldIfAvailableTx,
  confirmBooking,
  failBooking,
  cancelBooking,
  getBookingById,

  // debug
  listTables,
} from "../../db.js";

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

    // tokens
    getGoogleTokens: (businessId) => getGoogleTokens(db, businessId),
    upsertGoogleTokens: (businessId, tokens) => upsertGoogleTokens(db, businessId, tokens),
    assertBusinessExists: (businessId) => assertBusinessExists(db, businessId),

    // bookings
    cleanupExpiredHolds: (businessId = null) => cleanupExpiredHolds(db, businessId),
    findOverlappingActiveBookings: (businessId, startUtcIso, endUtcIso) =>
      findOverlappingActiveBookings(db, businessId, startUtcIso, endUtcIso),
    createPendingHold: (payload) => createPendingHold(db, payload),
    createPendingHoldIfAvailableTx: (payload) => createPendingHoldIfAvailableTx(db, payload),
    confirmBooking: (bookingId, gcalEventId) => confirmBooking(db, bookingId, gcalEventId),
    failBooking: (bookingId, reason = null) => failBooking(db, bookingId, reason),
    cancelBooking: (bookingId) => cancelBooking(db, bookingId),
    getBookingById: (bookingId) => getBookingById(db, bookingId),
  };
}
