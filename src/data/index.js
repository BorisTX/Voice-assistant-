// src/data/index.js
import { makeSqliteData } from "./sqlite.js";

export function makeDataLayer({ db }) {
  // по дефолту sqlite — чтобы не было dialect = undefined
  const dialect = (process.env.DB_DIALECT || "sqlite").toLowerCase();

  if (dialect === "sqlite") {
    return { dialect, data: makeSqliteData(db) };
  }

  // позже добавим postgres adapter
  throw new Error(`DB_DIALECT=${dialect} not supported yet (postgres adapter not implemented)`);
}
