// src/data/index.js
import { makeSqliteData } from "./sqlite.js";

export function makeDataLayer({ db }) {
  const dialect = process.env.DB_DIALECT || "sqlite";

  if (dialect === "sqlite") {
    return makeSqliteData(db);
  }

  // позже добавим postgres adapter
  throw new Error(`DB_DIALECT=${dialect} not supported yet`);
}
