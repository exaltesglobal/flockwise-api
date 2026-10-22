// What each staff role can do. Owners and admins can do everything; churches can add roles of their own.
import type { Db } from './db.js';
import type { BuiltInRole, Permission, RoleScope, StaffMember, StaffRole } from './types.js';

const ALL: Permission[] = ['people.view', 'people.edit', 'giving.view', 'giving.edit', 'events', 'groups', 'comms', 'care', 'checkin', 'volunteers', 'services', 'settings', 'staff', 'insights'];

export const PERMISSIONS: Record<BuiltInRole, Permission[]> = {
  owner: ALL,
  admin: ALL,
  // Pastors see everything about people and ministry, but not individual giving.
  pastor: ['people.view', 'people.edit', 'events', 'groups', 'comms', 'care', 'checkin', 'volunteers', 'services', 'insights'],
  finance: ['people.view', 'giving.view', 'giving.edit', 'insights'],
  // Group and ministry leaders.
  leader: ['people.view', 'groups', 'care', 'checkin', 'volunteers', 'services'],
  // Volunteer / worship coordinators.
  coordinator: ['people.view', 'volunteers', 'services', 'checkin', 'events'],
  // Check-in desk and kiosk logins.
  checkin: ['checkin'],
};

export const ROLE_LABELS: Record<StaffRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  pastor: 'Pastor',
  finance: 'Finance',
  leader: 'Group leader',
  coordinator: 'Volunteer coordinator',
  checkin: 'Check-in desk',
  custom: 'Custom role',
};

export const isBuiltIn = (role: string): role is BuiltInRole => role in PERMISSIONS;

/** The permissions a login has: the built-in role's, or the custom role's. A custom role that was deleted gives nothing. */
export function permsOf(db: Db, staff: Pick<StaffMember, 'role' | 'roleId'>): Permission[] {
  if (staff.role !== 'custom') return PERMISSIONS[staff.role] ?? [];
  return (staff.roleId && db.get('roles', staff.roleId)?.permissions) || [];
}

/** Who a scoped login may see, or null when it sees the whole church. */
export type Scope = { kind: RoleScope; ids: string[]; people: Set<string> };
export function scopeOf(db: Db, staff: Pick<StaffMember, 'role' | 'roleId' | 'scopeIds'>): Scope | null {
  if (staff.role !== 'custom' || !staff.roleId) return null;
  const role = db.get('roles', staff.roleId);
  const ids = staff.scopeIds ?? [];
  if (!role || role.scope === 'church' || ids.length === 0) return null;
  const people = new Set<string>();
  if (role.scope === 'zone') {
    // A zone includes its smaller units.
    const all = new Set(ids);
    for (const z of db.all('zones')) if (z.parentId && all.has(z.parentId)) all.add(z.id);
    for (const p of db.all('people')) if (p.zoneId && all.has(p.zoneId)) people.add(p.id);
  } else if (role.scope === 'group') {
    for (const m of db.all('groupMembers')) if (ids.includes(m.groupId)) people.add(m.personId);
  } else {
    for (const t of db.all('teams')) if (ids.includes(t.id)) for (const m of t.members) people.add(m.personId);
  }
  return { kind: role.scope, ids, people };
}
