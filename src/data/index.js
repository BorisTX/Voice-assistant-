// src/data/index.js
import { makeSqliteData } from "./sqlite.js";

export function makeDataLayer({ db }) {
  const dialect = process.env.DB_DIALECT || "sqlite";

  if (dialect === "sqlite") {
    return { dialect, data: makeSqliteData(db) };
  }

  // позже тут сделаем Postgres
  throw new Error(`DB_DIALECT=${dialect} not supported yet (postgres adapter not implemented)`);
}
