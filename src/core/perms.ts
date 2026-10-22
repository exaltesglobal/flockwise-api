// What each staff role can do. Owners and admins can do everything.
import type { Permission, StaffRole } from './types.js';

const ALL: Permission[] = ['people.view', 'people.edit', 'giving.view', 'giving.edit', 'events', 'groups', 'comms', 'care', 'checkin', 'volunteers', 'services', 'settings', 'staff', 'insights'];

export const PERMISSIONS: Record<StaffRole, Permission[]> = {
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
};
