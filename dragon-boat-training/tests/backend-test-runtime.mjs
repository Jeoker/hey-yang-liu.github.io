import crypto from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import vm from "node:vm";

const sourceDirectory = new URL("../backend/src/", import.meta.url);

class FakeRange {
  constructor(sheet, row, column, rowCount, columnCount) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.rowCount = rowCount;
    this.columnCount = columnCount;
  }

  getValues() {
    return Array.from({ length: this.rowCount }, (_, rowOffset) =>
      Array.from({ length: this.columnCount }, (_, columnOffset) =>
        this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? ""
      )
    );
  }

  setValues(values) {
    for (let rowOffset = 0; rowOffset < this.rowCount; rowOffset += 1) {
      const rowIndex = this.row - 1 + rowOffset;
      this.sheet.rows[rowIndex] ||= [];
      for (let columnOffset = 0; columnOffset < this.columnCount; columnOffset += 1) {
        this.sheet.rows[rowIndex][this.column - 1 + columnOffset] = values[rowOffset][columnOffset];
      }
    }
    return this;
  }

  setNumberFormat() {
    return this;
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
  }

  getName() {
    return this.name;
  }

  getLastRow() {
    let last = this.rows.length;
    while (last > 0 && (!this.rows[last - 1] || this.rows[last - 1].every((value) => value === ""))) {
      last -= 1;
    }
    return last;
  }

  getLastColumn() {
    return this.rows.reduce((maximum, row) => Math.max(maximum, row?.length || 0), 0);
  }

  getRange(row, column, rowCount, columnCount) {
    return new FakeRange(this, row, column, rowCount, columnCount);
  }

  setFrozenRows() {}
}

class FakeSpreadsheet {
  constructor(id, title = id) {
    this.id = id;
    this.title = title;
    this.sheets = new Map();
  }

  getId() {
    return this.id;
  }

  getSheetByName(name) {
    return this.sheets.get(name) || null;
  }

  insertSheet(name) {
    const sheet = new FakeSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }

  getSheets() {
    return [...this.sheets.values()];
  }

  deleteSheet(sheet) {
    this.sheets.delete(sheet.getName());
  }
}

class FakeProperties {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  }

  getProperty(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setProperty(key, value) {
    this.values.set(key, String(value));
    return this;
  }

  deleteProperty(key) {
    this.values.delete(key);
    return this;
  }
}

function byteArray(value) {
  return [...Buffer.from(value)].map((byte) => (byte > 127 ? byte - 256 : byte));
}

function bufferFromBytes(value) {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.from([...value].map((byte) => (byte < 0 ? byte + 256 : byte)));
}

export async function createBackend(options = {}) {
  let uuidSequence = 0;
  const spreadsheet = new FakeSpreadsheet("system-sheet-test");
  const initialProperties = {
    DRAGON_BOAT_INITIAL_COACH_ID: options.coachId || "coach_alpha",
    DRAGON_BOAT_INITIAL_COACH_NAME: options.displayName || "Coach Alpha",
    DRAGON_BOAT_INITIAL_COACH_CODE: options.coachCode || "coach-code-123",
    DRAGON_BOAT_CODE_SECRET: "test-code-secret",
    DRAGON_BOAT_SESSION_SECRET: "test-session-secret",
    ...(options.properties || {})
  };
  if (!options.withoutSystemSpreadsheetId) {
    initialProperties.DRAGON_BOAT_SYSTEM_SPREADSHEET_ID = spreadsheet.getId();
  }
  const properties = new FakeProperties(initialProperties);
  const cacheValues = new Map();
  const spreadsheets = new Map([[spreadsheet.getId(), spreadsheet]]);
  let createdSpreadsheetSequence = 0;

  const context = {
    CacheService: {
      getScriptCache() {
        return {
          get(key) {
            return cacheValues.get(key) ?? null;
          },
          put(key, value) {
            cacheValues.set(key, String(value));
          }
        };
      }
    },
    ContentService: {
      MimeType: { JSON: "application/json" },
      createTextOutput(content) {
        return {
          content,
          mimeType: null,
          setMimeType(mimeType) {
            this.mimeType = mimeType;
            return this;
          }
        };
      }
    },
    LockService: {
      getScriptLock() {
        return { waitLock() {}, releaseLock() {} };
      }
    },
    PropertiesService: {
      getScriptProperties() {
        return properties;
      }
    },
    SpreadsheetApp: {
      openById(id) {
        const match = spreadsheets.get(id);
        if (!match) throw new Error("Spreadsheet not found");
        return match;
      },
      create(title) {
        createdSpreadsheetSequence += 1;
        const created = new FakeSpreadsheet(
          `created-system-sheet-${createdSpreadsheetSequence}`,
          title
        );
        created.insertSheet("Sheet1");
        spreadsheets.set(created.getId(), created);
        return created;
      }
    },
    Utilities: {
      Charset: { UTF_8: "UTF-8" },
      base64DecodeWebSafe(value) {
        return byteArray(Buffer.from(value, "base64url"));
      },
      base64EncodeWebSafe(value) {
        return bufferFromBytes(value).toString("base64url");
      },
      computeHmacSha256Signature(value, key) {
        return byteArray(crypto.createHmac("sha256", key).update(value, "utf8").digest());
      },
      getUuid() {
        uuidSequence += 1;
        return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, "0")}`;
      },
      newBlob(bytes) {
        return {
          getDataAsString() {
            return bufferFromBytes(bytes).toString("utf8");
          }
        };
      }
    },
    Date,
    Error,
    JSON,
    Math,
    Number,
    Object,
    String
  };

  vm.createContext(context);
  const files = (await readdir(sourceDirectory))
    .filter((name) => name.endsWith(".gs"))
    .sort();
  for (const file of files) {
    const source = await readFile(new URL(file, sourceDirectory), "utf8");
    vm.runInContext(source, context, { filename: file });
  }

  if (options.setup !== false) {
    context.setupDragonBoatP0();
  }

  const activeSpreadsheetId = properties.getProperty("DRAGON_BOAT_SYSTEM_SPREADSHEET_ID");
  return {
    context,
    spreadsheet: spreadsheets.get(activeSpreadsheetId) || spreadsheet,
    spreadsheets,
    properties,
    cacheValues
  };
}

export function payload(output) {
  return JSON.parse(output.content);
}

export function post(context, body) {
  return payload(context.doPost({ postData: { contents: JSON.stringify(body) } }));
}

export function sheetRecords(spreadsheet, sheetName) {
  const rows = spreadsheet.getSheetByName(sheetName)?.rows || [];
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}
