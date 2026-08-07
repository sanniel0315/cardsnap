/* @cardsnap/core 型別宣告 — 對齊 assets/core.js 的 API */

export interface Phone {
  label: string;   // 例:'手機' | '市話'
  value: string;
}

/** 名片資料(欄位多為選填;同步/去重以 email→phone→name+company 為鍵)。 */
export interface Contact {
  id?: string;
  name?: string;
  company?: string;
  title?: string;
  phone?: string;        // 主電話,通常 = phones[0].value
  phones?: Phone[];
  fax?: string;
  taxId?: string;        // 台灣統一編號(8 碼)
  email?: string;
  website?: string;
  address?: string;
  tags?: string[];
  note?: string;
  group?: string;
  source?: string;
  favorite?: boolean;
  image?: string;        // 主圖(dataURL)
  images?: string[];     // 多面影像(dataURL)
  imagePath?: string;    // Storage 主圖路徑
  imagePaths?: string[]; // Storage 多面路徑
  created?: number;      // epoch ms
  updated?: number;      // epoch ms;同步衝突解以較大者勝
  deleted?: number;      // epoch ms;>0=在回收站(軟刪除),空=正常。同步欄位
  [key: string]: unknown;
}

export interface MergeResult {
  merged: Contact[];
  added: number;
  skipped: number;
}

export interface Tombstone { k: string; ts: number; }

export interface ReconcileResult {
  merged: Contact[];
  toUpsert: Contact[];
  toDelete: string[];
  tombstones: Tombstone[];
}

/** OCR 文字 → 名片欄位(正則 + 關鍵字推斷)。 */
export function parseCard(raw: string): Contact;

/** 名片 → vCard 3.0 字串。 */
export function toVCard(contact: Contact): string;

/** 名單 → CSV 字串(含 BOM、跳脫)。 */
export function toCSV(contacts: Contact[]): string;

/** CSV 字串 → 名片陣列(自動辨識表頭)。 */
export function parseCSV(text: string): Contact[];

/** vCard 文字 → 名片陣列。 */
export function parseVCards(text: string): Contact[];

/** 既有 + 匯入 → 去重合併,回報新增/略過數。 */
export function mergeContacts(existing: Contact[], incoming: Contact[]): MergeResult;

/** 計算去重鍵:'e:'+email → 'p:'+純數字電話 → 'n:'+name|company。 */
export function contactKey(contact: Contact): string;

/** 雙向同步合併:聯集去重,同鍵取較新(updated/created 大者),依 created 新→舊排序。 */
export function syncMerge(local: Contact[], remote: Contact[]): Contact[];

/** 判斷亂碼/空白名片(解碼失敗、控制字元、Excel 殘骸、無姓名也無公司)。 */
export function isJunkContact(c: Contact): boolean;

/** 過濾掉亂碼/空白名片。 */
export function dropJunk(contacts: Contact[]): Contact[];

/** 舊資料 → 新欄位格式(image→images[]、phone→phones[]、補 group/source);原地修改並回傳。 */
export function migrate(c: Contact): Contact;

/** 把 extra 的欄位補進 base 目前「空缺」的欄位(不覆蓋已有值、電話去重合併)。正反面互補用。 */
export function fillMissing(base: Contact, extra: Contact): Contact;

/** 合併兩端墓碑:同鍵取較新 ts,清掉超過 180 天的舊墓碑。 */
export function mergeTombstones(a: Tombstone[], b: Tombstone[]): Tombstone[];

/** 套用墓碑:墓碑 ts >= 該聯絡人 updated 視為已刪,過濾掉。 */
export function applyTombstones(contacts: Contact[], tombs: Tombstone[]): Contact[];

/** 同步對帳(純決策,不碰 I/O):算出最終名單、要 upsert、要刪的 id、合併後墓碑。Web 與 App 共用。 */
export function reconcile(
  local: Contact[], remote: Contact[],
  localTombs: Tombstone[], remoteTombs: Tombstone[]
): ReconcileResult;

/** Supabase DB row → 前端 contact。 */
export function rowToContact(row: Record<string, unknown>): Contact;

/** 前端 contact → Supabase DB row(帶 owner_id)。 */
export function contactToRow(contact: Contact, ownerId: string): Record<string, unknown>;

/** 回收站:該聯絡人是否在回收站(deleted>0=軟刪除)。主清單/計數/搜尋一律濾掉 true 的。 */
export function isTrashed(contact: Contact): boolean;
