import type {SQLiteDatabase} from './sqlite.js';
import type {GroupCoordinationStorage, GroupRow} from './resource-group-driver.js';

/** Uses the host connection; place content and Group fences in the same database for purge. */
export function createSQLiteGroupStorage(db: SQLiteDatabase): GroupCoordinationStorage {
  db.exec('CREATE TABLE IF NOT EXISTS authz_resource_groups (key TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT; PRAGMA busy_timeout=5000;');
  const read = (key: string): GroupRow|null => {
    const row = db.prepare('SELECT payload FROM authz_resource_groups WHERE key=?').get(key);
    if (!row) return null;if (typeof row.payload !== 'string' || row.payload.length > 1048576) throw Error('group_state_invalid');
    return JSON.parse(row.payload) as GroupRow;
  };
  return {
    async read(key) {return read(key);},
    async readMany(keys){db.exec('BEGIN');try{const result=keys.map(read);db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}},
    async transaction(key, work) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const {row,result}=work(read(key));const payload=JSON.stringify(row);
        if(new TextEncoder().encode(payload).byteLength>1048576)throw Error('group_capacity');
        db.prepare('INSERT OR REPLACE INTO authz_resource_groups VALUES(?,?)').run(key,payload);
        db.exec('COMMIT');return result;
      }catch(error){db.exec('ROLLBACK');throw error;}
    },
  };
}
