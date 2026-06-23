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
  created?: number;      // epoch ms
  updated?: number;      // epoch ms;同步衝突解以較大者勝
  [key: string]: unknown;
}

export interface MergeResult {
  merged: Contact[];
  added: number;
  skipped: number;
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
