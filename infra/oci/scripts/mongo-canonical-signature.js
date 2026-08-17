if (typeof DB_NAME !== "string" || !/^[A-Za-z0-9_]+$/.test(DB_NAME)) {
  throw new Error("DB_NAME must be a safe database identifier");
}

const targetDb = db.getSiblingDB(DB_NAME);

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonical(value[key]);
        return result;
      }, {});
  }
  return value;
}

function comparableIndex(index) {
  const fields = [
    "name",
    "key",
    "unique",
    "sparse",
    "expireAfterSeconds",
    "partialFilterExpression",
    "collation",
    "wildcardProjection",
    "hidden",
  ];
  return fields.reduce((result, field) => {
    if (Object.prototype.hasOwnProperty.call(index, field)) {
      result[field] = index[field];
    }
    return result;
  }, {});
}

const collectionInfos = targetDb
  .getCollectionInfos()
  .sort((left, right) => left.name.localeCompare(right.name));
const collections = collectionInfos.map((info) => {
  const result = {
    name: info.name,
    type: info.type,
    options: info.options || {},
  };
  if (info.idIndex) {
    result.idIndex = comparableIndex(info.idIndex);
  }
  if (info.type === "collection") {
    result.documents = targetDb.getCollection(info.name).countDocuments({});
    result.indexes = targetDb
      .getCollection(info.name)
      .getIndexes()
      .map(comparableIndex)
      .sort((left, right) => left.name.localeCompare(right.name));
  }
  return result;
});

const dbHash = targetDb.runCommand({ dbHash: 1 });
if (dbHash.ok !== 1) {
  throw new Error(`dbHash failed for ${DB_NAME}`);
}

print(
  EJSON.stringify(
    canonical({
      database: DB_NAME,
      collections,
      dataHash: dbHash.md5,
      collectionHashes: dbHash.collections || {},
    }),
    { relaxed: false },
  ),
);
