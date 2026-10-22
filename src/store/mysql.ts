// MySQL store for Hostinger. Create the tables with schema.sql (hPanel > Databases > phpMyAdmin > Import).
import mysql, { type RowDataPacket } from 'mysql2/promise';

import type { Donation, DonationFilter, Fund, Store } from './types.js';

type Conn = { host: string; port: number; user: string; password: string; database: string };

const COLS = 'id, church_id, member_id, donor_name, donor_email, donor_phone, fund_id, fund_name, amount, currency, frequency, status, method, pan, donor_citizenship, fcra, provider, provider_ref, provider_payment_id, created_at, paid_at';

function toDonation(r: RowDataPacket): Donation {
  return {
    id: r.id,
    churchId: r.church_id,
    memberId: r.member_id,
    donorName: r.donor_name,
    donorEmail: r.donor_email,
    donorPhone: r.donor_phone,
    fundId: r.fund_id,
    fundName: r.fund_name,
    amount: Number(r.amount),
    currency: r.currency,
    frequency: r.frequency,
    status: r.status,
    method: r.method,
    pan: r.pan,
    donorCitizenship: r.donor_citizenship,
    fcra: !!r.fcra,
    provider: r.provider,
    providerRef: r.provider_ref,
    providerPaymentId: r.provider_payment_id,
    createdAt: new Date(r.created_at).toISOString(),
    paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
  };
}

const toSql = (iso: string | null) => (iso ? iso.slice(0, 19).replace('T', ' ') : null);

const FIELD_COLUMN: Partial<Record<keyof Donation, string>> = {
  status: 'status',
  method: 'method',
  providerRef: 'provider_ref',
  providerPaymentId: 'provider_payment_id',
  paidAt: 'paid_at',
  donorName: 'donor_name',
  donorEmail: 'donor_email',
  donorPhone: 'donor_phone',
};

export function mysqlStore(conn: Conn): Store {
  // Times are stored in UTC.
  const pool = mysql.createPool({ ...conn, connectionLimit: 5, timezone: 'Z', dateStrings: false });
  const query = async <T extends RowDataPacket[]>(sql: string, params: unknown[] = []) => (await pool.query<T>(sql, params))[0];

  return {
    async listFunds(churchId) {
      const rows = await query<RowDataPacket[]>('SELECT * FROM funds WHERE church_id = ? ORDER BY sort_order, name', [churchId]);
      return rows.map((r): Fund => ({ id: r.id, churchId: r.church_id, name: r.name, description: r.description, taxDeductible: !!r.tax_deductible, active: !!r.active, goal: r.goal === null ? null : Number(r.goal) }));
    },
    async getFund(churchId, id) {
      return (await this.listFunds(churchId)).find((f) => f.id === id) ?? null;
    },
    async insertDonation(d) {
      await pool.query(
        `INSERT IGNORE INTO donations (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [d.id, d.churchId, d.memberId, d.donorName, d.donorEmail, d.donorPhone, d.fundId, d.fundName, d.amount, d.currency, d.frequency, d.status, d.method, d.pan, d.donorCitizenship, d.fcra ? 1 : 0, d.provider, d.providerRef, d.providerPaymentId, toSql(d.createdAt), toSql(d.paidAt)],
      );
    },
    async updateDonation(id, patch) {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [k, v] of Object.entries(patch) as [keyof Donation, unknown][]) {
        const col = FIELD_COLUMN[k];
        if (!col) continue;
        sets.push(`${col} = ?`);
        params.push(k === 'paidAt' ? toSql(v as string | null) : v);
      }
      if (sets.length) await pool.query(`UPDATE donations SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    },
    async findDonation(id) {
      const [r] = await query<RowDataPacket[]>(`SELECT ${COLS} FROM donations WHERE id = ?`, [id]);
      return r ? toDonation(r) : null;
    },
    async findByProviderRef(ref) {
      const [r] = await query<RowDataPacket[]>(`SELECT ${COLS} FROM donations WHERE provider_ref = ? ORDER BY created_at ASC LIMIT 1`, [ref]);
      return r ? toDonation(r) : null;
    },
    async findByPaymentId(pid) {
      const [r] = await query<RowDataPacket[]>(`SELECT ${COLS} FROM donations WHERE provider_payment_id = ?`, [pid]);
      return r ? toDonation(r) : null;
    },
    async listDonations(f: DonationFilter) {
      const where = ['church_id = ?'];
      const params: unknown[] = [f.churchId];
      if (f.memberId) (where.push('member_id = ?'), params.push(f.memberId));
      if (f.fundId) (where.push('fund_id = ?'), params.push(f.fundId));
      if (f.from) (where.push('created_at >= ?'), params.push(`${f.from} 00:00:00`));
      if (f.to) (where.push('created_at <= ?'), params.push(`${f.to} 23:59:59`));
      if (f.q) (where.push('(donor_name LIKE ? OR pan LIKE ?)'), params.push(`%${f.q}%`, `%${f.q}%`));
      const w = where.join(' AND ');
      const rows = await query<RowDataPacket[]>(`SELECT ${COLS} FROM donations WHERE ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, f.limit ?? 50, f.offset ?? 0]);
      const [agg] = await query<RowDataPacket[]>(`SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = 'succeeded' THEN amount END), 0) AS amt FROM donations WHERE ${w}`, params);
      return { rows: rows.map(toDonation), total: Number(agg.n), totalAmount: Number(agg.amt) };
    },
    async getPlanId(key) {
      const [r] = await query<RowDataPacket[]>('SELECT plan_id FROM razorpay_plans WHERE plan_key = ?', [key]);
      return r?.plan_id ?? null;
    },
    async savePlanId(key, planId) {
      await pool.query('INSERT IGNORE INTO razorpay_plans (plan_key, plan_id) VALUES (?, ?)', [key, planId]);
    },
  };
}
